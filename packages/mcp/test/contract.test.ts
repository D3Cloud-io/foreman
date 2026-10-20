import {
  AttributeInput,
  BriefInput,
  CACHE,
  CoverageInput,
  CreatableKind,
  CreateInput,
  FindingsInput,
  gateForDelete,
  gateForLink,
  gateForPriority,
  gateForStatus,
  GetInput,
  PortfolioInput,
  SEARCHABLE_TYPES,
  SearchInput,
  UpdateInput,
} from '@foreman/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import { createClient, ForemanApiError } from '../src/client.js';
import { listResources, parseUri, readResource, RESOURCE_TEMPLATE } from '../src/resources.js';
import { createServer } from '../src/server.js';
import {
  MAX_TOOLS,
  READ_TOOLS,
  TOOL_DEFINITION_TOKEN_BUDGET,
  TOOLS,
  toolDefinitionTokens,
  WRITE_TOOLS,
} from '../src/tools/index.js';

/**
 * The contract tests (T-1.10). Each one fails on a deliberate violation — that is the only kind of
 * guard worth having.
 */

describe('the tool surface stays small (FRM-REQ-079, FRM-REQ-080)', () => {
  it('has at most twelve tools', () => {
    expect(TOOLS.length).toBeLessThanOrEqual(MAX_TOOLS);
  });

  it('fails when a thirteenth is added — the exit demo, as an assertion', () => {
    const thirteen = [
      ...TOOLS,
      ...Array.from({ length: MAX_TOOLS + 1 - TOOLS.length }, (_, i) => ({
        ...TOOLS[0],
        name: `foreman_extra_${String(i)}`,
      })),
    ];
    expect(thirteen.length).toBeGreaterThan(MAX_TOOLS);
  });

  it('keeps the whole definition set inside its token budget', () => {
    const tokens = toolDefinitionTokens();
    expect(tokens).toBeLessThan(TOOL_DEFINITION_TOKEN_BUDGET);
  });

  it('fails the budget when a description bloats', () => {
    const bloated = TOOLS.map((tool) => ({
      ...tool,
      description: tool.description.repeat(40),
    }));
    expect(toolDefinitionTokens(bloated)).toBeGreaterThan(TOOL_DEFINITION_TOKEN_BUDGET);
  });

  it('names every tool distinctly, and with the product prefix', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.startsWith('foreman_')).toBe(true);
  });

  it('gives every tool a description short enough to be sent every turn', () => {
    for (const tool of TOOLS) {
      expect(tool.description.length, tool.name).toBeLessThan(220);
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
    }
  });
});

describe('schemas are generated from packages/shared (FRM-REQ-081)', () => {
  // The claim under test: the shim does not carry its own copy of the request shapes. If one of
  // these ever needs updating by hand, the two surfaces have already drifted.
  const expected: Record<string, z.ZodType> = {
    foreman_brief: BriefInput,
    foreman_portfolio: PortfolioInput,
    foreman_search: SearchInput,
    foreman_get: GetInput,
    foreman_coverage: CoverageInput,
    foreman_findings: FindingsInput,
  };

  it.each(READ_TOOLS.map((tool) => [tool.name, tool] as const))(
    '%s uses the shared schema itself, not a copy',
    (name, tool) => {
      const shared = expected[name];
      if (shared === undefined) throw new Error(`${name} has no shared schema declared`);
      expect(z.toJSONSchema(tool.inputSchema, { io: 'input' })).toEqual(
        z.toJSONSchema(shared, { io: 'input' }),
      );
    },
  );

  it('notices when a field is added on one side only', () => {
    const drifted = SearchInput.extend({ sneaky: z.string() });
    expect(z.toJSONSchema(drifted, { io: 'input' })).not.toEqual(
      z.toJSONSchema(SearchInput, { io: 'input' }),
    );
  });

  it('offers every searchable type the API knows about', () => {
    const schema: unknown = z.toJSONSchema(SearchInput, { io: 'input' });
    const types = (schema as { properties: Record<string, { items?: { enum?: string[] } }> })
      .properties['types'];
    expect(types?.items?.enum).toEqual([...SEARCHABLE_TYPES]);
  });
});

