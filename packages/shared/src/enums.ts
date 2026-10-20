import { z } from 'zod';

/**
 * Every enumerated value in the model, declared once (FRM-REQ-003). The Prisma schema mirrors
 * these as native Postgres enums, the API validates against them, and the MCP tool schemas are
 * generated from them — so a value added here cannot silently miss a surface.
 */

export const ProjectLifecycle = z.enum([
  'planned',
  'scaffolded',
  'building',
  'deployed',
  'parked',
  'scrapped',
]);
export type ProjectLifecycle = z.infer<typeof ProjectLifecycle>;

/**
 * `planned`, `active`, `complete` and `cancelled` are derived from the phase's tasks
 * (FRM-REQ-183); only `parked` is a decision nobody else can make, so only `parked` is sticky.
 */
export const PhaseStatus = z.enum(['planned', 'active', 'complete', 'cancelled', 'parked']);
export type PhaseStatus = z.infer<typeof PhaseStatus>;

/** T-shirt sizes only. Foreman records no time estimates anywhere (FRM-REQ-125 territory). */
export const Size = z.enum(['XS', 'S', 'M', 'L', 'XL']);
export type Size = z.infer<typeof Size>;

export const TaskStatus = z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** MoSCoW. `M` must, `S` should, `C` could, `W` won't. */
export const Priority = z.enum(['M', 'S', 'C', 'W']);
export type Priority = z.infer<typeof Priority>;

/**
 * EARS patterns. `unparsed` is a legal stored state, never a rejection: the lint warns and the
 * requirement is kept (ADR/Discovery D-14).
 */
export const EarsPattern = z.enum([
  'ubiquitous',
  'state',
  'event',
  'unwanted',
  'optional',
  'complex',
  'unparsed',
]);
export type EarsPattern = z.infer<typeof EarsPattern>;

export const AdrStatus = z.enum(['proposed', 'accepted', 'superseded', 'rejected']);
export type AdrStatus = z.infer<typeof AdrStatus>;

export const AdrRelationKind = z.enum(['extends', 'supersedes', 'superseded_by']);
export type AdrRelationKind = z.infer<typeof AdrRelationKind>;

/**
 * The four states an idea can be in.
 *
 * Taken from the "Feature Ideas & Future Development" documents four projects already carry
 * rather than invented: Accepted, Parked — *"good ideas, deliberately not now"* — and Rejected,
 * under the heading *"do not re-litigate these"*. `new` is one nobody has judged yet.
 */
export const IdeaStatus = z.enum(['new', 'accepted', 'parked', 'rejected']);
export type IdeaStatus = z.infer<typeof IdeaStatus>;

/** The two that need a reason: a decision without one gets re-argued. */
export const IDEA_NEEDS_REASON: readonly IdeaStatus[] = ['parked', 'rejected'];

/**
 * A **project idea** — something that might become a project of its own.
 *
 * Deliberately not `IdeaStatus`. A feature idea is accepted and then built inside a project it
 * already belongs to; a project idea has one more state to reach, and reaching it creates
 * something: `converted` means a project now exists, and it is set by converting, never by hand.
 * `considering` is the step in between that a feature idea has no use for — the point where
 * somebody is actually thinking about it rather than having merely written it down.
 */
/**
 * A guideline is followed or it is not. `retired` keeps the card and its reasoning — the history
 * of why something used to be the rule is worth more than a clean list — but drops it from every
 * brief, so a session is never told to follow what was abandoned.
 */
export const GuidelineStatus = z.enum(['active', 'retired']);
export type GuidelineStatus = z.infer<typeof GuidelineStatus>;

export const ProjectIdeaStatus = z.enum([
  'new',
  'considering',
  'shortlisted',
  'funded',
  'parked',
  'rejected',
  'converted',
]);

/**
 * The statuses each deployment mode offers.
 *
 * Both lists are subsets of one enum rather than two enums, because the *record* is the same
 * thing in both: a candidate somebody might build. What differs is where it can end up — a solo
 * instance converts an idea into a Foreman project, and a fund board funds it.
 */
export const SOLO_STATUSES: readonly ProjectIdeaStatus[] = [
  'new',
  'considering',
  'parked',
  'rejected',
  'converted',
];

export const BOARD_STATUSES: readonly ProjectIdeaStatus[] = [
  'new',
  'considering',
  'shortlisted',
  'funded',
  'parked',
  'rejected',
];

/** Reached by deciding to fund, and carrying an amount. */
export const PROJECT_IDEA_FUNDED: ProjectIdeaStatus = 'funded';
export type ProjectIdeaStatus = z.infer<typeof ProjectIdeaStatus>;

/** Same rule, same reason as an idea's: a decision with no reason written down gets re-argued. */
export const PROJECT_IDEA_NEEDS_REASON: readonly ProjectIdeaStatus[] = ['parked', 'rejected'];

/** Reachable by converting, and by nothing else. A PATCH that asks for it is refused. */
export const PROJECT_IDEA_CONVERTED: ProjectIdeaStatus = 'converted';

/**
 * What an account may do (FRM-ADR-016).
 *
 * Ordered most-privileged first, which is the order a person reads them in and the order the
 * members screen lists them. A solo instance has exactly one account, and it is an `admin`.
 */
export const UserRole = z.enum(['admin', 'reviewer', 'submitter']);
export type UserRole = z.infer<typeof UserRole>;

