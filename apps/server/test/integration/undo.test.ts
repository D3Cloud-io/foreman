import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * Soft delete and undo (T-2.3, T-2.4) — "nothing is unrecoverable", tested rather than asserted.
 *
 * The test that matters most is the refusal: undoing a change something else has since changed
 * again would silently discard the later edit, and refusing is the better outcome.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'undo@example.com';
const PASSWORD = 'a-password-for-the-undo-tests';
const CODE = 'UND';

describe.skipIf(url === undefined)('delete and undo', () => {
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

  const lastEvent = async (action?: 'create' | 'update' | 'delete' | 'undo') =>
    db.auditEvent.findFirstOrThrow({
      where: { entityHumanId: { startsWith: CODE }, ...(action === undefined ? {} : { action }) },
      orderBy: { createdAt: 'desc' },
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
      data: { email: EMAIL, displayName: 'Undo', status: 'active' },
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
    await post('/projects', { code: CODE, name: 'Undo Test' });
    await post(`/projects/${CODE}/requirements`, {
      statement: 'Foreman shall make every mutation reversible.',
    });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  describe('soft delete (FRM-REQ-140)', () => {
    it('keeps the row and stamps it, rather than removing it', async () => {
      const res = await api(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { method: 'DELETE' });
      expect(res.status).toBe(204);

      const row = await db.requirement.findFirstOrThrow({ where: { humanId: `${CODE}-REQ-001` } });
      expect(row.deletedAt).not.toBeNull();
      // Still there, which is the whole point: a delete that removes cannot be undone.
      expect(row.statement).toContain('reversible');
    });

    it('hides a deleted entity from lists and lookups', async () => {
      await api(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { method: 'DELETE' });

      const listed = (await (await api(`/projects/${CODE}/requirements`)).json()) as {
        items: unknown[];
      };
      expect(listed.items).toEqual([]);
      expect((await api(`/entities/${CODE}-REQ-001`)).status).toBe(404);
    });

    it('records what it deleted, so there is something to restore from', async () => {
      await api(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { method: 'DELETE' });

      const event = await lastEvent('delete');
      const before = event.before as { statement: string };
      expect(before.statement).toContain('reversible');
    });

    it('404s a delete of something already deleted', async () => {
      await api(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { method: 'DELETE' });
      const again = await api(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { method: 'DELETE' });
      expect(again.status).toBe(404);
    });
  });

  describe('undo (FRM-REQ-138, FRM-REQ-139)', () => {
    it('restores a deleted entity', async () => {
      await api(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { method: 'DELETE' });
      const deletion = await lastEvent('delete');

      const res = await post(`/undo/${deletion.id}`);
      expect(res.status).toBe(200);

      const row = await db.requirement.findFirstOrThrow({ where: { humanId: `${CODE}-REQ-001` } });
      expect(row.deletedAt).toBeNull();
      expect((await api(`/entities/${CODE}-REQ-001`)).status).toBe(200);
    });

    it('puts an edited field back the way it was', async () => {
      await patch(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { priority: 'C' });
      const edit = await lastEvent('update');

      await post(`/undo/${edit.id}`);

      const row = await db.requirement.findFirstOrThrow({ where: { humanId: `${CODE}-REQ-001` } });
      expect(row.priority).toBe('M');
    });

    it('reverses a creation by deleting what it made', async () => {
      const created = await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall be undone.',
      });
      expect(created.status).toBe(201);
      const creation = await lastEvent('create');

      await post(`/undo/${creation.id}`);
      const row = await db.requirement.findFirstOrThrow({ where: { humanId: `${CODE}-REQ-002` } });
      expect(row.deletedAt).not.toBeNull();
    });

    it('audits the reversal itself, and stamps the original', async () => {
      await patch(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { priority: 'S' });
      const edit = await lastEvent('update');

      const res = await post(`/undo/${edit.id}`);
      const body = (await res.json()) as { reversalEventId: string };

      const reversal = await db.auditEvent.findUniqueOrThrow({ where: { id: body.reversalEventId } });
      expect(reversal.action).toBe('undo');

      const original = await db.auditEvent.findUniqueOrThrow({ where: { id: edit.id } });
      expect(original.undoneAt).not.toBeNull();
      expect(original.undoneByEventId).toBe(body.reversalEventId);
    });

    it('refuses to undo the same change twice', async () => {
      await patch(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { priority: 'S' });
      const edit = await lastEvent('update');

      expect((await post(`/undo/${edit.id}`)).status).toBe(200);
      const again = await post(`/undo/${edit.id}`);
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toContain('already been undone');
    });

    it('refuses when the entity has changed since — the assertion undo exists for', async () => {
      await patch(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { priority: 'S' });
      const firstEdit = await lastEvent('update');

      // Somebody else edits the same field afterwards.
      await patch(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { priority: 'C' });

      const res = await post(`/undo/${firstEdit.id}`);
      expect(res.status).toBe(409);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain('priority');
      expect(error).toContain('discard the later edit');

      // And the later edit survives, which is the point of refusing.
      const row = await db.requirement.findFirstOrThrow({ where: { humanId: `${CODE}-REQ-001` } });
      expect(row.priority).toBe('C');
    });

    it('refuses to undo a reversal, rather than quietly redoing', async () => {
      await patch(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { priority: 'S' });
      const edit = await lastEvent('update');
      const res = await post(`/undo/${edit.id}`);
      const { reversalEventId } = (await res.json()) as { reversalEventId: string };

      const redo = await post(`/undo/${reversalEventId}`);
      expect(redo.status).toBe(409);
      expect(((await redo.json()) as { error: string }).error).toContain('itself a reversal');
    });

    it('404s an audit event that does not exist', async () => {
      const res = await post('/undo/01a0b000-0000-7000-8000-000000000000');
      expect(res.status).toBe(404);
    });

    it('requires authentication', async () => {
      const deletion = await lastEvent();
      const res = await fetch(`${origin}/api/undo/${deletion.id}`, { method: 'POST' });
      expect(res.status).toBe(401);
    });
  });

  /**
   * A link is recorded as a `create` on the entity it starts from, and an unlink as a `delete`, so
   * an undo that replays by action alone soft-deleted the *task* and could not put an unlink back
   * (FRM-T-11.3). The link is what changed, so the link is what an undo reverses.
   */
  describe('undo of a link or an unlink (FRM-T-11.3)', () => {
    const REQ = `${CODE}-REQ-001`;

    const newTask = async (title: string): Promise<string> => {
      const res = await post(`/projects/${CODE}/tasks`, { title });
      expect(res.status).toBe(201);
      return ((await res.json()) as { humanId: string }).humanId;
    };
    const newRequirement = async (statement: string): Promise<string> => {
      const res = await post(`/projects/${CODE}/requirements`, { statement });
      expect(res.status).toBe(201);
      return ((await res.json()) as { humanId: string }).humanId;
    };
    const links = (body: { from: string; to: string; kind: string; remove?: boolean }) =>
      post('/links', body);
    const linkEvent = async (humanId: string, action: 'create' | 'delete') =>
      db.auditEvent.findFirstOrThrow({
        where: { entityHumanId: humanId, action },
        orderBy: { createdAt: 'desc' },
      });
    const undoOf = async (eventId: string) => {
      const res = await post(`/undo/${eventId}`);
      return { status: res.status, body: (await res.json()) as { error?: string; reversalEventId?: string } };
    };
    const idOf = async (humanId: string): Promise<string> =>
      humanId.includes('-REQ-')
        ? (await db.requirement.findFirstOrThrow({ where: { humanId } })).id
        : humanId.includes('-ADR-')
          ? (await db.adr.findFirstOrThrow({ where: { humanId } })).id
          : (await db.task.findFirstOrThrow({ where: { humanId } })).id;
    const reference = async (
      from: string,
      to: string,
      kind: 'relates' | 'satisfies' | 'depends_on' | 'extends' | 'violates',
    ): Promise<boolean> => {
      const [fromId, toId] = await Promise.all([idOf(from), idOf(to)]);
      return (await db.reference.findFirst({ where: { fromId, toId, kind } })) !== null;
    };
    const satisfies = async (taskHumanId: string) => {
      const task = await db.task.findFirstOrThrow({ where: { humanId: taskHumanId } });
      const req = await db.requirement.findFirstOrThrow({ where: { humanId: REQ } });
      const row = await db.taskRequirement.findUnique({
        where: { taskId_requirementId: { taskId: task.id, requirementId: req.id } },
      });
      return { task, linked: row !== null, referenced: await reference(taskHumanId, REQ, 'satisfies') };
    };
    const dependsOn = async (from: string, to: string) => {
      const [a, b] = await Promise.all([
        db.task.findFirstOrThrow({ where: { humanId: from } }),
        db.task.findFirstOrThrow({ where: { humanId: to } }),
      ]);
      const edge = await db.taskDependency.findUnique({
        where: { taskId_dependsOnId: { taskId: a.id, dependsOnId: b.id } },
      });
      return { task: a, linked: edge !== null, referenced: await reference(from, to, 'depends_on') };
    };

    describe('undoing a link removes it, and leaves the entity untouched', () => {
      it('a plain citation: the reference row', async () => {
        const other = await newRequirement('Foreman shall say what an undo reversed.');
        expect((await links({ from: other, to: REQ, kind: 'relates' })).status).toBe(200);
        const before = await db.requirement.findFirstOrThrow({ where: { humanId: other } });
        expect(await reference(other, REQ, 'relates')).toBe(true);
        const event = await linkEvent(other, 'create');

        expect((await undoOf(event.id)).status).toBe(200);

        expect(await reference(other, REQ, 'relates')).toBe(false);
        const after = await db.requirement.findFirstOrThrow({ where: { humanId: other } });
        expect(after).toEqual(before);
      });

      it('task → requirement: the task_requirement row and the reference', async () => {
        const task = await newTask('Make undo reversible');
        expect((await links({ from: task, to: REQ, kind: 'satisfies' })).status).toBe(200);
        const before = await db.task.findFirstOrThrow({ where: { humanId: task } });
        const event = await linkEvent(task, 'create');

        expect((await undoOf(event.id)).status).toBe(200);

        const state = await satisfies(task);
        expect(state.linked).toBe(false);
        expect(state.referenced).toBe(false);
        // Untouched: not soft-deleted, and not so much as re-saved.
        expect(state.task).toEqual(before);
        expect((await api(`/entities/${task}`)).status).toBe(200);
      });

      it('depends_on: the task_dependency row and the reference', async () => {
        const first = await newTask('Scaffold');
        const second = await newTask('Build on the scaffold');
        expect((await links({ from: second, to: first, kind: 'depends_on' })).status).toBe(200);
        const [a, b] = await Promise.all([
          db.task.findFirstOrThrow({ where: { humanId: second } }),
          db.task.findFirstOrThrow({ where: { humanId: first } }),
        ]);
        const event = await linkEvent(second, 'create');

        expect((await undoOf(event.id)).status).toBe(200);

        const state = await dependsOn(second, first);
        expect(state.linked).toBe(false);
        expect(state.referenced).toBe(false);
        expect(state.task).toEqual(a);
        expect(await db.task.findFirstOrThrow({ where: { humanId: first } })).toEqual(b);
      });
    });

    describe('undoing an unlink puts it back', () => {
      it('a plain citation', async () => {
        const other = await newRequirement('Foreman shall keep what it cites.');
        await links({ from: other, to: REQ, kind: 'relates' });
        expect((await links({ from: other, to: REQ, kind: 'relates', remove: true })).status).toBe(200);
        const event = await linkEvent(other, 'delete');

        expect((await undoOf(event.id)).status).toBe(200);
        expect(await reference(other, REQ, 'relates')).toBe(true);
      });

      it('task → requirement', async () => {
        const task = await newTask('Keep the citation');
        await links({ from: task, to: REQ, kind: 'satisfies' });
        expect((await links({ from: task, to: REQ, kind: 'satisfies', remove: true })).status).toBe(200);
        const before = await db.task.findFirstOrThrow({ where: { humanId: task } });
        const event = await linkEvent(task, 'delete');

        expect((await undoOf(event.id)).status).toBe(200);

        const state = await satisfies(task);
        expect(state.linked).toBe(true);
        expect(state.referenced).toBe(true);
        expect(state.task).toEqual(before);
      });

      it('depends_on', async () => {
        const first = await newTask('Scaffold');
        const second = await newTask('Build on the scaffold');
        await links({ from: second, to: first, kind: 'depends_on' });
        await links({ from: second, to: first, kind: 'depends_on', remove: true });
        const event = await linkEvent(second, 'delete');

        expect((await undoOf(event.id)).status).toBe(200);

        const state = await dependsOn(second, first);
        expect(state.linked).toBe(true);
        expect(state.referenced).toBe(true);
      });

      it('refuses a depends_on that would now close a cycle', async () => {
        const first = await newTask('Scaffold');
        const second = await newTask('Build on the scaffold');
        await links({ from: second, to: first, kind: 'depends_on' });
        await links({ from: second, to: first, kind: 'depends_on', remove: true });
        const event = await linkEvent(second, 'delete');
        // The other way round is fine with the edge gone, and makes putting it back a loop.
        expect((await links({ from: first, to: second, kind: 'depends_on' })).status).toBe(200);

        const res = await undoOf(event.id);
        expect(res.status).toBe(409);
        expect(res.body.error).toContain('cycle');

        expect((await dependsOn(second, first)).linked).toBe(false);
        expect((await dependsOn(first, second)).linked).toBe(true);
        const original = await db.auditEvent.findUniqueOrThrow({ where: { id: event.id } });
        expect(original.undoneAt).toBeNull();
        expect(original.undoneByEventId).toBeNull();
      });
    });

    describe('a link that changed nothing has nothing to undo', () => {
      it('records which rows a link and an unlink changed', async () => {
        const task = await newTask('Recorded');
        const rows = {
          reference: true,
          taskRequirement: true,
          taskDependency: false,
          adrRelation: false,
          supersededBy: false,
          status: false,
        };
        await links({ from: task, to: REQ, kind: 'satisfies' });
        expect((await linkEvent(task, 'create')).after).toEqual({
          event: 'link',
          to: REQ,
          kind: 'satisfies',
          changed: true,
          rows,
        });
        await links({ from: task, to: REQ, kind: 'satisfies', remove: true });
        expect((await linkEvent(task, 'delete')).after).toEqual({
          event: 'unlink',
          to: REQ,
          kind: 'satisfies',
          changed: true,
          rows,
        });
      });

      it('refuses a link that was already there, rather than removing the earlier one', async () => {
        const task = await newTask('Linked twice');
        await links({ from: task, to: REQ, kind: 'satisfies' });
        await links({ from: task, to: REQ, kind: 'satisfies' });
        const repeat = await linkEvent(task, 'create');
        expect(repeat.after).toMatchObject({ changed: false });

        const res = await undoOf(repeat.id);
        expect(res.status).toBe(409);
        expect(res.body.error).toContain('nothing to undo');
        expect((await satisfies(task)).linked).toBe(true);
        expect((await db.auditEvent.findUniqueOrThrow({ where: { id: repeat.id } })).undoneAt).toBeNull();
      });

      it('refuses a depends_on that was already there', async () => {
        const first = await newTask('Scaffold');
        const second = await newTask('Build on the scaffold');
        await links({ from: second, to: first, kind: 'depends_on' });
        await links({ from: second, to: first, kind: 'depends_on' });
        const repeat = await linkEvent(second, 'create');

        const res = await undoOf(repeat.id);
        expect(res.status).toBe(409);
        expect(res.body.error).toContain('nothing to undo');
        expect((await dependsOn(second, first)).linked).toBe(true);
      });

      it('refuses an unlink of something that was not linked', async () => {
        const task = await newTask('Never linked');
        expect((await links({ from: task, to: REQ, kind: 'satisfies', remove: true })).status).toBe(200);
        const event = await linkEvent(task, 'delete');
        expect(event.after).toMatchObject({ changed: false });

        const res = await undoOf(event.id);
        expect(res.status).toBe(409);
        expect(res.body.error).toContain('nothing to undo');
        // Refusing is the point: putting back a link that never existed would invent one.
        expect((await satisfies(task)).linked).toBe(false);
      });

      it('refuses an event written before links said whether they changed anything', async () => {
        const task = await newTask('From before');
        await links({ from: task, to: REQ, kind: 'satisfies' });
        const event = await linkEvent(task, 'create');
        await db.auditEvent.update({
          where: { id: event.id },
          data: { after: { event: 'link', to: REQ, kind: 'satisfies', changed: true } },
        });

        const res = await undoOf(event.id);
        expect(res.status).toBe(409);
        expect(res.body.error).toContain('unlink');
        const state = await satisfies(task);
        expect(state.linked).toBe(true);
        expect(state.task.deletedAt).toBeNull();
      });
    });

    /**
     * Every row beside a reference has one owning kind: only satisfies writes `task_requirement`,
     * only extends the extends relation, only supersedes the supersedes relation and its mirror.
     * Two kinds sharing a row left it with no owner — reversing one link took the row the other
     * still needed, or reversing both left it behind, still counted as coverage.
     */
    describe('each row beside a reference has one owning kind', () => {
      const newAdr = async (title: string): Promise<string> => {
        const res = await post(`/projects/${CODE}/adrs`, { title });
        expect(res.status).toBe(201);
        return ((await res.json()) as { humanId: string }).humanId;
      };
      const coverage = async () => {
        const res = await api(`/projects/${CODE}/coverage`);
        expect(res.status).toBe(200);
        return (await res.json()) as { requirements: { covered: number }; uncovered: { humanId: string }[] };
      };
      const coverageRows = async () => {
        const req = await db.requirement.findFirstOrThrow({ where: { humanId: REQ } });
        return db.taskRequirement.count({ where: { requirementId: req.id } });
      };
      const relation = async (from: string, to: string, kind: 'extends' | 'supersedes' | 'superseded_by') => {
        const [a, b] = await Promise.all([
          db.adr.findFirstOrThrow({ where: { humanId: from } }),
          db.adr.findFirstOrThrow({ where: { humanId: to } }),
        ]);
        const row = await db.adrRelation.findUnique({
          where: { adrId_relatedAdrId_kind: { adrId: a.id, relatedAdrId: b.id, kind } },
        });
        return row !== null;
      };
      const linkEvents = async (humanId: string) =>
        db.auditEvent.findMany({
          where: { entityHumanId: humanId, action: 'create', after: { path: ['event'], equals: 'link' } },
          orderBy: { createdAt: 'asc' },
        });

      it('a relates between a task and a requirement never covers it', async () => {
        const task = await newTask('Only mentions it');
        const before = await coverage();
        await links({ from: task, to: REQ, kind: 'relates' });

        expect(await coverage()).toEqual(before);
        expect(await coverageRows()).toBe(0);
        expect(await reference(task, REQ, 'relates')).toBe(true);
      });

      it('satisfies then relates, undone in write order: coverage ends as it began', async () => {
        const task = await newTask('Covers it');
        const before = await coverage();
        await links({ from: task, to: REQ, kind: 'satisfies' });
        await links({ from: task, to: REQ, kind: 'relates' });
        const [satisfiesEvent, relatesEvent] = await linkEvents(task);

        expect((await undoOf(satisfiesEvent?.id ?? '')).status).toBe(200);
        expect((await undoOf(relatesEvent?.id ?? '')).status).toBe(200);

        expect(await coverage()).toEqual(before);
        expect(await coverageRows()).toBe(0);
        expect(await reference(task, REQ, 'satisfies')).toBe(false);
        expect(await reference(task, REQ, 'relates')).toBe(false);
      });

      it('satisfies then relates, undone in reverse order: coverage ends as it began', async () => {
        const task = await newTask('Covers it');
        const before = await coverage();
        await links({ from: task, to: REQ, kind: 'satisfies' });
        const covered = await coverage();
        await links({ from: task, to: REQ, kind: 'relates' });
        const [satisfiesEvent, relatesEvent] = await linkEvents(task);

        expect((await undoOf(relatesEvent?.id ?? '')).status).toBe(200);
        // The relates owned nothing but its reference, so the satisfies still covers.
        expect(await coverage()).toEqual(covered);
        expect((await undoOf(satisfiesEvent?.id ?? '')).status).toBe(200);

        expect(await coverage()).toEqual(before);
        expect(await coverageRows()).toBe(0);
      });

      it('unlinking a relates leaves a satisfies covering, in either order', async () => {
        const first = await newTask('Satisfies first');
        await links({ from: first, to: REQ, kind: 'satisfies' });
        await links({ from: first, to: REQ, kind: 'relates' });
        await links({ from: first, to: REQ, kind: 'relates', remove: true });
        expect((await satisfies(first)).linked).toBe(true);

        const second = await newTask('Relates first');
        await links({ from: second, to: REQ, kind: 'relates' });
        await links({ from: second, to: REQ, kind: 'satisfies' });
        await links({ from: second, to: REQ, kind: 'relates', remove: true });
        expect((await satisfies(second)).linked).toBe(true);
      });

      it('undoing a satisfies leaves a coverage row the task was created with', async () => {
        const req = await db.requirement.findFirstOrThrow({ where: { humanId: REQ } });
        const res = await post(`/projects/${CODE}/tasks`, {
          title: 'Created covering it',
          requirementIds: [req.id],
        });
        const task = ((await res.json()) as { humanId: string }).humanId;
        await links({ from: task, to: REQ, kind: 'satisfies' });
        const event = await linkEvent(task, 'create');
        expect(event.after).toMatchObject({ rows: { reference: true, taskRequirement: false } });

        expect((await undoOf(event.id)).status).toBe(200);
        const state = await satisfies(task);
        expect(state.referenced).toBe(false);
        expect(state.linked).toBe(true);
      });

      it('unlinking a satisfies over a row the task was created with keeps that row', async () => {
        const req = await db.requirement.findFirstOrThrow({ where: { humanId: REQ } });
        const res = await post(`/projects/${CODE}/tasks`, {
          title: 'Created covering it, then cited',
          requirementIds: [req.id],
        });
        const task = ((await res.json()) as { humanId: string }).humanId;
        await links({ from: task, to: REQ, kind: 'satisfies' });
        await links({ from: task, to: REQ, kind: 'satisfies', remove: true });

        const state = await satisfies(task);
        expect(state.referenced).toBe(false);
        expect(state.linked).toBe(true);
      });

      it('undoing an unlink puts back what it removed and nothing it did not', async () => {
        const req = await db.requirement.findFirstOrThrow({ where: { humanId: REQ } });
        const res = await post(`/projects/${CODE}/tasks`, {
          title: 'Created covering it, never cited',
          requirementIds: [req.id],
        });
        const task = ((await res.json()) as { humanId: string }).humanId;
        expect((await links({ from: task, to: REQ, kind: 'satisfies', remove: true })).status).toBe(200);
        const event = await linkEvent(task, 'delete');
        expect(event.after).toMatchObject({ rows: { reference: false, taskRequirement: true } });
        expect((await satisfies(task)).linked).toBe(false);

        expect((await undoOf(event.id)).status).toBe(200);

        const state = await satisfies(task);
        expect(state.linked).toBe(true);
        // No reference was there to remove, so none is invented.
        expect(state.referenced).toBe(false);
      });

      it('a violates between ADRs is not an edge in their graph', async () => {
        const older = await newAdr('Postgres for everything');
        const newer = await newAdr('A queue in Redis after all');
        await links({ from: newer, to: older, kind: 'violates' });
        expect(await relation(newer, older, 'extends')).toBe(false);
      });

      it('extends then violates, undone in write order: the ADR relation is gone', async () => {
        const older = await newAdr('Postgres for everything');
        const newer = await newAdr('Postgres for the queue as well');
        await links({ from: newer, to: older, kind: 'extends' });
        await links({ from: newer, to: older, kind: 'violates' });
        const [extendsEvent, violatesEvent] = await linkEvents(newer);

        expect((await undoOf(extendsEvent?.id ?? '')).status).toBe(200);
        expect((await undoOf(violatesEvent?.id ?? '')).status).toBe(200);
        expect(await relation(newer, older, 'extends')).toBe(false);
      });

      it('extends then violates, undone in reverse order: the relation goes with the extends', async () => {
        const older = await newAdr('Postgres for everything');
        const newer = await newAdr('Postgres for the queue as well');
        await links({ from: newer, to: older, kind: 'extends' });
        await links({ from: newer, to: older, kind: 'violates' });
        const [extendsEvent, violatesEvent] = await linkEvents(newer);

        expect((await undoOf(violatesEvent?.id ?? '')).status).toBe(200);
        expect(await relation(newer, older, 'extends')).toBe(true);
        expect((await undoOf(extendsEvent?.id ?? '')).status).toBe(200);
        expect(await relation(newer, older, 'extends')).toBe(false);
      });

      it('unlinking a violates keeps the extends relation', async () => {
        const older = await newAdr('Postgres for everything');
        const newer = await newAdr('Postgres for the queue as well');
        await links({ from: newer, to: older, kind: 'extends' });
        await links({ from: newer, to: older, kind: 'violates' });
        await links({ from: newer, to: older, kind: 'violates', remove: true });
        expect(await relation(newer, older, 'extends')).toBe(true);
      });

      it('undoing a supersedes unlink puts the edge back, and the older ADR stays superseded', async () => {
        const older = await newAdr('Roll our own OIDC client');
        const newer = await newAdr('Use the published SDK');
        await links({ from: newer, to: older, kind: 'supersedes' });
        await links({ from: newer, to: older, kind: 'supersedes', remove: true });
        const event = await linkEvent(newer, 'delete');
        expect(event.after).toMatchObject({
          rows: { reference: true, adrRelation: true, supersededBy: true, status: false },
          replacedStatus: 'superseded',
        });
        expect(await relation(newer, older, 'supersedes')).toBe(false);

        expect((await undoOf(event.id)).status).toBe(200);

        expect(await relation(newer, older, 'supersedes')).toBe(true);
        expect(await relation(older, newer, 'superseded_by')).toBe(true);
        expect((await db.adr.findFirstOrThrow({ where: { humanId: older } })).status).toBe('superseded');
      });

      it('refuses to undo a supersedes unlink once the older ADR has been decided again', async () => {
        const older = await newAdr('Roll our own OIDC client');
        const newer = await newAdr('Use the published SDK');
        await links({ from: newer, to: older, kind: 'supersedes' });
        await links({ from: newer, to: older, kind: 'supersedes', remove: true });
        const event = await linkEvent(newer, 'delete');
        // Not reachable through the API, which never lets a superseded ADR be set to anything,
        // but an import or a later change of that rule could; the undo must not overwrite it.
        await db.adr.updateMany({ where: { humanId: older }, data: { status: 'accepted' } });

        const res = await undoOf(event.id);
        expect(res.status).toBe(409);
        expect(res.body.error).toContain('accepted');
        expect(await relation(newer, older, 'supersedes')).toBe(false);
        expect((await db.adr.findFirstOrThrow({ where: { humanId: older } })).status).toBe('accepted');
      });
    });

    /**
     * `extends` was stored as a `relates` reference, so an extends link and a relates link between
     * the same two ADRs shared one row: reversing either took the other's, or left the extends
     * relation with no reference. Every kind now owns a reference row of its own kind.
     */
    describe('a relates and an extends between the same two ADRs are two links', () => {
      const newAdr = async (title: string): Promise<string> => {
        const res = await post(`/projects/${CODE}/adrs`, { title });
        expect(res.status).toBe(201);
        return ((await res.json()) as { humanId: string }).humanId;
      };
      const extendsRelation = async (from: string, to: string) => {
        const [adrId, relatedAdrId] = await Promise.all([idOf(from), idOf(to)]);
        const row = await db.adrRelation.findUnique({
          where: { adrId_relatedAdrId_kind: { adrId, relatedAdrId, kind: 'extends' } },
        });
        return row !== null;
      };
      const eventOf = async (humanId: string, action: 'create' | 'delete', kind: string) =>
        db.auditEvent.findFirstOrThrow({
          where: { entityHumanId: humanId, action, after: { path: ['kind'], equals: kind } },
          orderBy: { createdAt: 'desc' },
        });

      type Kind = 'relates' | 'extends';
      const orders: readonly (readonly [Kind, Kind])[] = [
        ['relates', 'extends'],
        ['extends', 'relates'],
      ];

      for (const [first, second] of orders) {
        for (const target of [first, second]) {
          const other: Kind = target === 'relates' ? 'extends' : 'relates';
          const setUp = async () => {
            const older = await newAdr('Postgres for everything');
            const newer = await newAdr('Postgres for the queue as well');
            expect((await links({ from: newer, to: older, kind: first })).status).toBe(200);
            expect((await links({ from: newer, to: older, kind: second })).status).toBe(200);
            expect(await reference(newer, older, 'relates')).toBe(true);
            expect(await reference(newer, older, 'extends')).toBe(true);
            return { older, newer };
          };
          // The other link, whole: its own reference, and the relation when it is the extends.
          const otherIntact = async (newer: string, older: string) => {
            expect(await reference(newer, older, other)).toBe(true);
            expect(await extendsRelation(newer, older)).toBe(other === 'extends');
          };

          describe(`${first} then ${second}`, () => {
            it(`undoing the ${target} link leaves the ${other} whole`, async () => {
              const { older, newer } = await setUp();
              const event = await eventOf(newer, 'create', target);
              expect(event.after).toMatchObject({ rows: { reference: true } });

              expect((await undoOf(event.id)).status).toBe(200);

              expect(await reference(newer, older, target)).toBe(false);
              await otherIntact(newer, older);
            });

            it(`unlinking the ${target} leaves the ${other} whole`, async () => {
              const { older, newer } = await setUp();
              const res = await links({ from: newer, to: older, kind: target, remove: true });
              expect(((await res.json()) as { removed: boolean }).removed).toBe(true);

              expect(await reference(newer, older, target)).toBe(false);
              await otherIntact(newer, older);
            });

            it(`undoing an unlink of the ${target} puts back only the ${target}`, async () => {
              const { older, newer } = await setUp();
              await links({ from: newer, to: older, kind: target, remove: true });
              const event = await eventOf(newer, 'delete', target);

              expect((await undoOf(event.id)).status).toBe(200);

              expect(await reference(newer, older, 'relates')).toBe(true);
              expect(await reference(newer, older, 'extends')).toBe(true);
              expect(await extendsRelation(newer, older)).toBe(true);
              // Two links, two references: nothing was doubled or invented.
              const [fromId, toId] = await Promise.all([idOf(newer), idOf(older)]);
              expect(await db.reference.count({ where: { fromId, toId } })).toBe(2);
            });
          });
        }
      }

      it('unlinking an extends that is not there leaves a relates that is', async () => {
        const older = await newAdr('Postgres for everything');
        const newer = await newAdr('Postgres for the queue as well');
        await links({ from: newer, to: older, kind: 'relates' });

        const res = await links({ from: newer, to: older, kind: 'extends', remove: true });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { removed: boolean }).removed).toBe(false);
        expect(await reference(newer, older, 'relates')).toBe(true);
      });

      it('unlinking a relates that is not there leaves an extends whole', async () => {
        const older = await newAdr('Postgres for everything');
        const newer = await newAdr('Postgres for the queue as well');
        await links({ from: newer, to: older, kind: 'extends' });

        const res = await links({ from: newer, to: older, kind: 'relates', remove: true });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { removed: boolean }).removed).toBe(false);
        expect(await reference(newer, older, 'extends')).toBe(true);
        expect(await extendsRelation(newer, older)).toBe(true);
      });
    });

    describe('the reversal is audited, and cannot be repeated', () => {
      it('audits undoing a link as one undo event, and stamps the link event', async () => {
        const task = await newTask('Audited');
        await links({ from: task, to: REQ, kind: 'satisfies' });
        const event = await linkEvent(task, 'create');

        const { body } = await undoOf(event.id);

        const reversal = await db.auditEvent.findUniqueOrThrow({ where: { id: body.reversalEventId ?? '' } });
        expect(reversal.action).toBe('undo');
        expect(reversal.entityHumanId).toBe(task);
        expect(reversal.before).toMatchObject({ event: 'link', to: REQ, kind: 'satisfies' });
        expect(reversal.after).toMatchObject({ event: 'unlink', to: REQ, kind: 'satisfies' });

        const original = await db.auditEvent.findUniqueOrThrow({ where: { id: event.id } });
        expect(original.undoneAt).not.toBeNull();
        expect(original.undoneByEventId).toBe(body.reversalEventId);

        // The reversal is one event, not an undo plus a fresh link event that could itself be undone.
        const since = await db.auditEvent.count({
          where: { entityHumanId: task, createdAt: { gt: event.createdAt } },
        });
        expect(since).toBe(1);
      });

      it('audits undoing an unlink the same way', async () => {
        const first = await newTask('Scaffold');
        const second = await newTask('Build on the scaffold');
        await links({ from: second, to: first, kind: 'depends_on' });
        await links({ from: second, to: first, kind: 'depends_on', remove: true });
        const event = await linkEvent(second, 'delete');

        const { body } = await undoOf(event.id);

        const reversal = await db.auditEvent.findUniqueOrThrow({ where: { id: body.reversalEventId ?? '' } });
        expect(reversal.action).toBe('undo');
        expect(reversal.before).toMatchObject({ event: 'unlink', to: first, kind: 'depends_on' });
        expect(reversal.after).toMatchObject({ event: 'link', to: first, kind: 'depends_on' });
        const original = await db.auditEvent.findUniqueOrThrow({ where: { id: event.id } });
        expect(original.undoneByEventId).toBe(body.reversalEventId);
      });

      it('refuses to undo the same link twice', async () => {
        const task = await newTask('Twice');
        await links({ from: task, to: REQ, kind: 'satisfies' });
        const event = await linkEvent(task, 'create');

        expect((await undoOf(event.id)).status).toBe(200);
        const again = await undoOf(event.id);
        expect(again.status).toBe(409);
        expect(again.body.error).toContain('already been undone');
        expect((await satisfies(task)).task.deletedAt).toBeNull();
      });

      it('refuses to undo the same unlink twice, even with the link removed again', async () => {
        const task = await newTask('Twice over');
        await links({ from: task, to: REQ, kind: 'satisfies' });
        await links({ from: task, to: REQ, kind: 'satisfies', remove: true });
        const event = await linkEvent(task, 'delete');

        expect((await undoOf(event.id)).status).toBe(200);
        // Back to the state the unlink left, which on its own would let a second reversal through.
        await links({ from: task, to: REQ, kind: 'satisfies', remove: true });
        const again = await undoOf(event.id);
        expect(again.status).toBe(409);
        expect(again.body.error).toContain('already been undone');
        expect((await satisfies(task)).linked).toBe(false);
      });

      it('refuses to undo the reversal itself', async () => {
        const task = await newTask('No redo');
        await links({ from: task, to: REQ, kind: 'satisfies' });
        const event = await linkEvent(task, 'create');
        const { body } = await undoOf(event.id);

        const res = await undoOf(body.reversalEventId ?? '');
        expect(res.status).toBe(409);
        expect((await satisfies(task)).linked).toBe(false);
      });
    });

    describe('refuses when the link has moved on since', () => {
      it('a link that has since been removed', async () => {
        const task = await newTask('Already unlinked');
        await links({ from: task, to: REQ, kind: 'satisfies' });
        const event = await linkEvent(task, 'create');
        await links({ from: task, to: REQ, kind: 'satisfies', remove: true });

        const res = await undoOf(event.id);
        expect(res.status).toBe(409);
        expect(res.body.error).toContain('no longer linked');

        const original = await db.auditEvent.findUniqueOrThrow({ where: { id: event.id } });
        expect(original.undoneAt).toBeNull();
        expect((await satisfies(task)).task.deletedAt).toBeNull();
      });

      it('an unlink when the link is already back', async () => {
        const task = await newTask('Relinked by hand');
        await links({ from: task, to: REQ, kind: 'satisfies' });
        await links({ from: task, to: REQ, kind: 'satisfies', remove: true });
        const event = await linkEvent(task, 'delete');
        await links({ from: task, to: REQ, kind: 'satisfies' });

        const res = await undoOf(event.id);
        expect(res.status).toBe(409);
        expect(res.body.error).toContain('already linked');
      });

      it('a depends_on that has since been removed', async () => {
        const first = await newTask('Scaffold');
        const second = await newTask('Build on the scaffold');
        await links({ from: second, to: first, kind: 'depends_on' });
        const event = await linkEvent(second, 'create');
        await links({ from: second, to: first, kind: 'depends_on', remove: true });

        const res = await undoOf(event.id);
        expect(res.status).toBe(409);
        expect(res.body.error).toContain('no longer linked');
        expect((await db.auditEvent.findUniqueOrThrow({ where: { id: event.id } })).undoneAt).toBeNull();
        expect((await dependsOn(second, first)).task.deletedAt).toBeNull();
      });

      it('a depends_on unlink when the edge is already back', async () => {
        const first = await newTask('Scaffold');
        const second = await newTask('Build on the scaffold');
        await links({ from: second, to: first, kind: 'depends_on' });
        await links({ from: second, to: first, kind: 'depends_on', remove: true });
        const event = await linkEvent(second, 'delete');
        await links({ from: second, to: first, kind: 'depends_on' });

        const res = await undoOf(event.id);
        expect(res.status).toBe(409);
        expect(res.body.error).toContain('already linked');
        expect((await db.auditEvent.findUniqueOrThrow({ where: { id: event.id } })).undoneAt).toBeNull();
      });

      it('a link whose entity has since been deleted', async () => {
        const task = await newTask('Cites a goner');
        const gone = await newRequirement('Foreman shall be deleted in this test.');
        await links({ from: task, to: gone, kind: 'satisfies' });
        const event = await linkEvent(task, 'create');
        expect((await api(`/projects/${CODE}/requirements/${gone}`, { method: 'DELETE' })).status).toBe(204);

        const res = await undoOf(event.id);
        expect(res.status).toBe(409);
        expect(res.body.error).toContain("the link's entity is gone");
        expect((await db.auditEvent.findUniqueOrThrow({ where: { id: event.id } })).undoneAt).toBeNull();
      });

      it('an unlink whose entity has since been deleted', async () => {
        const task = await newTask('Unlinked from a goner');
        await links({ from: task, to: REQ, kind: 'satisfies' });
        await links({ from: task, to: REQ, kind: 'satisfies', remove: true });
        const event = await linkEvent(task, 'delete');
        expect((await api(`/projects/${CODE}/tasks/${task}`, { method: 'DELETE' })).status).toBe(204);

        const res = await undoOf(event.id);
        expect(res.status).toBe(409);
        expect(res.body.error).toContain("the link's entity is gone");
      });
    });
  });

  describe('the audit trail never holds secrets (T-2.2)', () => {
    it('redacts password material from a snapshot', async () => {
      const user = await db.user.findFirstOrThrow({ where: { email: EMAIL } });
      const credential = await db.credential.findUniqueOrThrow({ where: { userId: user.id } });

      const { scrub } = await import('../../src/domain/audit.js');
      const scrubbed = scrub(credential) as Record<string, unknown>;

      expect(scrubbed['passwordHash']).toBe('[redacted]');
      expect(JSON.stringify(scrubbed)).not.toContain(credential.passwordHash);
    });

    it('redacts a token hash and a TOTP secret wherever they appear', async () => {
      const { scrub } = await import('../../src/domain/audit.js');
      const scrubbed = JSON.stringify(
        scrub({
          name: 'a token',
          tokenHash: 'abc123',
          nested: { totpSecret: 'JBSWY3DPEHPK3PXP', fine: 'kept' },
        }),
      );

      expect(scrubbed).not.toContain('abc123');
      expect(scrubbed).not.toContain('JBSWY3DPEHPK3PXP');
      expect(scrubbed).toContain('kept');
    });

    it('records a phase number as a number, not as a Decimal’s internals', async () => {
      await post(`/projects/${CODE}/phases`, { number: 8.5, name: 'The half phase' });
      const event = await lastEvent('create');
      expect((event.after as { number: unknown }).number).toBe('8.5');
    });
  });
});
