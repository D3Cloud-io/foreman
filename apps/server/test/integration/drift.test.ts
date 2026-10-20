import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * Drift, and the three surfaces that read it (T-7.1, T-7.2).
 *
 * The assertion that matters most is the last one: the badge, the brief and the view all report
 * the same number. Two of Foreman's own numbers disagreeing is the fastest way for it to stop
 * being believed.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'drift@example.com';
const PASSWORD = 'a-password-for-the-drift-tests';
const CODE = 'DRF';

describe.skipIf(url === undefined)('drift', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;
  let projectId: string;

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

  interface DriftBody {
    total: number;
    counts: Record<string, number>;
    items: { category: string; humanId: string; detail: string }[];
  }

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
      data: { email: EMAIL, displayName: 'Drift', status: 'active' },
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
    await post('/projects', { code: CODE, name: 'Drift Test' });
    projectId = (await db.project.findFirstOrThrow({ where: { code: CODE } })).id;
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  const long = (days: number) => new Date(Date.now() - days * 86_400_000);

  it('reports a clean project as having no drift', async () => {
    const drift = await get<DriftBody>(`/projects/${CODE}/drift`);
    // The empty state is a success state, and has to be reachable or the screen never means
    // anything.
    expect(drift.total).toBe(0);
    expect(drift.items).toEqual([]);
  });

  describe('the five categories', () => {
    it('finds a Must with no task', async () => {
      await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall be covered by something.',
        priority: 'M',
      });

      const drift = await get<DriftBody>(`/projects/${CODE}/drift`);
      expect(drift.counts['coverage-hole']).toBe(1);
      expect(drift.items[0]?.humanId).toBe(`${CODE}-REQ-001`);
    });

    it('finds work with no stated reason', async () => {
      await post(`/projects/${CODE}/tasks`, { title: 'Why is this being done?' });

      const drift = await get<DriftBody>(`/projects/${CODE}/drift`);
      const hole = drift.items.find((i) => i.category === 'coverage-hole');
      expect(hole?.detail).toContain('no stated reason');
    });

    it('reports an in-progress task nothing has touched as stale (FRM-REQ-129)', async () => {
      const created = await post(`/projects/${CODE}/tasks`, {
        title: 'Started in April',
        files: ['apps/server/src/thing.ts'],
      });
      const task = (await created.json()) as { id: string; humanId: string };
      await db.task.update({
        where: { id: task.id },
        data: { status: 'in_progress', startedAt: long(40) },
      });

      const drift = await get<DriftBody>(`/projects/${CODE}/drift`);
      const stale = drift.items.find((i) => i.category === 'stale-task');
      expect(stale?.humanId).toBe(task.humanId);
      // The file it declared is named, so the next question is already answered.
      expect(stale?.detail).toContain('apps/server/src/thing.ts');
    });

    it('does not call a task stale while commits are touching its files', async () => {
      const created = await post(`/projects/${CODE}/tasks`, {
        title: 'Being worked on',
        files: ['apps/server/src/active.ts'],
      });
      const task = (await created.json()) as { id: string };
      await db.task.update({
        where: { id: task.id },
        data: { status: 'in_progress', startedAt: long(40) },
      });

      const repo = await db.repo.create({
        data: { projectId, fullName: 'matdemers1/drift-test' },
      });
      await db.commit.create({
        data: {
          repoId: repo.id,
          sha: 'a'.repeat(40),
          message: 'Still going',
          author: 'matt',
          committedAt: new Date(),
          files: { create: [{ path: 'apps/server/src/active.ts', status: 'modified' }] },
        },
      });

      const drift = await get<DriftBody>(`/projects/${CODE}/drift`);
      expect(drift.items.filter((i) => i.category === 'stale-task')).toHaveLength(0);
    });

    it('does not call a freshly started task stale', async () => {
      const created = await post(`/projects/${CODE}/tasks`, { title: 'Picked up on Friday' });
      const task = (await created.json()) as { id: string };
      await db.task.update({
        where: { id: task.id },
        data: { status: 'in_progress', startedAt: long(2) },
      });

      // A threshold short enough to fire on a normal week is one that gets ignored.
      const drift = await get<DriftBody>(`/projects/${CODE}/drift`);
      expect(drift.items.filter((i) => i.category === 'stale-task')).toHaveLength(0);
    });

    it('finds a fired tripwire, and says what the condition was', async () => {
      const created = await post(`/projects/${CODE}/risks`, {
        title: 'The importer drops a file',
        tripwire: 'Any source file appears in no reconciliation row.',
      });
      const { humanId } = (await created.json()) as { humanId: string };
      await api(`/projects/${CODE}/risks/${humanId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'fired' }),
      });

      const drift = await get<DriftBody>(`/projects/${CODE}/drift`);
      const fired = drift.items.find((i) => i.category === 'fired-tripwire');
      expect(fired?.humanId).toBe(humanId);
      expect(fired?.detail).toContain('no reconciliation row');
    });

    it('finds a completed phase with no exit demo', async () => {
      await post(`/projects/${CODE}/phases`, { number: 1, name: 'Finished somehow' });
      await db.phase.updateMany({
        where: { humanId: `${CODE}-P-1` },
        data: { status: 'complete' },
      });

      const drift = await get<DriftBody>(`/projects/${CODE}/drift`);
      const gate = drift.items.find((i) => i.category === 'failed-exit-gate');
      expect(gate?.detail).toContain('nothing states what finishing meant');
    });

    it('finds a completed phase that would not pass its gate today', async () => {
      await post(`/projects/${CODE}/phases`, {
        number: 2,
        name: 'Completed, then reopened',
        exitDemo: 'It worked at the time.',
      });
      const phase = await db.phase.findFirstOrThrow({ where: { humanId: `${CODE}-P-2` } });
      await db.phase.update({ where: { id: phase.id }, data: { status: 'complete' } });

      // A Must added to a phase that was already finished: the gate refused nothing, because
      // nothing asked it again.
      await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall have been finished properly.',
        priority: 'M',
        phaseId: phase.id,
      });

      const drift = await get<DriftBody>(`/projects/${CODE}/drift`);
      const gate = drift.items.find(
        (i) => i.category === 'failed-exit-gate' && i.detail.includes('would not pass'),
      );
      expect(gate?.humanId).toBe(`${CODE}-P-2`);
    });

    it('finds an accepted ADR nothing cites', async () => {
      const created = await post(`/projects/${CODE}/adrs`, {
        title: 'A decision nobody refers to',
        status: 'accepted',
      });
      const { humanId } = (await created.json()) as { humanId: string };

      const drift = await get<DriftBody>(`/projects/${CODE}/drift`);
      const orphan = drift.items.find((i) => i.category === 'orphan-adr');
      expect(orphan?.humanId).toBe(humanId);
    });

    it('finds a supersedes chain that loops (FRM-REQ-060)', async () => {
      const a = await post(`/projects/${CODE}/adrs`, { title: 'A' });
      const b = await post(`/projects/${CODE}/adrs`, { title: 'B' });
      const first = (await a.json()) as { humanId: string };
      const second = (await b.json()) as { humanId: string };

      await post('/links', { from: first.humanId, to: second.humanId, kind: 'extends' });
      await post('/links', { from: second.humanId, to: first.humanId, kind: 'extends' });

      const drift = await get<DriftBody>(`/projects/${CODE}/drift`);
      const cycle = drift.items.find((i) => i.detail.includes('circle'));
      expect(cycle?.detail).toContain(first.humanId);
    });
  });

  describe('one engine, three surfaces (FRM-REQ-127, FRM-REQ-128)', () => {
    it('reports the same number in the view, the brief and the portfolio', async () => {
      // Enough drift that a disagreement would be visible.
      await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall be uncovered.',
        priority: 'M',
      });
      await post(`/projects/${CODE}/tasks`, { title: 'A task citing nothing' });
      const risk = await post(`/projects/${CODE}/risks`, {
        title: 'Something might go wrong',
        tripwire: 'It went wrong.',
      });
      await api(`/projects/${CODE}/risks/${((await risk.json()) as { humanId: string }).humanId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'fired' }),
      });

      const view = await get<DriftBody>(`/projects/${CODE}/drift`);
      const brief = await get<{ drift: { total: number } }>(`/brief/${CODE}`);
      const portfolio = await get<{ items: { code: string; drift: { total: number } }[] }>(
        '/portfolio',
      );
      const badge = portfolio.items.find((p) => p.code === CODE)?.drift.total;

      expect(view.total).toBeGreaterThan(2);
      // The badge links to the view. If they can disagree, the badge is a lie with a hyperlink.
      expect(brief.drift.total).toBe(view.total);
      expect(badge).toBe(view.total);
    });
  });
});
