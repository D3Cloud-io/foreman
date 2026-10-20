import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ForemanClient } from './client.js';
import { ForemanApiError } from './client.js';
import { listResources, readResource, RESOURCE_TEMPLATE } from './resources.js';
import { READ_TOOLS, WRITE_TOOLS, type ToolDefinition } from './tools/index.js';

/**
 * The MCP server the shim exposes over stdio.
 *
 * Built on `registerTool` and `registerResource` — the SDK marks the older `tool()` and
 * `resource()` forms deprecated, and a shim written against a deprecated primitive is one that
 * breaks on an SDK upgrade rather than on a decision.
 *
 * **The protocol version is the SDK's, not the plan's.** See ADR-011: the plan specifies MCP
 * 2026-07-28, and no released TypeScript SDK supports it — 1.30.0, the newest, tops out at
 * 2025-11-25. That version carries `elicitation`, which is what Phase 2's confirmation round-trip
 * will use where the plan says MRTR `input_required`.
 */

export const SERVER_NAME = '@d3cloud/foreman-mcp';
export const SERVER_VERSION = '0.1.0';

export interface ServerOptions {
  readonly client: ForemanClient;
  readonly name?: string;
  readonly version?: string;
}

export function createServer({ client, name, version }: ServerOptions): McpServer {
  const server = new McpServer(
    { name: name ?? SERVER_NAME, version: version ?? SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        'Foreman holds the plan-of-record for every D3 Cloud project: requirements, phases, ' +
        'tasks, ADRs, findings. Call foreman_brief before starting work on a project. Its ' +
        '`guidelines` are the standing decisions that apply to it (GL-<SEQ>): follow them, and read ' +
        'one in full with foreman_get, or all of them at foreman://guidelines.',
    },
  );

  for (const tool of READ_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema.shape,
        annotations: {
          // Every tool in this phase reads. Saying so lets a client skip a confirmation it would
          // otherwise be right to ask for.
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        try {
          const result = await tool.run(client, args);
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(result, null, 2) },
              ...(await imagesFor(tool, client, args, result)),
            ],
            // Advertised cache metadata: how long this answer stays good, and what it covers.
            _meta: { 'io.d3cloud.foreman/cache': tool.cache },
          };
        } catch (error) {
          // An error is returned as a tool result, not thrown: the model can read it and decide,
          // where a protocol error just ends the call.
          const message =
            error instanceof ForemanApiError
              ? `Foreman: ${error.message} (${String(error.status)})`
              : error instanceof Error
                ? error.message
                : String(error);
          return { content: [{ type: 'text' as const, text: message }], isError: true };
        }
      },
    );
  }

  for (const tool of WRITE_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // The whole schema, not its shape: the shape alone is rebuilt by the SDK as a plain
        // object, which strips a field it does not know and drops the per-kind refinement — the
        // silent loss these schemas exist to refuse (FRM-T-017).
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: false,
          // Not destructive by default: most writes here add or advance. The ones that lose
          // something are gated individually below, which is more honest than one flag for all.
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        try {
          const decision = await tool.gate(client, args);

          if (decision.gated) {
            // ADR-011: the plan's MRTR `input_required` round-trip, carried by 2025-11-25's
            // elicitation. The design is unchanged — ask before losing something — and this is
            // the mechanism the SDK actually ships.
            const asked = await server.server.elicitInput({
              message: `${decision.because ?? 'This change needs confirming.'}\n\nGo ahead?`,
              requestedSchema: {
                type: 'object',
                properties: {
                  confirm: {
                    type: 'boolean',
                    title: 'Confirm',
                    description: 'Yes, make this change.',
                  },
                },
                required: ['confirm'],
              },
            });

            if (asked.action !== 'accept' || asked.content?.['confirm'] !== true) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    // Declining is a normal outcome, not a failure: say what did not happen.
                    text: `Not done — ${asked.action === 'accept' ? 'not confirmed' : asked.action}. Nothing was changed.`,
                  },
                ],
              };
            }
          }

          const result = await tool.run(client, args);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          const message =
            error instanceof ForemanApiError
              ? `Foreman: ${error.message} (${String(error.status)})`
              : error instanceof Error
                ? error.message
                : String(error);
          return { content: [{ type: 'text' as const, text: message }], isError: true };
        }
      },
    );
  }

  /**
   * Documents and sections, addressed by URI (T-4.9).
   *
   * One template for both: `foreman://BND/architecture` is the document, and
   * `foreman://BND/architecture#deployment` is three paragraphs of it. Long content goes here and
   * never through tool output — a tool result is spent context whether or not it was the part
   * anybody needed.
   */
  server.registerResource(
    'document',
    new ResourceTemplate(RESOURCE_TEMPLATE, {
      list: async () => ({
        resources: (await listResources(client)).map((entry) => ({
          uri: entry.uri,
          name: entry.name,
          description: entry.description,
          mimeType: entry.mimeType,
        })),
      }),
    }),
    {
      title: 'Project documents',
      description:
        'Architecture, data model, API contract, runbooks and phase plans — whole, or one ' +
        'addressed section.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      try {
        const content = await readResource(client, uri.href);
        return { contents: [content] };
      } catch (error) {
        const message =
          error instanceof ForemanApiError
            ? `Foreman: ${error.message} (${String(error.status)})`
            : error instanceof Error
              ? error.message
              : String(error);
        // A resource read has no `isError`, so the message is the content — and a 404 here names
        // the addresses that do exist, which is what makes the next call the right one.
        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: message }] };
      }
    },
  );

  /**
   * Every active guideline as one page (FRM-REQ-188). Static, not templated: there is one, and it
   * belongs to no project — so it has no code to put in `foreman://<code>/…`.
   */
  server.registerResource(
    'guidelines',
    GUIDELINES_URI,
    {
      title: 'Guidelines',
      description:
        'Standing decisions for every D3 Cloud project — each with its reasoning and how to apply it.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const body = await client.get<{ markdown: string }>('/api/guidelines/markdown');
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: body.markdown }] };
    },
  );

  return server;
}

export const GUIDELINES_URI = 'foreman://guidelines';

/**
 * A tool's pictures as MCP `image` content (FRM-REQ-198). A failure to fetch them is said in a
 * line of text rather than failing the call: the entity was found, and is worth returning without
 * its pictures.
 */
async function imagesFor(
  tool: ToolDefinition,
  client: ForemanClient,
  args: unknown,
  result: unknown,
): Promise<({ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string })[]> {
  if (tool.images === undefined) return [];
  try {
    const images = await tool.images(client, args, result);
    return images.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }));
  } catch (error) {
    const message =
      error instanceof ForemanApiError
        ? `${error.message} (${String(error.status)})`
        : error instanceof Error
          ? error.message
          : String(error);
    return [{ type: 'text' as const, text: `Images unavailable: ${message}` }];
  }
}
