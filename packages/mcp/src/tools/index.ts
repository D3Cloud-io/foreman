import {
  BriefInput,
  CACHE,
  CoverageInput,
  FindingsInput,
  GetInput,
  parseHumanId,
  PortfolioInput,
  type ScreenImages,
  SearchInput,
} from '@foreman/shared';
import { z } from 'zod';
import type { ForemanClient } from '../client.js';
import { WRITE_TOOLS } from './writes.js';

/**
 * The read tools (T-1.9). Writes arrive in Phase 2.
 *
 * Every input schema is **the one declared in `packages/shared`** — not a copy of it. That is what
 * makes the console and this shim equal peers rather than an API and a wrapper that drifts from it,
 * and a contract test asserts the generated JSON Schema still matches.
 *
 * Descriptions are deliberately terse. Tool definitions are sent on every single turn, so prose
 * here is a tax paid forever; the research this was sized against says an overlong definition set
 * is the specific thing that kills an MCP server's usefulness.
 */

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  /** Advertised so a client need not re-ask for an answer that has not gone stale. */
  readonly cache: { readonly ttlMs: number; readonly cacheScope: 'project' | 'global' };
  /**
   * Always returns a promise, and never throws synchronously — including on invalid input. A
   * caller that has to handle both a throw and a rejection will eventually handle only one.
   */
  run(client: ForemanClient, input: unknown): Promise<unknown>;
  /**
   * Pictures to send beside the JSON, as MCP `image` content. Only `foreman_get` has any: a screen
   * is something to look at, and its JSON alone says what changed without showing it (FRM-REQ-198).
   */
  images?(client: ForemanClient, input: unknown, result: unknown): Promise<readonly ToolImage[]>;
}

/** One MCP `image` content item: base64 bytes and their type. */
export interface ToolImage {
  readonly data: string;
  readonly mimeType: string;
}

/**
 * A screen's current proposal and latest capture (FRM-REQ-198), fetched as base64 JSON through
 * the same API client as every other call — so the stdio shim and the remote `/mcp`, which loops
 * back through that client, attach them the same way.
 */
async function screenImages(client: ForemanClient, result: unknown): Promise<readonly ToolImage[]> {
  const found = result as { type?: unknown; humanId?: unknown } | null;
  if (found?.type !== 'screen' || typeof found.humanId !== 'string') return [];
  const code = parseHumanId(found.humanId)?.code;
  if (code === undefined) return [];
  const answer = await client.get<ScreenImages>(`/api/projects/${code}/screens/${found.humanId}/images`);
  return answer.images.map((image) => ({ data: image.data, mimeType: image.mimeType }));
}

export const READ_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'foreman_brief',
    title: 'Project brief',
    description:
      'Where a project stands: active phase, next unblocked tasks, blocked work and why, open ' +
      'criticals, CI, and drift. Call this first.',
    inputSchema: BriefInput,
    cache: CACHE.brief,
    run: async (client, input) => {
      const { project } = BriefInput.parse(input);
      return client.get(`/api/brief/${project}`);
    },
  },
  {
    name: 'foreman_portfolio',
    title: 'Portfolio',
    description:
      'Every project under its group, in order: lifecycle, active phase, task counts, criticals, ' +
      'CI, drift.',
    inputSchema: PortfolioInput,
    cache: CACHE.portfolio,
    run: async (client, input) => {
      const args = PortfolioInput.parse(input);
      // The grouped sections only. `items` is the same rows again in code order, kept for the
      // readers that predate groups; sent here it would double every portfolio call's output.
      const answer = await (args.group === undefined
        ? client.get<Record<string, unknown>>('/api/portfolio')
        : client.get<Record<string, unknown>>('/api/portfolio', { group: args.group }));
      return Object.fromEntries(Object.entries(answer).filter(([key]) => key !== 'items'));
    },
  },
  {
    name: 'foreman_search',
    title: 'Search',
    description:
      'Search every project, by kind; an exact human ID resolves to that entity first.',
    inputSchema: SearchInput,
    cache: CACHE.search,
    run: async (client, input) => {
      const args = SearchInput.parse(input);
      return client.get('/api/search', {
        q: args.q,
        types: args.types,
        project: args.project,
        limit: args.limit,
      });
    },
  },
  {
    name: 'foreman_get',
    title: 'Get by ID',
    // A screen also comes back with its current proposal and latest capture as image content
    // (FRM-REQ-198) — not said here, because the definition budget has almost nothing left.
    description: 'One entity by human ID (BND-REQ-021), with what cites it.',
    inputSchema: GetInput,
    cache: CACHE.get,
    run: async (client, input) => {
      const args = GetInput.parse(input);
      return client.get(`/api/entities/${args.id}`, { backlinks: args.backlinks });
    },
    images: (client, _input, result) => screenImages(client, result),
  },
  {
    name: 'foreman_coverage',
    title: 'Coverage',
    description:
      'Uncovered Musts, tasks citing no requirement, requirements with no acceptance test, EARS ' +
      'warnings. With a phase: its exit gate, what stands in the way of completing it.',
    inputSchema: CoverageInput,
    cache: CACHE.coverage,
    run: async (client, input) => {
      const args = CoverageInput.parse(input);
      return args.phase === undefined
        ? client.get(`/api/projects/${args.project}/coverage`)
        : client.get(`/api/projects/${args.project}/phases/${args.phase}/gate`);
    },
  },
  {
    name: 'foreman_findings',
    title: 'Findings inbox',
    description:
      'Open audit findings across every project, by severity, each with its location, audit and ' +
      'fix state.',
    inputSchema: FindingsInput,
    cache: CACHE.findings,
    run: async (client, input) => {
      const args = FindingsInput.parse(input);
      return client.get('/api/findings', {
        project: args.project,
        severity: args.severity,
        status: args.status,
        lens: args.lens,
        limit: args.limit,
      });
    },
  },
];

/** What every tool has, whichever half it belongs to. This is what the budget is measured over. */
export interface ToolSummary {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
}

/** Every tool, read and write. The contract tests measure this list. */
export const TOOLS: readonly ToolSummary[] = [...READ_TOOLS, ...WRITE_TOOLS];

export { WRITE_TOOLS };

/**
 * The ceiling, asserted by a contract test. Twelve is not arbitrary: past roughly that many, the
 * definitions cost more context than the answers are worth, and the model starts choosing badly
 * between tools that sound alike.
 */
export const MAX_TOOLS = 12;

/**
 * The token budget for the whole definition set.
 *
 * Derived from the plan's own figure — the API Contract sizes the surface at **~2–3k tokens for
 * ~10 verbs**, against the measured token tax in the research notes. 2400 is the middle of that
 * range, and with the full surface the set costs about 1250, so there is real headroom rather than
 * a number chosen to fit what happens to be there.
 *
 * It was 1200 while only the four read tools existed, and the write tools tripped it — which is the
 * guard working. The right response was to calibrate the constant against the plan rather than
 * against the moment, and to keep the test that proves it still bites when a definition bloats.
 *
 * Four characters per token is the usual approximation for English; the number is crude on purpose,
 * because the failure it guards against is a doubling, not a rounding.
 */
export const TOOL_DEFINITION_TOKEN_BUDGET = 2400;

export function toolDefinitionTokens(definitions: readonly ToolSummary[] = TOOLS): number {
  const payload = definitions.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema, { io: 'input' }),
  }));
  return Math.ceil(JSON.stringify(payload).length / 4);
}
