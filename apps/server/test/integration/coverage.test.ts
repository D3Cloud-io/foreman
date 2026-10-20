import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * Coverage, the matrix and the exit gate (T-3.4, T-3.5, T-3.6).
 *
 * The Phase 3 exit demo, as a suite: try to complete a phase with an uncovered Must and Foreman
 * refuses **and names it**; add a task citing that requirement and it succeeds.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'coverage@example.com';
const PASSWORD = 'a-password-for-the-coverage-tests';
const CODE = 'COV';

describe.skipIf(url === undefined)('coverage and the exit gate', () => {
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
  const patch = (path: string, body: unknown) =>
    api(path, { method: 'PATCH', body: JSON.stringify(body) });
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
      data: { email: EMAIL, displayName: 'Coverage', status: 'active' },
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

  beforeEach(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await post('/projects', { code: CODE, name: 'Coverage Test' });
    await post(`/projects/${CODE}/phases`, {
      number: 1,
      name: 'The phase under test',
      exitDemo: 'Every webhook arrives signed, and an unsigned one is refused.',
    });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  const phaseId = async (): Promise<string> =>
    (await db.phase.findFirstOrThrow({ where: { humanId: `${CODE}-P-1` } })).id;

  describe('the exit demo (T-3.6, FRM-REQ-056)', () => {
    it('refuses to complete a phase with an uncovered Must, and names it', async () => {
      await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall verify the signature of every webhook.',
        priority: 'M',
        phaseId: await phaseId(),
      });

      const res = await patch(`/projects/${CODE}/phases/${CODE}-P-1`, { status: 'complete' });
      expect(res.status).toBe(409);

      const body = (await res.json()) as {
        error: string;
        gate: { passed: boolean; failures: { kind: string; humanId: string; detail: string }[] };
      };
      expect(body.gate.passed).toBe(false);

      // Naming it is the requirement. "The exit gate failed" sends somebody looking.
      const failure = body.gate.failures.find((f) => f.kind === 'uncovered-must');
      expect(failure?.humanId).toBe(`${CODE}-REQ-001`);
      expect(failure?.detail).toContain('no task satisfies it');
      expect(failure?.detail).toContain('signature');

      // And the phase did not move.
      const phase = await db.phase.findFirstOrThrow({ where: { humanId: `${CODE}-P-1` } });
      expect(phase.status).not.toBe('complete');
    });

    it('refuses to complete a phase whose exit demo is empty, naming the exit demo', async () => {
      // Blank is as empty as missing: whitespace states nothing about what finishing meant.
      await patch(`/projects/${CODE}/phases/${CODE}-P-1`, { exitDemo: '   ' });

      const res = await patch(`/projects/${CODE}/phases/${CODE}-P-1`, { status: 'complete' });
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: string;
        gate: { passed: boolean; failures: { kind: string; humanId: string; detail: string }[] };
      };
      expect(body.gate.failures).toEqual([
        expect.objectContaining({ kind: 'no-exit-demo', humanId: `${CODE}-P-1` }),
      ]);
      expect(body.gate.failures[0]?.detail).toContain('exit demo');

      const phase = await db.phase.findFirstOrThrow({ where: { humanId: `${CODE}-P-1` } });
      expect(phase.status).not.toBe('complete');
    });

    it('refuses over a Must with no acceptance test recorded, naming the requirement', async () => {
      const id = await phaseId();
      const created = await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall verify the signature of every webhook.',
        priority: 'M',
        phaseId: id,
      });
      const requirement = (await created.json()) as { id: string; humanId: string };
      // Covered and finished: the only thing missing is a way to check it.
      await post(`/projects/${CODE}/tasks`, {
        title: 'Verify the HMAC signature',
        phaseId: id,
        status: 'done',
        requirementIds: [requirement.id],
      });

      const res = await patch(`/projects/${CODE}/phases/${CODE}-P-1`, { status: 'complete' });
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        gate: { failures: { kind: string; humanId: string; detail: string }[] };
      };
      expect(body.gate.failures).toEqual([
        expect.objectContaining({ kind: 'no-acceptance-test', humanId: requirement.humanId }),
      ]);
      expect(body.gate.failures[0]?.detail).toContain('no acceptance test');

      // A Should without one is not a reason to hold the phase; recording the Must's lets it close.
      await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman should log the rejected signature.',
        priority: 'S',
        phaseId: id,
      });
      await patch(`/projects/${CODE}/requirements/${requirement.humanId}`, {
        acceptanceTest: 'An unsigned webhook is answered 401 and nothing is ingested.',
      });
      expect((await patch(`/projects/${CODE}/phases/${CODE}-P-1`, { status: 'complete' })).status).toBe(200);
    });

    it('completes once a task cites the requirement', async () => {
      const id = await phaseId();
      const created = await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall verify the signature of every webhook.',
        priority: 'M',
        phaseId: id,
        acceptanceTest: 'An unsigned webhook is answered 401.',
      });
      const requirement = (await created.json()) as { id: string };

      await post(`/projects/${CODE}/tasks`, {
        title: 'Verify the HMAC signature',
        phaseId: id,
        status: 'done',
        requirementIds: [requirement.id],
      });

      const res = await patch(`/projects/${CODE}/phases/${CODE}-P-1`, { status: 'complete' });
      expect(res.status).toBe(200);

      const phase = await db.phase.findFirstOrThrow({ where: { humanId: `${CODE}-P-1` } });
      expect(phase.status).toBe('complete');
      expect(phase.completedAt).not.toBeNull();
    });

    it('refuses over unfinished work, and says which task and why', async () => {
      const id = await phaseId();
      await post(`/projects/${CODE}/tasks`, {
        title: 'Still going',
        phaseId: id,
        status: 'blocked',
        blockedReason: 'Waiting on the GitHub App.',
      });

      const res = await patch(`/projects/${CODE}/phases/${CODE}-P-1`, { status: 'complete' });
      expect(res.status).toBe(409);

      const body = (await res.json()) as {
        gate: { failures: { kind: string; humanId: string; detail: string }[] };
      };
      const failure = body.gate.failures.find((f) => f.kind === 'unfinished-task');
      expect(failure?.humanId).toBe(`${CODE}-T-1.1`);
      // The reason travels with the refusal, so the next question is already answered.
      expect(failure?.detail).toContain('Waiting on the GitHub App');
    });

    it('refuses over an open critical found in the phase', async () => {
      const id = await phaseId();
      const project = await db.project.findFirstOrThrow({ where: { code: CODE } });
      await db.finding.create({
        data: {
          projectId: project.id,
          phaseId: id,
          humanId: `${CODE}-CR-001`,
          title: 'The webhook accepts an unsigned payload',
          severity: 'critical',
          status: 'open',
        },
      });

      const res = await patch(`/projects/${CODE}/phases/${CODE}-P-1`, { status: 'complete' });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { gate: { failures: { kind: string }[] } };
      expect(body.gate.failures.some((f) => f.kind === 'open-critical')).toBe(true);
    });

    it('does not block on a Should, only on a Must', async () => {
      const id = await phaseId();
      await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman should colour the badge nicely.',
        priority: 'S',
        phaseId: id,
      });

      // A Should with no task is worth seeing in coverage and is not a reason to hold a phase.
      expect((await patch(`/projects/${CODE}/phases/${CODE}-P-1`, { status: 'complete' })).status).toBe(200);
    });

    it('can be asked before it is triggered', async () => {
      await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall do the uncovered thing.',
        priority: 'M',
        phaseId: await phaseId(),
        acceptanceTest: 'The thing is done.',
      });

      // The console asks first, so a refusal is never the first anybody hears of it.
      const gate = await get<{ passed: boolean; failures: unknown[] }>(
        `/projects/${CODE}/phases/${CODE}-P-1/gate`,
      );
      expect(gate.passed).toBe(false);
      expect(gate.failures).toHaveLength(1);

      // Asking changed nothing.
      const phase = await db.phase.findFirstOrThrow({ where: { humanId: `${CODE}-P-1` } });
      expect(phase.status).toBe('planned');
    });
  });

  describe('coverage (T-3.4, FRM-REQ-053, FRM-REQ-054)', () => {
    it('counts Musts apart from everything else', async () => {
      const id = await phaseId();
      const must = await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall be covered.',
        priority: 'M',
        phaseId: id,
      });
      await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall be uncovered.',
        priority: 'M',
        phaseId: id,
      });
      await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman could be nice about it.',
        priority: 'C',
      });

      await post(`/projects/${CODE}/tasks`, {
        title: 'Covers the first',
        requirementIds: [((await must.json()) as { id: string }).id],
      });

      const coverage = await get<{
        requirements: { total: number; covered: number; musts: number; mustsCovered: number };
        uncoveredMusts: { humanId: string }[];
        uncovered: { humanId: string }[];
      }>(`/projects/${CODE}/coverage`);

      expect(coverage.requirements).toEqual({ total: 3, covered: 1, musts: 2, mustsCovered: 1 });
      expect(coverage.uncoveredMusts.map((r) => r.humanId)).toEqual([`${CODE}-REQ-002`]);
      // The Could is uncovered too — visible, but not blocking.
      expect(coverage.uncovered).toHaveLength(2);
    });

    it('does not count a coincidence as coverage (ADR-005)', async () => {
      const created = await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall not be covered by an accident.',
        priority: 'M',
        phaseId: await phaseId(),
      });
      const requirement = (await created.json()) as { id: string };

      // A task exists and a commit touched a file it declared — but the attribution is
      // unconfirmed, and an unconfirmed attribution is a proposal, not a fact.
      const project = await db.project.findFirstOrThrow({ where: { code: CODE } });
      const task = await db.task.create({
        data: { projectId: project.id, humanId: `${CODE}-T-999`, title: 'Touched a file' },
      });
      const repo = await db.repo.create({ data: { projectId: project.id, fullName: 'x/cov' } });
      const commit = await db.commit.create({
        data: {
          repoId: repo.id,
          sha: 'c'.repeat(40),
          message: 'Touched something',
          author: 'tester',
          committedAt: new Date(),
        },
      });
      await db.commitTask.create({
        data: { commitId: commit.id, taskId: task.id, source: 'file_overlap', confidence: 0.4 },
      });

      const coverage = await get<{ uncoveredMusts: { humanId: string }[] }>(
        `/projects/${CODE}/coverage`,
      );
      // The task does not cite the requirement, so the requirement is still uncovered — and no
      // amount of commit activity changes that.
      expect(coverage.uncoveredMusts).toHaveLength(1);
      expect(requirement.id).toBeDefined();
    });

    it('finds work with no stated reason', async () => {
      await post(`/projects/${CODE}/tasks`, { title: 'Why is this being done?' });

      const coverage = await get<{ tasksWithoutRequirements: { humanId: string }[] }>(
        `/projects/${CODE}/coverage`,
      );
      expect(coverage.tasksWithoutRequirements.map((t) => t.humanId)).toContain(`${CODE}-T-001`);
    });

    it('finds requirements nothing can be checked against', async () => {
      await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall have no acceptance test.',
        priority: 'M',
      });
      await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall have one.',
        priority: 'M',
        acceptanceTest: 'A test covers it.',
      });

      const coverage = await get<{ withoutAcceptanceTest: { humanId: string }[] }>(
        `/projects/${CODE}/coverage`,
      );
      expect(coverage.withoutAcceptanceTest.map((r) => r.humanId)).toEqual([`${CODE}-REQ-001`]);
    });

    it('surfaces the EARS warnings alongside the holes', async () => {
      await post(`/projects/${CODE}/requirements`, { statement: 'Per-user recovery codes' });

      const coverage = await get<{ earsWarnings: { humanId: string; note: string }[] }>(
        `/projects/${CODE}/coverage`,
      );
      expect(coverage.earsWarnings[0]?.humanId).toBe(`${CODE}-REQ-001`);
      expect(coverage.earsWarnings[0]?.note).toContain('names a feature');
    });

    it('still reports a failing requirement that carries no note', async () => {
      // The verdict is `earsLintOk`; the note only explains it. Requiring both meant the 210
      // imported requirements — every one on the column defaults, not ok and no note — showed an
      // attention badge apiece on the Requirements screen while this answered `earsWarnings: []`.
      const created = await post(`/projects/${CODE}/requirements`, {
        statement: 'Per-user recovery codes',
      });
      const { humanId } = (await created.json()) as { humanId: string };
      await db.requirement.update({ where: { humanId }, data: { earsLintNote: null } });

      const coverage = await get<{ earsWarnings: { humanId: string; note: string }[] }>(
        `/projects/${CODE}/coverage`,
      );
      const warning = coverage.earsWarnings.find((w) => w.humanId === humanId);
      expect(warning, 'a failed lint with no note is still a failed lint').toBeDefined();
      expect(warning?.note.length ?? 0).toBeGreaterThan(0);
    });
  });

  describe('the traceability matrix (T-3.5, FRM-REQ-055)', () => {
    it('is generated, with each requirement and what satisfies it', async () => {
      const id = await phaseId();
      const created = await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall appear in the matrix.',
        priority: 'M',
        phaseId: id,
        acceptanceTest: 'It appears.',
      });
      await post(`/projects/${CODE}/tasks`, {
        title: 'Puts it there',
        phaseId: id,
        requirementIds: [((await created.json()) as { id: string }).id],
      });

      const matrix = await get<{
        items: {
          humanId: string;
          priority: string;
          phase: { humanId: string } | null;
          satisfiedBy: { humanId: string; status: string }[];
        }[];
      }>(`/projects/${CODE}/matrix`);

      const row = matrix.items[0];
      expect(row?.humanId).toBe(`${CODE}-REQ-001`);
      expect(row?.phase?.humanId).toBe(`${CODE}-P-1`);
      expect(row?.satisfiedBy[0]?.humanId).toBe(`${CODE}-T-1.1`);
    });

    it('shows an empty row for an uncovered requirement rather than omitting it', async () => {
      await post(`/projects/${CODE}/requirements`, { statement: 'Foreman shall be listed anyway.' });

      const matrix = await get<{ items: { satisfiedBy: unknown[] }[] }>(`/projects/${CODE}/matrix`);
      // A matrix that hides its holes is the matrix that was kept by hand.
      expect(matrix.items).toHaveLength(1);
      expect(matrix.items[0]?.satisfiedBy).toEqual([]);
    });
  });
});
