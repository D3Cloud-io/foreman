import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { Brief } from '../../src/domain/brief.js';

/**
 * Screens in the exit gate, the drift engine and coverage (FRM-T-12.4; FRM-REQ-200, FRM-REQ-201).
 *
 * A screen whose latest capture nobody has judged, or judged drifted-fix, keeps its phase from
 * closing and is named when it does; a drifted-fix screen and a screen built but never captured
 * show up as drift in the drift view, the portfolio badge and the brief — which must still agree.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'screens-gate@example.com';
const PASSWORD = 'a-password-for-the-screen-gate-tests';
const CODE = 'SGATE';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (label: string) => Buffer.concat([PNG_SIGNATURE, Buffer.from(`screens-gate ${label}`)]);

const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

interface GateBody {
  passed: boolean;
  failures: { kind: string; humanId: string; detail: string }[];
}
interface DriftBody {
  total: number;
  counts: Record<string, number>;
  items: { category: string; humanId: string; detail: string }[];
}

describe.skipIf(url === undefined)('screens in the gate and drift', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let blobDir: string;
  let writeToken: string;
  let readToken: string;
  let phaseId: string;
  /** Every image this file uploads, so the blob rows can go with it. */
  const uploaded = new Set<string>();
  let imageCount = 0;

  const call = (path: string, init: RequestInit & { token?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${init.token ?? writeToken}`);
    if (typeof init.body === 'string') headers.set('content-type', 'application/json');
    return fetch(`${origin}/api${path}`, { ...init, headers });
  };
  const post = (path: string, body: unknown) =>
    call(path, { method: 'POST', body: JSON.stringify(body) });
  const get = async <T>(path: string): Promise<T> => {
    const res = await call(path, { token: readToken });
    expect(res.status, path).toBe(200);
    return (await res.json()) as T;
  };

  const gate = (n = 1) => get<GateBody>(`/projects/${CODE}/phases/${CODE}-P-${String(n)}/gate`);
  const drift = () => get<DriftBody>(`/projects/${CODE}/drift`);
  const screenDrift = async () => (await drift()).items.filter((i) => i.category === 'screen-drift');

  async function newScreen(name: string): Promise<string> {
    const res = await post(`/projects/${CODE}/screens`, { name });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { humanId: string }).humanId;
  }

  /** A capture of a screen, from a PNG nobody else uploaded. Returns the version's ID. */
  async function capture(screen: string): Promise<string> {
    imageCount += 1;
    const bytes = png(`capture ${String(imageCount)}`);
    uploaded.add(sha(bytes));
    const form = new FormData();
    form.append('file', new File([bytes], 'screen.png', { type: 'image/png' }));
    const upload = await call('/blobs', { method: 'POST', body: form });
    expect([200, 201]).toContain(upload.status);
    const { sha256 } = (await upload.json()) as { sha256: string };

    const res = await post(`/projects/${CODE}/screens/${screen}/captures`, {
      blobSha256: sha256,
      viewport: 'desktop',
      theme: 'dark',
      commitSha: COMMIT,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function judge(screen: string, versionId: string, verdict: string, note?: string) {
    const res = await post(`/projects/${CODE}/screens/${screen}/captures/${versionId}/verdict`, {
      verdict,
      ...(note === undefined ? {} : { note }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
  }

  async function relate(screen: string, to: string, direction: 'screen-first' | 'screen-last' = 'screen-first') {
    const [from, target] = direction === 'screen-first' ? [screen, to] : [to, screen];
    const res = await post('/links', { from, to: target, kind: 'relates' });
    expect(res.status, await res.clone().text()).toBe(200);
  }

  /** A task in the phase; done by default so it does not itself fail the gate. */
  async function newTask(status: 'done' | 'todo' = 'done'): Promise<string> {
    const res = await post(`/projects/${CODE}/tasks`, { title: 'Build the screen', phaseId, status });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { humanId: string }).humanId;
  }

  beforeAll(async () => {
    blobDir = await mkdtemp(join(tmpdir(), 'foreman-screens-gate-'));
    const config: Config = loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'http://localhost:3200',
      DATABASE_URL: url ?? '',
      KEK: Buffer.alloc(32, 1).toString('base64'),
      PEPPER: Buffer.alloc(32, 2).toString('base64'),
      COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
      FOREMAN_BLOB_DIR: blobDir,
    });
    db = createDb(url ?? '');
    await db.project.deleteMany({ where: { code: CODE } });

    await db.user.deleteMany({ where: { email: EMAIL } });
    const user = await db.user.create({
      data: { email: EMAIL, displayName: 'Screens gate', status: 'active' },
    });
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
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const mint = async (name: string, scopes: string[]) => {
      const res = await fetch(`${origin}/api/tokens`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name, scopes }),
      });
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { token: string }).token;
    };
    readToken = await mint('screens-gate read', ['read']);
    writeToken = await mint('screens-gate write', ['read', 'write']);
  });

  beforeEach(async () => {
    // A project per test, so one test's screens are never another's drift.
    await db.project.deleteMany({ where: { code: CODE } });
    expect((await post('/projects', { code: CODE, name: 'Screens Gate Test' })).status).toBe(201);
    expect((await post(`/projects/${CODE}/phases`, { number: 1, name: 'Build the screens' })).status)
      .toBe(201);
    phaseId = (await db.phase.findFirstOrThrow({ where: { humanId: `${CODE}-P-1` } })).id;
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.blob.deleteMany({ where: { sha256: { in: [...uploaded] } } });
    await db.auditEvent.deleteMany({
      where: { actor: { in: ['screens-gate write', 'screens-gate read', EMAIL] } },
    });
    await db.apiToken.deleteMany({ where: { name: { startsWith: 'screens-gate ' } } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
    await rm(blobDir, { recursive: true, force: true });
  });

  it('fails the gate naming a screen whose latest capture is unreviewed, until it is judged (FRM-REQ-200)', async () => {
    const task = await newTask();
    const screen = await newScreen('Project overview');
    await relate(screen, task);
    const version = await capture(screen);

    const before = await gate();
    expect(before.passed).toBe(false);
    const failure = before.failures.find((f) => f.humanId === screen);
    expect(failure?.kind).toBe('screen-unreviewed');
    expect(failure?.detail).toContain('Project overview');
    expect(failure?.detail).toContain('has not been reviewed');

    await judge(screen, version, 'matches');
    const after = await gate();
    expect(after.failures.map((f) => f.humanId)).not.toContain(screen);
    expect(after.passed).toBe(true);
  });

  it('judges only the newest capture: a fresh one starts unreviewed again', async () => {
    const task = await newTask();
    const screen = await newScreen('Task board');
    await relate(screen, task);
    await judge(screen, await capture(screen), 'matches');
    expect((await gate()).passed).toBe(true);

    await capture(screen);
    expect((await gate()).failures.map((f) => f.humanId)).toEqual([screen]);
  });

  it('accepts a drift a reviewer chose to live with, and refuses one marked for a fix', async () => {
    const task = await newTask();
    const accepted = await newScreen('Accepted drift');
    const fix = await newScreen('Needs a fix');
    await relate(accepted, task);
    await relate(fix, task);
    await judge(accepted, await capture(accepted), 'drifted_accepted', 'Tighter spacing; fine.');
    await judge(fix, await capture(fix), 'drifted_fix', 'The header lost its border.');

    const result = await gate();
    expect(result.failures.map((f) => f.humanId)).toEqual([fix]);
    expect(result.failures[0]).toMatchObject({ kind: 'screen-drifted' });
    expect(result.failures[0]?.detail).toContain('drifted-fix');
    expect((await screenDrift()).map((i) => i.humanId)).toEqual([fix]);
  });

  it('shows a drifted-fix verdict in the drift view, the portfolio badge and the brief, and they agree', async () => {
    const task = await newTask();
    const screen = await newScreen('Drift view');
    await relate(screen, task);
    await judge(screen, await capture(screen), 'drifted_fix', 'The empty state is missing.');

    const view = await drift();
    const item = view.items.find((i) => i.category === 'screen-drift');
    expect(item?.humanId).toBe(screen);
    expect(item?.detail).toContain('fix is pending');
    expect(view.counts['screen-drift']).toBe(1);

    const brief = await get<Brief>(`/brief/${CODE}`);
    const { items } = await get<{ items: { code: string; drift: Brief['drift'] }[] }>('/portfolio');
    const badge = items.find((row) => row.code === CODE)?.drift;

    expect(brief.drift.counts['screen-drift']).toBe(1);
    expect(badge?.counts['screen-drift']).toBe(1);
    // The agreement the brief test also holds: the parts sum to the total, on all three surfaces.
    const sum = Object.values(brief.drift.counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(brief.drift.total);
    expect(brief.drift).toEqual({ counts: view.counts, total: view.total });
    expect(badge).toEqual(brief.drift);
  });

  it('reports a done task\'s screen with no capture as drift, until it is captured (FRM-REQ-201)', async () => {
    const task = await newTask('done');
    const screen = await newScreen('Built, never captured');
    await relate(screen, task);

    const [item, ...rest] = await screenDrift();
    expect(rest).toEqual([]);
    expect(item?.humanId).toBe(screen);
    expect(item?.detail).toContain('never captured');
    // And it is not a gate failure: there is no capture to have gone unreviewed.
    expect((await gate()).failures.map((f) => f.humanId)).not.toContain(screen);

    await capture(screen);
    expect(await screenDrift()).toEqual([]);
  });

  it('does not call a screen drift when its task is not done', async () => {
    const task = await newTask('todo');
    const screen = await newScreen('Not built yet');
    await relate(screen, task);
    expect(await screenDrift()).toEqual([]);
  });

  it('counts a screen linked only through a requirement assigned to the phase', async () => {
    const created = await post(`/projects/${CODE}/requirements`, {
      statement: 'The console shall show the overview.',
      phaseId,
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const requirement = ((await created.json()) as { humanId: string }).humanId;
    const screen = await newScreen('Via a requirement');
    await relate(screen, requirement);
    await capture(screen);

    const result = await gate();
    expect(result.failures.find((f) => f.humanId === screen)?.kind).toBe('screen-unreviewed');
  });

  it('reads a link written task to screen the same as screen to task', async () => {
    // `foreman_link FRM-T-5 relates FRM-SCR-001` stores the task as the source of the row.
    const done = await newTask('done');
    const unreviewed = await newScreen('Linked from the task');
    const neverCaptured = await newScreen('Task-side, never captured');
    await relate(unreviewed, done, 'screen-last');
    await relate(neverCaptured, done, 'screen-last');
    await capture(unreviewed);

    expect((await gate()).failures.find((f) => f.humanId === unreviewed)?.kind).toBe('screen-unreviewed');
    expect((await screenDrift()).map((i) => i.humanId)).toEqual([neverCaptured]);
  });

  it('reads a requirement-to-screen link into the requirement\'s phase', async () => {
    const created = await post(`/projects/${CODE}/requirements`, {
      statement: 'The console shall show the board.',
      phaseId,
    });
    const requirement = ((await created.json()) as { humanId: string }).humanId;
    const screen = await newScreen('Linked from the requirement');
    await relate(screen, requirement, 'screen-last');
    await capture(screen);

    expect((await gate()).failures.find((f) => f.humanId === screen)?.kind).toBe('screen-unreviewed');
  });

  it('ignores a screen linked to nothing in the phase', async () => {
    const screen = await newScreen('Unlinked');
    await capture(screen);
    expect((await gate()).failures.map((f) => f.humanId)).not.toContain(screen);
  });

  it('ignores a deleted screen', async () => {
    const task = await newTask();
    const unreviewed = await newScreen('Deleted, unreviewed');
    const neverCaptured = await newScreen('Deleted, never captured');
    await relate(unreviewed, task);
    await relate(neverCaptured, task);
    await capture(unreviewed);

    expect((await gate()).failures.map((f) => f.humanId)).toEqual([unreviewed]);
    expect((await screenDrift()).map((i) => i.humanId)).toEqual([neverCaptured]);

    for (const screen of [unreviewed, neverCaptured]) {
      const res = await call(`/projects/${CODE}/screens/${screen}`, { method: 'DELETE' });
      expect(res.status).toBe(204);
    }
    expect((await gate()).passed).toBe(true);
    expect(await screenDrift()).toEqual([]);
  });
});
