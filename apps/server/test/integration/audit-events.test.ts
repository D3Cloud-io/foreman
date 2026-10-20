import type { Server } from 'node:http';
import type { AuditEventEntry, AuditEventsResponse } from '@foreman/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * Undo, the server half (FRM-T-18.3 — FRM-REQ-243).
 *
 * Two promises, through the API because that is where the console meets them:
 *
 *   1. every mutation the console makes answers with the audit events it wrote — the record's own
 *      first, anything that moved because of it after — so the toast can offer Undo; a DELETE keeps
 *      its 204 and says them in a header;
 *   2. `GET /api/audit-events?entity=` lists one record's history, newest first, and says for each
 *      event whether `POST /api/undo/:id` would work right now, and why not when it would not.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'audit-events@example.com';
const PASSWORD = 'a-password-for-the-audit-events-tests';
const CODE = 'AEV';

describe.skipIf(url === undefined)('audit event ids and history', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;
  /** Records outside the project, which `beforeEach` cannot reach through the project code. */
  const strays = { guidelines: [] as string[], projectIdeas: [] as string[], tokens: [] as string[] };

  const api = (path: string, init: RequestInit & { bearer?: string } = {}) => {
    const { bearer, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (bearer === undefined) headers.set('cookie', cookie);
    else headers.set('authorization', `Bearer ${bearer}`);
    if (rest.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}/api${path}`, { ...rest, headers });
  };
  const send = async <T = Record<string, unknown>>(
    method: 'POST' | 'PATCH' | 'PUT',
    path: string,
    body: unknown,
    status = method === 'POST' ? 201 : 200,
  ) => {
    const res = await api(path, { method, body: JSON.stringify(body) });
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T & { auditEventIds: string[] };
  };
  const remove = async (path: string) => {
    const res = await api(path, { method: 'DELETE' });
    expect(res.status, await res.clone().text()).toBe(204);
    return res;
  };
  const history = async (entity: string, limit?: number): Promise<AuditEventEntry[]> => {
    const query = new URLSearchParams({ entity, ...(limit === undefined ? {} : { limit: String(limit) }) });
    const res = await api(`/audit-events?${query.toString()}`);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as AuditEventsResponse;
    expect(body.entity).toBe(entity);
    return [...body.items];
  };
  const eventOf = (id: string) => db.auditEvent.findUniqueOrThrow({ where: { id } });
  /** The IDs a DELETE says in its headers, in order. */
  const idsOf = (res: Response) => (res.headers.get('audit-event-ids') ?? '').split(',').filter((s) => s !== '');

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
      data: { email: EMAIL, displayName: 'Audit events', status: 'active' },
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
    cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  const clean = async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.auditEvent.deleteMany({
      where: { OR: [{ entityHumanId: { startsWith: CODE } }, { actor: { contains: CODE } }] },
    });
    // Stray records: hard-deleted, and their events with them, so a rerun starts empty.
    await db.guideline.deleteMany({ where: { humanId: { in: strays.guidelines } } });
    await db.projectIdea.deleteMany({ where: { humanId: { in: strays.projectIdeas } } });
    await db.apiToken.deleteMany({ where: { prefix: { in: strays.tokens } } });
    await db.auditEvent.deleteMany({
      where: { entityHumanId: { in: [...strays.guidelines, ...strays.projectIdeas, ...strays.tokens] } },
    });
  };

  beforeEach(async () => {
    await clean();
    await send('POST', '/projects', { code: CODE, name: 'Audit events test' });
  });

  afterAll(async () => {
    await clean();
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    await db.$disconnect();
  });

  describe('tasks, and what rolls up from them', () => {
    let phaseId: string;

    beforeEach(async () => {
      const phase = await send<{ id: string }>('POST', `/projects/${CODE}/phases`, {
        number: 1,
        name: 'The only phase',
        exitDemo: 'It is done.',
      });
      phaseId = phase.id;
      await send('POST', `/projects/${CODE}/tasks`, { title: 'First', phaseId });
    });

    it('answers a status change with the task event first and the rollups after, in order', async () => {
      const res = await send<{ rolledUp: { humanId: string; kind: string }[] }>(
        'PATCH',
        `/projects/${CODE}/tasks/${CODE}-T-1.1`,
        { status: 'in_progress' },
      );

      // The task, then the phase it started, then the project that began building.
      expect(res.rolledUp.map((moved) => moved.kind)).toEqual(['phase', 'project']);
      expect(res.auditEventIds).toHaveLength(3);
      const events = await Promise.all(res.auditEventIds.map(eventOf));
      expect(events.map((event) => event.entityType)).toEqual(['task', 'phase', 'project']);
      expect(events[0]?.actorKind).toBe('user');
      expect(events.slice(1).every((event) => event.actorKind === 'system')).toBe(true);
    });

    it('is additive: the task is still the response, with its rolledUp beside the new field', async () => {
      const res = await send<{ humanId: string; title: string; rolledUp: unknown[] }>(
        'PATCH',
        `/projects/${CODE}/tasks/${CODE}-T-1.1`,
        { title: 'Reworded' },
      );
      expect(res.humanId).toBe(`${CODE}-T-1.1`);
      expect(res.title).toBe('Reworded');
      expect(res.rolledUp).toEqual([]);
      expect(res.auditEventIds).toHaveLength(1);
    });

    it('names the event of a create', async () => {
      const made = await send('POST', `/projects/${CODE}/tasks`, { title: 'Second', phaseId });
      expect(made.auditEventIds).toHaveLength(1);
      expect((await eventOf(made.auditEventIds[0] ?? '')).entityHumanId).toBe(`${CODE}-T-1.2`);
    });

    it('lists the history newest first, each event with actor, summary and a verdict', async () => {
      const first = await send('PATCH', `/projects/${CODE}/tasks/${CODE}-T-1.1`, { title: 'Second title' });
      const second = await send('PATCH', `/projects/${CODE}/tasks/${CODE}-T-1.1`, { title: 'Third title' });

      const items = await history(`${CODE}-T-1.1`);
      expect(items.map((item) => item.id).slice(0, 2)).toEqual([
        second.auditEventIds[0],
        first.auditEventIds[0],
      ]);
      // Newest first throughout.
      const times = items.map((item) => Date.parse(item.at));
      expect(times).toEqual([...times].sort((a, b) => b - a));

      const [latest, earlier, created] = items;
      expect(latest).toMatchObject({ action: 'update', undoable: true, actor: { kind: 'user' } });
      expect(latest?.actor.label).toBeTruthy();
      expect(latest?.reason).toBeUndefined();
      expect(latest?.summary).toMatch(/title/);
      // A later edit to the same field means this one cannot be undone without losing it.
      expect(earlier).toMatchObject({ action: 'update', undoable: false });
      expect(earlier?.reason).toMatch(/title .*changed since/);
      expect(created).toMatchObject({ action: 'create', undoable: true });
      expect(created?.summary).toMatch(/^Created task /);
    });

    it('agrees with the undo itself: what it calls undoable, undo does, and the reverse', async () => {
      const first = await send('PATCH', `/projects/${CODE}/tasks/${CODE}-T-1.1`, { title: 'Second title' });
      await send('PATCH', `/projects/${CODE}/tasks/${CODE}-T-1.1`, { title: 'Third title' });
      const items = await history(`${CODE}-T-1.1`);

      const refused = await api(`/undo/${first.auditEventIds[0] ?? ''}`, { method: 'POST' });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toBe(
        items.find((item) => item.id === first.auditEventIds[0])?.reason,
      );

      // And the dry run left nothing behind: the newest is still undoable, the task unchanged.
      const again = await history(`${CODE}-T-1.1`);
      expect(again[0]?.undoable).toBe(true);
      expect((await db.task.findFirstOrThrow({ where: { humanId: `${CODE}-T-1.1` } })).title).toBe('Third title');

      const undone = await api(`/undo/${again[0]?.id ?? ''}`, { method: 'POST' });
      expect(undone.status).toBe(200);
      expect((await db.task.findFirstOrThrow({ where: { humanId: `${CODE}-T-1.1` } })).title).toBe('Second title');
    });

    it('marks an undone event, and the reversal, in the history', async () => {
      const changed = await send('PATCH', `/projects/${CODE}/tasks/${CODE}-T-1.1`, { title: 'Changed' });
      const reversed = await api(`/undo/${changed.auditEventIds[0] ?? ''}`, { method: 'POST' });
      expect(reversed.status).toBe(200);
      // The undo answers with the events it wrote, too.
      expect(((await reversed.json()) as { auditEventIds: string[] }).auditEventIds).toHaveLength(1);

      const [newest, original] = await history(`${CODE}-T-1.1`);
      expect(newest).toMatchObject({ action: 'undo', undoable: false });
      expect(newest?.reason).toMatch(/reversal/);
      expect(original).toMatchObject({ id: changed.auditEventIds[0], undoable: false });
      expect(original?.reason).toMatch(/already been undone/);
    });

    it('says a DELETE in headers, keeping its 204, with the rollup events after the task', async () => {
      await send('PATCH', `/projects/${CODE}/tasks/${CODE}-T-1.1`, { status: 'in_progress' });

      const res = await remove(`/projects/${CODE}/tasks/${CODE}-T-1.1`);
      const ids = idsOf(res);
      expect(ids.length).toBeGreaterThanOrEqual(1);
      expect(res.headers.get('audit-event-id')).toBe(ids[0]);
      const first = await eventOf(ids[0] ?? '');
      expect(first).toMatchObject({ action: 'delete', entityHumanId: `${CODE}-T-1.1` });
      for (const id of ids.slice(1)) expect((await eventOf(id)).actorKind).toBe('system');

      // The first id is the one the console undoes, and the history says it can.
      const [newest] = await history(`${CODE}-T-1.1`);
      expect(newest).toMatchObject({ id: ids[0], action: 'delete', undoable: true });
      expect(newest?.summary).toMatch(/^Deleted task /);
      expect((await api(`/undo/${ids[0] ?? ''}`, { method: 'POST' })).status).toBe(200);
    });

    it('answers a phase status change, and a phase create, with their events', async () => {
      const made = await send('POST', `/projects/${CODE}/phases`, { number: 2, name: 'Second' });
      expect(made.auditEventIds).toHaveLength(1);
      const moved = await send('PATCH', `/projects/${CODE}/phases/${CODE}-P-2`, { status: 'active' });
      expect((await eventOf(moved.auditEventIds[0] ?? '')).entityHumanId).toBe(`${CODE}-P-2`);
    });
  });

  describe('requirements', () => {
    it('carries ids on create, update and delete, and lists them newest first', async () => {
      const made = await send('POST', `/projects/${CODE}/requirements`, {
        statement: 'Foreman shall make every console change reversible.',
      });
      expect(made.auditEventIds).toHaveLength(1);
      const changed = await send('PATCH', `/projects/${CODE}/requirements/${CODE}-REQ-001`, {
        priority: 'must',
      });
      expect(changed.auditEventIds).toHaveLength(1);
      const deleted = idsOf(await remove(`/projects/${CODE}/requirements/${CODE}-REQ-001`));
      expect(deleted).toHaveLength(1);

      const items = await history(`${CODE}-REQ-001`);
      expect(items.map((item) => item.action)).toEqual(['delete', 'update', 'create']);
      expect(items.map((item) => item.id)).toEqual([deleted[0], changed.auditEventIds[0], made.auditEventIds[0]]);
      // The delete is undoable even though the record is gone: a deleted record has a history.
      expect(items[0]).toMatchObject({ undoable: true });
      expect(items[0]?.summary).toMatch(/^Deleted requirement /);
    });

    it('limits the list', async () => {
      await send('POST', `/projects/${CODE}/requirements`, { statement: 'Foreman shall keep a history.' });
      await send('PATCH', `/projects/${CODE}/requirements/${CODE}-REQ-001`, { priority: 'must' });
      await send('PATCH', `/projects/${CODE}/requirements/${CODE}-REQ-001`, { priority: 'should' });
      expect(await history(`${CODE}-REQ-001`, 2)).toHaveLength(2);
      expect((await api(`/audit-events?entity=${CODE}-REQ-001&limit=0`)).status).toBe(400);
    });
  });

  describe('findings and audits', () => {
    it('carries ids on finding and audit create and update', async () => {
      const audit = await send<{ humanId: string }>('POST', `/projects/${CODE}/audits`, { kind: 'code_review' });
      expect(audit.auditEventIds).toHaveLength(1);
      const finding = await send<{ humanId: string }>('POST', `/projects/${CODE}/findings`, {
        title: 'The thing is wrong',
        severity: 'high',
      });
      expect(finding.auditEventIds).toHaveLength(1);
      const updated = await send('PATCH', `/projects/${CODE}/findings/${finding.humanId}`, { status: 'deferred' });
      expect(updated.auditEventIds).toHaveLength(1);
      const audited = await send('PATCH', `/projects/${CODE}/audits/${audit.humanId}`, { verdict: 'fine' });
      expect(audited.auditEventIds).toHaveLength(1);

      const items = await history(finding.humanId);
      expect(items.map((item) => item.id)).toEqual([updated.auditEventIds[0], finding.auditEventIds[0]]);
      expect(items[0]).toMatchObject({ action: 'update', undoable: true });
      expect(items[0]?.summary).toMatch(/status/);
      expect((await history(audit.humanId))[0]?.id).toBe(audited.auditEventIds[0]);
    });
  });

  describe('ideas', () => {
    it('carries ids on create, update and delete', async () => {
      const idea = await send<{ humanId: string }>('POST', `/projects/${CODE}/ideas`, { title: 'Try a thing' });
      expect(idea.auditEventIds).toHaveLength(1);
      const updated = await send('PATCH', `/projects/${CODE}/ideas/${idea.humanId}`, { title: 'Try another' });
      expect(updated.auditEventIds).toHaveLength(1);
      const deleted = idsOf(await remove(`/projects/${CODE}/ideas/${idea.humanId}`));
      expect(deleted).toHaveLength(1);

      const items = await history(idea.humanId);
      expect(items.map((item) => item.action)).toEqual(['delete', 'update', 'create']);
      expect(items[0]?.undoable).toBe(true);
    });
  });

  describe('project ideas, which belong to no project', () => {
    it('carries ids, and finds the history by its codeless PI- id', async () => {
      const idea = await send<{ humanId: string }>('POST', '/project-ideas', { title: 'A whole new project' });
      strays.projectIdeas.push(idea.humanId);
      expect(idea.humanId).toMatch(/^PI-\d+$/);
      expect(idea.auditEventIds).toHaveLength(1);

      const updated = await send('PATCH', `/project-ideas/${idea.humanId}`, { pitch: 'It does a thing.' });
      expect(updated.auditEventIds).toHaveLength(1);
      const deleted = idsOf(await remove(`/project-ideas/${idea.humanId}`));
      expect(deleted).toHaveLength(1);

      const items = await history(idea.humanId);
      expect(items.map((item) => item.id)).toEqual([deleted[0], updated.auditEventIds[0], idea.auditEventIds[0]]);
      expect(items[0]).toMatchObject({ action: 'delete', undoable: true });
    });
  });

  describe('guidelines, which apply to every project', () => {
    it('carries ids, and finds the history by its codeless GL- id', async () => {
      const guideline = await send<{ humanId: string }>('POST', '/guidelines', {
        title: 'Every change can be undone',
        area: 'Process',
        decision: 'A console mutation offers Undo.',
      });
      strays.guidelines.push(guideline.humanId);
      expect(guideline.humanId).toMatch(/^GL-\d+$/);
      expect(guideline.auditEventIds).toHaveLength(1);

      const updated = await send('PATCH', `/guidelines/${guideline.humanId}`, { area: 'Design' });
      expect(updated.auditEventIds).toHaveLength(1);
      const deleted = idsOf(await remove(`/guidelines/${guideline.humanId}`));
      expect(deleted).toHaveLength(1);

      const items = await history(guideline.humanId);
      expect(items.map((item) => item.id)).toEqual([deleted[0], updated.auditEventIds[0], guideline.auditEventIds[0]]);
      expect(items[0]?.undoable).toBe(true);
    });
  });

  describe('documents, which have no human ID', () => {
    it('carries ids on create, update and section writes, and lists the history by UUID', async () => {
      const doc = await send<{ id: string }>('POST', `/projects/${CODE}/documents`, {
        kind: 'architecture',
        title: 'How it fits',
        sections: [{ heading: 'Overview', bodyMd: 'One box.' }],
      });
      expect(doc.auditEventIds).toHaveLength(1);

      const renamed = await send('PATCH', `/projects/${CODE}/documents/${doc.id}`, { title: 'How it all fits' });
      expect(renamed.auditEventIds).toHaveLength(1);
      const section = await send('PUT', `/projects/${CODE}/documents/${doc.id}/sections/overview`, {
        bodyMd: 'Two boxes.',
      });
      expect(section.auditEventIds).toHaveLength(1);
      const added = await send('POST', `/projects/${CODE}/documents/${doc.id}/sections`, {
        heading: 'Deployment',
        bodyMd: 'One container.',
      });
      expect(added.auditEventIds).toHaveLength(1);

      const items = await history(doc.id);
      // The document's own events: the section writes are the sections', under their own address.
      expect(items.map((item) => item.id)).toEqual([renamed.auditEventIds[0], doc.auditEventIds[0]]);
      expect(items[0]).toMatchObject({ action: 'update' });
      expect(items[0]?.summary).toMatch(/title/);

      const sections = await history(`${CODE}/architecture#overview`);
      expect(sections.map((item) => item.id)).toEqual([section.auditEventIds[0]]);
    });
  });

  describe('tokens, which are not undoable', () => {
    it('carries ids on issue, says a revoke in headers, and says why neither can be undone', async () => {
      const issued = await send<{ id: string; prefix: string; token: string }>('POST', '/tokens', {
        name: 'audit-events test',
        scopes: ['read'],
      });
      strays.tokens.push(issued.prefix);
      expect(issued.auditEventIds).toHaveLength(1);

      const revoked = idsOf(await remove(`/tokens/${issued.id}`));
      expect(revoked).toHaveLength(1);

      const items = await history(issued.prefix);
      expect(items.map((item) => item.id)).toEqual([revoked[0], issued.auditEventIds[0]]);
      expect(items[0]?.summary).toMatch(/^Revoked API token /);
      expect(items[1]?.summary).toMatch(/^Issued API token /);
      for (const item of items) {
        expect(item.undoable).toBe(false);
        expect(item.reason).toMatch(/cannot be undone/);
      }
      // And what the trail holds never includes the secret.
      expect(JSON.stringify(items)).not.toContain(issued.token);
    });
  });

  describe('the history endpoint itself', () => {
    it('needs an entity, and a signed-in caller', async () => {
      expect((await api('/audit-events')).status).toBe(400);
      expect((await fetch(`${origin}/api/audit-events?entity=${CODE}`)).status).toBe(401);
    });

    it('answers an entity with no history with an empty list', async () => {
      expect(await history(`${CODE}-T-9.9`)).toEqual([]);
    });

    it('finds a project by its code', async () => {
      const items = await history(CODE);
      expect(items.map((item) => item.action)).toContain('create');
    });

    it('is a read: a read-only token may list it, and may not undo', async () => {
      const issued = await send<{ id: string; prefix: string; token: string }>('POST', '/tokens', {
        name: 'audit-events reader',
        scopes: ['read'],
      });
      strays.tokens.push(issued.prefix);
      const listed = await api(`/audit-events?entity=${CODE}`, { bearer: issued.token });
      expect(listed.status).toBe(200);
      const [event] = ((await listed.json()) as AuditEventsResponse).items;
      expect((await api(`/undo/${event?.id ?? ''}`, { method: 'POST', bearer: issued.token })).status).toBe(403);
    });
  });
});
