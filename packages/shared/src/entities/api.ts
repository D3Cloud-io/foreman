import { z } from 'zod';
import { type ActorKind, type AttributionSource, type AuditAction, TaskStatus } from '../enums.js';
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

// ─── Undo (FRM-REQ-243) ────────────────────────────────────────────────────

/**
 * What every console mutation adds to the JSON it already returns: the audit events the change
 * wrote, the record's own first and anything that moved because of it (a phase or project rolled
 * up, a group renumbered) after. `POST /api/undo/:auditEventId` reverses any one of them.
 *
 * Additive — a client that does not read it sees the response it always saw. A DELETE keeps its
 * 204 and carries the same IDs in the `Audit-Event-Ids` header (the first also in `Audit-Event-Id`).
 */
export interface WithAuditEventIds {
  readonly auditEventIds: readonly string[];
}

/** Response headers on a DELETE, which has no body to put `auditEventIds` in. */
export const AUDIT_EVENT_ID_HEADER = 'Audit-Event-Id';
export const AUDIT_EVENT_IDS_HEADER = 'Audit-Event-Ids';

/** `GET /api/audit-events?entity=<humanId>&limit=`: one record's history. */
export const AuditEventsQuery = z.object({
  // A human ID (FRM-REQ-001, PI-007, GL-004, GRP-001), a project code, or a document's UUID.
  entity: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditEventsQuery = z.infer<typeof AuditEventsQuery>;

export interface AuditEventEntry {
  readonly id: string;
  /** ISO 8601. */
  readonly at: string;
  readonly actor: { readonly kind: ActorKind; readonly label: string };
  readonly action: AuditAction;
  /** One human sentence: what changed. */
  readonly summary: string;
  /**
   * Whether `POST /api/undo/:id` would succeed right now. `null` for an event beyond the newest
   * ten of a response, which is not checked: ask `GET /api/audit-events/:id/undoable`.
   */
  readonly undoable: boolean | null;
  /** Why not, when it is not: the refusal the undo itself would give — or why it was not checked. */
  readonly reason?: string;
}

/** `GET /api/audit-events/:id/undoable`: one event's verdict. */
export type AuditEventUndoability =
  | { readonly id: string; readonly undoable: true }
  | { readonly id: string; readonly undoable: false; readonly reason: string };

export interface AuditEventsResponse {
  readonly entity: string;
  /** Newest first. */
  readonly items: readonly AuditEventEntry[];
}

// ─── Triage across a scope (FRM-T-18.7, FRM-REQ-246) ────────────────────────

/**
 * `GET /api/attributions?status=proposed&group=&project=&limit=`: the attributions nobody has
 * confirmed or rejected, across a scope, newest commit first — the Review tab of `/findings`.
 *
 * `proposed` is the only status asked for: a confirmed attribution is settled and a rejected one is
 * kept only so it is never proposed again, so neither is anything to triage.
 */
export const AttributionsQuery = z.object({
  status: z.enum(['proposed']).default('proposed'),
  group: GroupArg.optional(),
  project: ProjectCode.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AttributionsQuery = z.infer<typeof AttributionsQuery>;

export interface ProposedAttribution {
  /** The project of the task it claims — the one whose brief counts it as unconfirmed. */
  readonly project: { readonly code: string; readonly name: string };
  readonly commit: {
    readonly sha: string;
    /** The whole message; its first line is the subject. */
    readonly message: string;
    readonly author: string;
    /** ISO 8601. */
    readonly committedAt: string;
    readonly repo: string;
    readonly files: readonly string[];
    /** Set when a force push removed it from the remote (FRM-REQ-105). */
    readonly orphaned: boolean;
    /** Every check run reported for the commit. Empty is "nothing reported", not "passing". */
    readonly checks: readonly { readonly name: string; readonly conclusion: string | null }[];
  };
  readonly task: {
    readonly humanId: string;
    readonly title: string;
    readonly status: string;
    readonly doneWhen: string | null;
    readonly phase: { readonly humanId: string; readonly name: string } | null;
  };
  /** Which signal proposed it — declared, the message, or a file overlap (a hint only). */
  readonly source: AttributionSource;
  readonly confidence: number;
  /** What was seen, kept so a person confirming can check rather than trust. */
  readonly evidence: unknown;
  /** ISO 8601: when the proposal was made. */
  readonly proposedAt: string;
}

export interface ProposedAttributionsResponse {
  readonly items: readonly ProposedAttribution[];
  readonly nextCursor: null;
  /** The whole matching set, not the page — the same count each project's brief reports. */
  readonly total: number;
}

/**
 * `GET /api/tasks?status=blocked&group=&project=&limit=`: tasks in one status across a scope — the
 * Blocked tab of `/findings`. `blocked` when no status is named, because that is the question the
 * read exists for.
 */
export const TasksAcrossQuery = z.object({
  status: TaskStatus.default('blocked'),
  group: GroupArg.optional(),
  project: ProjectCode.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type TasksAcrossQuery = z.infer<typeof TasksAcrossQuery>;

export interface TaskAcrossRow {
  readonly project: { readonly code: string; readonly name: string };
  readonly humanId: string;
  readonly title: string;
  readonly status: string;
  readonly blockedReason: string | null;
  readonly size: string | null;
  readonly doneWhen: string | null;
  readonly phase: { readonly humanId: string; readonly name: string } | null;
  /** ISO 8601. */
  readonly updatedAt: string;
}

export interface TasksAcrossResponse {
  readonly items: readonly TaskAcrossRow[];
  readonly nextCursor: null;
  readonly total: number;
}