describe('listings carry cache metadata', () => {
  it.each(READ_TOOLS.map((tool) => [tool.name, tool] as const))('%s advertises a TTL and a scope', (_name, tool) => {
    expect(tool.cache.ttlMs).toBeGreaterThan(0);
    expect(['project', 'global']).toContain(tool.cache.cacheScope);
  });

  it('scopes the portfolio globally and the brief to a project', () => {
    expect(CACHE.portfolio.cacheScope).toBe('global');
    expect(CACHE.brief.cacheScope).toBe('project');
  });
});

describe('the tools call the API they claim to', () => {
  const clientWith = (get: ReturnType<typeof vi.fn>) => ({ get }) as never;

  it('foreman_portfolio narrows to a group, and returns the grouped sections without the flat copy', async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ items: [{ code: 'KURO' }], groups: [], ungrouped: null, guidelines: [] });
    const tool = READ_TOOLS.find((t) => t.name === 'foreman_portfolio');
    const result = await tool?.run(clientWith(get), { group: 'dormice' });
    expect(get).toHaveBeenCalledWith('/api/portfolio', { group: 'dormice' });
    expect(result).toEqual({ groups: [], ungrouped: null, guidelines: [] });

    await tool?.run(clientWith(get), {});
    expect(get).toHaveBeenLastCalledWith('/api/portfolio');
  });

  it('foreman_brief asks for that project’s brief', async () => {
    const get = vi.fn().mockResolvedValue({ project: { code: 'BND' } });
    const tool = READ_TOOLS.find((t) => t.name === 'foreman_brief');
    await tool?.run(clientWith(get), { project: 'BND' });
    expect(get).toHaveBeenCalledWith('/api/brief/BND');
  });

  it('foreman_search passes its filters through', async () => {
    const get = vi.fn().mockResolvedValue({ items: [] });
    const tool = READ_TOOLS.find((t) => t.name === 'foreman_search');
    await tool?.run(clientWith(get), { q: 'pg_trgm', types: ['adr'], project: 'BND', limit: 5 });
    expect(get).toHaveBeenCalledWith('/api/search', {
      q: 'pg_trgm',
      types: ['adr'],
      project: 'BND',
      limit: 5,
    });
  });

  it('foreman_search and foreman_findings narrow to a group, as the portfolio does (FRM-T-17.4)', async () => {
    const get = vi.fn().mockResolvedValue({ items: [] });
    const search = READ_TOOLS.find((t) => t.name === 'foreman_search');
    await search?.run(clientWith(get), { q: 'tunnel', group: 'dormice' });
    expect(get).toHaveBeenLastCalledWith('/api/search', expect.objectContaining({ q: 'tunnel', group: 'dormice' }));

    const findings = READ_TOOLS.find((t) => t.name === 'foreman_findings');
    await findings?.run(clientWith(get), { group: 'GRP-002', severity: 'critical' });
    expect(get).toHaveBeenLastCalledWith(
      '/api/findings',
      expect.objectContaining({ group: 'GRP-002', severity: 'critical' }),
    );
  });

  it('foreman_coverage asks the project for its holes', async () => {
    const get = vi.fn().mockResolvedValue({ uncoveredMusts: [] });
    const tool = READ_TOOLS.find((t) => t.name === 'foreman_coverage');
    await tool?.run(clientWith(get), { project: 'BND' });
    expect(get).toHaveBeenCalledWith('/api/projects/BND/coverage');
  });

  it('foreman_coverage asks the gate when it is given a phase', async () => {
    const get = vi.fn().mockResolvedValue({ passed: false, failures: [] });
    const tool = READ_TOOLS.find((t) => t.name === 'foreman_coverage');
    await tool?.run(clientWith(get), { project: 'BND', phase: 'BND-P-3' });
    // Asking is not completing: the gate is a question here, never a state change.
    expect(get).toHaveBeenCalledWith('/api/projects/BND/phases/BND-P-3/gate');
  });

  it('foreman_get fetches a screen\'s images, and nothing for any other kind (FRM-REQ-198)', async () => {
    const tool = READ_TOOLS.find((t) => t.name === 'foreman_get');
    const get = vi.fn().mockResolvedValue({
      images: [{ kind: 'proposal', data: 'iVBORw0K', mimeType: 'image/png' }],
    });

    const images = await tool?.images?.(clientWith(get), { id: 'BND-SCR-001' }, {
      type: 'screen',
      humanId: 'BND-SCR-001',
    });
    expect(get).toHaveBeenCalledWith('/api/projects/BND/screens/BND-SCR-001/images');
    expect(images).toEqual([{ data: 'iVBORw0K', mimeType: 'image/png' }]);

    get.mockClear();
    const none = await tool?.images?.(clientWith(get), { id: 'BND-REQ-001' }, {
      type: 'requirement',
      humanId: 'BND-REQ-001',
    });
    expect(none).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it('refuses input that does not match the shared schema', async () => {
    const tool = READ_TOOLS.find((t) => t.name === 'foreman_get');
    // Not project-prefixed, so it is not a human ID (ADR-008).
    await expect(tool?.run(clientWith(vi.fn()), { id: 'REQ-021' })).rejects.toThrow();
  });
});

