import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { Brief } from '../../src/domain/brief.js';
import type { CiState } from '../../src/domain/reality.js';

/**
 * A build result from Shipyard becomes its commit's CI state (FRM-T-008, FRM-REQ-182).
 *
 * Done when: a posted build reads back in the brief and on the activity screen; a replay of the
 * same build ID changes nothing; a token without write scope is refused. The body posted here is
 * Shipyard's `foreman_build` outbox row exactly as `outbox/builds.ts` writes it.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'builds@example.com';
const PASSWORD = 'a-password-for-the-build-result-tests';
const CODE = 'BLD';
const MULTI = 'BLDM';
const BARE = 'BLDN';
const TOKEN_PREFIX = 'builds-test:';
const REPO = 'example/bld-app';
const SHA = 'a1b2c3d4'.repeat(5);
const OTHER_SHA = 'f0e1d2c3'.repeat(5);

interface BuildResponse {
  buildId: string;
  outcome: 'created' | 'updated' | 'unchanged';
  replayed: boolean;
  repo: string;
  commitKnown: boolean;
  applied: boolean;
  checkRun: {
    id: string;
    name: string;
    commitSha: string;
    conclusion: string | null;
    completedAt: string | null;
    detailsUrl: string | null;
  };
}

/** Shipyard's `foreman_build` outbox payload, as `enqueueForemanBuild` writes it. */
const shipyardRow = (overrides: Record<string, unknown> = {}) => ({
  kind: 'foreman_build',
  buildId: '0199f1a2-0000-7000-8000-000000000001',
  app: 'bld-app',
  sha: SHA,
  project: CODE,
  environment: 'production',
  state: 'succeeded',
  ...overrides,
});

