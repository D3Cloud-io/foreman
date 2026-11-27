import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { ForemanClient } from '../src/client.js';
import { createServer } from '../src/server.js';
import { MAX_TOOLS } from '../src/tools/index.js';
import { WRITE_TOOLS } from '../src/tools/writes.js';

/**
 * The shim over the **actual protocol** (T-1.9, T-2.8, T-4.9).
 *
 * Everything in `contract.test.ts` tests the tool definitions: their schemas, their gates, the URL
 * each one builds. That is most of the risk, but not all of it — none of it goes through the SDK.
 * A tool registered with a schema the SDK rejects, a resource template that matches nothing, a
 * result shape a client cannot parse: all of those pass a definition test and fail the first time
 * Claude connects.
 *
 * So these drive a real `Client` over a linked in-memory transport: `initialize`, `tools/list`,
 * `tools/call`, `resources/list`, `resources/read` — the same calls Claude makes, through the same
 * code path, with only the network replaced.
 */

/** A Foreman API that answers from a table, so a test can say what the server saw. */
function fakeApi(responses: Record<string, unknown> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];

  const match = (path: string): unknown => {
    for (const [pattern, value] of Object.entries(responses)) {
      if (path === pattern || path.startsWith(pattern)) return value;
    }
    return {};
  };

  const client: ForemanClient = {
    get: (path) => {
      calls.push({ method: 'GET', path });
      return Promise.resolve(match(path) as never);
    },
    post: (path, body) => {
      calls.push({ method: 'POST', path, body });
      return Promise.resolve(match(path) as never);
    },
    patch: (path, body) => {
      calls.push({ method: 'PATCH', path, body });
      return Promise.resolve(match(path) as never);
    },
    del: (path) => {
      calls.push({ method: 'DELETE', path });
      return Promise.resolve(match(path) as never);
    },
    upload: (path, file, query) => {
      calls.push({ method: 'UPLOAD', path, body: { name: file.name, size: file.bytes.length, query } });
      return Promise.resolve(match(path) as never);
    },
    bytes: (path) => {
      calls.push({ method: 'BYTES', path });
      return Promise.resolve(match(path) as never);
    },
  };

  return { client, calls };
}

/** A connected client/server pair, with the transports linked in memory. */
async function connect(
  api: ForemanClient,
  clientOptions: {
    elicitation?: (message: string) => { confirm: boolean } | 'decline';
    readFile?: (path: string) => Promise<Uint8Array>;
  } = {},
) {
  const server = createServer({
    client: api,
    ...(clientOptions.readFile === undefined ? {} : { readFile: clientOptions.readFile }),
  });
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    // Elicitation is declared only when the test provides a handler, so the "client cannot be
    // asked" path is reachable too.
    { capabilities: clientOptions.elicitation === undefined ? {} : { elicitation: {} } },
  );

  if (clientOptions.elicitation !== undefined) {
    const handler = clientOptions.elicitation;
    client.setRequestHandler(
      (await import('@modelcontextprotocol/sdk/types.js')).ElicitRequestSchema,
      (request) => {
        const answer = handler(request.params.message);
        return answer === 'decline'
          ? { action: 'decline' as const }
          : { action: 'accept' as const, content: { confirm: answer.confirm } };
      },
    );
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

/** The text of a tool result. The SDK's union includes a `toolResult` shape with no content. */
const text = (result: unknown): string => {
  const content = (result as { content?: { text?: string }[] }).content;
  return (content ?? []).map((part) => part.text ?? '').join('\n');
};

describe('initialize and the handshake', () => {
  it('connects, and declares the capabilities it actually implements', async () => {
    const { client } = await connect(fakeApi().client);

    const capabilities = client.getServerCapabilities();
    expect(capabilities?.tools).toBeDefined();
    expect(capabilities?.resources).toBeDefined();
    // Nothing is claimed that is not implemented: a declared capability with no handler is a
    // client calling something that answers "method not found".
    expect(capabilities?.prompts).toBeUndefined();
    expect(capabilities?.logging).toBeUndefined();
  });

  it('carries instructions that tell a client where to start', async () => {
    const { client } = await connect(fakeApi().client);
    // The first thing a model reads. "Call foreman_brief first" is worth more than a tool list.
    expect(client.getInstructions() ?? '').toContain('foreman_brief');
  });
});

describe('tools/list over the protocol', () => {
  it('lists every tool, inside the ceiling', async () => {
    const { client } = await connect(fakeApi().client);
    const { tools } = await client.listTools();

    expect(tools.length).toBeGreaterThan(5);
    expect(tools.length).toBeLessThanOrEqual(MAX_TOOLS);
    expect(tools.every((t) => t.name.startsWith('foreman_'))).toBe(true);
  });

  it('publishes a project idea canvas as an object, with its fields', async () => {
    const { client } = await connect(fakeApi().client);
    const { tools } = await client.listTools();
    const create = tools.find((t) => t.name === 'foreman_create');
    const canvas = (create?.inputSchema.properties as Record<string, Record<string, unknown>>)['canvas'];

    // Accepting JSON text as well must not cost a client that is up to date the object's shape —
    // a canvas published as "anything" is a field a model has to guess at.
    expect(canvas?.['type']).toBe('object');
    expect(Object.keys(canvas?.['properties'] as object)).toContain('problem');
  });

  it('gives every tool a usable JSON Schema, not an empty object', async () => {
    const { client } = await connect(fakeApi().client);
    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      // `foreman_portfolio` legitimately takes nothing; everything else must describe its input,
      // or the model is guessing at argument names.
      if (tool.name !== 'foreman_portfolio') {
        expect(Object.keys(tool.inputSchema.properties ?? {}).length, tool.name).toBeGreaterThan(0);
      }
    }
  });

  it('marks the read tools read-only and the write tools not', async () => {
    const { client } = await connect(fakeApi().client);
    const { tools } = await client.listTools();

    const brief = tools.find((t) => t.name === 'foreman_brief');
    const create = tools.find((t) => t.name === 'foreman_create');
    // A client that skips a confirmation for a read is relying on this being right.
    expect(brief?.annotations?.readOnlyHint).toBe(true);
    expect(create?.annotations?.readOnlyHint).toBe(false);
  });

  it('describes every tool in a sentence a model can choose from', async () => {
    const { client } = await connect(fakeApi().client);
    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.description ?? '', tool.name).not.toBe('');
      expect((tool.description ?? '').length, tool.name).toBeLessThan(220);
    }
  });
});