/** Who may see an internal comment, score a submission, or decide one. */
export const REVIEWS: readonly UserRole[] = ['admin', 'reviewer'];

export const RiskLikelihood = z.enum(['low', 'medium', 'high']);
export type RiskLikelihood = z.infer<typeof RiskLikelihood>;

export const RiskImpact = z.enum(['low', 'medium', 'high']);
export type RiskImpact = z.infer<typeof RiskImpact>;

export const RiskStatus = z.enum(['open', 'fired', 'closed']);
export type RiskStatus = z.infer<typeof RiskStatus>;

/**
 * Document kinds are *data*, not a migration (ADR-006): the five registers that used to be files
 * are views over tables and deliberately absent from this list.
 */
export const DocumentKind = z.enum([
  'architecture',
  'data_model',
  'api_contract',
  'ux_flows',
  'research',
  'discovery',
  'phase_plan',
  'test_strategy',
  'feature_ideas',
  'overview',
  'runbook',
]);
export type DocumentKind = z.infer<typeof DocumentKind>;

export const AuditKind = z.enum(['code_review', 'design', 'feature', 'api']);
export type AuditKind = z.infer<typeof AuditKind>;

export const AuditStatus = z.enum(['running', 'complete', 'abandoned']);
export type AuditStatus = z.infer<typeof AuditStatus>;

export const Severity = z.enum(['critical', 'high', 'medium', 'low']);
export type Severity = z.infer<typeof Severity>;

/**
 * The adversarial verifier's verdict. **`unverified` is a real state, not a missing value**:
 * 123 of the 127 real findings carry it, because a verifier was cut off or never ran.
 */
export const Verified = z.enum(['confirmed', 'plausible', 'unverified']);
export type Verified = z.infer<typeof Verified>;

/** `deferred` is in the real corpus and distinct from `wont_fix`: later, not never. */
export const FindingStatus = z.enum(['open', 'fixed', 'deferred', 'skipped', 'wont_fix']);
export type FindingStatus = z.infer<typeof FindingStatus>;

export const CheckConclusion = z.enum([
  'success',
  'failure',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  'neutral',
  'stale',
]);
export type CheckConclusion = z.infer<typeof CheckConclusion>;

/** How a commit came to be attributed to a task (ADR-005 — declared beats inferred). */
export const AttributionSource = z.enum(['declared', 'message', 'file_overlap']);
export type AttributionSource = z.infer<typeof AttributionSource>;

/** The importer's three outcomes. Every source file gets one; silence is the failure mode. */
export const ImportStatus = z.enum(['mapped', 'partial', 'unmapped']);
export type ImportStatus = z.infer<typeof ImportStatus>;

export const JobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatus>;

export const ReferenceKind = z.enum([
  'cites',
  'satisfies',
  'violates',
  'relates',
  'supersedes',
  'depends_on',
]);
export type ReferenceKind = z.infer<typeof ReferenceKind>;

/** The entity types addressable by a reference, an audit event or an import record. */
export const EntityType = z.enum([
  'project',
  'repo',
  'phase',
  'requirement',
  'task',
  'adr',
  'decision',
  'risk',
  'term',
  'document',
  'document_section',
  'audit',
  'finding',
  'commit',
  'check_run',
  'release',
  'deployment',
  'tech_item',
  'idea',
  'project_idea',
  'guideline',
  'idea_score',
  'idea_comment',
  'user',
  'api_token',
  'job',
  'blob',
  'screen',
  'screen_version',
  'screen_verdict',
  'screen_component',
]);
export type EntityType = z.infer<typeof EntityType>;

// ─── Screens (FRM-REQ-189 … FRM-REQ-199) ───────────────────────────────────

/** One table holds both: what the screen should look like, and what it did look like. */
export const ScreenVersionKind = z.enum(['proposal', 'capture']);
export type ScreenVersionKind = z.infer<typeof ScreenVersionKind>;

export const ScreenViewport = z.enum(['desktop', 'mobile']);
export type ScreenViewport = z.infer<typeof ScreenViewport>;

export const ScreenTheme = z.enum(['light', 'dark']);
export type ScreenTheme = z.infer<typeof ScreenTheme>;

/** A proposal's standing in its (viewport, theme) line (FRM-REQ-193). A capture has none. */
export const ScreenProposalStatus = z.enum(['current', 'superseded']);
export type ScreenProposalStatus = z.infer<typeof ScreenProposalStatus>;

/** A reviewer's judgement of a capture against the proposal (FRM-REQ-195). */
export const ScreenVerdictKind = z.enum(['matches', 'drifted_accepted', 'drifted_fix']);
export type ScreenVerdictKind = z.infer<typeof ScreenVerdictKind>;

/** An `@d3cloud/ui` component the screen uses, or one it needs that the library lacks. */
export const ScreenComponentKind = z.enum(['uses', 'gap']);
export type ScreenComponentKind = z.infer<typeof ScreenComponentKind>;

export const AuditAction = z.enum(['create', 'update', 'delete', 'restore', 'undo']);
export type AuditAction = z.infer<typeof AuditAction>;

/** Who performed a mutation. The MCP shim and the importer are first-class actors. */
export const ActorKind = z.enum(['user', 'mcp', 'importer', 'webhook', 'system']);
export type ActorKind = z.infer<typeof ActorKind>;