describe.skipIf(url === undefined)('build results from Shipyard', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;
  let writeToken: string;
  let readToken: string;
  let repoId: string;

  const asToken = (token: string, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}/api${path}`, { ...init, headers });
  };
  const post = (body: unknown, code = CODE, token = writeToken) =>
    asToken(token, `/projects/${code}/builds`, { method: 'POST', body: JSON.stringify(body) });
  const get = async <T>(path: string): Promise<T> => {
    const res = await asToken(readToken, path);
    expect(res.status, path).toBe(200);
    return (await res.json()) as T;
  };
  const issue = async (name: string, scopes: string[]): Promise<string> => {
    const res = await fetch(`${origin}/api/tokens`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name, scopes }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { token: string }).token;
  };
  const checkRuns = () => db.checkRun.findMany({ where: { repo: { project: { code: { in: [CODE, MULTI] } } } } });
  /** Every audit event a build post writes: the check run's, and the build record's own. */
  const ourAudits = {
    OR: [
      { entityType: 'check_run' as const, entityHumanId: { startsWith: 'shipyard/build/' } },
      { entityType: 'build' as const },
    ],
  };
  const buildAudits = () => db.auditEvent.count({ where: ourAudits });
  const builds = () => db.buildResult.findMany({ orderBy: { createdAt: 'asc' } });
  const at = (iso: string) => ({ completedAt: iso });

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
    await db.apiToken.deleteMany({ where: { name: { startsWith: TOKEN_PREFIX } } });
    const user = await db.user.create({ data: { email: EMAIL, displayName: 'Builds', status: 'active' } });
    await setPassword({ db, config }, user.id, PASSWORD);

    server = await new Promise<Server>((resolve) => {
      const s = createApp({ config, db }).listen(0, () => {
        resolve(s);
      });
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

    writeToken = await issue(`${TOKEN_PREFIX}shipyard`, ['read', 'write']);
    readToken = await issue(`${TOKEN_PREFIX}reader`, ['read']);
  });

  beforeEach(async () => {
    await db.auditEvent.deleteMany({ where: ourAudits });
    await db.project.deleteMany({ where: { code: { in: [CODE, MULTI, BARE] } } });
    const project = await db.project.create({
      data: { code: CODE, name: 'Build Result Test', slug: 'build-result-test', lifecycle: 'building' },
    });
    const repo = await db.repo.create({ data: { projectId: project.id, fullName: REPO } });
    repoId = repo.id;
  });

  afterAll(async () => {
    await db.auditEvent.deleteMany({ where: ourAudits });
    await db.project.deleteMany({ where: { code: { in: [CODE, MULTI, BARE] } } });
    await db.apiToken.deleteMany({ where: { name: { startsWith: TOKEN_PREFIX } } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await db.$disconnect();
  });

  it("records Shipyard's outbox row as the commit's CI state, read back by the brief and the activity screen", async () => {
    // Nothing yet: grey, not green.
    expect((await get<Brief>(`/brief/${CODE}`)).ci.unknown).toBe(true);

    const res = await post(shipyardRow({ url: 'https://shipyard.example/builds/1' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as BuildResponse;
    expect(body).toMatchObject({
      outcome: 'created',
      replayed: false,
      repo: REPO,
      checkRun: {
        name: 'shipyard/build/bld-app',
        commitSha: SHA,
        conclusion: 'success',
        detailsUrl: 'https://shipyard.example/builds/1',
      },
    });

    const brief = await get<Brief>(`/brief/${CODE}`);
    expect(brief.ci).toMatchObject({ conclusion: 'success', commitSha: SHA, unknown: false });
    expect(brief.ci.at).toBe(body.checkRun.completedAt);

    // The activity screen's read.
    const ci = await get<CiState>(`/projects/${CODE}/ci`);
    expect(ci).toMatchObject({
      conclusion: 'success',
      commitSha: SHA,
      name: 'shipyard/build/bld-app',
      unknown: false,
    });

    // The build is recorded once, with what has no column on a check run.
    const build = await db.buildResult.findFirstOrThrow({ where: { buildId: shipyardRow().buildId } });
    expect(build).toMatchObject({
      buildId: shipyardRow().buildId,
      app: 'bld-app',
      state: 'succeeded',
      conclusion: 'success',
      environment: 'production',
      applied: true,
      checkRunId: body.checkRun.id,
    });

    // Audited, both: the check run it wrote and the build record. The token's name is the actor —
    // the trail says Shipyard did this, not a person.
    const checkEvent = await db.auditEvent.findFirstOrThrow({
      where: { entityType: 'check_run', entityId: body.checkRun.id },
    });
    expect(checkEvent).toMatchObject({ action: 'create', actor: `${TOKEN_PREFIX}shipyard`, actorKind: 'mcp' });
    const buildEvent = await db.auditEvent.findFirstOrThrow({ where: { entityType: 'build', entityId: build.id } });
    expect(buildEvent).toMatchObject({ action: 'create', entityHumanId: shipyardRow().buildId });
    expect(buildEvent.after).toMatchObject({ state: 'succeeded', environment: 'production' });
  });

  it('changes nothing when the same build ID is posted again, even with a different result', async () => {
    const first = await post(shipyardRow());
    expect(first.status).toBe(201);
    const runsBefore = await checkRuns();
    const auditsBefore = await buildAudits();

    for (const replay of [shipyardRow(), shipyardRow({ state: 'failed', failedStage: 'test' })]) {
      const res = await post(replay);
      expect(res.status).toBe(200);
      const body = (await res.json()) as BuildResponse;
      expect(body.outcome).toBe('unchanged');
      expect(body.replayed).toBe(true);
      expect(body.checkRun.conclusion).toBe('success');
    }

    expect(await checkRuns()).toEqual(runsBefore);
    expect(await buildAudits()).toBe(auditsBefore);
    expect(await builds()).toHaveLength(1);
    expect((await get<Brief>(`/brief/${CODE}`)).ci.conclusion).toBe('success');
  });

  it('changes nothing when a build a later one has superseded is replayed', async () => {
    const A = shipyardRow({ buildId: 'build-A', state: 'succeeded', ...at('2026-10-19T10:00:00Z') });
    const B = shipyardRow({ buildId: 'build-B', state: 'failed', failedStage: 'test', ...at('2026-10-19T11:00:00Z') });
    expect((await post(A)).status).toBe(201);
    expect((await post(B)).status).toBe(201);
    expect((await get<Brief>(`/brief/${CODE}`)).ci.conclusion).toBe('failure');

    const runsBefore = await checkRuns();
    const auditsBefore = await buildAudits();
    const buildsBefore = await builds();

    const replay = await post(A);
    expect(replay.status).toBe(200);
    const body = (await replay.json()) as BuildResponse;
    expect(body).toMatchObject({ outcome: 'unchanged', replayed: true, checkRun: { conclusion: 'failure' } });

    // Still B's conclusion, and not one row or audit event more.
    expect(await checkRuns()).toEqual(runsBefore);
    expect(await builds()).toEqual(buildsBefore);
    expect(await buildAudits()).toBe(auditsBefore);
    expect((await get<Brief>(`/brief/${CODE}`)).ci.conclusion).toBe('failure');
    expect((await get<CiState>(`/projects/${CODE}/ci`)).conclusion).toBe('failure');
  });

  it('never lets a result that finished earlier replace one that finished later, whatever order they arrive in', async () => {
    const newer = shipyardRow({ buildId: 'build-newer', state: 'succeeded', ...at('2026-10-19T12:00:00Z') });
    const older = shipyardRow({ buildId: 'build-older', state: 'failed', ...at('2026-10-19T09:00:00Z') });
    expect((await post(newer)).status).toBe(201);
    const runsBefore = await checkRuns();
    const runId = runsBefore[0]?.id ?? 'none';
    const checkEventsBefore = await db.auditEvent.count({ where: { entityType: 'check_run', entityId: runId } });

    const late = await post(older);
    expect(late.status).toBe(201);
    const body = (await late.json()) as BuildResponse;
    expect(body).toMatchObject({ outcome: 'superseded', applied: false, checkRun: { conclusion: 'success' } });

    // The check run is untouched; the older build is still recorded, as not applied.
    expect(await checkRuns()).toEqual(runsBefore);
    expect(await db.auditEvent.count({ where: { entityType: 'check_run', entityId: runId } })).toBe(
      checkEventsBefore,
    );
    expect((await builds()).map((b) => [b.buildId, b.applied])).toEqual([
      ['build-newer', true],
      ['build-older', false],
    ]);
    expect((await get<Brief>(`/brief/${CODE}`)).ci).toMatchObject({
      conclusion: 'success',
      at: '2026-10-19T12:00:00.000Z',
    });

    // And replaying the superseded one is a replay like any other.
    const replay = await post(older);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as BuildResponse).applied).toBe(false);
    expect(await builds()).toHaveLength(2);
  });

  it('refuses a build ID already recorded for another project', async () => {
    expect((await post(shipyardRow())).status).toBe(201);
    const project = await db.project.create({
      data: { code: BARE, name: 'Elsewhere', slug: 'build-elsewhere', lifecycle: 'building' },
    });
    await db.repo.create({ data: { projectId: project.id, fullName: 'example/bld-elsewhere' } });
    const res = await post(shipyardRow({ project: BARE }), BARE);
    expect(res.status).toBe(409);
    expect(await builds()).toHaveLength(1);
  });

  it('records a replay once even when the posts race', async () => {
    const results = await Promise.all([post(shipyardRow()), post(shipyardRow()), post(shipyardRow())]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(await checkRuns()).toHaveLength(1);
    expect(await builds()).toHaveLength(1);
    // The check run's event and the build's: written once, not three times.
    expect(await buildAudits()).toBe(2);
  });

  it('replaces the conclusion when a new build of the same commit and app reports', async () => {
    expect((await post(shipyardRow())).status).toBe(201);

    const rebuild = await post(
      shipyardRow({ buildId: '0199f1a2-0000-7000-8000-000000000002', state: 'failed', failedStage: 'test' }),
    );
    expect(rebuild.status).toBe(201);
    const body = (await rebuild.json()) as BuildResponse;
    expect(body).toMatchObject({ outcome: 'updated', applied: true });
    expect(body.checkRun.conclusion).toBe('failure');

    expect(await checkRuns()).toHaveLength(1);
    expect((await get<Brief>(`/brief/${CODE}`)).ci).toMatchObject({ conclusion: 'failure', unknown: false });
    expect((await get<CiState>(`/projects/${CODE}/ci`)).conclusion).toBe('failure');

    const update = await db.auditEvent.findFirstOrThrow({
      where: { entityType: 'check_run', entityId: body.checkRun.id, action: 'update' },
    });
    expect(update.before).toMatchObject({ conclusion: 'success' });
    expect(update.after).toMatchObject({ conclusion: 'failure', externalId: '0199f1a2-0000-7000-8000-000000000002' });
    expect((await builds()).map((b) => [b.state, b.failedStage, b.applied])).toEqual([
      ['succeeded', null, true],
      ['failed', 'test', true],
    ]);
  });

  it('maps every terminal state, a refusal as action required rather than a failure', async () => {
    const states = { succeeded: 'success', failed: 'failure', cancelled: 'cancelled', refused: 'action_required' };
    let n = 10;
    for (const [state, conclusion] of Object.entries(states)) {
      n += 1;
      const res = await post(shipyardRow({ buildId: `build-${String(n)}`, app: `app-${state}`, state }));
      expect(res.status).toBe(201);
      expect(((await res.json()) as BuildResponse).checkRun.conclusion).toBe(conclusion);
    }
  });

  it('refuses a token without write scope, and an absent one, writing nothing', async () => {
    const readOnly = await post(shipyardRow(), CODE, readToken);
    expect(readOnly.status).toBe(403);

    const anonymous = await fetch(`${origin}/api/projects/${CODE}/builds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(shipyardRow()),
    });
    expect(anonymous.status).toBe(401);

    expect(await checkRuns()).toHaveLength(0);
    expect((await get<Brief>(`/brief/${CODE}`)).ci.unknown).toBe(true);
  });

  it('answers 400 for a malformed body, naming the fields', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [shipyardRow({ sha: 'abc123' }), 'sha'],
      [shipyardRow({ state: 'passed' }), 'state'],
      [shipyardRow({ kind: 'deployment' }), 'kind'],
      [shipyardRow({ buildId: '' }), 'buildId'],
      [shipyardRow({ app: 'has spaces' }), 'app'],
      [shipyardRow({ completedAt: 'yesterday' }), 'completedAt'],
      [shipyardRow({ conclusion: 'success' }), 'conclusion'],
    ];
    for (const [body, field] of cases) {
      const res = await post(body);
      expect(res.status, field).toBe(400);
      const problem = (await res.json()) as { fields: { path: string }[] };
      expect(problem.fields.map((f) => f.path), field).toContain(field);
    }
    // Left out altogether: JSON drops an undefined key.
    expect((await post(shipyardRow({ buildId: undefined }))).status).toBe(400);

    expect(await checkRuns()).toHaveLength(0);
  });

  it('answers 404 for a project that does not exist', async () => {
    const res = await post(shipyardRow({ project: 'NOPE' }), 'NOPE');
    expect(res.status).toBe(404);
  });

  it('refuses a body that names another project than the URL', async () => {
    const res = await post(shipyardRow({ project: 'SHP' }));
    expect(res.status).toBe(422);
    expect(await checkRuns()).toHaveLength(0);
  });

  it('accepts a commit not yet ingested, keyed by SHA, and says so; it is the same row once the commit lands', async () => {
    const res = await post(shipyardRow({ sha: OTHER_SHA }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as BuildResponse;
    expect(body.commitKnown).toBe(false);
    // No stub commit is invented: the history holds only what GitHub sent.
    expect(await db.commit.count({ where: { repoId } })).toBe(0);
    expect((await get<Brief>(`/brief/${CODE}`)).ci.commitSha).toBe(OTHER_SHA);

    await db.commit.create({
      data: { repoId, sha: OTHER_SHA, message: 'later', author: 'someone', committedAt: new Date() },
    });
    const later = await post(shipyardRow({ sha: OTHER_SHA, buildId: 'second-build', state: 'failed' }));
    expect(later.status).toBe(201);
    const laterBody = (await later.json()) as BuildResponse;
    expect(laterBody.commitKnown).toBe(true);
    expect(laterBody.checkRun.id).toBe(body.checkRun.id);
  });

  it('finds the repository among several by the commit, or by name, and refuses to guess', async () => {
    const project = await db.project.create({
      data: { code: MULTI, name: 'Two Repos', slug: 'build-two-repos', lifecycle: 'building' },
    });
    await db.repo.create({ data: { projectId: project.id, fullName: 'example/bld-one' } });
    const two = await db.repo.create({ data: { projectId: project.id, fullName: 'example/bld-two' } });

    // An unknown commit and no repository named: refused, naming the choices.
    const ambiguous = await post(shipyardRow({ project: MULTI }), MULTI);
    expect(ambiguous.status).toBe(422);
    expect(((await ambiguous.json()) as { error: string }).error).toContain('name the one that was built');

    // Named: recorded there.
    const named = await post(shipyardRow({ project: MULTI, repo: 'example/bld-two' }), MULTI);
    expect(named.status).toBe(201);
    expect(((await named.json()) as BuildResponse).repo).toBe('example/bld-two');

    // A repository that is not this project's: refused.
    const foreign = await post(shipyardRow({ project: MULTI, buildId: 'x', repo: REPO }), MULTI);
    expect(foreign.status).toBe(422);

    // Ingested: the repository holding the commit is the one.
    await db.commit.create({
      data: { repoId: two.id, sha: OTHER_SHA, message: 'm', author: 'a', committedAt: new Date() },
    });
    const byCommit = await post(shipyardRow({ project: MULTI, buildId: 'y', sha: OTHER_SHA }), MULTI);
    expect(byCommit.status).toBe(201);
    expect(((await byCommit.json()) as BuildResponse)).toMatchObject({ repo: 'example/bld-two', commitKnown: true });
  });

  it('refuses a project with no linked repository', async () => {
    await db.project.create({
      data: { code: BARE, name: 'No Repos', slug: 'build-no-repos', lifecycle: 'building' },
    });
    const res = await post(shipyardRow({ project: BARE }), BARE);
    expect(res.status).toBe(422);
  });
});
