import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
// Source, not the package name, as in `mcp.test.ts`: `exports` points at the published `dist`.
import { createClient } from '../../../../packages/mcp/src/client.js';
import { createServer as createMcpServer } from '../../../../packages/mcp/src/server.js';
import {
  MAX_TOOLS,
  TOOL_DEFINITION_TOKEN_BUDGET,
  toolDefinitionTokens,
} from '../../../../packages/mcp/src/tools/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { GUIDELINES_TOKEN_BUDGET, approximateTokens } from '../../src/domain/brief.js';

/**
 * Groups through the real MCP server (FRM-T-17.2; FRM-ADR-024, FRM-REQ-236 … FRM-REQ-239).
 *
 * The shim against a real Foreman, as `mcp.test.ts` runs it: a real write token, HTTP to the
 * Express app, a database behind it. What it asserts is that a session can do everything groups
 * need without a thirteenth tool — make a group, put a project in one, move it, read a group back —
 * and that what it reads is honest about scope: a Dormice project's brief does not carry a rule
 * scoped to D3 Cloud.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'groups-mcp@example.com';
const PASSWORD = 'a-password-for-the-group-mcp-tests';
const PREFIX = 'GM ';
/** GMA in D3 Cloud; GMB and GMC in Dormice, in that order; GMU in no group. */
const CODES = ['GMA', 'GMB', 'GMC', 'GMU'] as const;

interface GroupRow {
  humanId: string;
  name: string;
  slug: string;
  description: string | null;
  siteUrl: string | null;
  accent: string;
}
interface PortfolioRow {
  code: string;
  group: { humanId: string; slug: string } | null;
}
interface PortfolioGroup {
  humanId: string;
  name: string;
  slug: string;
  accent: string;
  siteUrl: string | null;
  projects: PortfolioRow[];
}
interface ScopedGuideline {
  humanId: string;
  title: string;
  decision: string;
  appliesTo: 'all' | 'groups';
  groups: string[];
}
interface Portfolio {
  items?: PortfolioRow[];
  groups: PortfolioGroup[];
  ungrouped: { humanId: null; slug: string; projects: PortfolioRow[] } | null;
  guidelines: ScopedGuideline[];
}
interface Brief {
  project: { code: string; group: { humanId: string; name: string; slug: string } | null };
  guidelines: { humanId: string; title: string; decision: string; appliesTo?: string }[];
}

