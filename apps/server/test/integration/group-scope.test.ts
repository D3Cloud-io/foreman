import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * A scope over the cross-project reads (FRM-T-17.4; FRM-ADR-024).
 *
 * `/api/portfolio`, `/api/findings`, `/api/search` and `/api/drift` each take `?group=` — a
 * `GRP-n`, a slug in any case, or `ungrouped` — and resolve it the same way, so "Dormice" means
 * the same projects on every one of them. An unknown group, `all`, or a deleted one is a 404 on
 * all four: a link to "Dormice's findings" that quietly answered with everybody's would be a
 * wrong answer delivered confidently.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'group-scope@example.com';
const PASSWORD = 'a-password-for-the-group-scope-tests';
const PREFIX = 'GS ';
/** GSA in D3 Cloud; GSB and GSC in Dormice; GSU in no group. */
const CODES = ['GSA', 'GSB', 'GSC', 'GSU'] as const;
const NEEDLE = 'gsneedlescope';

interface Group {
  humanId: string;
  slug: string;
}
interface FindingRow {
  humanId: string;
  project: string;
}
interface Hit {
  type: string;
  humanId: string | null;
  projectCode: string | null;
}
interface ProjectDrift {
  project: string;
  name: string;
  total: number;
  counts: Record<string, number>;
  items: { category: string; humanId: string }[];
}
interface DriftAcross {
  items: ProjectDrift[];
  total: number;
  drift: { total: number; counts: Record<string, number> };
}