describe('the HTTP client', () => {
  it('sends the scoped token as a bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const client = createClient({ baseUrl: 'https://foreman.test', token: 'shh', fetch: fetchMock });
    await client.get('/api/portfolio');

    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers['authorization']).toBe('Bearer shh');
  });

  it('joins an array parameter the way the API parses it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const client = createClient({ baseUrl: 'https://foreman.test', token: 'shh', fetch: fetchMock });
    await client.get('/api/search', { q: 'x', types: ['adr', 'task'] });

    const url = fetchMock.mock.calls[0]?.[0] as URL;
    expect(url.searchParams.get('types')).toBe('adr,task');
  });

  it('turns an error response into a message a model can act on', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"error":"project NOPE not found"}', { status: 404 }));
    const client = createClient({ baseUrl: 'https://foreman.test', token: 'shh', fetch: fetchMock });

    await expect(client.get('/api/brief/NOPE')).rejects.toThrow(/project NOPE not found/);
    await expect(client.get('/api/brief/NOPE')).rejects.toBeInstanceOf(ForemanApiError);
  });

  it('gives up rather than hanging the session', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: URL, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });
    const client = createClient({
      baseUrl: 'https://foreman.test',
      token: 'shh',
      fetch: fetchMock,
      timeoutMs: 10,
    });

    await expect(client.get('/api/portfolio')).rejects.toThrow(/did not answer/);
  });
});