describe.skipIf(url === undefined)('groups through the MCP server', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;
  let writeToken: string;
  let mcp: Client;

  let d3: GroupRow;
  let dormice: GroupRow;
  /** Scoped to D3 Cloud, to Dormice, and to every project. */
  let forD3: string;
  let forDormice: string;
  let forAll: string;

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
  const post = (path: string, body: unknown) =>
    api(path, { method: 'POST', body: JSON.stringify(body) });

  const text = (result: unknown): string => {
    const content = (result as { content?: { text?: string }[] }).content;
    return (content ?? []).map((part) => part.text ?? '').join('\n');
  };
  /** Call a tool and parse its JSON, failing with the tool's own message if it errored. */
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await mcp.callTool({ name, arguments: args });
    expect(result.isError, text(result)).toBeFalsy();
    return JSON.parse(text(result)) as T;
  };
  const projectGroup = async (code: string) =>
    (await json<{ group: { humanId: string } | null }>(await api(`/api/projects/${code}`))).group
      ?.humanId ?? null;

  const cleanUp = async () => {
    await db.guideline.deleteMany({ where: { title: { startsWith: PREFIX } } });
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
    const user = await db.user.create({
      data: { email: EMAIL, displayName: 'Groups MCP', status: 'active' },
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
    writeToken = (
      await json<{ token: string }>(
        await post('/api/tokens', { name: 'groups mcp write', scopes: ['read', 'write'] }),
        201,
      )
    ).token;

    const shim = createMcpServer({ client: createClient({ baseUrl: origin, token: writeToken }) });
    mcp = new Client({ name: 'groups-e2e', version: '0.0.0' }, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(a), shim.connect(b)]);
  });

  afterAll(async () => {
    await cleanUp();
    await db.apiToken.deleteMany({ where: { name: 'groups mcp write' } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  it('keeps the surface at twelve tools, inside the definition budget', async () => {
    const { tools } = await mcp.listTools();
    expect(tools).toHaveLength(MAX_TOOLS);
    expect(toolDefinitionTokens()).toBeLessThan(TOOL_DEFINITION_TOKEN_BUDGET);
    // And measured over what the server actually sends, not only over the source definitions.
    const wire = tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    expect(Math.ceil(JSON.stringify(wire).length / 4)).toBeLessThan(TOOL_DEFINITION_TOKEN_BUDGET);
  });

  it('makes a group with foreman_create kind group (FRM-REQ-238)', async () => {
    d3 = await call<GroupRow>('foreman_create', {
      kind: 'group',
      text: `${PREFIX}D3 Cloud`,
      pitch: 'The connected ecosystem.',
      siteUrl: 'https://d3cloud.io',
      accent: 'foreman',
    });
    expect(d3.humanId).toMatch(/^GRP-\d{3,}$/);
    expect(d3).toMatchObject({
      slug: 'gm-d3-cloud',
      description: 'The connected ecosystem.',
      siteUrl: 'https://d3cloud.io',
      accent: 'foreman',
    });
    dormice = await call<GroupRow>('foreman_create', { kind: 'group', text: `${PREFIX}Dormice` });
    expect(dormice.accent).toBe('neutral');

    // A group belongs to no project; a refusal, not a group filed somewhere it cannot live.
    const refused = await mcp.callTool({
      name: 'foreman_create',
      arguments: { project: 'GMA', kind: 'group', text: `${PREFIX}Nowhere` },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/a group belongs to no project/);
  });

  it('puts a project in a group with foreman_create kind project, by ID or slug', async () => {
    await call('foreman_create', { project: 'GMA', kind: 'project', text: 'GM Alpha', group: d3.slug });
    await call('foreman_create', { project: 'GMB', kind: 'project', text: 'GM Bravo', group: dormice.humanId });
    await call('foreman_create', { project: 'GMC', kind: 'project', text: 'GM Charlie', group: dormice.slug });
    await call('foreman_create', { project: 'GMU', kind: 'project', text: 'GM Ungrouped' });

    expect(await projectGroup('GMA')).toBe(d3.humanId);
    expect(await projectGroup('GMB')).toBe(dormice.humanId);
    expect(await projectGroup('GMC')).toBe(dormice.humanId);
    expect(await projectGroup('GMU')).toBeNull();

    // An unknown group is a bad value for the field, and nothing is created.
    const unknown = await mcp.callTool({
      name: 'foreman_create',
      arguments: { project: 'GMX', kind: 'project', text: 'GM X', group: 'no-such-group' },
    });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain('422');
    expect(await db.project.count({ where: { code: 'GMX' } })).toBe(0);
  });

  it('moves a project between groups with foreman_update, and null clears it', async () => {
    await call('foreman_update', { id: 'GMC', group: d3.humanId });
    expect(await projectGroup('GMC')).toBe(d3.humanId);

    await call('foreman_update', { id: 'GMC', group: null });
    expect(await projectGroup('GMC')).toBeNull();

    // Back to Dormice, at the end of it — after GMB, which is the order the portfolio reads.
    await call('foreman_update', { id: 'GMC', group: dormice.slug });
    expect(await projectGroup('GMC')).toBe(dormice.humanId);

    // A group on anything but a project is refused by name rather than dropped.
    const onTask = await mcp.callTool({
      name: 'foreman_update',
      arguments: { id: 'GMC-T-1.1', group: dormice.slug },
    });
    expect(onTask.isError).toBe(true);
    expect(text(onTask)).toMatch(/which has no group/);
  });

  it('carries each project’s group on /api/projects', async () => {
    const page = await json<{ items: PortfolioRow[] }>(await api('/api/projects?limit=200'));
    const ours = page.items.filter((p) => (CODES as readonly string[]).includes(p.code));
    expect(Object.fromEntries(ours.map((p) => [p.code, p.group?.humanId ?? null]))).toEqual({
      GMA: d3.humanId,
      GMB: dormice.humanId,
      GMC: dormice.humanId,
      GMU: null,
    });
    expect(ours.find((p) => p.code === 'GMA')?.group).toMatchObject({ slug: d3.slug });
  });

  describe('guidelines by scope', () => {
    beforeAll(async () => {
      const guideline = async (title: string, scope: Record<string, unknown>) =>
        (
          await json<{ humanId: string }>(
            await post('/api/guidelines', {
              title: `${PREFIX}${title}`,
              area: 'Design',
              decision: `${title}.`,
              ...scope,
            }),
            201,
          )
        ).humanId;
      forD3 = await guideline('Plan UI on the D3 Design Language board', {
        appliesTo: 'groups',
        groups: [d3.humanId],
      });
      forDormice = await guideline('No theme is the theme', {
        appliesTo: 'groups',
        groups: [dormice.humanId],
      });
      forAll = await guideline('No time estimates', {});
    });

    /** Every active guideline that applies to every project, from the API rather than assumed. */
    const everywhere = async () =>
      (
        await json<{ items: { humanId: string; status: string; appliesTo: string }[] }>(
          await api('/api/guidelines'),
        )
      ).items
        .filter((g) => g.status === 'active' && g.appliesTo === 'all')
        .map((g) => g.humanId);

    it('gives a Dormice project a brief without D3 Cloud’s guideline, with every all-projects one (FRM-REQ-236)', async () => {
      const brief = await call<Brief>('foreman_brief', { project: 'GMB' });
      const ids = brief.guidelines.map((g) => g.humanId);

      expect(brief.project.group).toEqual({
        humanId: dormice.humanId,
        name: dormice.name,
        slug: dormice.slug,
      });
      expect(ids).not.toContain(forD3);
      expect(ids).toContain(forDormice);
      expect(ids).toContain(forAll);
      for (const id of await everywhere()) expect(ids).toContain(id);
      // A family's rule says it is one; an ecosystem rule carries nothing more than it did.
      expect(brief.guidelines.find((g) => g.humanId === forDormice)?.appliesTo).toBe('groups');
      expect(brief.guidelines.find((g) => g.humanId === forAll)).not.toHaveProperty('appliesTo');
      expect(approximateTokens(brief.guidelines)).toBeLessThan(GUIDELINES_TOKEN_BUDGET);
    });

    it('gives an ungrouped project only the all-projects guidelines', async () => {
      const brief = await call<Brief>('foreman_brief', { project: 'GMU' });
      const ids = brief.guidelines.map((g) => g.humanId);
      expect(brief.project.group).toBeNull();
      expect(ids).not.toContain(forD3);
      expect(ids).not.toContain(forDormice);
      expect([...ids].sort()).toEqual((await everywhere()).sort());
    });

    it('lists projects under their groups in order, the ungrouped last (FRM-REQ-237)', async () => {
      const portfolio = await call<Portfolio>('foreman_portfolio', {});
      expect(portfolio).not.toHaveProperty('items');

      // In the groups' own order, which `/api/groups` is the authority on.
      const order = (
        await json<{ items: { humanId: string }[] }>(await api('/api/groups'))
      ).items.map((g) => g.humanId);
      expect(portfolio.groups.map((g) => g.humanId)).toEqual(order);
      const ours = portfolio.groups.filter((g) => [d3.humanId, dormice.humanId].includes(g.humanId));
      expect(ours.map((g) => g.humanId)).toEqual([d3.humanId, dormice.humanId]);

      const members = (g: PortfolioGroup | undefined) =>
        (g?.projects ?? []).map((p) => p.code).filter((c) => c.startsWith('GM'));
      expect(members(ours[0])).toEqual(['GMA']);
      expect(members(ours[1])).toEqual(['GMB', 'GMC']);
      expect(ours[0]).toMatchObject({ name: d3.name, slug: d3.slug, accent: 'foreman', siteUrl: 'https://d3cloud.io' });
      // The section rows are the portfolio's own rows, with the counts and drift they always had.
      expect(ours[1]?.projects[0]).toMatchObject({ code: 'GMB', group: { humanId: dormice.humanId } });
      expect(ours[1]?.projects[0]).toHaveProperty('drift.total');

      const ungrouped = (portfolio.ungrouped?.projects ?? []).map((p) => p.code);
      expect(ungrouped).toContain('GMU');
      expect(ungrouped).not.toContain('GMA');

      // Each guideline with its scope.
      const scoped = portfolio.guidelines.find((g) => g.humanId === forD3);
      expect(scoped).toMatchObject({ appliesTo: 'groups', groups: [d3.humanId] });
      expect(portfolio.guidelines.find((g) => g.humanId === forAll)).toMatchObject({
        appliesTo: 'all',
        groups: [],
      });
    });

    it('narrows the portfolio to one group with group', async () => {
      for (const ref of [dormice.humanId, dormice.slug]) {
        const portfolio = await call<Portfolio>('foreman_portfolio', { group: ref });
        expect(portfolio.groups.map((g) => g.humanId)).toEqual([dormice.humanId]);
        expect(portfolio.groups[0]?.projects.map((p) => p.code)).toEqual(['GMB', 'GMC']);
        expect(portfolio.ungrouped).toBeNull();
        const ids = portfolio.guidelines.map((g) => g.humanId);
        expect(ids).toContain(forDormice);
        expect(ids).toContain(forAll);
        expect(ids).not.toContain(forD3);
      }

      const ungrouped = await call<Portfolio>('foreman_portfolio', { group: 'ungrouped' });
      expect(ungrouped.groups).toEqual([]);
      const codes = (ungrouped.ungrouped?.projects ?? []).map((p) => p.code);
      expect(codes).toContain('GMU');
      expect(codes).not.toContain('GMB');
      expect(ungrouped.guidelines.every((g) => g.appliesTo === 'all')).toBe(true);

      const unknown = await mcp.callTool({ name: 'foreman_portfolio', arguments: { group: 'GRP-999999' } });
      expect(unknown.isError).toBe(true);
      expect(text(unknown)).toContain('404');
    });

    it('returns a group, its projects in order and its guidelines from foreman_get GRP-n (FRM-REQ-239)', async () => {
      const found = await call<{
        type: string;
        humanId: string;
        projectCode: string | null;
        entity: GroupRow & {
          projects: { code: string; position: number }[];
          guidelines: { humanId: string; appliesTo: string }[];
        };
      }>('foreman_get', { id: dormice.humanId });

      expect(found.type).toBe('group');
      expect(found.humanId).toBe(dormice.humanId);
      expect(found.projectCode).toBeNull();
      expect(found.entity).toMatchObject({ humanId: dormice.humanId, name: dormice.name, slug: dormice.slug });
      expect(found.entity.projects.map((p) => p.code)).toEqual(['GMB', 'GMC']);
      expect(found.entity.projects.map((p) => p.position)).toEqual([0, 1]);
      const ids = found.entity.guidelines.map((g) => g.humanId);
      expect(ids).toContain(forDormice);
      expect(ids).toContain(forAll);
      expect(ids).not.toContain(forD3);

      const missing = await mcp.callTool({ name: 'foreman_get', arguments: { id: 'GRP-999999' } });
      expect(missing.isError).toBe(true);
      expect(text(missing)).toContain('404');
    });
  });

  it('carries groups on /api/portfolio, keeping the flat items for older readers', async () => {
    const portfolio = await json<Portfolio & { items: PortfolioRow[]; total: number }>(
      await api('/api/portfolio'),
    );
    expect(portfolio.items.map((p) => p.code)).toEqual([...portfolio.items.map((p) => p.code)].sort());
    expect(portfolio.total).toBe(portfolio.items.length);
    expect(portfolio.items.find((p) => p.code === 'GMB')?.group).toMatchObject({ humanId: dormice.humanId });
    expect(portfolio.items.find((p) => p.code === 'GMU')?.group).toBeNull();

    // Every row is in exactly one section.
    const sectioned = [
      ...portfolio.groups.flatMap((g) => g.projects),
      ...(portfolio.ungrouped?.projects ?? []),
    ].map((p) => p.code);
    expect([...sectioned].sort()).toEqual(portfolio.items.map((p) => p.code));

    const narrowed = await json<Portfolio & { items: PortfolioRow[] }>(
      await api(`/api/portfolio?group=${d3.humanId}`),
    );
    expect(narrowed.items.map((p) => p.code)).toEqual(['GMA']);
    expect((await api('/api/portfolio?group=no-such-group')).status).toBe(404);
  });
});