describe.skipIf(url === undefined)('a group scope on the cross-project reads', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;
  let d3: Group;
  let dormice: Group;
  /** Each project's finding, by code. */
  const findingOf = new Map<string, string>();

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
  const ours = (code: string | null) => code !== null && (CODES as readonly string[]).includes(code);

  const findings = async (query: string) =>
    (await json<{ items: FindingRow[] }>(await api(`/api/findings?limit=200&${query}`))).items.filter((f) =>
      ours(f.project),
    );
  const search = async (q: string, query = '') =>
    (await json<{ items: Hit[] }>(await api(`/api/search?q=${encodeURIComponent(q)}&limit=100${query}`))).items;
  const drift = async (query = '') => json<DriftAcross>(await api(`/api/drift${query}`));

  const cleanUp = async () => {
    await db.project.deleteMany({ where: { code: { in: [...CODES] } } });
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
    const user = await db.user.create({ data: { email: EMAIL, displayName: 'Group scope', status: 'active' } });
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

    d3 = await json<Group>(await post('/api/groups', { name: `${PREFIX}D3 Cloud`, accent: 'foreman' }), 201);
    dormice = await json<Group>(await post('/api/groups', { name: `${PREFIX}Dormice` }), 201);

    const placement: Record<(typeof CODES)[number], string | null> = {
      GSA: d3.humanId,
      GSB: dormice.humanId,
      GSC: dormice.slug,
      GSU: null,
    };
    for (const code of CODES) {
      await json(await post('/api/projects', { code, name: `GS ${code}`, group: placement[code] }), 201);
      const finding = await json<{ humanId: string }>(
        await post(`/api/projects/${code}/findings`, { title: `${NEEDLE} in ${code}`, severity: 'high' }),
        201,
      );
      findingOf.set(code, finding.humanId);
      // A Must no task satisfies: one coverage hole of drift each.
      await json(
        await post(`/api/projects/${code}/requirements`, { statement: `${NEEDLE} must hold for ${code}`, priority: 'M' }),
        201,
      );
    }
  });

  afterAll(async () => {
    await cleanUp();
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  it('narrows the findings inbox to a group, by slug in any case or by GRP-n', async () => {
    const everyone = await findings('');
    expect(everyone.map((f) => f.project).sort()).toEqual(['GSA', 'GSB', 'GSC', 'GSU']);

    for (const ref of [dormice.slug, dormice.slug.toUpperCase(), dormice.humanId]) {
      const scoped = await findings(`group=${encodeURIComponent(ref)}`);
      expect(scoped.map((f) => f.project).sort(), ref).toEqual(['GSB', 'GSC']);
    }
    // The whole answer, not only ours: nothing from outside Dormice gets in.
    const whole = await json<{ items: FindingRow[] }>(await api(`/api/findings?limit=200&group=${dormice.slug}`));
    expect(whole.items.every((f) => f.project === 'GSB' || f.project === 'GSC')).toBe(true);

    expect((await findings(`group=${d3.slug}`)).map((f) => f.project)).toEqual(['GSA']);
    const ungrouped = (await findings('group=ungrouped')).map((f) => f.project);
    expect(ungrouped).toEqual(['GSU']);
  });

  it('keeps a project filter inside the scope: a project outside it matches nothing', async () => {
    expect((await findings(`group=${dormice.slug}&project=GSB`)).map((f) => f.project)).toEqual(['GSB']);
    expect(await findings(`group=${dormice.slug}&project=GSA`)).toEqual([]);
  });

  it('narrows search to a group, the exact-ID answer included', async () => {
    const everywhere = await search(NEEDLE);
    expect(new Set(everywhere.filter((h) => ours(h.projectCode)).map((h) => h.projectCode))).toEqual(
      new Set(CODES),
    );

    const scoped = await search(NEEDLE, `&group=${dormice.slug}`);
    expect(scoped.length).toBeGreaterThan(0);
    expect(new Set(scoped.map((h) => h.projectCode))).toEqual(new Set(['GSB', 'GSC']));
    // Both kinds that matched are scoped: the finding and the requirement.
    expect(new Set(scoped.map((h) => h.type))).toEqual(new Set(['finding', 'requirement']));

    // A pasted ID from outside the scope is not answered from inside it.
    const outside = findingOf.get('GSA') ?? '';
    expect((await search(outside)).some((h) => h.humanId === outside)).toBe(true);
    expect((await search(outside, `&group=${dormice.slug}`)).some((h) => h.humanId === outside)).toBe(false);
    const inside = findingOf.get('GSB') ?? '';
    expect((await search(inside, `&group=${dormice.humanId}`))[0]?.humanId).toBe(inside);

    // …but it says where the record is, so the console can offer it instead of "nothing matches".
    const hidden = await json<{ items: Hit[]; outside: (Hit & { group: { name: string; slug: string } | null }) | null }>(
      await api(`/api/search?q=${encodeURIComponent(outside)}&group=${dormice.slug}`),
    );
    expect(hidden.outside).toMatchObject({
      type: 'finding',
      humanId: outside,
      projectCode: 'GSA',
      group: { name: `${PREFIX}D3 Cloud`, slug: d3.slug },
    });
    const unscoped = await json<{ outside: unknown }>(await api(`/api/search?q=${encodeURIComponent(outside)}`));
    expect(unscoped.outside).toBeNull();
    const ungroupedOutside = await json<{ outside: { group: unknown } | null }>(
      await api(`/api/search?q=${encodeURIComponent(findingOf.get('GSU') ?? '')}&group=${dormice.slug}`),
    );
    expect(ungroupedOutside.outside?.group).toBeNull();
    const found = await json<{ outside: unknown }>(
      await api(`/api/search?q=${encodeURIComponent(inside)}&group=${dormice.slug}`),
    );
    expect(found.outside).toBeNull();

    const ungrouped = await search(NEEDLE, '&group=ungrouped');
    expect(ungrouped.filter((h) => ours(h.projectCode)).map((h) => h.projectCode)).toEqual(
      expect.arrayContaining(['GSU']),
    );
    expect(ungrouped.some((h) => h.projectCode === 'GSA' || h.projectCode === 'GSB')).toBe(false);
  });

  it('reads drift across a group’s projects, in the group’s order, summed', async () => {
    const scoped = await drift(`?group=${dormice.slug}`);
    expect(scoped.items.map((p) => p.project)).toEqual(['GSB', 'GSC']);
    expect(scoped.total).toBe(2);
    expect(scoped.items[0]?.name).toBe('GS GSB');
    for (const project of scoped.items) {
      expect(project.items.some((item) => item.category === 'coverage-hole')).toBe(true);
    }
    expect(scoped.drift.total).toBe(scoped.items.reduce((sum, p) => sum + p.total, 0));
    expect(scoped.drift.counts['coverage-hole']).toBeGreaterThanOrEqual(2);

    // The same engine as a project's own drift view, so the two agree.
    const own = await json<{ total: number }>(await api('/api/projects/GSB/drift'));
    expect(scoped.items[0]?.total).toBe(own.total);

    const all = await drift();
    const codes = all.items.map((p) => p.project);
    for (const code of CODES) expect(codes).toContain(code);
    // Home's order: groups in their order, the ungrouped last.
    expect(codes.indexOf('GSB')).toBeLessThan(codes.indexOf('GSC'));
    expect(codes.indexOf('GSC')).toBeLessThan(codes.indexOf('GSU'));

    expect((await drift('?group=ungrouped')).items.map((p) => p.project)).toContain('GSU');
    expect((await drift('?group=ungrouped')).items.map((p) => p.project)).not.toContain('GSA');
  });

  it('agrees with the portfolio about who is in a scope', async () => {
    const portfolio = await json<{ items: { code: string }[] }>(await api(`/api/portfolio?group=${dormice.slug}`));
    const scopedDrift = await drift(`?group=${dormice.slug}`);
    expect(portfolio.items.map((p) => p.code).sort()).toEqual(scopedDrift.items.map((p) => p.project).sort());
  });

  it('answers 404 for an unknown group, for "all", and for a deleted one — on every read', async () => {
    const empty = await json<Group>(await post('/api/groups', { name: `${PREFIX}Gone` }), 201);
    expect((await api(`/api/groups/${empty.humanId}`, { method: 'DELETE' })).status).toBeLessThan(300);

    for (const ref of ['no-such-group', 'all', empty.slug, empty.humanId]) {
      for (const path of [
        `/api/portfolio?group=${ref}`,
        `/api/findings?group=${ref}`,
        `/api/search?q=${NEEDLE}&group=${ref}`,
        `/api/drift?group=${ref}`,
      ]) {
        expect((await api(path)).status, path).toBe(404);
      }
    }
  });

  it('treats an empty group as no scope at all', async () => {
    expect((await findings('group=')).map((f) => f.project).sort()).toEqual(['GSA', 'GSB', 'GSC', 'GSU']);
  });
});