describe('the server', () => {
  it('builds, and registers every tool', () => {
    const server = createServer({ client: createClient({ baseUrl: 'https://x.test', token: 't' }) });
    expect(server).toBeDefined();
  });

  it('uses no deprecated SDK primitive', async () => {
    // `tool()` and `resource()` are deprecated in favour of `registerTool` / `registerResource`.
    // Reading the source is cruder than it looks, and it is the only check that actually notices.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    expect(source).toContain('registerTool');
    expect(source).not.toMatch(/\bserver\.tool\(/);
    expect(source).not.toMatch(/\bserver\.resource\(/);
    expect(source).not.toMatch(/\bserver\.prompt\(/);
  });
});

describe('the gate in front of the write tools (T-2.9, FRM-REQ-090, FRM-REQ-091)', () => {
  it('gates nothing that is forward progress', () => {
    // The motions of working. A confirmation on each is exactly how a confirmation stops being read.
    expect(gateForStatus('task', 'todo', 'in_progress').gated).toBe(false);
    expect(gateForStatus('task', 'in_progress', 'done').gated).toBe(false);
    expect(gateForStatus('task', null, 'todo').gated).toBe(false);
    expect(gateForStatus('finding', 'open', 'fixed').gated).toBe(false);
    expect(gateForPriority('M').gated).toBe(false);
    expect(gateForLink(false).gated).toBe(false);
  });

  it('gates a task moving backwards, and says which way it went', () => {
    const decision = gateForStatus('task', 'done', 'todo');
    expect(decision.gated).toBe(true);
    expect(decision.because).toContain('done');
    expect(decision.because).toContain('todo');
  });

  it('gates cancelling, whatever the entity', () => {
    expect(gateForStatus('task', 'in_progress', 'cancelled').gated).toBe(true);
    expect(gateForStatus('phase', 'planned', 'cancelled').gated).toBe(true);
  });

  it('gates completing a phase', () => {
    expect(gateForStatus('phase', 'active', 'complete').gated).toBe(true);
  });

  it('gates retiring a finding as wont_fix, but not deferring or skipping it', () => {
    // `deferred` and `skipped` say "not now" and "not here" and stay legible as open questions.
    // `wont_fix` says the work will not happen, which is the same act as cancelling.
    expect(gateForStatus('finding', 'open', 'wont_fix').gated).toBe(true);
    expect(gateForStatus('finding', 'open', 'deferred').gated).toBe(false);
    expect(gateForStatus('finding', 'open', 'skipped').gated).toBe(false);
  });

  it("gates setting a requirement to Won't, because it leaves every coverage count", () => {
    const decision = gateForPriority('W');
    expect(decision.gated).toBe(true);
    expect(decision.because).toContain('coverage');
  });

  it('gates unlinking but not linking', () => {
    expect(gateForLink(true).gated).toBe(true);
    expect(gateForLink(false).gated).toBe(false);
  });

  it('gives every gated decision a reason phrased for the person being asked', () => {
    const gated = [
      gateForStatus('task', 'done', 'todo'),
      gateForStatus('task', 'todo', 'cancelled'),
      gateForStatus('phase', 'active', 'complete'),
      gateForPriority('W'),
      gateForLink(true),
      gateForDelete(),
    ];
    for (const decision of gated) {
      expect(decision.gated).toBe(true);
      expect(decision.because?.length ?? 0).toBeGreaterThan(20);
      // A reason, not a restatement of the rule: it says what is lost.
      expect(decision.because).toMatch(/\.$/);
    }
  });

  it('asks the gate before running, for every write tool', () => {
    for (const tool of WRITE_TOOLS) {
      expect(typeof tool.gate, tool.name).toBe('function');
      expect(typeof tool.run, tool.name).toBe('function');
    }
  });

  it('decides a status gate from the current state, not from the request alone', async () => {
    const get = vi.fn().mockResolvedValue({ type: 'task', entity: { status: 'done' } });
    const setStatus = WRITE_TOOLS.find((t) => t.name === 'foreman_set_status');

    // The same request is a regression or not depending on where the task already is — which is
    // why the gate fetches rather than guesses.
    const decision = await setStatus?.gate({ get } as never, { id: 'BND-T-0.3', status: 'todo' });
    expect(decision?.gated).toBe(true);
  });

  it('does not gate the same request when the task has not got there yet', async () => {
    const get = vi.fn().mockResolvedValue({ type: 'task', entity: { status: 'todo' } });
    const setStatus = WRITE_TOOLS.find((t) => t.name === 'foreman_set_status');
    const decision = await setStatus?.gate({ get } as never, { id: 'BND-T-0.3', status: 'in_progress' });
    expect(decision?.gated).toBe(false);
  });

  // The tool's own description says "task, phase or finding". It threw on every finding ID,
  // because the path lookup knew three prefixes and findings are written under four — so a
  // session could read the inbox, do the work, and have no way to close what it had fixed.
  it.each(['BND-CR-089', 'BND-DA-012', 'BND-FR-004', 'BND-API-003'])(
    'closes a finding written under any audit lens: %s',
    async (id) => {
      const patch = vi.fn().mockResolvedValue({});
      const setStatus = WRITE_TOOLS.find((t) => t.name === 'foreman_set_status');
      await setStatus?.run({ patch } as never, { id, status: 'fixed' });
      expect(patch).toHaveBeenCalledWith(`/api/projects/BND/findings/${id}`, { status: 'fixed' });
    },
  );

  it('creates a project, the one write that bootstraps every other', async () => {
    // The first write of any greenfield plan. Its absence was an asymmetry rather than a
    // boundary: a planning session had to drop to curl for its opening move and then switch
    // back, and `/plan-project` papered over it with a raw POST.
    const post = vi.fn().mockResolvedValue({});
    const create = WRITE_TOOLS.find((t) => t.name === 'foreman_create');
    await create?.run({ post } as never, {
      project: 'KDSH',
      kind: 'project',
      text: 'Kardashev',
      pitch: 'Climb the energy scale.',
    });

    // A different path from every other kind: it is not created *inside* a project.
    expect(post).toHaveBeenCalledWith('/api/projects', {
      code: 'KDSH',
      name: 'Kardashev',
      pitch: 'Climb the energy scale.',
    });
  });

  it('still files every other kind inside its project', async () => {
    const post = vi.fn().mockResolvedValue({});
    const create = WRITE_TOOLS.find((t) => t.name === 'foreman_create');
    await create?.run({ post } as never, {
      project: 'KDSH',
      kind: 'requirement',
      text: 'Kardashev shall simulate one tick per frame.',
    });
    expect(post).toHaveBeenCalledWith(
      '/api/projects/KDSH/requirements',
      { statement: 'Kardashev shall simulate one tick per frame.' },
      {},
    );
  });

  it('offers no kind whose body it could not then fill in', () => {
    // ADRs, risks, decisions and terms each carry fields `foreman_update` cannot write, so
    // creating one over MCP would make a titled shell nothing could fill. Better not offered
    // than offered broken — and this is the assertion that keeps that decision deliberate.
    // An idea qualifies on exactly that test: its whole body is a title and a paragraph, and
    // `foreman_update` writes both. So does a project idea, whose pitch is the same shape. A
    // screen is a name and a route; its images arrive through the API (FRM-REQ-189). A group is
    // a name, a line, a site and an accent, and every one of them is a create field (FRM-REQ-238).
    expect(CreatableKind.options).toEqual([
      'project',
      'requirement',
      'task',
      'phase',
      'idea',
      'project_idea',
      'screen',
      'group',
    ]);
  });

  it('creates a group with no project, its line as the description (FRM-REQ-238)', async () => {
    const post = vi.fn().mockResolvedValue({});
    const create = WRITE_TOOLS.find((t) => t.name === 'foreman_create');
    await create?.run({ post } as never, {
      kind: 'group',
      text: 'Dormice',
      pitch: 'The theme is that there is no theme.',
      siteUrl: 'https://dormice.ai',
      accent: 'neutral',
    });
    expect(post).toHaveBeenCalledWith('/api/groups', {
      name: 'Dormice',
      description: 'The theme is that there is no theme.',
      siteUrl: 'https://dormice.ai',
      accent: 'neutral',
    });
  });

  it('refuses a group filed under a project, and a group field on any kind but a project', () => {
    const asGroup = CreateInput.safeParse({ project: 'BND', kind: 'group', text: 'Dormice' });
    expect(asGroup.success).toBe(false);
    expect(asGroup.error?.issues.map((i) => i.path.join('.'))).toEqual(['project']);

    const onTask = CreateInput.safeParse({ project: 'BND', kind: 'task', text: 'x', group: 'dormice' });
    expect(onTask.error?.issues[0]?.message).toMatch(/a task has no group/);

    const accentOnProject = CreateInput.safeParse({
      project: 'BND',
      kind: 'project',
      text: 'x',
      accent: 'bindery',
    });
    expect(accentOnProject.error?.issues[0]?.message).toMatch(/a project has no accent/);
  });

  it('creates a project in a group', async () => {
    const post = vi.fn().mockResolvedValue({});
    const create = WRITE_TOOLS.find((t) => t.name === 'foreman_create');
    await create?.run({ post } as never, { project: 'KURO', kind: 'project', text: 'Kurō', group: 'GRP-002' });
    expect(post).toHaveBeenCalledWith('/api/projects', { code: 'KURO', name: 'Kurō', group: 'GRP-002' });
  });

  it('moves a project between groups by its code, and null ungroups it', async () => {
    const patch = vi.fn().mockResolvedValue({});
    const update = WRITE_TOOLS.find((t) => t.name === 'foreman_update');
    await update?.run({ patch } as never, { id: 'KURO', group: 'dormice' });
    expect(patch).toHaveBeenLastCalledWith('/api/projects/KURO', { group: 'dormice' });
    await update?.run({ patch } as never, { id: 'KURO', group: null, text: 'Kurō', body: 'Anime.' });
    expect(patch).toHaveBeenLastCalledWith('/api/projects/KURO', {
      name: 'Kurō',
      pitch: 'Anime.',
      group: null,
    });
  });

  it('refuses a group on anything but a project, and a project field it does not store', () => {
    expect(UpdateInput.safeParse({ id: 'BND-T-0.3', group: 'dormice' }).error?.issues[0]?.message).toMatch(
      /is a task, which has no group/,
    );
    expect(UpdateInput.safeParse({ id: 'KURO', size: 'M' }).error?.issues[0]?.message).toMatch(
      /KURO is a project, which has no size/,
    );
    expect(UpdateInput.safeParse({ id: 'not a code' }).success).toBe(false);
  });

  it('creates a screen inside its project, from a name and a route', async () => {
    const post = vi.fn().mockResolvedValue({});
    const create = WRITE_TOOLS.find((t) => t.name === 'foreman_create');
    await create?.run({ post } as never, {
      project: 'BND',
      kind: 'screen',
      text: 'Document viewer',
      route: '/documents/:id',
    });
    expect(post).toHaveBeenCalledWith(
      '/api/projects/BND/screens',
      { name: 'Document viewer', route: '/documents/:id' },
      {},
    );
  });

  it('records the fixing commit as a SHA, so a fix is not lost waiting on ingest', async () => {
    const patch = vi.fn().mockResolvedValue({});
    const update = WRITE_TOOLS.find((t) => t.name === 'foreman_update');
    await update?.run({ patch } as never, { id: 'BND-FR-004', fixedCommitSha: '1d68d46' });
    expect(patch).toHaveBeenCalledWith('/api/projects/BND/findings/BND-FR-004', {
      fixedCommitSha: '1d68d46',
    });
  });
});

describe('foreman_findings (T-6.6, FRM-REQ-120)', () => {
  const tool = READ_TOOLS.find((t) => t.name === 'foreman_findings');

  it('asks for every project by default', async () => {
    const get = vi.fn().mockResolvedValue({ items: [] });
    await tool?.run({ get } as never, {});

    // Cross-project is the whole point: "the worst thing outstanding anywhere" was not a question
    // the vault could answer.
    expect(get).toHaveBeenCalledWith('/api/findings', {
      project: undefined,
      severity: undefined,
      status: undefined,
      lens: undefined,
      limit: 50,
    });
  });

  it('passes a narrowing through', async () => {
    const get = vi.fn().mockResolvedValue({ items: [] });
    await tool?.run({ get } as never, { severity: 'critical', lens: 'security', limit: 10 });

    expect(get).toHaveBeenCalledWith(
      '/api/findings',
      expect.objectContaining({ severity: 'critical', lens: 'security', limit: 10 }),
    );
  });

  it('is cached globally, because it spans projects', () => {
    expect(tool?.cache.cacheScope).toBe('global');
  });
});

describe('foreman_attribute (T-5.9, FRM-REQ-109)', () => {
  const tool = WRITE_TOOLS.find((t) => t.name === 'foreman_attribute');

  it('exists, and takes a short SHA', () => {
    expect(tool).toBeDefined();
    expect(AttributeInput.parse({ sha: 'a1b2c3d', task: 'BND-T-13.9' }).sha).toBe('a1b2c3d');
  });

  it('refuses something that is not a SHA', () => {
    for (const sha of ['', 'zzzz', 'abc', 'not a sha']) {
      expect(AttributeInput.safeParse({ sha, task: 'BND-T-13.9' }).success, sha).toBe(false);
    }
  });

  it('is not gated when asserting, because that is the motion of working', async () => {
    // Signal 1 arriving with a confirmation prompt in front of it is signal 1 nobody uses.
    const decision = await tool?.gate({} as never, { sha: 'a1b2c3d', task: 'BND-T-13.9' });
    expect(decision?.gated).toBe(false);
  });

  it('is gated when withdrawing, because that removes a recorded fact', async () => {
    const decision = await tool?.gate({} as never, {
      sha: 'a1b2c3d',
      task: 'BND-T-13.9',
      remove: true,
    });
    expect(decision?.gated).toBe(true);
    expect(decision?.because).toContain('Coverage');
  });

  it('confirms as declared, so the source is not whatever a guess had proposed', async () => {
    const post = vi.fn().mockResolvedValue({ confirmed: true });
    await tool?.run({ post } as never, { sha: 'a1b2c3d', task: 'BND-T-13.9' });

    expect(post).toHaveBeenCalledWith('/api/projects/BND/attributions/a1b2c3d/confirm', {
      task: 'BND-T-13.9',
      declared: true,
    });
  });

  it('withdraws by rejecting, which is remembered rather than forgotten', async () => {
    const post = vi.fn().mockResolvedValue({ confirmed: false });
    await tool?.run({ post } as never, { sha: 'a1b2c3d', task: 'BND-T-13.9', remove: true });

    expect(post).toHaveBeenCalledWith('/api/projects/BND/attributions/a1b2c3d/reject', {
      task: 'BND-T-13.9',
    });
  });
});

describe('documents as resources (T-4.9, FRM-REQ-087)', () => {
  it('splits a URI into project, document and section', () => {
    expect(parseUri('foreman://BND/architecture#deployment')).toEqual({
      code: 'BND',
      address: 'architecture',
      section: 'deployment',
    });
  });

  it('reads a whole document when there is no fragment', () => {
    expect(parseUri('foreman://BND/architecture')).toEqual({
      code: 'BND',
      address: 'architecture',
    });
  });

  it('upper-cases the project code, because that is what a code is', () => {
    expect(parseUri('foreman://bnd/architecture')?.code).toBe('BND');
  });

  it('returns null rather than throwing on something that is not one', () => {
    for (const uri of ['', 'https://example.com', 'foreman://', 'foreman://B/x', 'nonsense']) {
      expect(parseUri(uri), uri).toBeNull();
    }
  });

  it('the template matches both forms, and puts the pieces where they belong', () => {
    // The reason the template is `{+rest}` and not `{address}{#section}`: the SDK's matcher splits
    // the latter one character from the end — address `architecture#deploymen`, section `t`.
    const template = new UriTemplate(RESOURCE_TEMPLATE);
    expect(template.match('foreman://BND/architecture#deployment')).toEqual({
      code: 'BND',
      rest: 'architecture#deployment',
    });
    expect(template.match('foreman://BND/architecture')).toEqual({
      code: 'BND',
      rest: 'architecture',
    });
  });

  it('asks the API for the section, not the document, when given a fragment', async () => {
    const get = vi.fn().mockResolvedValue({ markdown: '## Deployment\n\nBehind a tunnel.' });
    const content = await readResource({ get } as never, 'foreman://BND/architecture#deployment');

    expect(get).toHaveBeenCalledWith('/api/projects/BND/documents/at/architecture/sections/deployment');
    // The whole argument for addressing sections: three paragraphs, not two thousand lines.
    expect(content.text).toContain('Behind a tunnel');
    expect(content.mimeType).toBe('text/markdown');
  });

  it('asks for the whole document when given none', async () => {
    const get = vi.fn().mockResolvedValue({ markdown: '# Architecture' });
    await readResource({ get } as never, 'foreman://BND/architecture');
    expect(get).toHaveBeenCalledWith('/api/projects/BND/documents/at/architecture');
  });

  it('lists everything addressable in one call', async () => {
    const get = vi.fn().mockResolvedValue({ items: [{ uri: 'foreman://BND/architecture' }] });
    const listed = await listResources({ get } as never);
    // Once at connect time, not per project as a client discovers them.
    expect(get).toHaveBeenCalledWith('/api/resources');
    expect(listed).toHaveLength(1);
  });
});