describe('tools/call over the protocol', () => {
  it('calls the brief and returns the API’s answer as text', async () => {
    const { client: api, calls } = fakeApi({
      '/api/brief/BND': { project: { code: 'BND', name: 'Bindery' }, nextTasks: [] },
    });
    const { client } = await connect(api);

    const result = await client.callTool({ name: 'foreman_brief', arguments: { project: 'BND' } });

    expect(calls[0]?.path).toBe('/api/brief/BND');
    expect(text(result)).toContain('Bindery');
    expect(result.isError).toBeFalsy();
  });

  it('carries the cache metadata a client needs to not re-ask', async () => {
    const { client } = await connect(fakeApi().client);
    const result = await client.callTool({ name: 'foreman_brief', arguments: { project: 'BND' } });

    const meta = result._meta as Record<string, { ttlMs: number; cacheScope: string }> | undefined;
    expect(meta?.['io.d3cloud.foreman/cache']?.ttlMs).toBeGreaterThan(0);
    expect(meta?.['io.d3cloud.foreman/cache']?.cacheScope).toBe('project');
  });

  it('refuses input the shared schema rejects, as a readable error', async () => {
    const { client } = await connect(fakeApi().client);
    // `REQ-021` is not project-prefixed, so it is ambiguous by construction (ADR-008).
    const result = await client.callTool({ name: 'foreman_get', arguments: { id: 'REQ-021' } });

    expect(result.isError).toBe(true);
    // A model has to be able to read this and fix its own call.
    expect(text(result).toLowerCase()).toMatch(/expected|invalid|human id/);
  });

  it('returns an API failure as a tool error rather than killing the call', async () => {
    const failing: ForemanClient = {
      get: () => Promise.reject(Object.assign(new Error('no such project'), { status: 404 })),
      post: () => Promise.reject(new Error('unused')),
      patch: () => Promise.reject(new Error('unused')),
      del: () => Promise.reject(new Error('unused')),
      upload: () => Promise.reject(new Error('unused')),
      bytes: () => Promise.reject(new Error('unused')),
    };
    const { client } = await connect(failing);

    const result = await client.callTool({ name: 'foreman_brief', arguments: { project: 'ZZZ' } });
    // A protocol error ends the call; a tool error is something the model can read and act on.
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no such project');
  });

  it('answers a tool that does not exist as an error result, not a dropped connection', async () => {
    const { client } = await connect(fakeApi().client);
    const result = await client.callTool({ name: 'foreman_nonsense', arguments: {} });

    // The SDK answers rather than rejecting, which is the better behaviour: a model that guessed
    // a tool name can read the reply and pick a real one.
    expect(result.isError).toBe(true);
    expect(text(result).toLowerCase()).toContain('foreman_nonsense');
  });

  it('passes search filters through as the API expects them', async () => {
    const { client: api, calls } = fakeApi({ '/api/search': { items: [] } });
    const { client } = await connect(api);

    await client.callTool({
      name: 'foreman_search',
      arguments: { q: 'pg_trgm', types: ['adr', 'requirement'], project: 'BND', limit: 5 },
    });

    expect(calls[0]?.path).toBe('/api/search');
  });
});

