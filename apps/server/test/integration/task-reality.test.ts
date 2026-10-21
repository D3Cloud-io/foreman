import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { attachAuth } from '../../src/auth/middleware.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { taskRealityRoutes, type Reality } from '../../src/routes/taskReality.js';

/**
 * What bears on a task, and on a requirement through its tasks (FRM-T-18.8, FRM-REQ-247).
 *
 * The route is `taskRealityRoutes`, mounted at `/api` in `app.ts`. These tests mount it on a small
 * app of their own, behind the same `attachAuth`, so they say what the route does whether or not the
 * one mount line in `app.ts` has been added; the e2e spec drives the real app through it.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'task-reality@example.com';
const PASSWORD = 'a-password-for-the-reality-tests';
const CODE = 'TRL';

describe.skipIf(url === undefined)('the reality behind a task', () => {
  let db: Db;
  let config: Config;
  let server: Server;
  let origin: string;
  let cookie: string;
  let projectId: string;
  let repoId: string;
  let taskId: string;
  let otherTaskId: string;
  let requirementId: string;

  const reality = async (path: string): Promise<Reality> => {
    const res = await fetch(`${origin}/api/${path}/reality`, { headers: { cookie } });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Reality;
  };

  const commit = (sha: string, minutesAgo: number, data: Record<string, unknown> = {}) =>
    db.commit.create({
      data: {
        repoId,
        sha,
        message: `Subject of ${sha.slice(0, 7)}\n\nBody that is not shown.`,
        author: 't',
        committedAt: new Date(Date.now() - minutesAgo * 60_000),
        ...data,
      },
    });

  const attribute = (commitId: string, task: string, data: { confirmed: boolean; rejectedAt?: Date }) =>
    db.commitTask.create({
      data: {
        commitId,
        taskId: task,
        source: data.confirmed ? 'declared' : 'file_overlap',
        confidence: 0.8,
        confirmed: data.confirmed,
        ...(data.rejectedAt === undefined ? {} : { rejectedAt: data.rejectedAt }),
      },
    });

  beforeAll(async () => {
    config = loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'http://localhost:3200',
      DATABASE_URL: url ?? '',
      KEK: Buffer.alloc(32, 1).toString('base64'),
      PEPPER: Buffer.alloc(32, 2).toString('base64'),
      COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
    });
    db = createDb(url ?? '');
    await db.user.deleteMany({ where: { email: EMAIL } });
    const user = await db.user.create({ data: { email: EMAIL, displayName: 'Reality', status: 'active' } });
    await setPassword({ db, config }, user.id, PASSWORD);

    // The real app signs in; this one serves the route behind the same session middleware.
    const real = await new Promise<Server>((resolve) => {
      const r = createApp({ config, db }).listen(0, () => {
        resolve(r);
      });
    });
    const realAddress = real.address();
    if (realAddress === null || typeof realAddress === 'string') throw new Error('no port');
    const signIn = await fetch(`http://127.0.0.1:${String(realAddress.port)}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    await new Promise<void>((resolve) => real.close(() => { resolve(); }));

    const app = express();
    app.use(attachAuth({ db, config, verifier: null }));
    app.use('/api', taskRealityRoutes(db));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => {
        resolve(s);
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    origin = `http://127.0.0.1:${String(address.port)}`;
  });

  beforeEach(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    const project = await db.project.create({ data: { code: CODE, name: 'Reality', slug: 'reality' } });
    projectId = project.id;
    repoId = (await db.repo.create({ data: { projectId, fullName: 'test/reality' } })).id;
    const phase = await db.phase.create({
      data: { projectId, humanId: `${CODE}-P-1`, number: 1, sortOrder: 1, name: 'One', status: 'active' },
    });
    taskId = (
      await db.task.create({ data: { projectId, phaseId: phase.id, humanId: `${CODE}-T-1.1`, title: 'First' } })
    ).id;
    otherTaskId = (
      await db.task.create({ data: { projectId, phaseId: phase.id, humanId: `${CODE}-T-1.2`, title: 'Second' } })
    ).id;
    requirementId = (
      await db.requirement.create({ data: { projectId, humanId: `${CODE}-REQ-001`, seq: 1, statement: 'It shall.' } })
    ).id;
    await db.taskRequirement.createMany({
      data: [
        { taskId, requirementId },
        { taskId: otherTaskId, requirementId },
      ],
    });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  it('lists a confirmed commit as confirmed and a suggestion as not, and never a rejected or orphaned one', async () => {
    const confirmed = await commit('a'.repeat(40), 60);
    const suggested = await commit('b'.repeat(40), 50);
    const rejected = await commit('c'.repeat(40), 40);
    const orphaned = await commit('d'.repeat(40), 30, { orphanedAt: new Date() });
    await attribute(confirmed.id, taskId, { confirmed: true });
    await attribute(suggested.id, taskId, { confirmed: false });
    await attribute(rejected.id, taskId, { confirmed: false, rejectedAt: new Date() });
    await attribute(orphaned.id, taskId, { confirmed: true });

    const body = await reality(`tasks/${CODE}-T-1.1`);
    expect(body.commits.map((c) => [c.sha[0], c.confirmed])).toEqual([
      ['b', false],
      ['a', true],
    ]);
    // Only the subject line travels.
    expect(body.commits[1]?.message).toBe('Subject of aaaaaaa');
    expect(body.commits[1]?.task).toBe(`${CODE}-T-1.1`);
  });

  it('reports the CI results of the commits it lists, and no other', async () => {
    const mine = await commit('a'.repeat(40), 60);
    await attribute(mine.id, taskId, { confirmed: true });
    await db.checkRun.createMany({
      data: [
        { repoId, commitSha: 'a'.repeat(40), name: 'ci', conclusion: 'success', completedAt: new Date() },
        { repoId, commitSha: 'f'.repeat(40), name: 'ci', conclusion: 'failure', completedAt: new Date() },
      ],
    });
    const body = await reality(`tasks/${CODE}-T-1.1`);
    expect(body.checks.map((c) => [c.commitSha[0], c.conclusion])).toEqual([['a', 'success']]);
  });

  it('finds the deployments a commit is in, and those that name the task', async () => {
    const shipped = await commit('1'.repeat(40), 120);
    // On main and deployed, and not the task's: its deploy contains `shipped`.
    await commit('2'.repeat(40), 60);
    const unshipped = await commit('3'.repeat(40), 5);
    await attribute(shipped.id, taskId, { confirmed: true });
    await attribute(unshipped.id, taskId, { confirmed: true });
    const deploy = await db.deployment.create({
      data: {
        projectId,
        environment: 'production',
        image: 'ghcr.io/test/reality',
        imageSha: `sha-${'2'.repeat(7)}`,
        deployedAt: new Date(Date.now() - 30 * 60_000),
      },
    });
    const declared = await db.deployment.create({
      data: {
        projectId,
        environment: 'staging',
        image: 'ghcr.io/test/reality',
        imageSha: 'sha-0000000',
        deployedAt: new Date(Date.now() - 10 * 60_000),
        tasks: { create: { taskId } },
      },
    });

    const body = await reality(`tasks/${CODE}-T-1.1`);
    expect(body.deployments.map((d) => [d.id, d.via])).toEqual([
      [declared.id, 'declared'],
      [deploy.id, 'image'],
    ]);
    const byCommit: Record<string, string | null> = {};
    for (const c of body.commits) byCommit[c.sha.slice(0, 1)] = c.shippedIn;
    expect(byCommit).toEqual({ '1': deploy.id, '3': null });
  });

  it('does not list a deployment for a task whose only commit in it is a suggestion (ADR-005)', async () => {
    const suggested = await commit('1'.repeat(40), 120);
    await attribute(suggested.id, taskId, { confirmed: false });
    await db.deployment.create({
      data: {
        projectId,
        environment: 'production',
        image: 'ghcr.io/test/reality',
        imageSha: `sha-${'1'.repeat(7)}`,
        deployedAt: new Date(Date.now() - 30 * 60_000),
      },
    });
    const body = await reality(`tasks/${CODE}-T-1.1`);
    // The suggestion is listed, marked not confirmed; the deploy that contains it is not a fact
    // about the task.
    expect(body.commits.map((c) => c.confirmed)).toEqual([false]);
    expect(body.deployments).toEqual([]);

    // Confirmed, the same deploy appears.
    await db.commitTask.updateMany({ where: { taskId }, data: { confirmed: true, confirmedAt: new Date() } });
    const confirmed = await reality(`tasks/${CODE}-T-1.1`);
    expect(confirmed.deployments.map((d) => d.via)).toEqual(['image']);
  });

  it('answers for a requirement through every task that satisfies it', async () => {
    const one = await commit('a'.repeat(40), 60);
    const two = await commit('b'.repeat(40), 50);
    await attribute(one.id, taskId, { confirmed: true });
    await attribute(two.id, otherTaskId, { confirmed: true });

    const body = await reality(`requirements/${CODE}-REQ-001`);
    expect(body.humanId).toBe(`${CODE}-REQ-001`);
    expect(body.commits.map((c) => c.task).sort()).toEqual([`${CODE}-T-1.1`, `${CODE}-T-1.2`]);
  });

  it('carries the drift engine’s own line for the record, and is empty for a record with none', async () => {
    const body = await reality(`requirements/${CODE}-REQ-001`);
    expect(body.drift).toEqual([]);
    // A task citing no requirement is a coverage hole, in the engine's words.
    await db.taskRequirement.deleteMany({ where: { taskId } });
    const task = await reality(`tasks/${CODE}-T-1.1`);
    expect(task.drift.map((d) => d.category)).toEqual(['coverage-hole']);
  });

  it('is empty, not an error, for a task nothing has touched', async () => {
    const body = await reality(`tasks/${CODE}-T-1.1`);
    expect(body).toMatchObject({ commits: [], checks: [], deployments: [] });
  });

  it('404s an unknown task or requirement, and requires authentication', async () => {
    const missing = await fetch(`${origin}/api/tasks/${CODE}-T-9.9/reality`, { headers: { cookie } });
    expect(missing.status).toBe(404);
    const missingReq = await fetch(`${origin}/api/requirements/${CODE}-REQ-999/reality`, { headers: { cookie } });
    expect(missingReq.status).toBe(404);
    const anonymous = await fetch(`${origin}/api/tasks/${CODE}-T-1.1/reality`);
    expect(anonymous.status).toBe(401);
  });
});
