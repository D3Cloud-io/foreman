import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProposedAttributionsResponse, TasksAcrossResponse } from '@foreman/shared';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * The reads and writes the triage surface on `/findings` runs on (FRM-T-18.7, FRM-REQ-246).
 *
 * - `GET /api/attributions?status=proposed&group=`: the Review tab — every attribution nobody has
 *   ruled on, across a scope, newest first, counted exactly as each project's brief counts it.
 * - `GET /api/tasks?status=blocked&group=`: the Blocked tab.
 * - The finding verdicts go through the existing `PATCH …/findings/:humanId`, and each one undoes.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'triage@example.com';
const PASSWORD = 'a-password-for-the-triage-tests';
const PREFIX = 'TRG ';
/** TRA in one group, TRB in another, TRU in none. */
const CODES = ['TRA', 'TRB', 'TRU'] as const;

interface Group {
  humanId: string;
  slug: string;
}

describe.skipIf(url === undefined)('triage across a scope', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;
  let alpha: Group;
  let beta: Group;
  /** The commit SHAs, by what they are. */
  const sha: Record<string, string> = {};
  /** Each project's open task and its blocked one, by code. */
  const work: Record<string, string> = {};
  const stuck: Record<string, string> = {};
  const id = (map: Record<string, string>, code: string) => map[code] ?? '';

  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}${path}`, { ...init, headers });
  };
  const json = async <T>(res: Response, status = 200): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });
  const patch = (path: string, body: unknown) => api(path, { method: 'PATCH', body: JSON.stringify(body) });
  const ours = (code: string) => (CODES as readonly string[]).includes(code);

  const proposals = async (query = '') => {
    const body = await json<ProposedAttributionsResponse>(await api(`/api/attributions?status=proposed&limit=200${query}`));
    return { ...body, items: body.items.filter((item) => ours(item.project.code)) };
  };
  const blocked = async (query = '') => {
    const body = await json<TasksAcrossResponse>(await api(`/api/tasks?limit=200${query}`));
    return { ...body, items: body.items.filter((item) => ours(item.project.code)) };
  };

  const cleanUp = async () => {
    await db.project.deleteMany({ where: { code: { in: [...CODES] } } });
    await db.projectGroup.deleteMany({ where: { name: { startsWith: PREFIX } } });
  };

  /** A commit in `code`'s repository, attributed to `task` as stated. */
  const attribute = async (
    code: string,
    key: string,
    task: string,
    state: 'proposed' | 'confirmed' | 'rejected',
    daysAgo: number,
  ) => {
    const project = await db.project.findFirstOrThrow({ where: { code } });
    const repo =
      (await db.repo.findFirst({ where: { projectId: project.id } })) ??
      (await db.repo.create({ data: { projectId: project.id, fullName: `example/triage-${code.toLowerCase()}` } }));
    const value = randomBytes(20).toString('hex');
    sha[key] = value;
    const commit = await db.commit.create({
      data: {
        repoId: repo.id,
        sha: value,
        message: `${task}: ${key}\n\nThe body of the message.`,
        author: 'triage',
        committedAt: new Date(Date.now() - daysAgo * 86_400_000),
        files: { create: [{ path: `src/${key}.ts`, status: 'modified' }] },
      },
    });
    const row = await db.task.findFirstOrThrow({ where: { humanId: task } });
    await db.commitTask.create({
      data: {
        commitId: commit.id,
        taskId: row.id,
        source: 'message',
        confidence: 0.9,
        confirmed: state === 'confirmed',
        ...(state === 'rejected' ? { rejectedAt: new Date() } : {}),
        evidence: { citedAs: task },
      },
    });
    await db.checkRun.create({
      data: { repoId: repo.id, commitSha: value, name: 'ci', conclusion: 'success', completedAt: new Date() },
    });
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
    const user = await db.user.create({ data: { email: EMAIL, displayName: 'Triage', status: 'active' } });
    await setPassword({ db, config }, user.id, PASSWORD);
    await cleanUp();

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

    alpha = await json<Group>(await post('/api/groups', { name: `${PREFIX}Alpha` }), 201);
    beta = await json<Group>(await post('/api/groups', { name: `${PREFIX}Beta` }), 201);
    const placement: Record<(typeof CODES)[number], string | null> = {
      TRA: alpha.humanId,
      TRB: beta.slug,
      TRU: null,
    };
    for (const code of CODES) {
      await json(await post('/api/projects', { code, name: `Triage ${code}`, group: placement[code] }), 201);
      work[code] = (await json<{ humanId: string }>(await post(`/api/projects/${code}/tasks`, { title: `Work in ${code}` }), 201)).humanId;
      stuck[code] = (await json<{ humanId: string }>(
        await post(`/api/projects/${code}/tasks`, {
          title: `Stuck in ${code}`,
          status: 'blocked',
          blockedReason: `Waiting on something outside ${code}`,
        }),
        201,
      )).humanId;
    }

    await attribute('TRA', 'alpha-old', id(work, 'TRA'), 'proposed', 3);
    await attribute('TRA', 'alpha-new', id(work, 'TRA'), 'proposed', 1);
    await attribute('TRA', 'alpha-settled', id(work, 'TRA'), 'confirmed', 0);
    await attribute('TRB', 'beta', id(work, 'TRB'), 'proposed', 2);
    await attribute('TRB', 'beta-turned-down', id(work, 'TRB'), 'rejected', 0);
    await attribute('TRU', 'loose', id(work, 'TRU'), 'proposed', 4);
  });

  afterAll(async () => {
    await cleanUp();
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  describe('GET /api/attributions — the Review tab', () => {
    it('lists only what nobody has ruled on, newest commit first, with what a reviewer checks', async () => {
      const { items } = await proposals();
      expect(items.map((item) => item.commit.sha)).toEqual([sha['alpha-new'], sha['beta'], sha['alpha-old'], sha['loose']]);

      const first = items[0];
      expect(first?.project).toEqual({ code: 'TRA', name: 'Triage TRA' });
      expect(first?.task).toMatchObject({ humanId: id(work, 'TRA'), title: 'Work in TRA', status: 'todo' });
      expect(first?.commit).toMatchObject({
        repo: 'example/triage-tra',
        files: ['src/alpha-new.ts'],
        orphaned: false,
        checks: [{ name: 'ci', conclusion: 'success' }],
      });
      expect(first?.commit.message.split('\n')[0]).toBe(`${id(work, 'TRA')}: alpha-new`);
      expect(first?.source).toBe('message');
      expect(first?.confidence).toBeCloseTo(0.9);
    });

    it('counts what each project brief counts, so the queue and the sidebar agree', async () => {
      const brief = async (code: string) =>
        (await json<{ unconfirmedAttributions: number }>(await api(`/api/brief/${code}`))).unconfirmedAttributions;
      for (const code of CODES) {
        const { total } = await proposals(`&project=${code}`);
        expect(total, code).toBe(await brief(code));
      }
      expect((await proposals('&project=TRA')).total).toBe(2);
    });

    it('narrows to a group by slug or GRP-n, or to the ungrouped', async () => {
      expect((await proposals(`&group=${alpha.slug.toUpperCase()}`)).items.map((i) => i.project.code)).toEqual(['TRA', 'TRA']);
      expect((await proposals(`&group=${beta.humanId}`)).items.map((i) => i.commit.sha)).toEqual([sha['beta']]);
      expect((await proposals('&group=ungrouped')).items.map((i) => i.project.code)).toEqual(['TRU']);
      // A project outside the scope matches nothing rather than widening it.
      expect((await proposals(`&group=${alpha.slug}&project=TRB`)).total).toBe(0);
    });

    it('answers an unknown scope with 404, never with everyone', async () => {
      expect((await api('/api/attributions?group=no-such-group')).status).toBe(404);
      expect((await api('/api/attributions?group=all')).status).toBe(404);
    });

    it('refuses a status it does not triage, and a caller who is not signed in', async () => {
      expect((await api('/api/attributions?status=confirmed')).status).toBe(400);
      expect((await fetch(`${origin}/api/attributions`)).status).toBe(401);
    });

    it('drops a proposal from the queue once it is confirmed or rejected', async () => {
      await json(await post(`/api/projects/TRU/attributions/${sha['loose'] ?? ''}/confirm`, { task: id(work, 'TRU') }));
      expect((await proposals('&group=ungrouped')).total).toBe(0);

      await json(await post(`/api/projects/TRB/attributions/${sha['beta'] ?? ''}/reject`, { task: id(work, 'TRB') }));
      expect((await proposals(`&group=${beta.slug}`)).items).toEqual([]);
    });
  });

  describe('GET /api/tasks — the Blocked tab', () => {
    it('lists blocked tasks across every project by default, each with its reason', async () => {
      const { items } = await blocked();
      expect(items.map((t) => t.humanId)).toEqual(CODES.map((code) => id(stuck, code)));
      expect(items[0]).toMatchObject({
        project: { code: 'TRA', name: 'Triage TRA' },
        title: 'Stuck in TRA',
        status: 'blocked',
        blockedReason: 'Waiting on something outside TRA',
        phase: null,
      });
    });

    it('narrows to a scope and a project, and to another status when one is named', async () => {
      const scoped = await blocked(`&status=blocked&group=${beta.slug}`);
      expect(scoped.items.map((t) => t.humanId)).toEqual([id(stuck, 'TRB')]);
      expect(scoped.total).toBe(1);
      expect((await blocked('&group=ungrouped&project=TRU')).items.map((t) => t.humanId)).toEqual([id(stuck, 'TRU')]);
      expect((await blocked(`&status=todo&group=${alpha.humanId}`)).items.map((t) => t.humanId)).toEqual([id(work, 'TRA')]);
      expect((await api('/api/tasks?group=no-such-group')).status).toBe(404);
      expect((await api('/api/tasks?status=stuck')).status).toBe(400);
    });

    it('lets a blocked task go once it is unblocked, and undo puts it back', async () => {
      const write = await json<{ auditEventIds: string[] }>(
        await patch(`/api/projects/TRA/tasks/${id(stuck, 'TRA')}`, { status: 'in_progress' }),
      );
      expect((await blocked(`&group=${alpha.slug}`)).items).toEqual([]);

      for (const event of [...write.auditEventIds].reverse()) await json(await post(`/api/undo/${event}`, {}));
      expect((await blocked(`&group=${alpha.slug}`)).items.map((t) => t.humanId)).toEqual([id(stuck, 'TRA')]);
    });
  });

  describe('the finding verdicts the Findings tab sends', () => {
    it('acknowledges, marks won\'t fix with its reason, reopens, and undoes', async () => {
      const created = await json<{ humanId: string }>(
        await post('/api/projects/TRA/findings', { title: 'A verdict to rule on', severity: 'high' }),
        201,
      );
      const finding = created.humanId;
      const read = async () =>
        json<{ status: string; verified: string; recommendationMd: string | null; wontFixReason: string | null }>(
          await api(`/api/findings/${finding}`),
        );

      const acknowledged = await json<{ auditEventIds: string[] }>(
        await patch(`/api/projects/TRA/findings/${finding}`, { verified: 'confirmed' }),
      );
      expect((await read()).verified).toBe('confirmed');

      // Won't fix keeps its reason in its own field; the recommendation is not touched (FRM-T-18.15).
      await json(
        await patch(`/api/projects/TRA/findings/${finding}`, {
          status: 'wont_fix',
          wontFixReason: 'the code is being deleted.',
        }),
      );
      expect(await read()).toMatchObject({ status: 'wont_fix', wontFixReason: 'the code is being deleted.', recommendationMd: null });

      const reopened = await json<{ auditEventIds: string[] }>(await patch(`/api/projects/TRA/findings/${finding}`, { status: 'open' }));
      await json(await post(`/api/undo/${reopened.auditEventIds[0] ?? ''}`, {}));
      expect((await read()).status).toBe('wont_fix');

      // An older verdict whose record has moved on since is refused, and says so.
      const refused = await post(`/api/undo/${acknowledged.auditEventIds[0] ?? ''}`, {});
      expect(refused.status).toBe(409);
    });
  });
});
