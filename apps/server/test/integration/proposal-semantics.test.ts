import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * **Never-regress test #1** (T-5.8, FRM-REQ-108, ADR-005).
 *
 * *An unconfirmed `commit_task` row is a proposal. No coverage calculation, status transition,
 * brief or drift report may read it as truth. A file-path coincidence must never be able to mark
 * work complete.*
 *
 * The shape of this test is deliberate: it sets up the **maximum** amount of unconfirmed evidence
 * — a commit attributed to a task by every signal, with files overlapping, cited by message — and
 * then asserts that every read path still reports the work as unfinished. If attribution is ever
 * wired into a status transition or a coverage count "as a convenience", this fails.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'proposal@example.com';
const PASSWORD = 'a-password-for-the-proposal-tests';
const CODE = 'PRP';

describe.skipIf(url === undefined)('an unconfirmed attribution is never truth', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;

  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}/api${path}`, { ...init, headers });
  };
  const post = (path: string, body?: unknown) =>
    api(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const get = async <T>(path: string): Promise<T> => {
    const res = await api(path);
    expect(res.status, path).toBe(200);
    return (await res.json()) as T;
  };

  beforeAll(async () => {
    const config: Config = loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'http://localhost:3200',
      DATABASE_URL: url ?? '',
      KEK: Buffer.alloc(32, 1).toString('base64'),
      PEPPER: Buffer.alloc(32, 2).toString('base64'),
      COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
    });
    db = createDb(url ?? '');

    await db.user.deleteMany({ where: { email: EMAIL } });
    const user = await db.user.create({
      data: { email: EMAIL, displayName: 'Proposal', status: 'active' },
    });
    await setPassword({ db, config }, user.id, PASSWORD);

    server = await new Promise<Server>((resolve) => {
      const s = createApp({ config, db }).listen(0, () => { resolve(s); });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    origin = `http://127.0.0.1:${String(address.port)}`;

    const signIn = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  /**
   * A project where everything points at the task being done, and nothing is confirmed.
   *
   * Two Musts, one covered by a task with a commit attributed to it by every signal. If a
   * proposal ever counted, this project would look finished.
   */
  let taskHumanId: string;
  let phaseHumanId: string;

  beforeEach(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await post('/projects', { code: CODE, name: 'Proposal Test' });
    await post(`/projects/${CODE}/phases`, {
      number: 1,
      name: 'The phase',
      exitDemo: 'The finished work is shown satisfying the requirement.',
    });

    const project = await db.project.findFirstOrThrow({ where: { code: CODE } });
    const phase = await db.phase.findFirstOrThrow({ where: { humanId: `${CODE}-P-1` } });
    phaseHumanId = phase.humanId;

    const requirement = await post(`/projects/${CODE}/requirements`, {
      statement: 'Foreman shall be satisfied by finished work.',
      priority: 'M',
      phaseId: phase.id,
      acceptanceTest: 'The work is done and confirmed.',
    });
    const { id: requirementId } = (await requirement.json()) as { id: string };

    const created = await post(`/projects/${CODE}/tasks`, {
      title: 'The work',
      phaseId: phase.id,
      requirementIds: [requirementId],
      files: ['apps/server/src/app.ts'],
    });
    const task = (await created.json()) as { id: string; humanId: string };
    taskHumanId = task.humanId;

    // Every signal, all pointing the same way, none of it confirmed.
    const repo = await db.repo.create({
      data: { projectId: project.id, fullName: `matdemers1/${CODE.toLowerCase()}` },
    });
    const commit = await db.commit.create({
      data: {
        repoId: repo.id,
        sha: 'f'.repeat(40),
        message: `Finish the work (${taskHumanId})`,
        author: 'Matthew',
        committedAt: new Date(),
        files: { create: [{ path: 'apps/server/src/app.ts', status: 'modified' }] },
      },
    });
    await db.commitTask.create({
      data: {
        commitId: commit.id,
        taskId: task.id,
        source: 'message',
        confidence: 0.9,
        // The line the whole test turns on.
        confirmed: false,
      },
    });
  });

  it('leaves the task in the state a person put it in', async () => {
    const task = await db.task.findFirstOrThrow({ where: { humanId: taskHumanId } });
    // A commit is not a status transition. Nothing about ingest may advance work.
    expect(task.status).toBe('todo');
    expect(task.completedAt).toBeNull();
  });

  it('does not count the requirement as satisfied by a proposal', async () => {
    const coverage = await get<{
      requirements: { mustsCovered: number; musts: number };
      uncoveredMusts: { humanId: string }[];
    }>(`/projects/${CODE}/coverage`);

    // The requirement *is* covered — by a task citing it, which is a person's statement. The
    // proposal adds nothing either way, and that is the point.
    expect(coverage.requirements.musts).toBe(1);
    expect(coverage.requirements.mustsCovered).toBe(1);
  });

  it('refuses to complete the phase, because the work is not done', async () => {
    const res = await api(`/projects/${CODE}/phases/${phaseHumanId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'complete' }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { gate: { failures: { kind: string; humanId: string }[] } };
    // An attributed commit does not close a gate. Only somebody saying the task is done does.
    expect(body.gate.failures.some((f) => f.kind === 'unfinished-task' && f.humanId === taskHumanId)).toBe(true);
  });

  it('shows the task as outstanding in the brief', async () => {
    const brief = await get<{
      nextTasks: { humanId: string }[];
      unconfirmedAttributions: number;
    }>(`/brief/${CODE}`);

    expect(brief.nextTasks.map((t) => t.humanId)).toContain(taskHumanId);
    // And the proposal is surfaced — visible, and counted as work to review rather than as work
    // that happened.
    expect(brief.unconfirmedAttributions).toBe(1);
  });

  it('counts it as drift on the portfolio, never as progress', async () => {
    const portfolio = await get<{
      items: { code: string; tasks: { done: number; open: number }; unconfirmedAttributions: number }[];
    }>('/portfolio');

    const row = portfolio.items.find((p) => p.code === CODE);
    expect(row?.tasks.done).toBe(0);
    expect(row?.tasks.open).toBe(1);
    expect(row?.unconfirmedAttributions).toBe(1);
  });

  it('changes every one of those answers the moment it is confirmed and the task is marked done', async () => {
    // The control: the same rows, confirmed, plus the one act that actually means "finished".
    await post(`/projects/${CODE}/attributions/${'f'.repeat(40)}/confirm`, { task: taskHumanId });
    await api(`/projects/${CODE}/tasks/${taskHumanId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'done' }),
    });

    const brief = await get<{ unconfirmedAttributions: number }>(`/brief/${CODE}`);
    expect(brief.unconfirmedAttributions).toBe(0);

    const res = await api(`/projects/${CODE}/phases/${phaseHumanId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'complete' }),
    });
    expect(res.status).toBe(200);
  });
});