describe('the confirmation round-trip (T-2.9, ADR-011)', () => {
  it('asks before cancelling, and does not call the API when declined', async () => {
    const { client: api, calls } = fakeApi({
      '/api/entities/BND-T-1.1': { type: 'task', entity: { status: 'in_progress' } },
    });
    let asked = '';
    const { client } = await connect(api, {
      elicitation: (message) => {
        asked = message;
        return 'decline';
      },
    });

    const result = await client.callTool({
      name: 'foreman_set_status',
      arguments: { id: 'BND-T-1.1', status: 'cancelled' },
    });

    // The question names what is lost, rather than asking "are you sure?".
    expect(asked.toLowerCase()).toMatch(/abandon|history of intent/);
    // Declining is a normal outcome that says what did not happen.
    expect(text(result)).toMatch(/Not done|Nothing was changed/);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('creates an idea with the title and the description, in one call', async () => {
    const { client: api, calls } = fakeApi({
      '/api/projects/BND/ideas': { humanId: 'BND-IDEA-004', title: 'A scanner shortcut' },
    });
    const { client } = await connect(api);

    const result = await client.callTool({
      name: 'foreman_create',
      arguments: {
        kind: 'idea',
        project: 'BND',
        text: 'A scanner shortcut',
        body: 'One button that ingests whatever is on the glass.',
      },
    });

    const call = calls.find((c) => c.method === 'POST');
    expect(call?.path).toBe('/api/projects/BND/ideas');
    // `text` is the title and `body` is the description: one tool spelling for five kinds, and
    // the mapping is the thing that silently drops a field if it is wrong.
    expect(call?.body).toEqual({
      title: 'A scanner shortcut',
      body: 'One button that ingests whatever is on the glass.',
    });
    expect(text(result)).toContain('BND-IDEA-004');
  });

  it('sends an idea’s reason as `reason`, not as `blockedReason`', async () => {
    const { client: api, calls } = fakeApi({
      '/api/entities/BND-IDEA-004': { type: 'idea', entity: { status: 'new' } },
      '/api/projects/BND/ideas/BND-IDEA-004': { ok: true },
    });
    const { client } = await connect(api, { elicitation: () => ({ confirm: true }) });

    await client.callTool({
      name: 'foreman_set_status',
      arguments: { id: 'BND-IDEA-004', status: 'rejected', reason: 'Bindery is desktop-first.' },
    });

    // A task carries its reason as `blockedReason` and only while blocked. Sending an idea's the
    // same way would drop it on the floor — the server would take the rejection with no reason,
    // which is the one state this feature exists to prevent.
    const call = calls.find((c) => c.method === 'PATCH');
    expect(call?.body).toEqual({ status: 'rejected', reason: 'Bindery is desktop-first.' });
  });

  it('proceeds when confirmed', async () => {
    const { client: api, calls } = fakeApi({
      '/api/entities/BND-T-1.1': { type: 'task', entity: { status: 'in_progress' } },
      '/api/projects/BND/tasks/BND-T-1.1': { ok: true },
    });
    const { client } = await connect(api, { elicitation: () => ({ confirm: true }) });

    await client.callTool({
      name: 'foreman_set_status',
      arguments: { id: 'BND-T-1.1', status: 'cancelled' },
    });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
  });

  it('asks before a task moves backwards', async () => {
    const { client: api } = fakeApi({
      '/api/entities/BND-T-1.1': { type: 'task', entity: { status: 'done' } },
      '/api/projects/BND/tasks/BND-T-1.1': { ok: true },
    });
    let asked = '';
    const { client } = await connect(api, {
      elicitation: (message) => {
        asked = message;
        return { confirm: true };
      },
    });

    await client.callTool({
      name: 'foreman_set_status',
      arguments: { id: 'BND-T-1.1', status: 'todo' },
    });
    // A regression is the one status change worth stopping on.
    expect(asked).not.toBe('');
  });

  it('asks before unlinking, which loses a citation', async () => {
    const { client: api, calls } = fakeApi({ '/api/links': { ok: true } });
    let asked = '';
    const { client } = await connect(api, {
      elicitation: (message) => {
        asked = message;
        return 'decline';
      },
    });

    await client.callTool({
      name: 'foreman_link',
      arguments: { from: 'BND-T-1.1', to: 'BND-REQ-021', remove: true },
    });
    expect(asked).not.toBe('');
    expect(calls.some((c) => c.path === '/api/links')).toBe(false);
  });

  it('cannot be asked, and says so, when the client declares no elicitation', async () => {
    // A client with no elicitation capability is a real case — and a gated write must not
    // silently proceed just because nobody could be asked.
    const { client: api, calls } = fakeApi({
      '/api/entities/BND-T-1.1': { type: 'task', entity: { status: 'in_progress' } },
    });
    const { client } = await connect(api);

    const result = await client.callTool({
      name: 'foreman_set_status',
      arguments: { id: 'BND-T-1.1', status: 'cancelled' },
    });

    expect(result.isError ?? false, text(result)).toBe(true);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('does not ask before forward progress', async () => {
    const { client: api, calls } = fakeApi({
      '/api/entities/BND-T-1.1': { type: 'task', entity: { status: 'todo' } },
      '/api/projects/BND/tasks/BND-T-1.1': { ok: true },
    });
    let asked = false;
    const { client } = await connect(api, {
      elicitation: () => {
        asked = true;
        return { confirm: true };
      },
    });

    await client.callTool({
      name: 'foreman_set_status',
      arguments: { id: 'BND-T-1.1', status: 'in_progress' },
    });

    // A confirmation on every motion of working is how confirmations stop being read.
    expect(asked).toBe(false);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
  });
});

describe('resources over the protocol (T-4.9, FRM-REQ-087)', () => {
  it('lists documents and sections as URIs', async () => {
    const { client: api } = fakeApi({
      '/api/resources': {
        items: [
          {
            uri: 'foreman://BND/architecture',
            name: 'BND — Architecture',
            description: 'architecture, 6 sections',
            mimeType: 'text/markdown',
          },
          {
            uri: 'foreman://BND/architecture#deployment',
            name: 'BND — Architecture — Deployment',
            description: 'Behind a Cloudflare Tunnel.',
            mimeType: 'text/markdown',
          },
        ],
      },
    });
    const { client } = await connect(api);

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('foreman://BND/architecture#deployment');
  });

  it('reads one section, through the template, and returns markdown', async () => {
    const { client: api, calls } = fakeApi({
      '/api/projects/BND/documents/at/architecture/sections/deployment': {
        markdown: '## Deployment\n\nBehind a Cloudflare Tunnel, with no host ports.',
      },
    });
    const { client } = await connect(api);

    const result = await client.readResource({ uri: 'foreman://BND/architecture#deployment' });

    expect(calls[0]?.path).toBe('/api/projects/BND/documents/at/architecture/sections/deployment');
    expect((result.contents[0] as { text?: string }).text).toContain('no host ports');
    expect(result.contents[0]?.mimeType).toBe('text/markdown');
  });

  it('reads a whole document when the URI has no fragment', async () => {
    const { client: api, calls } = fakeApi({
      '/api/projects/BND/documents/at/architecture': { markdown: '# Architecture' },
    });
    const { client } = await connect(api);

    await client.readResource({ uri: 'foreman://BND/architecture' });
    expect(calls[0]?.path).toBe('/api/projects/BND/documents/at/architecture');
  });

  it('answers a URI that resolves to nothing with the message, not a crash', async () => {
    const failing: ForemanClient = {
      get: () =>
        Promise.reject(
          Object.assign(new Error('BND has no document at "nonsense" — it has architecture'), {
            status: 404,
          }),
        ),
      post: () => Promise.reject(new Error('unused')),
      patch: () => Promise.reject(new Error('unused')),
      del: () => Promise.reject(new Error('unused')),
      upload: () => Promise.reject(new Error('unused')),
      bytes: () => Promise.reject(new Error('unused')),
    };
    const { client } = await connect(failing);

    const result = await client.readResource({ uri: 'foreman://BND/nonsense' });
    // A resource read has no `isError`, so the message is the content — and it names what exists,
    // which is what makes the next call the right one.
    expect((result.contents[0] as { text?: string }).text).toContain('it has architecture');
  });
});

describe('what the MCP surface deliberately cannot do', () => {
  it('can delete an idea, and nothing else', async () => {
    const { client } = await connect(fakeApi().client);
    const { tools } = await client.listTools();

    // This test used to assert that no delete verb existed at all (ADR-002), on the reasoning
    // that the one surface able to delete should be the one where a person can see what they are
    // about to lose. That reasoning is about *citations*, so FRM-ADR-014 narrows the absence to
    // where it earns its keep rather than reversing it: an idea is cited by nothing, and a
    // backlog nobody can prune is a backlog nobody reads.
    const names = tools.map((t) => t.name);
    expect(names).toContain('foreman_delete');
    // Exactly one. A second spelling is how a narrowed verb quietly gets its scope back.
    expect(names.filter((n) => /delete|destroy|purge|remove/i.test(n))).toEqual(['foreman_delete']);

    const remove = WRITE_TOOLS.find((t) => t.name === 'foreman_delete');
    // An idea and a project idea: the two kinds nothing cites. `PI-007` was added deliberately,
    // on the same test ADR-014 states — not because it was convenient to allow.
    for (const uncited of ['BND-IDEA-004', 'PI-007']) {
      expect(remove?.inputSchema.safeParse({ id: uncited }).success, uncited).toBe(true);
    }
    // The narrowing is the schema's, not a branch inside `run` — so it holds for anything that
    // parses this input, and the model is told why rather than getting a generic type error.
    // `BND` is here because a *project* is the thing a project idea is most easily confused with,
    // and deleting one would take nine hundred records that cite each other.
    for (const cited of ['BND-REQ-012', 'BND-T-004', 'BND-P-3', 'BND-CR-037', 'BND']) {
      const result = remove?.inputSchema.safeParse({ id: cited });
      expect(result?.success, cited).toBe(false);
    }
    for (const cited of ['BND-REQ-012', 'BND-CR-037']) {
      expect(remove?.inputSchema.safeParse({ id: cited }).error?.issues[0]?.message).toContain(
        'console',
      );
    }
  });

  it('creates a project idea with no project, and refuses one with', async () => {
    const { client: api, calls } = fakeApi({ '/api/project-ideas': { humanId: 'PI-007' } });
    const { client } = await connect(api);

    const made = await client.callTool({
      name: 'foreman_create',
      arguments: {
        kind: 'project_idea',
        text: 'A print notifier for the Bambu',
        pitch: 'Texts you when a print finishes. MQTT locally, cloud as a fallback.',
      },
    });
    const call = calls.find((c) => c.method === 'POST');
    expect(call?.path).toBe('/api/project-ideas');
    expect(call?.body).toEqual({
      title: 'A print notifier for the Bambu',
      pitch: 'Texts you when a print finishes. MQTT locally, cloud as a fallback.',
    });
    expect(text(made)).toContain('PI-007');

    // Passing a project is the mistake worth catching by name: it means the caller thinks this is
    // an idea *inside* a project, which is the other feature.
    const wrong = await client.callTool({
      name: 'foreman_create',
      arguments: { kind: 'project_idea', project: 'BND', text: 'Wrong shape' },
    });
    expect(wrong.isError).toBe(true);
    expect(text(wrong).toLowerCase()).toContain('belongs to no project');
  });

  it('creates a whole project idea, canvas and all, in one call', async () => {
    const { client: api, calls } = fakeApi({ '/api/project-ideas': { humanId: 'PI-021' } });
    const { client } = await connect(api);

    await client.callTool({
      name: 'foreman_create',
      arguments: {
        kind: 'project_idea',
        text: 'A print notifier',
        pitch: 'Texts you when a print finishes.',
        canvas: {
          problem: 'Prints fail silently.',
          tags: ['home-lab'],
          questions: ['LAN or cloud?'],
          links: [{ label: 'HA integration', url: 'https://example.com/ha' }],
          related: ['BND'],
        },
      },
    });

    // Plain items in, the API's shape out: the shim makes the ids so a model never has to.
    const body = calls.find((c) => c.method === 'POST')?.body as Record<string, unknown>;
    expect(body['problem']).toBe('Prints fail silently.');
    expect(body['questions']).toEqual([
      { id: expect.any(String) as string, text: 'LAN or cloud?', done: false },
    ]);
    expect(body['links']).toEqual([
      { id: expect.any(String) as string, label: 'HA integration', url: 'https://example.com/ha' },
    ]);
    expect(body['related']).toEqual(['BND']);
  });

  it('takes a canvas sent as JSON text by a client with an old tool list', async () => {
    const { client: api, calls } = fakeApi({ '/api/project-ideas': { humanId: 'PI-022' } });
    const { client } = await connect(api);

    // A client that cached the tool list before `canvas` existed does not know it is an object,
    // and sends the object as a string. That bounced the first real canvas, the day it shipped.
    const made = await client.callTool({
      name: 'foreman_create',
      arguments: {
        kind: 'project_idea',
        text: 'A print notifier',
        canvas: JSON.stringify({ problem: 'Prints fail silently.', tags: ['home-lab'] }),
      },
    });

    expect(made.isError).toBeFalsy();
    const body = calls.find((c) => c.method === 'POST')?.body as Record<string, unknown>;
    expect(body['problem']).toBe('Prints fail silently.');
    expect(body['tags']).toEqual(['home-lab']);
  });

  it('writes a list on a project idea from one item per line', async () => {
    const { client: api, calls } = fakeApi({ '/api/project-ideas/PI-021': { ok: true } });
    const { client } = await connect(api);

    await client.callTool({
      name: 'foreman_update',
      arguments: { id: 'PI-021', section: 'nextSteps', text: '- Capture a night of MQTT\n- Price SMS' },
    });

    const body = calls.find((c) => c.method === 'PATCH')?.body as { nextSteps: { text: string }[] };
    expect(body.nextSteps.map((s) => s.text)).toEqual(['Capture a night of MQTT', 'Price SMS']);
  });

  it('reads a project idea back by its codeless ID', async () => {
    const { client: api, calls } = fakeApi({
      '/api/entities/PI-021': { type: 'project_idea', entity: { humanId: 'PI-021' } },
    });
    const { client } = await connect(api);

    // It used to refuse `PI-021` outright, so a session could create a project idea and never
    // read it back.
    const result = await client.callTool({ name: 'foreman_get', arguments: { id: 'PI-021' } });
    expect(result.isError).toBeFalsy();
    expect(calls[0]?.path).toBe('/api/entities/PI-021');
  });

  it('writes a named canvas section on a project idea, not its title', async () => {
    const { client: api, calls } = fakeApi({ '/api/project-ideas/PI-007': { ok: true } });
    const { client } = await connect(api);

    await client.callTool({
      name: 'foreman_update',
      arguments: {
        id: 'PI-007',
        section: 'risks',
        text: 'Bambu may close the local MQTT port in a firmware update.',
      },
    });

    // FRM-ADR-017: "write up the risks on PI-007" must land on the risks section. Sent as the
    // title, it would silently replace the idea's name with a paragraph about firmware.
    const call = calls.find((c) => c.method === 'PATCH');
    expect(call?.path).toBe('/api/project-ideas/PI-007');
    expect(call?.body).toEqual({ risks: 'Bambu may close the local MQTT port in a firmware update.' });
  });

  it('routes a project idea’s status change away from the project paths', async () => {
    const { client: api, calls } = fakeApi({
      '/api/entities/PI-007': { type: 'project_idea', entity: { status: 'new' } },
      '/api/project-ideas/PI-007': { ok: true },
    });
    const { client } = await connect(api, { elicitation: () => ({ confirm: true }) });

    await client.callTool({
      name: 'foreman_set_status',
      arguments: { id: 'PI-007', status: 'parked', reason: 'After Someday Vault ships.' },
    });

    // `PI-007` has no project code, so the usual `/api/projects/${code}/…` would build a path with
    // an empty segment and 404 — silently, as a tool result that reads like a refusal.
    const call = calls.find((c) => c.method === 'PATCH');
    expect(call?.path).toBe('/api/project-ideas/PI-007');
    expect(call?.body).toEqual({ status: 'parked', reason: 'After Someday Vault ships.' });
  });

  it('replaces a task’s declared files (FRM-T-007)', async () => {
    const { client: api, calls } = fakeApi({ '/api/projects/SPN/tasks/SPN-T-001': { ok: true } });
    const { client } = await connect(api);

    const result = await client.callTool({
      name: 'foreman_update',
      arguments: { id: 'SPN-T-001', files: ['apps/server/src/one.ts', 'apps/server/src/two.ts'] },
    });

    expect(result.isError).toBeFalsy();
    const call = calls.find((c) => c.method === 'PATCH');
    expect(call?.path).toBe('/api/projects/SPN/tasks/SPN-T-001');
    expect(call?.body).toMatchObject({
      files: ['apps/server/src/one.ts', 'apps/server/src/two.ts'],
    });
  });

  it('clears a task’s declared files with an empty array', async () => {
    const { client: api, calls } = fakeApi({ '/api/projects/SPN/tasks/SPN-T-001': { ok: true } });
    const { client } = await connect(api);

    await client.callTool({ name: 'foreman_update', arguments: { id: 'SPN-T-001', files: [] } });

    const call = calls.find((c) => c.method === 'PATCH');
    expect(call?.body).toMatchObject({ files: [] });
  });

  it('refuses files on anything but a task', async () => {
    const { client: api } = fakeApi({ '/api/projects/SPN/requirements/SPN-REQ-001': { ok: true } });
    const { client } = await connect(api);

    const result = await client.callTool({
      name: 'foreman_update',
      arguments: { id: 'SPN-REQ-001', files: ['x.ts'] },
    });

    expect(result.isError).toBe(true);
  });

  it('gates that delete unconditionally, unlike every other write', async () => {
    const remove = WRITE_TOOLS.find((t) => t.name === 'foreman_delete');
    const decision = await remove?.gate({} as never, { id: 'BND-IDEA-004' });

    expect(decision?.gated).toBe(true);
    expect(decision?.because).toContain('citation');
  });

  it('exposes no prompt, and no sampling', async () => {
    const { client } = await connect(fakeApi().client);
    // Foreman never calls a model (FRM-REQ-013). A sampling capability would be the server asking
    // the client to run an inference on its behalf — the same thing by another route.
    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
    await expect(client.listPrompts()).rejects.toThrow();
  });
});

describe('attachments over the protocol (FRM-ADR-026)', () => {
  const PDF = new TextEncoder().encode('%PDF-1.7\n% a design\n%%EOF\n');
  const attachment = {
    id: '01a21b28-0000-7000-8000-000000000001',
    humanId: 'ATT-012',
    name: 'living-town.pdf',
    mediaType: 'application/pdf',
    byteSize: PDF.length,
    sha256: 'a'.repeat(64),
    entity: { type: 'project_idea', humanId: 'PI-015' },
    uploadedBy: 'claude',
    createdAt: '2026-11-27T00:00:00.000Z',
    deletedAt: null,
    url: '/api/attachments/ATT-012',
    contentUrl: '/api/attachments/ATT-012/content',
  };

  it('through the shim, reads the local file and sends it as one multipart upload — no gate', async () => {
    const { client: api, calls } = fakeApi({ '/api/attachments': { ...attachment, auditEventIds: ['e1'] } });
    const read: string[] = [];
    const { client } = await connect(api, {
      readFile: (path) => {
        read.push(path);
        return Promise.resolve(PDF);
      },
    });

    const result = await client.callTool({
      name: 'foreman_update',
      arguments: { id: 'PI-015', attach: '/Users/someone/Design/living-town.pdf' },
    });

    expect(result.isError).toBeFalsy();
    expect(read).toEqual(['/Users/someone/Design/living-town.pdf']);
    const upload = calls.find((c) => c.method === 'UPLOAD');
    expect(upload?.path).toBe('/api/attachments');
    // The name is the file's own, not the path: the operator's directories go nowhere.
    expect(upload?.body).toEqual({ name: 'living-town.pdf', size: PDF.length, query: { entity: 'PI-015' } });
    expect(text(result)).toContain('ATT-012');
  });

  it('through the shim, refuses a file of a type Foreman would refuse before a byte leaves the machine', async () => {
    const { client: api, calls } = fakeApi();
    const { client } = await connect(api, {
      readFile: () => Promise.resolve(new TextEncoder().encode('-----BEGIN OPENSSH PRIVATE KEY-----')),
    });

    const result = await client.callTool({ name: 'foreman_update', arguments: { id: 'PI-015', attach: '~/.ssh/id_ed25519' } });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not sent/);
    expect(calls.some((c) => c.method === 'UPLOAD')).toBe(false);
  });

  it('with no local disk — the remote /mcp — answers with a one-use upload command and reads nothing', async () => {
    const { client: api, calls } = fakeApi({
      '/api/attachments/tickets': {
        uploadUrl: 'https://foreman.example/uploads/frmup_abc',
        expiresAt: '2026-11-27T00:15:00.000Z',
        name: "Bob's design.pdf",
        entity: 'PI-015',
        maxBytes: 26214400,
      },
    });
    const { client } = await connect(api);

    const result = await client.callTool({ name: 'foreman_update', arguments: { id: 'PI-015', attach: "~/Desktop/Bob's design.pdf" } });

    expect(result.isError).toBeFalsy();
    const ticket = calls.find((c) => c.path === '/api/attachments/tickets');
    expect(ticket?.body).toEqual({ entity: 'PI-015', name: "~/Desktop/Bob's design.pdf" });
    expect(calls.some((c) => c.method === 'UPLOAD')).toBe(false);
    const answer = JSON.parse(text(result)) as { attached: boolean; command: string };
    expect(answer.attached).toBe(false);
    // Quoted for a POSIX shell, with `~/` left outside the quotes so it still expands.
    expect(answer.command).toBe(
      "curl --fail-with-body -sS -T ~/'Desktop/Bob'\\''s design.pdf' 'https://foreman.example/uploads/frmup_abc'",
    );
  });

  it('refuses attach mixed with an edit, and on a kind that does not carry files', async () => {
    const { client } = await connect(fakeApi().client);
    const mixed = await client.callTool({ name: 'foreman_update', arguments: { id: 'PI-015', attach: 'a.pdf', text: 'x' } });
    expect(mixed.isError).toBe(true);
    expect(text(mixed)).toMatch(/own call/);
    const finding = await client.callTool({ name: 'foreman_update', arguments: { id: 'BND-CR-001', attach: 'a.pdf' } });
    expect(finding.isError).toBe(true);
  });

  it('foreman_get ATT-n returns the metadata and the PDF itself as an embedded resource', async () => {
    const { client: api, calls } = fakeApi({
      '/api/entities/ATT-012': { type: 'attachment', humanId: 'ATT-012', entity: attachment, backlinks: [] },
      '/api/attachments/ATT-012/content': { bytes: PDF, contentType: 'application/pdf' },
    });
    const { client } = await connect(api);

    const result = await client.callTool({ name: 'foreman_get', arguments: { id: 'ATT-012' } });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/entities/ATT-012',
      'BYTES /api/attachments/ATT-012/content',
    ]);
    const content = (result as { content: { type: string; resource?: { mimeType: string; blob: string } }[] }).content;
    const resource = content.find((part) => part.type === 'resource');
    expect(resource?.resource?.mimeType).toBe('application/pdf');
    expect(Buffer.from(resource?.resource?.blob ?? '', 'base64').toString('latin1')).toContain('%PDF-1.7');
  });

  it('foreman_get sends text as text and an image as an image, and links what is too large to inline', async () => {
    const md = { ...attachment, humanId: 'ATT-013', name: 'n.md', mediaType: 'text/markdown', byteSize: 9, contentUrl: '/api/attachments/ATT-013/content' };
    const big = { ...attachment, humanId: 'ATT-014', byteSize: 50 * 1024 * 1024, contentUrl: '/api/attachments/ATT-014/content' };
    const { client: api, calls } = fakeApi({
      '/api/entities/ATT-013': { type: 'attachment', humanId: 'ATT-013', entity: md, backlinks: [] },
      '/api/attachments/ATT-013/content': { bytes: new TextEncoder().encode('# Heading'), contentType: 'text/markdown' },
      '/api/entities/ATT-014': { type: 'attachment', humanId: 'ATT-014', entity: big, backlinks: [] },
    });
    const { client } = await connect(api);

    expect(text(await client.callTool({ name: 'foreman_get', arguments: { id: 'ATT-013' } }))).toContain('# Heading');
    const large = await client.callTool({ name: 'foreman_get', arguments: { id: 'ATT-014' } });
    expect(text(large)).toMatch(/over the .* sent inline/);
    expect(calls.some((c) => c.path === '/api/attachments/ATT-014/content')).toBe(false);
  });

  it('foreman_delete ATT-n asks first, then soft-deletes through the attachments route', async () => {
    const { client: api, calls } = fakeApi();
    let asked = '';
    const { client } = await connect(api, {
      elicitation: (message) => {
        asked = message;
        return { confirm: true };
      },
    });

    const result = await client.callTool({ name: 'foreman_delete', arguments: { id: 'ATT-012' } });

    expect(asked).toMatch(/can be undone/);
    expect(result.isError).toBeFalsy();
    expect(calls.find((c) => c.method === 'DELETE')?.path).toBe('/api/attachments/ATT-012');
  });
});
