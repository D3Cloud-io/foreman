import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * Groups over HTTP (FRM-T-17.1; FRM-ADR-024, FRM-REQ-221 … FRM-REQ-227, FRM-REQ-235).
 *
 * The families one Foreman holds. What these assert is the partition: a project is in at most one
 * group, the order of groups and of projects within them is what every list reads back, a move is
 * an audited change undo reverses, and nothing — a delete, an undo, a guideline's scope — can
 * leave a project or a guideline pointing at a group that is gone.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'groups@example.com';
const PASSWORD = 'a-password-for-the-group-tests';
const PREFIX = 'GT ';
const CODES = ['GTA', 'GTB', 'GTC', 'GTD'] as const;

interface Group {
  id: string;
  humanId: string;
  name: string;
  slug: string;
  description: string | null;
  siteUrl: string | null;
  accent: string;
  position: number;
}
interface GroupProject {
  code: string;
  position: number;
}
interface Listing {
  items: (Group & { projects: GroupProject[]; counts: { projects: number; guidelines: number } })[];
  ungrouped: { humanId: null; slug: string; projects: GroupProject[]; counts: { projects: number } };
  total: number;
  auditEventIds?: string[];
}
interface Guideline {
  id: string;
  humanId: string;
  appliesTo: string;
  groups: string[];
}

