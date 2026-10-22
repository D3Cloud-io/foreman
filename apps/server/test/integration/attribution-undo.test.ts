import type { Server } from 'node:http';
import type { AuditEventEntry, AuditEventsResponse } from '@foreman/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * Undoing a confirm or a reject of an attribution (FRM-T-18.14, FRM-REQ-243).
 *
 * The decision is recorded on the commit with the `commit_task` row as its before and after, and
 * used to be refused outright ("commit changes cannot be undone"). It is now reversed by putting the
 * row back — and by the same rule as every other undo, refused when the row has moved on since.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'attribution-undo@example.com';
const PASSWORD = 'a-password-for-the-attribution-undo-tests';
const CODE = 'ATU';
const REPO = 'test/attribution-undo';
const SHA = 'a'.repeat(40);

describe.skipIf(url === undefined)('undo of an attribution decision', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;
  let taskId: string;
  let taskHumanId: string;
  let commitId: string;

  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}/api${path}`, { ...init, headers });
  };
  const post = (path: string, body?: unknown) =>
    api(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  const decide = async (verb: 'confirm' | 'reject', extra: Record<string, unknown> = {}) => {
    const res = await post(`/projects/${CODE}/attributions/${SHA}/${verb}`, { task: taskHumanId, ...extra });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { auditEventIds: string[] };
    expect(body.auditEventIds).toHaveLength(1);
    return body.auditEventIds[0] ?? '';
  };
  const row = () => db.commitTask.findUnique({ where: { commitId_taskId: { commitId, taskId } } });
  const history = async (): Promise<AuditEventEntry[]> => {
    const res = await api(`/audit-events?entity=${SHA.slice(0, 12)}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return [...((await res.json()) as AuditEventsResponse).items];
  };
  /** A proposal nobody has decided: the message cited the task, 0.9. */
  const propose = () =>
    db.commitTask.create({
      data: { commitId, taskId, source: 'message', confidence: 0.9, evidence: { citedAs: 'T-1.1' } },
    });

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
      data: { email: EMAIL, displayName: 'Attribution undo', status: 'active' },
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
    await db.auditEvent.deleteMany({ where: { entityHumanId: { startsWith: CODE } } });
    await db.auditEvent.deleteMany({ where: { entityHumanId: SHA.slice(0, 12) } });
    await post('/projects', { code: CODE, name: 'Attribution undo' });
    const created = await post(`/projects/${CODE}/tasks`, { title: 'To be decided' });
    const task = (await created.json()) as { id: string; humanId: string };
    taskId = task.id;
    taskHumanId = task.humanId;
    const project = await db.project.findFirstOrThrow({ where: { code: CODE } });
    const repo = await db.repo.create({ data: { projectId: project.id, fullName: REPO } });
    const commit = await db.commit.create({
      data: { repoId: repo.id, sha: SHA, message: 'Work (T-1.1)', author: 'tester', committedAt: new Date() },
    });
    commitId = commit.id;
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.auditEvent.deleteMany({ where: { entityHumanId: SHA.slice(0, 12) } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  it('puts a confirmed attribution back to a proposal, with its signal and confidence', async () => {
    await propose();
    const confirm = await decide('confirm');
    expect((await row())?.confirmed).toBe(true);

    // The history says so before anybody presses anything.
    const listed = (await history()).find((item) => item.id === confirm);
    expect(listed).toMatchObject({ undoable: true });

    const res = await post(`/undo/${confirm}`);
    expect(res.status, await res.clone().text()).toBe(200);

    const back = await row();
    expect(back).toMatchObject({
      confirmed: false,
      confirmedAt: null,
      confirmedBy: null,
      rejectedAt: null,
      source: 'message',
      evidence: { citedAs: 'T-1.1' },
    });
    expect(Number(back?.confidence)).toBeCloseTo(0.9);

    // The never-regress rule: back to a proposal, it counts for nothing again.
    const brief = (await (await api(`/brief/${CODE}`)).json()) as { unconfirmedAttributions: number };
    expect(brief.unconfirmedAttributions).toBe(1);

    // Recorded as its own event, and the original says which event reversed it.
    const stamped = await db.auditEvent.findUniqueOrThrow({ where: { id: confirm } });
    expect(stamped.undoneByEventId).not.toBeNull();
    const reversal = await db.auditEvent.findUniqueOrThrow({ where: { id: stamped.undoneByEventId ?? '' } });
    expect(reversal.action).toBe('undo');
  });

  it('puts a rejected proposal back, so it is offered again', async () => {
    await propose();
    const reject = await decide('reject');
    expect((await row())?.rejectedAt).not.toBeNull();

    expect((await history()).find((item) => item.id === reject)).toMatchObject({ undoable: true });
    expect((await post(`/undo/${reject}`)).status).toBe(200);

    expect(await row()).toMatchObject({ confirmed: false, rejectedAt: null, source: 'message' });
    const queue = (await (await api('/attributions?status=proposed&limit=200')).json()) as {
      items: { commit: { sha: string }; task: { humanId: string } }[];
    };
    expect(queue.items.some((i) => i.commit.sha === SHA && i.task.humanId === taskHumanId)).toBe(true);
  });

  it('undoes a reject of a confirmed attribution back to confirmed', async () => {
    await propose();
    await decide('confirm');
    const reject = await decide('reject');
    expect(await row()).toMatchObject({ confirmed: false });

    expect((await post(`/undo/${reject}`)).status).toBe(200);
    expect(await row()).toMatchObject({ confirmed: true, rejectedAt: null });
  });

  it('removes the row a declaration made when nobody had proposed it', async () => {
    const declared = await decide('confirm', { declared: true });
    expect(await row()).toMatchObject({ confirmed: true, source: 'declared' });

    expect((await post(`/undo/${declared}`)).status).toBe(200);
    expect(await row()).toBeNull();
  });

  it('refuses when the attribution has been decided again since, and says so in the history', async () => {
    await propose();
    const confirm = await decide('confirm');
    await decide('reject');

    const res = await post(`/undo/${confirm}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/cannot be undone.*changed since/);
    // The later decision stands.
    expect(await row()).toMatchObject({ confirmed: false });
    expect((await row())?.rejectedAt).not.toBeNull();

    const listed = (await history()).find((item) => item.id === confirm);
    expect(listed).toMatchObject({ undoable: false });
  });

  it('undoes last-first when both were decided, and never twice', async () => {
    await propose();
    const confirm = await decide('confirm');
    const reject = await decide('reject');

    expect((await post(`/undo/${reject}`)).status).toBe(200);
    expect((await post(`/undo/${confirm}`)).status).toBe(200);
    expect(await row()).toMatchObject({ confirmed: false, rejectedAt: null });

    expect((await post(`/undo/${confirm}`)).status).toBe(409);
  });

  it('refuses when the task has been deleted', async () => {
    await propose();
    const confirm = await decide('confirm');
    await api(`/projects/${CODE}/tasks/${taskHumanId}`, { method: 'DELETE' });

    const res = await post(`/undo/${confirm}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/task it attributed is deleted/);
  });

  it('lets exactly one of two concurrent undos through', async () => {
    await propose();
    const confirm = await decide('confirm');
    const [a, b] = await Promise.all([post(`/undo/${confirm}`), post(`/undo/${confirm}`)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await row()).toMatchObject({ confirmed: false });
  });
});
