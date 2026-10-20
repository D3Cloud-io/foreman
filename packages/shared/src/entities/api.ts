import { z } from 'zod';
import { AnyId, HumanId, ProjectCode } from '../ids.js';
import { GroupArg } from './groups.js';

/**
 * The request shapes the API and the MCP shim **both** use.
 *
 * This is FRM-REQ-003 at its most load-bearing: an MCP tool's input schema is generated from the
 * schema declared here, and the Express route validates against the same one. A contract test
 * asserts the generated JSON Schema matches, so the two surfaces cannot drift — which is the whole
 * claim behind calling them equal peers rather than an API with a wrapper.
 */

export const SEARCHABLE_TYPES = [
  'requirement',
  'task',
  'adr',
  'finding',
  'document_section',
  'term',
  'phase',
  'decision',
  'risk',
  'idea',
  // Was missing here while the server's own list had it, so the API could search project ideas
  // and the MCP shim, whose enum is generated from this one, could not ask it to.
  'project_idea',
] as const;

export const SearchableType = z.enum(SEARCHABLE_TYPES);
export type SearchableType = z.infer<typeof SearchableType>;

/** `foreman_brief` / `GET /api/brief/:code`. */
export const BriefInput = z.object({
  project: ProjectCode.describe('The project code, e.g. BND'),
});
export type BriefInput = z.infer<typeof BriefInput>;

/**
 * `foreman_portfolio` / `GET /api/portfolio`: every project, under its group in order, the
 * ungrouped last (FRM-REQ-237). `group` narrows to one — `GRP-001`, a slug, or `ungrouped`.
 */
export const PortfolioInput = z.object({
  group: GroupArg.optional().describe('Narrow to one: GRP-n, slug or ungrouped'),
});
export type PortfolioInput = z.infer<typeof PortfolioInput>;

/** `foreman_search` / `GET /api/search`. */
export const SearchInput = z.object({
  q: z.string().min(1).max(200).describe('What to look for'),
  types: z.array(SearchableType).optional().describe('Narrow to these kinds'),
  project: ProjectCode.optional().describe('Narrow to one project'),
  // Narrow to one group, as `foreman_portfolio` does (FRM-ADR-024). Undescribed for the budget.
  group: GroupArg.optional(),
  limit: z.number().int().min(1).max(100).default(30),
});
export type SearchInput = z.infer<typeof SearchInput>;

/** `foreman_get` / `GET /api/entities/:humanId`. */
export const GetInput = z.object({
  // `AnyId`, not `HumanId`: a project idea's `PI-007` has no project code, and `foreman_get` used to
  // refuse it outright — so a session could create a project idea and never read it back.
  id: AnyId.describe('A human ID, e.g. BND-REQ-021 or PI-007'),
  backlinks: z
    .boolean()
    .default(true)
    .describe('Include what cites this entity'),
});
export type GetInput = z.infer<typeof GetInput>;

/**
 * `foreman_coverage` / `GET /api/projects/:code/coverage`.
 *
 * With a phase, the answer is that phase's exit gate — what stands in the way of calling it
 * complete — rather than the project-wide holes.
 */
export const CoverageInput = z.object({
  project: ProjectCode.describe('The project code, e.g. BND'),
  phase: HumanId.optional().describe('A phase ID, e.g. BND-P-3'),
});
export type CoverageInput = z.infer<typeof CoverageInput>;

/**
 * Cache metadata on a listing. The client is told how long an answer stays good for and what it is
 * scoped to, so it need not re-ask for a portfolio that has not changed.
 */
export const CacheMeta = z.object({
  ttlMs: z.number().int().nonnegative(),
  cacheScope: z.enum(['project', 'global']),
});
export type CacheMeta = z.infer<typeof CacheMeta>;

/** How long each answer stays useful. Short, because the point of Foreman is that it is current. */
export const CACHE = {
  brief: { ttlMs: 30_000, cacheScope: 'project' },
  portfolio: { ttlMs: 60_000, cacheScope: 'global' },
  search: { ttlMs: 15_000, cacheScope: 'global' },
  get: { ttlMs: 30_000, cacheScope: 'project' },
  coverage: { ttlMs: 30_000, cacheScope: 'project' },
  findings: { ttlMs: 30_000, cacheScope: 'global' },
} as const satisfies Record<string, CacheMeta>;