describe.skipIf(url === undefined)('groups', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;

  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}${path}`, { ...init, headers });
  };
  const send = (method: string, path: string, body?: unknown) =>
    api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const ok = async <T>(res: Response, status = 200): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const create = async (body: Record<string, unknown>): Promise<Group> =>
    ok<Group>(await send('POST', '/api/groups', body), 201);
  const listing = async (): Promise<Listing> => ok<Listing>(await api('/api/groups'));
  const membersOf = async (humanId: string | null): Promise<string[]> => {
    const all = await listing();
    const entry = humanId === null ? all.ungrouped : all.items.find((g) => g.humanId === humanId);
    return (entry?.projects ?? []).map((p) => p.code).filter((c) => c.startsWith('GT'));
  };
  const undo = (eventId: string) => send('POST', `/api/undo/${eventId}`);
  const lastEvent = (entityType: 'group' | 'project' | 'guideline', entityId: string) =>
    db.auditEvent.findFirstOrThrow({ where: { entityType, entityId }, orderBy: { createdAt: 'desc' } });

  const cleanUp = async () => {
    await db.guideline.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await db.project.deleteMany({ where: { code: { in: [...CODES, 'GTNEW'] } } });
    await db.projectGroup.deleteMany({ where: { name: { startsWith: PREFIX } } });
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
      data: { email: EMAIL, displayName: 'Groups', status: 'active' },
    });
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
  });

  beforeEach(async () => {
    for (const code of CODES) {
      await ok(await send('POST', '/api/projects', { code, name: `Group test ${code}` }), 201);
    }
  });

  /**
   * Positions are dense: exactly 0..n-1 among the live groups, and within each group and among the
   * ungrouped (FRM-REQ-226). Checked after every test, so no operation here may leave a gap or a
   * shared place behind it.
   */
  const assertDense = async () => {
    const groups = await db.projectGroup.findMany({
      where: { deletedAt: null },
      select: { id: true, humanId: true, position: true },
    });
    const indices = (n: number) => Array.from({ length: n }, (_, i) => i);
    expect(groups.map((g) => g.position).sort((a, b) => a - b), 'group positions').toEqual(indices(groups.length));
    for (const groupId of [null, ...groups.map((g) => g.id)]) {
      const projects = await db.project.findMany({
        where: { groupId, deletedAt: null },
        select: { code: true, groupPosition: true },
      });
      expect(
        projects.map((p) => p.groupPosition).sort((a, b) => a - b),
        `positions in ${groups.find((g) => g.id === groupId)?.humanId ?? 'Ungrouped'}`,
      ).toEqual(indices(projects.length));
    }
  };
  const positionsIn = async (groupId: string | null) =>
    Object.fromEntries(
      (
        await db.project.findMany({
          where: { groupId, deletedAt: null, code: { startsWith: 'GT' } },
          select: { code: true, groupPosition: true },
        })
      ).map((p) => [p.code, p.groupPosition]),
    );

  afterEach(async () => {
    await assertDense();
    await cleanUp();
  });

  afterAll(async () => {
    await cleanUp();
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  describe('a group itself (FRM-REQ-221, FRM-REQ-222)', () => {
    it('takes a codeless GRP- ID from its own sequence, and stores what belongs to the family', async () => {
      const group = await create({
        name: `${PREFIX}Dormice`,
        description: 'The theme is that there is no theme.',
        siteUrl: 'https://dormice.ai',
        accent: 'floorspec',
      });

      expect(group.humanId).toMatch(/^GRP-\d{3,}$/);
      expect(group.slug).toBe('gt-dormice');
      expect(group.description).toBe('The theme is that there is no theme.');
      expect(group.siteUrl).toBe('https://dormice.ai');
      expect(group.accent).toBe('floorspec');

      const events = await db.auditEvent.findMany({
        where: { entityType: 'group', entityId: group.id, action: 'create' },
      });
      expect(events).toHaveLength(1);

      // Reachable by its ID and by its slug alike.
      const byId = await ok<Group & { projects: unknown[] }>(await api(`/api/groups/${group.humanId}`));
      const bySlug = await ok<Group>(await api(`/api/groups/${group.slug}`));
      expect(byId.id).toBe(group.id);
      expect(byId.projects).toEqual([]);
      expect(bySlug.id).toBe(group.id);
    });

    it('defaults the accent to neutral and leaves the optional fields empty', async () => {
      const group = await create({ name: `${PREFIX}Plain` });
      expect(group.accent).toBe('neutral');
      expect(group.description).toBeNull();
      expect(group.siteUrl).toBeNull();
    });

    it('never reuses an ID, even once the group that held it is deleted', async () => {
      const first = await create({ name: `${PREFIX}First` });
      expect((await send('DELETE', `/api/groups/${first.humanId}`)).status).toBe(204);
      const second = await create({ name: `${PREFIX}First` });

      const seq = (id: string) => Number(id.replace('GRP-', ''));
      expect(second.humanId).not.toBe(first.humanId);
      expect(seq(second.humanId)).toBeGreaterThan(seq(first.humanId));
    });

    it('refuses a duplicate name among live groups, whatever its case, with 409', async () => {
      await create({ name: `${PREFIX}D3 Cloud` });
      const res = await send('POST', '/api/groups', { name: `${PREFIX}d3 cloud` });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/already exists/);

      // A rename onto another group's name is the same clash.
      const other = await create({ name: `${PREFIX}Other` });
      expect((await send('PATCH', `/api/groups/${other.humanId}`, { name: `${PREFIX}D3 CLOUD` })).status).toBe(409);
    });

    it('refuses an accent that is not one of the product accents, with 400', async () => {
      const res = await send('POST', '/api/groups', { name: `${PREFIX}Hex`, accent: '#ff00ff' });
      expect(res.status).toBe(400);
      const group = await create({ name: `${PREFIX}Hex` });
      expect((await send('PATCH', `/api/groups/${group.humanId}`, { accent: 'purple' })).status).toBe(400);
    });

    it('refuses a site URL that is not absolute https, a description over one line, and a reserved name', async () => {
      for (const body of [
        { name: `${PREFIX}Bad url`, siteUrl: 'http://dormice.ai' },
        { name: `${PREFIX}Bad url`, siteUrl: 'dormice.ai' },
        { name: `${PREFIX}Two lines`, description: 'one\ntwo' },
        { name: `${PREFIX}Long`, description: 'x'.repeat(201) },
        { name: 'Ungrouped' },
        { name: 'All' },
        { name: '!!!' },
      ]) {
        const res = await send('POST', '/api/groups', body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
    });

    it('refuses a field a group does not store, by name', async () => {
      const res = await send('POST', '/api/groups', { name: `${PREFIX}Colour`, colour: 'teal' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('colour');
    });

    it('keeps its slug through a rename, and clears an optional field with null or an empty string', async () => {
      const group = await create({
        name: `${PREFIX}Before`,
        description: 'Something',
        siteUrl: 'https://example.com',
      });
      const renamed = await ok<Group>(
        await send('PATCH', `/api/groups/${group.humanId}`, {
          name: `${PREFIX}After`,
          description: '',
          siteUrl: null,
        }),
      );
      expect(renamed.name).toBe(`${PREFIX}After`);
      expect(renamed.slug).toBe(group.slug);
      expect(renamed.description).toBeNull();
      expect(renamed.siteUrl).toBeNull();
      // A slug is not a field anyone can write.
      expect((await send('PATCH', `/api/groups/${group.humanId}`, { slug: 'new-slug' })).status).toBe(400);
    });

    it('undoes an update', async () => {
      const group = await create({ name: `${PREFIX}Undo me`, accent: 'auth' });
      await ok(await send('PATCH', `/api/groups/${group.humanId}`, { name: `${PREFIX}Undone`, accent: 'qr' }));
      const event = await lastEvent('group', group.id);

      await ok(await undo(event.id));
      const back = await ok<Group>(await api(`/api/groups/${group.humanId}`));
      expect(back.name).toBe(`${PREFIX}Undo me`);
      expect(back.accent).toBe('auth');
    });
  });

  describe("a project's group (FRM-REQ-223)", () => {
    it('is set and cleared on the project, and the listing follows', async () => {
      const group = await create({ name: `${PREFIX}Family` });

      const set = await ok<{ groupId: string | null }>(
        await send('PATCH', '/api/projects/GTA', { group: group.humanId }),
      );
      expect(set.groupId).toBe(group.id);
      expect(await membersOf(group.humanId)).toEqual(['GTA']);
      expect(await membersOf(null)).not.toContain('GTA');

      const shown = await ok<{ group: { humanId: string; slug: string } | null }>(await api('/api/projects/GTA'));
      expect(shown.group?.humanId).toBe(group.humanId);

      // By slug as well as by ID.
      await ok(await send('PATCH', '/api/projects/GTB', { group: group.slug }));
      expect(await membersOf(group.humanId)).toEqual(['GTA', 'GTB']);

      const cleared = await ok<{ groupId: string | null }>(
        await send('PATCH', '/api/projects/GTA', { group: null }),
      );
      expect(cleared.groupId).toBeNull();
      expect(await membersOf(group.humanId)).toEqual(['GTB']);
      expect(await membersOf(null)).toContain('GTA');
    });

    it('is taken on creation, and an unknown group is refused with 422', async () => {
      const group = await create({ name: `${PREFIX}At birth` });
      const made = await ok<{ groupId: string }>(
        await send('POST', '/api/projects', { code: 'GTNEW', name: 'Born grouped', group: group.humanId }),
        201,
      );
      expect(made.groupId).toBe(group.id);
      expect(await membersOf(group.humanId)).toEqual(['GTNEW']);

      expect((await send('PATCH', '/api/projects/GTA', { group: 'GRP-99999' })).status).toBe(422);
      expect((await send('PATCH', '/api/projects/GTA', { group: 'no-such-group' })).status).toBe(422);
    });

    it('is at most one: moving a project into a group takes it out of the other', async () => {
      const a = await create({ name: `${PREFIX}A` });
      const b = await create({ name: `${PREFIX}B` });
      await ok(await send('POST', `/api/groups/${a.humanId}/projects`, { projects: ['GTA', 'GTB'] }));
      expect(await membersOf(a.humanId)).toEqual(['GTA', 'GTB']);

      const moved = await ok<Listing>(
        await send('POST', `/api/groups/${b.humanId}/projects`, { projects: ['GTA'] }),
      );
      expect(moved.items.find((g) => g.humanId === a.humanId)?.projects.map((p) => p.code)).toEqual(['GTB']);
      expect(moved.items.find((g) => g.humanId === b.humanId)?.projects.map((p) => p.code)).toEqual(['GTA']);

      // Every live project appears exactly once across the listing.
      const all = [...moved.items.flatMap((g) => g.projects), ...moved.ungrouped.projects].map((p) => p.code);
      expect(new Set(all).size).toBe(all.length);

      const ungrouped = await ok<Listing>(
        await send('POST', '/api/groups/ungrouped/projects', { projects: ['GTA', 'GTB'] }),
      );
      expect(ungrouped.items.find((g) => g.humanId === a.humanId)?.counts.projects).toBe(0);
      expect(ungrouped.ungrouped.projects.map((p) => p.code)).toEqual(expect.arrayContaining(['GTA', 'GTB']));
    });

    it('refuses an unknown project in a move with 422, and moves nothing', async () => {
      const group = await create({ name: `${PREFIX}Strict` });
      const res = await send('POST', `/api/groups/${group.humanId}/projects`, { projects: ['GTA', 'GTZZZ'] });
      expect(res.status).toBe(422);
      expect(await membersOf(group.humanId)).toEqual([]);
      expect((await send('POST', '/api/groups/GRP-99999/projects', { projects: ['GTA'] })).status).toBe(404);
    });
  });

  describe('a move is audited and undoable (FRM-REQ-225)', () => {
    it('writes an update event on the project, and POST /api/undo puts it back', async () => {
      const a = await create({ name: `${PREFIX}From` });
      const b = await create({ name: `${PREFIX}To` });
      await ok(await send('POST', `/api/groups/${a.humanId}/projects`, { projects: ['GTA'] }));

      const moved = await ok<Listing>(await send('POST', `/api/groups/${b.humanId}/projects`, { projects: ['GTA'] }));
      expect(moved.auditEventIds).toHaveLength(1);
      const project = await db.project.findUniqueOrThrow({ where: { code: 'GTA' } });
      const event = await db.auditEvent.findUniqueOrThrow({ where: { id: moved.auditEventIds?.[0] ?? '' } });
      expect(event.entityType).toBe('project');
      expect(event.entityId).toBe(project.id);
      expect(event.action).toBe('update');
      expect((event.before as { groupId: string }).groupId).toBe(a.id);
      expect((event.after as { groupId: string }).groupId).toBe(b.id);

      await ok(await undo(event.id));
      expect(await membersOf(a.humanId)).toEqual(['GTA']);
      expect(await membersOf(b.humanId)).toEqual([]);
    });

    it('undoes a move made by PATCHing the project', async () => {
      const group = await create({ name: `${PREFIX}Patched` });
      await ok(await send('PATCH', '/api/projects/GTC', { group: group.humanId }));
      const project = await db.project.findUniqueOrThrow({ where: { code: 'GTC' } });

      await ok(await undo((await lastEvent('project', project.id)).id));
      expect(await membersOf(group.humanId)).toEqual([]);
      expect((await db.project.findUniqueOrThrow({ where: { code: 'GTC' } })).groupId).toBeNull();
    });

    it('refuses to undo a move back into a group deleted since', async () => {
      const a = await create({ name: `${PREFIX}Gone` });
      await ok(await send('POST', `/api/groups/${a.humanId}/projects`, { projects: ['GTA'] }));
      const out = await ok<Listing>(await send('POST', '/api/groups/ungrouped/projects', { projects: ['GTA'] }));
      expect((await send('DELETE', `/api/groups/${a.humanId}`)).status).toBe(204);

      const res = await undo(out.auditEventIds?.[0] ?? '');
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain(a.humanId);
      expect((await db.project.findUniqueOrThrow({ where: { code: 'GTA' } })).groupId).toBeNull();
    });

    it("keeps a rename undoable after the project's group has been reordered", async () => {
      const group = await create({ name: `${PREFIX}Rename` });
      await ok(await send('POST', `/api/groups/${group.humanId}/projects`, { projects: ['GTA', 'GTB'] }));
      await ok(await send('PATCH', '/api/projects/GTA', { name: 'Renamed' }));
      const project = await db.project.findUniqueOrThrow({ where: { code: 'GTA' } });
      const rename = await lastEvent('project', project.id);
      await ok(await send('POST', `/api/groups/${group.humanId}/projects/order`, { order: ['GTB', 'GTA'] }));

      await ok(await undo(rename.id));
      const back = await db.project.findUniqueOrThrow({ where: { code: 'GTA' } });
      expect(back.name).toBe('Group test GTA');
      // The reorder stands: the rename's undo restored the name and nothing else.
      expect(await membersOf(group.humanId)).toEqual(['GTB', 'GTA']);
    });
  });

  describe('order (FRM-REQ-226)', () => {
    it('reorders groups, and the listing reads that order back', async () => {
      const a = await create({ name: `${PREFIX}One` });
      const b = await create({ name: `${PREFIX}Two` });
      const c = await create({ name: `${PREFIX}Three` });
      // Appended in the order they were made.
      const initial = (await listing()).items.map((g) => g.humanId);
      expect(initial.slice(-3)).toEqual([a.humanId, b.humanId, c.humanId]);

      const others = initial.filter((id) => ![a.humanId, b.humanId, c.humanId].includes(id));
      const wanted = [c.humanId, a.humanId, ...others, b.humanId];
      const result = await ok<Listing>(await send('POST', '/api/groups/order', { order: wanted }));
      expect(result.items.map((g) => g.humanId)).toEqual(wanted);
      expect((await listing()).items.map((g) => g.humanId)).toEqual(wanted);
      expect(result.auditEventIds).toHaveLength(1);
    });

    it('takes every group exactly once: a missing one is 422, a repeated one 400', async () => {
      const a = await create({ name: `${PREFIX}Only` });
      const all = (await listing()).items.map((g) => g.humanId);

      const missing = await send('POST', '/api/groups/order', { order: all.filter((id) => id !== a.humanId) });
      expect(missing.status).toBe(422);
      expect(JSON.stringify(await missing.json())).toContain(a.humanId);
      expect((await send('POST', '/api/groups/order', { order: [...all, 'GRP-99999'] })).status).toBe(422);
      expect((await send('POST', '/api/groups/order', { order: [...all, a.humanId] })).status).toBe(400);
    });

    it('reorders the projects within a group, and the listing and the group read it back', async () => {
      const group = await create({ name: `${PREFIX}Ordered` });
      await ok(await send('POST', `/api/groups/${group.humanId}/projects`, { projects: ['GTA', 'GTB', 'GTC'] }));
      expect(await membersOf(group.humanId)).toEqual(['GTA', 'GTB', 'GTC']);

      await ok(await send('POST', `/api/groups/${group.humanId}/projects/order`, { order: ['GTC', 'GTA', 'GTB'] }));
      expect(await membersOf(group.humanId)).toEqual(['GTC', 'GTA', 'GTB']);
      const detail = await ok<{ projects: GroupProject[] }>(await api(`/api/groups/${group.slug}`));
      expect(detail.projects.map((p) => p.code)).toEqual(['GTC', 'GTA', 'GTB']);

      // Every project in the group, each once.
      expect((await send('POST', `/api/groups/${group.humanId}/projects/order`, { order: ['GTC', 'GTA'] })).status).toBe(422);
      expect((await send('POST', `/api/groups/${group.humanId}/projects/order`, { order: ['GTC', 'GTA', 'GTB', 'GTD'] })).status).toBe(422);
    });

    it('places moved projects at a position, and the projects they displace move as one reorder', async () => {
      const group = await create({ name: `${PREFIX}Insert` });
      await ok(await send('POST', `/api/groups/${group.humanId}/projects`, { projects: ['GTA', 'GTB'] }));
      const res = await ok<Listing>(
        await send('POST', `/api/groups/${group.humanId}/projects`, { projects: ['GTC', 'GTD'], position: 1 }),
      );
      expect(res.items.find((g) => g.humanId === group.humanId)?.projects.map((p) => p.code)).toEqual([
        'GTA',
        'GTC',
        'GTD',
        'GTB',
      ]);
      // Two moves, and the renumbering that made room for them, recorded as a reorder.
      const events = await db.auditEvent.findMany({ where: { id: { in: res.auditEventIds ?? [] } } });
      expect(events.filter((e) => e.entityType === 'project')).toHaveLength(2);
      expect(events.some((e) => (e.after as { event?: string }).event === 'reorder')).toBe(true);
      await assertDense();
    });

    it('orders the ungrouped too', async () => {
      const before = await membersOf(null);
      expect(before).toEqual(['GTA', 'GTB', 'GTC', 'GTD']);
      const all = (await listing()).ungrouped.projects.map((p) => p.code);
      const others = all.filter((code) => !code.startsWith('GT'));
      await ok(await send('POST', '/api/groups/ungrouped/projects/order', { order: ['GTD', 'GTC', ...others, 'GTB', 'GTA'] }));
      expect(await membersOf(null)).toEqual(['GTD', 'GTC', 'GTB', 'GTA']);
    });

    it('undoes a reorder by restoring the previous order, and refuses once it has moved again', async () => {
      const group = await create({ name: `${PREFIX}Undo order` });
      await ok(await send('POST', `/api/groups/${group.humanId}/projects`, { projects: ['GTA', 'GTB', 'GTC'] }));
      const first = await ok<Listing>(
        await send('POST', `/api/groups/${group.humanId}/projects/order`, { order: ['GTC', 'GTB', 'GTA'] }),
      );
      await ok(await undo(first.auditEventIds?.[0] ?? ''));
      expect(await membersOf(group.humanId)).toEqual(['GTA', 'GTB', 'GTC']);

      const second = await ok<Listing>(
        await send('POST', `/api/groups/${group.humanId}/projects/order`, { order: ['GTB', 'GTA', 'GTC'] }),
      );
      await ok(await send('POST', `/api/groups/${group.humanId}/projects/order`, { order: ['GTC', 'GTA', 'GTB'] }));
      const refused = await undo(second.auditEventIds?.[0] ?? '');
      expect(refused.status).toBe(409);
      expect(await membersOf(group.humanId)).toEqual(['GTC', 'GTA', 'GTB']);
    });

    it('undoes a reorder of the groups themselves', async () => {
      const a = await create({ name: `${PREFIX}Left` });
      const b = await create({ name: `${PREFIX}Right` });
      const initial = (await listing()).items.map((g) => g.humanId);
      const swapped = initial.map((id) => (id === a.humanId ? b.humanId : id === b.humanId ? a.humanId : id));
      const result = await ok<Listing>(await send('POST', '/api/groups/order', { order: swapped }));

      await ok(await undo(result.auditEventIds?.[0] ?? ''));
      expect((await listing()).items.map((g) => g.humanId)).toEqual(initial);
    });
  });

  describe('positions stay dense (FRM-REQ-226)', () => {
    it('keeps 0..n-1 through moves in and out, and an undone move goes back to its old index', async () => {
      const group = await create({ name: `${PREFIX}Dense` });
      await ok(await send('POST', `/api/groups/${group.humanId}/projects`, { projects: ['GTA', 'GTB', 'GTC'] }));
      expect(await positionsIn(group.id)).toEqual({ GTA: 0, GTB: 1, GTC: 2 });
      await assertDense();

      // C leaves, D is appended where C was: the undo must not give both of them 2.
      const out = await ok<Listing>(await send('POST', '/api/groups/ungrouped/projects', { projects: ['GTC'] }));
      await assertDense();
      await ok(await send('POST', `/api/groups/${group.humanId}/projects`, { projects: ['GTD'] }));
      expect(await positionsIn(group.id)).toEqual({ GTA: 0, GTB: 1, GTD: 2 });
      await assertDense();

      await ok(await undo(out.auditEventIds?.[0] ?? ''));
      expect(await positionsIn(group.id)).toEqual({ GTA: 0, GTB: 1, GTC: 2, GTD: 3 });
      await assertDense();

      // A move out of the middle closes the gap behind it.
      await ok(await send('PATCH', '/api/projects/GTB', { group: null }));
      expect(await positionsIn(group.id)).toEqual({ GTA: 0, GTC: 1, GTD: 2 });
      await assertDense();
    });

    it('clamps an undone move to the end when its old index is past the end now', async () => {
      const group = await create({ name: `${PREFIX}Clamp` });
      await ok(await send('POST', `/api/groups/${group.humanId}/projects`, { projects: ['GTA', 'GTB', 'GTC'] }));
      const out = await ok<Listing>(await send('POST', '/api/groups/ungrouped/projects', { projects: ['GTC'] }));
      await ok(await send('POST', '/api/groups/ungrouped/projects', { projects: ['GTB'] }));

      await ok(await undo(out.auditEventIds?.[0] ?? ''));
      expect(await positionsIn(group.id)).toEqual({ GTA: 0, GTC: 1 });
    });

    it('refuses to undo the renumbering a move caused on its own, naming the move', async () => {
      const group = await create({ name: `${PREFIX}Caused` });
      await ok(await send('POST', `/api/groups/${group.humanId}/projects`, { projects: ['GTA', 'GTB', 'GTC'] }));
      const out = await ok<Listing>(await send('POST', '/api/groups/ungrouped/projects', { projects: ['GTA'] }));
      const events = await db.auditEvent.findMany({ where: { id: { in: out.auditEventIds ?? [] } } });
      const renumbering = events.find((e) => (e.after as { group?: string }).group === group.humanId);
      expect((renumbering?.after as { cause?: string } | undefined)?.cause).toContain('GTA');

      const res = await undo(renumbering?.id ?? '');
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/undo that change/);
      expect(await positionsIn(group.id)).toEqual({ GTB: 0, GTC: 1 });
    });

    it('closes up the groups on a delete, and an undone delete rejoins where it was', async () => {
      const a = await create({ name: `${PREFIX}G one` });
      const b = await create({ name: `${PREFIX}G two` });
      const c = await create({ name: `${PREFIX}G three` });
      const initial = (await listing()).items.map((g) => g.humanId);

      expect((await send('DELETE', `/api/groups/${b.humanId}`)).status).toBe(204);
      await assertDense();
      expect((await listing()).items.map((g) => g.humanId)).toEqual(initial.filter((id) => id !== b.humanId));

      await ok(await undo((await lastEvent('group', b.id)).id));
      await assertDense();
      expect((await listing()).items.map((g) => g.humanId)).toEqual(initial);
      expect(initial.indexOf(b.humanId)).toBe(initial.indexOf(a.humanId) + 1);
      expect(initial.indexOf(c.humanId)).toBe(initial.indexOf(b.humanId) + 1);
    });
  });

  describe('concurrent writes are serialised (FRM-REQ-225)', () => {
    type Snapshot = { groupId: string | null; groupPosition: number; updatedAt: string };
    const keyOf = (s: Snapshot) => JSON.stringify([s.groupId, s.groupPosition, s.updatedAt]);

    /**
     * The project's events since `seen` form one chain from `start` to the row as it stands: each
     * event's `before` is exactly the state the previous one left. A write that read a stale row —
     * a move decided on, or a `before` recorded from, a state another writer had already replaced —
     * breaks the chain, and a final state no event left means the last writer did not win.
     */
    const assertChain = async (projectId: string, start: Snapshot, seen: Set<string>) => {
      const events = (
        await db.auditEvent.findMany({ where: { entityType: 'project', entityId: projectId } })
      ).filter((e) => !seen.has(e.id) && (e.after as { event?: string }).event !== 'reorder');
      let current = keyOf(start);
      const left = [...events];
      while (left.length > 0) {
        // A write that changed no column leaves the row as it was, `updatedAt` included, so it
        // starts and ends where it found the row; taken first, it cannot hide a stale `before`.
        const starts = (e: (typeof left)[number]) => keyOf(e.before as Snapshot) === current;
        const unchanged = left.findIndex((e) => starts(e) && keyOf(e.after as Snapshot) === current);
        const next = unchanged === -1 ? left.findIndex(starts) : unchanged;
        expect(next, `no event starts from ${current}: ${JSON.stringify(left.map((e) => e.before))}`).not.toBe(-1);
        const [event] = left.splice(next, 1);
        current = keyOf(event?.after as Snapshot);
      }
      const final = await db.project.findUniqueOrThrow({ where: { id: projectId } });
      expect(current).toBe(
        keyOf({ groupId: final.groupId, groupPosition: final.groupPosition, updatedAt: final.updatedAt.toISOString() }),
      );
    };
    const snapshot = async (code: string) => {
      const row = await db.project.findUniqueOrThrow({ where: { code } });
      const seen = new Set(
        (await db.auditEvent.findMany({ where: { entityId: row.id }, select: { id: true } })).map((e) => e.id),
      );
      return {
        id: row.id,
        seen,
        start: { groupId: row.groupId, groupPosition: row.groupPosition, updatedAt: row.updatedAt.toISOString() },
      };
    };

    it('a PATCH racing a move: the PATCH reports its own write, and every before is the real prior state', async () => {
      const g1 = await create({ name: `${PREFIX}Race one` });
      const g2 = await create({ name: `${PREFIX}Race two` });
      for (let round = 0; round < 25; round++) {
        await ok(await send('PATCH', '/api/projects/GTA', { group: g1.humanId }));
        const { id, seen, start } = await snapshot('GTA');

        const [patched, moved] = await Promise.all([
          send('PATCH', '/api/projects/GTA', { group: g1.humanId }),
          send('POST', `/api/groups/${g2.humanId}/projects`, { projects: ['GTA'] }),
        ]);
        const body = await ok<{ groupId: string | null }>(patched);
        await ok(moved);
        // What the PATCH answered is what it wrote, not what a later move made of it.
        expect(body.groupId).toBe(g1.id);
        await assertChain(id, start, seen);
      }
      await assertDense();
    });

    it('a four-way race of PATCHes and moves leaves one consistent chain, round after round', async () => {
      const g1 = await create({ name: `${PREFIX}Four one` });
      const g2 = await create({ name: `${PREFIX}Four two` });
      await ok(await send('POST', `/api/groups/${g1.humanId}/projects`, { projects: ['GTB', 'GTC'] }));
      for (let round = 0; round < 25; round++) {
        await ok(await send('PATCH', '/api/projects/GTA', { group: g1.humanId }));
        const { id, seen, start } = await snapshot('GTA');

        const [toG1, toG2, toNone, atFront] = await Promise.all([
          send('PATCH', '/api/projects/GTA', { group: g1.humanId }),
          send('POST', `/api/groups/${g2.humanId}/projects`, { projects: ['GTA'] }),
          send('PATCH', '/api/projects/GTA', { group: null }),
          send('POST', `/api/groups/${g1.humanId}/projects`, { projects: ['GTA'], position: 0 }),
        ]);
        expect((await ok<{ groupId: string | null }>(toG1)).groupId).toBe(g1.id);
        expect((await ok<{ groupId: string | null }>(toNone)).groupId).toBeNull();
        await ok(toG2);
        await ok(atFront);
        await assertChain(id, start, seen);
        await assertDense();
      }
    });
  });

  describe('deleting a group (FRM-REQ-227)', () => {
    it('refuses while it holds projects, naming them', async () => {
      const group = await create({ name: `${PREFIX}Full` });
      await ok(await send('POST', `/api/groups/${group.humanId}/projects`, { projects: ['GTB', 'GTA'] }));

      const res = await send('DELETE', `/api/groups/${group.humanId}`);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; projects: string[] };
      expect(body.projects).toEqual(['GTB', 'GTA']);
      expect(body.error).toContain('GTB');
      expect((await db.projectGroup.findUniqueOrThrow({ where: { id: group.id } })).deletedAt).toBeNull();
    });

    it('soft-deletes an empty one, and undo restores it', async () => {
      const group = await create({ name: `${PREFIX}Empty` });
      expect((await send('DELETE', `/api/groups/${group.humanId}`)).status).toBe(204);

      const row = await db.projectGroup.findUniqueOrThrow({ where: { id: group.id } });
      expect(row.deletedAt).not.toBeNull();
      expect((await api(`/api/groups/${group.humanId}`)).status).toBe(404);
      expect((await listing()).items.map((g) => g.humanId)).not.toContain(group.humanId);

      const event = await lastEvent('group', group.id);
      expect(event.action).toBe('delete');
      await ok(await undo(event.id));
      expect((await ok<Group>(await api(`/api/groups/${group.humanId}`))).name).toBe(`${PREFIX}Empty`);
    });

    it('refuses to undo a deletion once a live group has taken the name', async () => {
      const group = await create({ name: `${PREFIX}Taken` });
      expect((await send('DELETE', `/api/groups/${group.humanId}`)).status).toBe(204);
      const event = await lastEvent('group', group.id);
      await create({ name: `${PREFIX}Taken` });

      expect((await undo(event.id)).status).toBe(409);
    });

    it('refuses to undo a creation while the group holds projects', async () => {
      const group = await create({ name: `${PREFIX}Created` });
      const creation = await lastEvent('group', group.id);
      await ok(await send('POST', `/api/groups/${group.humanId}/projects`, { projects: ['GTA'] }));

      const res = await undo(creation.id);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { projects: string[] }).projects).toEqual(['GTA']);
    });

    it('cannot be done to the ungrouped, which is not a group', async () => {
      expect((await send('DELETE', '/api/groups/ungrouped')).status).toBe(404);
      const entry = await ok<{ slug: string; humanId: null }>(await api('/api/groups/ungrouped'));
      expect(entry.slug).toBe('ungrouped');
      expect(entry.humanId).toBeNull();
    });
  });

  describe("a guideline's scope (FRM-REQ-235)", () => {
    const guideline = async (body: Record<string, unknown> = {}): Promise<Guideline> =>
      ok<Guideline>(
        await send('POST', '/api/guidelines', {
          title: `${PREFIX}scoped rule`,
          area: 'Design',
          decision: 'Plan UI on the board.',
          ...body,
        }),
        201,
      );

    it('applies to every project by default', async () => {
      const made = await guideline();
      expect(made.appliesTo).toBe('all');
      expect(made.groups).toEqual([]);
    });

    it('is set to a set of groups and back to all, and GET reads it', async () => {
      const d3 = await create({ name: `${PREFIX}D3` });
      const dormice = await create({ name: `${PREFIX}Mice` });
      const made = await guideline();

      const scoped = await ok<Guideline>(
        await send('PATCH', `/api/guidelines/${made.humanId}`, {
          appliesTo: 'groups',
          groups: [dormice.humanId, d3.humanId],
        }),
      );
      expect(scoped.appliesTo).toBe('groups');
      // In the groups' own order, not the order they were sent in.
      expect(scoped.groups).toEqual([d3.humanId, dormice.humanId]);
      const read = await ok<Guideline>(await api(`/api/guidelines/${made.humanId}`));
      expect(read.groups).toEqual([d3.humanId, dormice.humanId]);

      // The group's own read names it; the other group's does not once it is narrowed.
      await ok(await send('PATCH', `/api/guidelines/${made.humanId}`, { appliesTo: 'groups', groups: [d3.humanId] }));
      const d3Detail = await ok<{ guidelines: { humanId: string }[] }>(await api(`/api/groups/${d3.humanId}`));
      const miceDetail = await ok<{ guidelines: { humanId: string }[] }>(await api(`/api/groups/${dormice.humanId}`));
      expect(d3Detail.guidelines.map((g) => g.humanId)).toContain(made.humanId);
      expect(miceDetail.guidelines.map((g) => g.humanId)).not.toContain(made.humanId);

      const all = await ok<Guideline>(await send('PATCH', `/api/guidelines/${made.humanId}`, { appliesTo: 'all' }));
      expect(all.appliesTo).toBe('all');
      expect(all.groups).toEqual([]);
    });

    it('is taken on creation', async () => {
      const group = await create({ name: `${PREFIX}Born` });
      const made = await guideline({ appliesTo: 'groups', groups: [group.humanId] });
      expect(made.groups).toEqual([group.humanId]);
    });

    it('refuses groups with no group (400), and groups without appliesTo (400)', async () => {
      const made = await guideline();
      expect((await send('PATCH', `/api/guidelines/${made.humanId}`, { appliesTo: 'groups' })).status).toBe(400);
      expect((await send('PATCH', `/api/guidelines/${made.humanId}`, { appliesTo: 'groups', groups: [] })).status).toBe(400);
      expect((await send('PATCH', `/api/guidelines/${made.humanId}`, { groups: ['GRP-001'] })).status).toBe(400);
      expect((await send('PATCH', `/api/guidelines/${made.humanId}`, { appliesTo: 'all', groups: ['GRP-001'] })).status).toBe(400);
    });

    it('cannot name a deleted or unknown group (422)', async () => {
      const group = await create({ name: `${PREFIX}Deleted` });
      expect((await send('DELETE', `/api/groups/${group.humanId}`)).status).toBe(204);
      const made = await guideline();

      const deleted = await send('PATCH', `/api/guidelines/${made.humanId}`, { appliesTo: 'groups', groups: [group.humanId] });
      expect(deleted.status).toBe(422);
      expect(JSON.stringify(await deleted.json())).toContain(group.humanId);
      expect((await send('PATCH', `/api/guidelines/${made.humanId}`, { appliesTo: 'groups', groups: ['GRP-99999'] })).status).toBe(422);
      expect((await ok<Guideline>(await api(`/api/guidelines/${made.humanId}`))).appliesTo).toBe('all');
    });

    it('keeps a group a guideline names from being deleted', async () => {
      const group = await create({ name: `${PREFIX}Named` });
      const made = await guideline({ appliesTo: 'groups', groups: [group.humanId] });

      const res = await send('DELETE', `/api/groups/${group.humanId}`);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { guidelines: string[] }).guidelines).toEqual([made.humanId]);
    });

    it('undoes a scope change, groups included', async () => {
      const group = await create({ name: `${PREFIX}Undo scope` });
      const made = await guideline();
      await ok(await send('PATCH', `/api/guidelines/${made.humanId}`, { appliesTo: 'groups', groups: [group.humanId] }));
      const event = await lastEvent('guideline', made.id);

      await ok(await undo(event.id));
      const back = await ok<Guideline>(await api(`/api/guidelines/${made.humanId}`));
      expect(back.appliesTo).toBe('all');
      expect(back.groups).toEqual([]);
    });
  });

  it('never accepts GRP as a project code', async () => {
    const res = await send('POST', '/api/projects', { code: 'GRP', name: 'Not a group' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('GRP');
  });
});
