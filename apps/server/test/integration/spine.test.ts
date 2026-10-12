import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * The spine over HTTP (T-1.2 … T-1.5): projects, phases, requirements, tasks.
 *
 * These are the assertions the plan calls out by name — an immutable project code, a phase order
 * that disagrees with its numbering, a blocked task that must say why, and a requirement with no
 * phase at all.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'spine@example.com';
const PASSWORD = 'a-password-for-the-spine-tests';

describe.skipIf(url === undefined)('the spine', () => {
  let db: Db;
  let config: Config;
  let server: Server;
  let origin: string;
  let cookie: string;

  const api = (path: string, init: RequestInit = {}) => {
    // Headers may be an array of pairs, which spreads into indices rather than into an object.
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}/api${path}`, { ...init, headers });
  };

  const post = (path: string, body: unknown) =>
    api(path, { method: 'POST', body: JSON.stringify(body) });
  const patch = (path: string, body: unknown) =>
    api(path, { method: 'PATCH', body: JSON.stringify(body) });

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
    const user = await db.user.create({
      data: { email: EMAIL, displayName: 'Spine', status: 'active' },
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
    await db.project.deleteMany({ where: { code: { in: ['SPN', 'OTH'] } } });
    await db.auditEvent.deleteMany({ where: { entityHumanId: { startsWith: 'SPN' } } });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: { in: ['SPN', 'OTH'] } } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  const makeProject = async () => {
    const res = await post('/projects', { code: 'SPN', name: 'Spine Test' });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; code: string; slug: string };
  };

  describe('projects (FRM-REQ-031, FRM-REQ-032)', () => {
    it('creates a project and derives a slug', async () => {
      const project = await makeProject();
      expect(project.code).toBe('SPN');
      expect(project.slug).toBe('spine-test');
    });

    it('refuses a duplicate code', async () => {
      await makeProject();
      const again = await post('/projects', { code: 'SPN', name: 'Something else' });
      expect(again.status).toBe(409);
    });

    it('cannot change a code — it is not a field an update has', async () => {
      await makeProject();
      // Refused by name rather than stripped (FRM-T-017): a stripped code answered 200, which read
      // as the rename having worked.
      const res = await patch('/projects/SPN', { code: 'NEW', name: 'Renamed' });
      expect(res.status).toBe(400);
      const refusal = (await res.json()) as { fields: { path: string }[] };
      expect(refusal.fields.map((f) => f.path)).toEqual(['code']);

      // Nothing in the refused request was applied — not even the field that was allowed.
      const after = (await (await api('/projects/SPN')).json()) as { code: string; name: string };
      expect(after.code).toBe('SPN');
      expect(after.name).not.toBe('Renamed');
      // And the new code resolves to nothing, because it was never applied.
      expect((await api('/projects/NEW')).status).toBe(404);
    });

    it('writes an audit event for every mutation', async () => {
      const project = await makeProject();
      await patch('/projects/SPN', { name: 'Renamed' });

      const events = await db.auditEvent.findMany({
        where: { entityId: project.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(events.map((e) => e.action)).toEqual(['create', 'update']);
      expect(events[0]?.actor).toBe(EMAIL);
      expect(events[1]?.before).toMatchObject({ name: 'Spine Test' });
    });

    it('refuses an unauthenticated request outright', async () => {
      const res = await fetch(`${origin}/api/projects`);
      expect(res.status).toBe(401);
    });
  });

  describe('phases (FRM-REQ-034, FRM-REQ-035)', () => {
    it('renders the real Bindery case: 0, 8.5, 9, 13, 16, 12 in build order', async () => {
      await makeProject();
      // The order they were authored in is the order they are being built in.
      for (const [index, number] of [0, 8.5, 9, 13, 16, 12].entries()) {
        const res = await post('/projects/SPN/phases', {
          number,
          name: `Phase ${String(number)}`,
        });
        expect(res.status, `phase ${String(number)} at position ${String(index)}`).toBe(201);
      }

      const listed = (await (await api('/projects/SPN/phases')).json()) as {
        items: { number: string; humanId: string }[];
      };
      // Not sorted numerically — 12 comes last because that is when it is being built.
      expect(listed.items.map((p) => Number(p.number))).toEqual([0, 8.5, 9, 13, 16, 12]);
      expect(listed.items[1]?.humanId).toBe('SPN-P-8.5');
    });

    it('refuses a second phase with the same number', async () => {
      await makeProject();
      await post('/projects/SPN/phases', { number: 1, name: 'One' });
      expect((await post('/projects/SPN/phases', { number: 1, name: 'Also one' })).status).toBe(409);
    });
  });

  describe('requirements (FRM-REQ-036)', () => {
    it('lints EARS as a warning, never a rejection', async () => {
      await makeProject();
      // A feature name rather than a behaviour — the warning the lint exists for. It is stored
      // anyway, which is the half that matters (FRM-REQ-051, FRM-REQ-052).
      const res = await post('/projects/SPN/requirements', {
        statement: 'Per-user recovery codes',
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { earsPattern: string; earsLintOk: boolean; earsLintNote: string };
      expect(body.earsPattern).toBe('unparsed');
      expect(body.earsLintOk).toBe(false);
      expect(body.earsLintNote).toContain('names a feature');
    });

    it('does not warn on the indicative mood, which is how most registers are written', async () => {
      await makeProject();
      const res = await post('/projects/SPN/requirements', {
        statement: 'Original bytes are stored content-addressed by SHA-256 and never modified.',
      });

      const body = (await res.json()) as { earsPattern: string; earsLintOk: boolean };
      expect(body.earsPattern).toBe('ubiquitous');
      // No "shall", and that is not a defect: 210 of Bindery's requirements are written this way.
      expect(body.earsLintOk).toBe(true);
    });

    it('stores a requirement with no phase — that is the backlog', async () => {
      await makeProject();
      const res = await post('/projects/SPN/requirements', {
        statement: 'Foreman shall keep a backlog.',
      });
      const body = (await res.json()) as { phaseId: string | null; humanId: string };
      expect(body.phaseId).toBeNull();
      expect(body.humanId).toBe('SPN-REQ-001');
    });

    it('never reuses a sequence, even after a delete', async () => {
      await makeProject();
      await post('/projects/SPN/requirements', { statement: 'Foreman shall do one thing.' });
      const second = await post('/projects/SPN/requirements', {
        statement: 'Foreman shall do another.',
      });
      const { humanId } = (await second.json()) as { humanId: string };
      expect(humanId).toBe('SPN-REQ-002');

      // Delete it, then add another: the number must move on, because a document body may cite
      // SPN-REQ-002 and must never resolve to something else.
      await db.requirement.deleteMany({ where: { humanId } });
      const third = await post('/projects/SPN/requirements', { statement: 'Foreman shall go on.' });
      expect(((await third.json()) as { humanId: string }).humanId).toBe('SPN-REQ-003');
    });

    it('filters to the backlog — the requirements no phase has claimed (T-3.1)', async () => {
      await makeProject();
      await post('/projects/SPN/phases', { number: 1, name: 'One' });
      const phase = await db.phase.findFirstOrThrow({ where: { humanId: 'SPN-P-1' } });

      await post('/projects/SPN/requirements', {
        statement: 'Foreman shall be scheduled.',
        phaseId: phase.id,
      });
      await post('/projects/SPN/requirements', { statement: 'Foreman shall wait its turn.' });

      const backlog = (await (await api('/projects/SPN/requirements?phase=none')).json()) as {
        items: { humanId: string }[];
        total: number;
      };
      expect(backlog.items.map((r) => r.humanId)).toEqual(['SPN-REQ-002']);
      // The total is the filtered total. "1 of 2" while showing one row is the only honest answer.
      expect(backlog.total).toBe(1);
    });

    it('finds the coverage hole: requirements no task cites', async () => {
      await makeProject();
      await post('/projects/SPN/requirements', { statement: 'Foreman shall be covered.' });
      await post('/projects/SPN/requirements', { statement: 'Foreman shall be uncovered.' });

      const covered = await db.requirement.findFirstOrThrow({ where: { humanId: 'SPN-REQ-001' } });
      await post('/projects/SPN/tasks', {
        title: 'Covers the first',
        requirementIds: [covered.id],
      });

      const uncovered = (await (
        await api('/projects/SPN/requirements?uncovered=true')
      ).json()) as { items: { humanId: string }[] };
      expect(uncovered.items.map((r) => r.humanId)).toEqual(['SPN-REQ-002']);
    });
  });

  describe('tasks (FRM-REQ-038 … FRM-REQ-043)', () => {
    it('refuses a blocked task with no reason, with a typed error', async () => {
      await makeProject();
      const res = await post('/projects/SPN/tasks', { title: 'Stuck', status: 'blocked' });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { fields: { path: string; message: string }[] };
      expect(body.fields[0]?.path).toBe('blockedReason');
    });

    it('refuses becoming blocked in an update, where only the status is sent', async () => {
      await makeProject();
      await post('/projects/SPN/tasks', { title: 'Fine for now' });

      // The body alone is valid; it is the merged state that is not.
      const res = await patch('/projects/SPN/tasks/SPN-T-001', { status: 'blocked' });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { fields: { path: string }[] }).fields[0]?.path).toBe(
        'blockedReason',
      );
    });

    it('retires the reason when the task stops being blocked', async () => {
      // A task that is moving again and still says "waiting on the GitHub App installation" reads
      // as a task that is still waiting. Nothing would have shown the contradiction: the reason is
      // only ever rendered beside the status, so the stale copy sat in the record unseen.
      await makeProject();
      await post('/projects/SPN/tasks', {
        title: 'Stuck for now',
        status: 'blocked',
        blockedReason: 'Waiting on the GitHub App installation.',
      });

      await patch('/projects/SPN/tasks/SPN-T-001', { status: 'in_progress' });

      const { entity } = (await (await api('/entities/SPN-T-001')).json()) as {
        entity: { blockedReason: string | null };
      };
      expect(entity.blockedReason).toBeNull();
    });

    it('keeps a reason the same patch supplies, whatever the status', async () => {
      // An explicit value is a deliberate act and wins over the clearing rule.
      await makeProject();
      await post('/projects/SPN/tasks', {
        title: 'Stuck for now',
        status: 'blocked',
        blockedReason: 'Waiting on the GitHub App installation.',
      });

      await patch('/projects/SPN/tasks/SPN-T-001', {
        status: 'todo',
        blockedReason: 'Kept on purpose.',
      });

      const { entity } = (await (await api('/entities/SPN-T-001')).json()) as {
        entity: { blockedReason: string | null };
      };
      expect(entity.blockedReason).toBe('Kept on purpose.');
    });

    it('lets one task cite three requirements', async () => {
      await makeProject();
      const ids: string[] = [];
      for (const n of [1, 2, 3]) {
        const res = await post('/projects/SPN/requirements', {
          statement: `Foreman shall satisfy case ${String(n)}.`,
        });
        ids.push(((await res.json()) as { id: string }).id);
      }

      const created = await post('/projects/SPN/tasks', {
        title: 'Satisfies three',
        requirementIds: ids,
        files: ['apps/server/src/one.ts', 'apps/server/src/two.ts'],
      });
      expect(created.status).toBe(201);

      const listed = (await (await api('/projects/SPN/tasks')).json()) as {
        items: { requirements: string[]; files: string[] }[];
      };
      expect(listed.items[0]?.requirements.sort()).toEqual([
        'SPN-REQ-001',
        'SPN-REQ-002',
        'SPN-REQ-003',
      ]);
      expect(listed.items[0]?.files).toHaveLength(2);
    });

    it('names a task after its phase and position', async () => {
      await makeProject();
      const phase = await post('/projects/SPN/phases', { number: 8.5, name: 'The half phase' });
      const { id } = (await phase.json()) as { id: string };

      const first = await post('/projects/SPN/tasks', { title: 'First', phaseId: id });
      const second = await post('/projects/SPN/tasks', { title: 'Second', phaseId: id });

      expect(((await first.json()) as { humanId: string }).humanId).toBe('SPN-T-8.5.1');
      expect(((await second.json()) as { humanId: string }).humanId).toBe('SPN-T-8.5.2');
    });

    it('refuses a task pointed at another project’s phase', async () => {
      await makeProject();
      await post('/projects', { code: 'OTH', name: 'Other' });
      const other = await post('/projects/OTH/phases', { number: 1, name: 'Theirs' });
      const { id } = (await other.json()) as { id: string };

      const res = await post('/projects/SPN/tasks', { title: 'Wrong project', phaseId: id });
      expect(res.status).toBe(422);
    });

    it('timestamps a task when it starts and when it is done', async () => {
      await makeProject();
      await post('/projects/SPN/tasks', { title: 'Timed' });

      await patch('/projects/SPN/tasks/SPN-T-001', { status: 'in_progress' });
      const started = await db.task.findFirstOrThrow({ where: { humanId: 'SPN-T-001' } });
      expect(started.startedAt).not.toBeNull();

      await patch('/projects/SPN/tasks/SPN-T-001', { status: 'done' });
      const done = await db.task.findFirstOrThrow({ where: { humanId: 'SPN-T-001' } });
      expect(done.completedAt).not.toBeNull();
      // The start is not overwritten by finishing.
      expect(done.startedAt?.getTime()).toBe(started.startedAt?.getTime());
    });

    describe('declared files (FRM-T-007)', () => {
      it('replaces a task’s file list in the same update', async () => {
        await makeProject();
        await post('/projects/SPN/tasks', {
          title: 'Declares files',
          files: ['apps/server/src/one.ts'],
        });

        const res = await patch('/projects/SPN/tasks/SPN-T-001', {
          files: ['apps/server/src/two.ts', 'apps/server/src/three.ts'],
        });
        expect(res.status).toBe(200);

        const { entity } = (await (await api('/entities/SPN-T-001')).json()) as {
          entity: { files: string[] };
        };
        expect(entity.files.sort()).toEqual(['apps/server/src/three.ts', 'apps/server/src/two.ts']);
      });

      it('clears a task’s file list with an empty array', async () => {
        await makeProject();
        await post('/projects/SPN/tasks', {
          title: 'Declares files',
          files: ['apps/server/src/one.ts'],
        });

        const res = await patch('/projects/SPN/tasks/SPN-T-001', { files: [] });
        expect(res.status).toBe(200);

        const { entity } = (await (await api('/entities/SPN-T-001')).json()) as {
          entity: { files: string[] };
        };
        expect(entity.files).toEqual([]);
      });

      it('refuses an absolute path or one that climbs out of the repo', async () => {
        await makeProject();
        await post('/projects/SPN/tasks', { title: 'Declares files' });

        const absolute = await patch('/projects/SPN/tasks/SPN-T-001', { files: ['/etc/passwd'] });
        expect(absolute.status).toBe(400);

        const climbing = await patch('/projects/SPN/tasks/SPN-T-001', {
          files: ['apps/../../../secrets.env'],
        });
        expect(climbing.status).toBe(400);

        const tooMany = await patch('/projects/SPN/tasks/SPN-T-001', {
          files: Array.from({ length: 101 }, (_, i) => `apps/server/src/${String(i)}.ts`),
        });
        expect(tooMany.status).toBe(400);
      });

      it('audits the file change with before and after', async () => {
        await makeProject();
        await post('/projects/SPN/tasks', {
          title: 'Declares files',
          files: ['apps/server/src/one.ts'],
        });

        await patch('/projects/SPN/tasks/SPN-T-001', { files: ['apps/server/src/two.ts'] });

        const event = await db.auditEvent.findFirstOrThrow({
          where: { entityHumanId: 'SPN-T-001', action: 'update' },
          orderBy: { createdAt: 'desc' },
        });
        const before = event.before as { files: { path: string }[] };
        const after = event.after as { files: { path: string }[] };
        expect(before.files.map((f) => f.path)).toEqual(['apps/server/src/one.ts']);
        expect(after.files.map((f) => f.path)).toEqual(['apps/server/src/two.ts']);
      });
    });
  });

  describe('paging (FRM-REQ-092)', () => {
    it('bounds every list and pages with a cursor', async () => {
      await makeProject();
      for (let i = 0; i < 5; i++) {
        await post('/projects/SPN/requirements', {
          statement: `Foreman shall satisfy case ${String(i)}.`,
        });
      }

      const first = (await (await api('/projects/SPN/requirements?limit=2')).json()) as {
        items: { humanId: string }[];
        nextCursor: string | null;
      };
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = (await (
        await api(`/projects/SPN/requirements?limit=2&cursor=${String(first.nextCursor)}`)
      ).json()) as { items: { humanId: string }[] };
      expect(second.items).toHaveLength(2);
      // A page never repeats what the one before it returned.
      expect(second.items[0]?.humanId).not.toBe(first.items[0]?.humanId);
    });

    it('refuses an unbounded request rather than honouring it', async () => {
      await makeProject();
      expect((await api('/projects/SPN/requirements?limit=100000')).status).toBe(400);
    });
  });

  describe('links (T-2.8)', () => {
    it('links a task to a requirement, and coverage counts it', async () => {
      await makeProject();
      await post('/projects/SPN/requirements', { statement: 'Foreman shall be covered by a link.' });
      await post('/projects/SPN/tasks', { title: 'Covers it' });

      const res = await post('/links', { from: 'SPN-T-001', to: 'SPN-REQ-001', kind: 'satisfies' });
      expect(res.status).toBe(200);

      // Coverage is computed from task_requirement, so the link has to land there too.
      const uncovered = (await (
        await api('/projects/SPN/requirements?uncovered=true')
      ).json()) as { items: unknown[] };
      expect(uncovered.items).toEqual([]);
    });

    it('makes the citation visible as a backlink', async () => {
      await makeProject();
      await post('/projects/SPN/requirements', { statement: 'Foreman shall be cited.' });
      await post('/projects/SPN/tasks', { title: 'Cites it' });
      await post('/links', { from: 'SPN-T-001', to: 'SPN-REQ-001', kind: 'satisfies' });

      const entity = (await (await api('/entities/SPN-REQ-001')).json()) as {
        backlinks: { humanId: string; kind: string }[];
      };
      expect(entity.backlinks[0]?.humanId).toBe('SPN-T-001');
      expect(entity.backlinks[0]?.kind).toBe('satisfies');
    });

    it('is idempotent: linking twice does not double anything', async () => {
      await makeProject();
      await post('/projects/SPN/requirements', { statement: 'Foreman shall be linked once.' });
      await post('/projects/SPN/tasks', { title: 'Links twice' });

      await post('/links', { from: 'SPN-T-001', to: 'SPN-REQ-001', kind: 'satisfies' });
      const second = await post('/links', { from: 'SPN-T-001', to: 'SPN-REQ-001', kind: 'satisfies' });
      expect(second.status).toBe(200);
      expect(((await second.json()) as { created: boolean }).created).toBe(false);

      const entity = (await (await api('/entities/SPN-REQ-001')).json()) as {
        backlinks: unknown[];
      };
      expect(entity.backlinks).toHaveLength(1);
    });

    it('removes a link when asked, and coverage notices', async () => {
      await makeProject();
      await post('/projects/SPN/requirements', { statement: 'Foreman shall lose a link.' });
      await post('/projects/SPN/tasks', { title: 'Unlinks' });
      await post('/links', { from: 'SPN-T-001', to: 'SPN-REQ-001', kind: 'satisfies' });

      await post('/links', { from: 'SPN-T-001', to: 'SPN-REQ-001', kind: 'satisfies', remove: true });

      const uncovered = (await (
        await api('/projects/SPN/requirements?uncovered=true')
      ).json()) as { items: { humanId: string }[] };
      expect(uncovered.items.map((r) => r.humanId)).toEqual(['SPN-REQ-001']);
    });

    it('refuses to cite something that does not exist', async () => {
      await makeProject();
      await post('/projects/SPN/tasks', { title: 'Cites nothing' });
      const res = await post('/links', { from: 'SPN-T-001', to: 'SPN-REQ-999', kind: 'satisfies' });
      // A citation of something absent is not a link, it is a typo.
      expect(res.status).toBe(404);
    });
  });

  describe('optimistic concurrency (T-2.5, FRM-REQ-146)', () => {
    it('hands out a version, and accepts a write that carries it', async () => {
      await makeProject();
      const read = await api('/projects/SPN');
      const etag = read.headers.get('etag');
      expect(etag).toMatch(/^"[0-9a-f]{16}"$/);

      const res = await api('/projects/SPN', {
        method: 'PATCH',
        headers: { 'if-match': etag ?? '' },
        body: JSON.stringify({ name: 'Renamed once' }),
      });
      expect(res.status).toBe(200);
      // The response carries the new version, so a second write needs no extra read.
      expect(res.headers.get('etag')).not.toBe(etag);
    });

    it('refuses a write against a version somebody else has moved past', async () => {
      await makeProject();
      const stale = (await api('/projects/SPN')).headers.get('etag') ?? '';

      // Somebody else writes first.
      await patch('/projects/SPN', { name: 'Theirs' });

      const res = await api('/projects/SPN', {
        method: 'PATCH',
        headers: { 'if-match': stale },
        body: JSON.stringify({ name: 'Mine' }),
      });

      expect(res.status).toBe(412);
      const body = (await res.json()) as { error: string; current: { name: string } };
      expect(body.error).toContain('changed since you read it');
      // The current state comes back with the refusal: a caller that lost a race can see what it
      // lost to without going and asking.
      expect(body.current.name).toBe('Theirs');
      expect(res.headers.get('etag')).not.toBe(stale);

      // And the losing write did not land.
      const now = (await (await api('/projects/SPN')).json()) as { name: string };
      expect(now.name).toBe('Theirs');
    });

    it('writes unconditionally when no version is presented', async () => {
      await makeProject();
      // Opt-in: requiring it would make every simple call a two-step.
      const res = await patch('/projects/SPN', { name: 'No if-match here' });
      expect(res.status).toBe(200);
    });

    it('accepts * as "it must still exist"', async () => {
      await makeProject();
      const res = await api('/projects/SPN', {
        method: 'PATCH',
        headers: { 'if-match': '*' },
        body: JSON.stringify({ name: 'Star' }),
      });
      expect(res.status).toBe(200);
    });

    it('guards a task the same way', async () => {
      await makeProject();
      await post('/projects/SPN/tasks', { title: 'Raced over' });
      const first = await patch('/projects/SPN/tasks/SPN-T-001', { size: 'S' });
      const stale = first.headers.get('etag') ?? '';

      await patch('/projects/SPN/tasks/SPN-T-001', { size: 'L' });

      const res = await api('/projects/SPN/tasks/SPN-T-001', {
        method: 'PATCH',
        headers: { 'if-match': stale },
        body: JSON.stringify({ size: 'XS' }),
      });
      expect(res.status).toBe(412);
    });
  });

  describe('editing a phase (T-2.10)', () => {
    it('updates the fields a phase can change', async () => {
      await makeProject();
      await post('/projects/SPN/phases', { number: 3, name: 'Original' });

      const res = await patch('/projects/SPN/phases/SPN-P-3', {
        name: 'Renamed',
        objective: 'A clearer objective.',
        size: 'L',
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { name: string; objective: string; size: string };
      expect(body.name).toBe('Renamed');
      expect(body.size).toBe('L');
    });

    it('refuses to renumber, because the number is inside the human ID', async () => {
      await makeProject();
      await post('/projects/SPN/phases', { number: 3, name: 'Three' });

      const res = await patch('/projects/SPN/phases/SPN-P-3', { number: 4 });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('renumbered');

      // And the phase is untouched.
      const phase = await db.phase.findFirstOrThrow({ where: { humanId: 'SPN-P-3' } });
      expect(Number(phase.number)).toBe(3);
    });

    it('accepts the number it already has, so a full-form save is not a conflict', async () => {
      await makeProject();
      await post('/projects/SPN/phases', { number: 3, name: 'Three' });
      // A form that round-trips every field would otherwise be refused for changing nothing.
      const res = await patch('/projects/SPN/phases/SPN-P-3', { number: 3, name: 'Still three' });
      expect(res.status).toBe(200);
    });

    it('stamps the dates a phase starting and finishing produce', async () => {
      await makeProject();
      await post('/projects/SPN/phases', { number: 3, name: 'Three' });

      await patch('/projects/SPN/phases/SPN-P-3', { status: 'active' });
      const started = await db.phase.findFirstOrThrow({ where: { humanId: 'SPN-P-3' } });
      expect(started.startedAt).not.toBeNull();

      await patch('/projects/SPN/phases/SPN-P-3', { status: 'complete' });
      const done = await db.phase.findFirstOrThrow({ where: { humanId: 'SPN-P-3' } });
      expect(done.completedAt).not.toBeNull();
      expect(done.startedAt?.getTime()).toBe(started.startedAt?.getTime());
    });

    it('audits the change with what it replaced', async () => {
      await makeProject();
      await post('/projects/SPN/phases', { number: 3, name: 'Before' });
      await patch('/projects/SPN/phases/SPN-P-3', { name: 'After' });

      const event = await db.auditEvent.findFirstOrThrow({
        where: { entityHumanId: 'SPN-P-3', action: 'update' },
        orderBy: { createdAt: 'desc' },
      });
      expect((event.before as { name: string }).name).toBe('Before');
      expect((event.after as { name: string }).name).toBe('After');
    });
  });
});
