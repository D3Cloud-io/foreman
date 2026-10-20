import { z } from 'zod';
import { AuditKind, AuditStatus, FindingStatus, Severity, Verified } from '../enums.js';
import { HumanId, ProjectCode } from '../ids.js';
import { Uuid } from './common.js';
import { GroupArg } from './groups.js';

/**
 * Audits and findings (T-6.1, T-6.2).
 *
 * **Transcribed, not invented.** Every field here already exists as YAML frontmatter in 127 real
 * finding files — `lens`, `severity`, `confidence`, `verified`, `status`, `found_round`, `effort`,
 * `fixed_round`, `fixed_commit`, `location`, `related_adr`. Where this differs from the plan, the
 * corpus won: `verified: unverified` appears on 123 of 127, and `status: deferred` on one.
 */

/** The ten lenses the review panel actually uses. Free-form, because a new lens is not a migration. */
export const LENSES = [
  'architecture',
  'security',
  'correctness',
  'performance',
  'accessibility',
  'data',
  'testing',
  'maintainability',
  'dependencies',
  'operability',
] as const;

export const AuditCreate = z.object({
  kind: AuditKind,
  scope: z.string().max(500).optional(),
  runDate: z.iso.date().optional(),
  verdict: z.string().max(500).optional(),
  rounds: z.number().int().min(1).max(50).optional(),
  status: AuditStatus.optional(),
  /** Where the write-up lives, for the audits that predate Foreman. */
  vaultPath: z.string().max(1000).optional(),
});
export type AuditCreate = z.infer<typeof AuditCreate>;

export const AuditUpdate = AuditCreate.partial();
export type AuditUpdate = z.infer<typeof AuditUpdate>;

export const FindingCreate = z.object({
  title: z.string().min(1).max(500),
  severity: Severity,
  lenses: z.array(z.string().min(1).max(40)).max(10).optional(),
  confidence: z.string().max(40).optional(),
  /**
   * Defaults to `unverified`, which is what 123 of 127 real findings say. A verdict is something
   * a verifier produces; its absence is a state, not a blank.
   */
  verified: Verified.optional(),
  status: FindingStatus.optional(),
  foundRound: z.number().int().min(1).max(50).optional(),
  fixedRound: z.number().int().min(1).max(50).optional(),
  effort: z.string().max(10).optional(),
  /** The location as written. Parsed into rows on save; the raw text is kept either way. */
  location: z.string().max(4000).optional(),
  observedMd: z.string().max(100_000).optional(),
  recommendationMd: z.string().max(100_000).optional(),
  /** `BND-ADR-008`, `BND-REQ-021` — what this finding contradicts. */
  adr: HumanId.optional(),
  requirement: HumanId.optional(),
  phaseId: Uuid.nullish(),
  auditId: Uuid.nullish(),
});
export type FindingCreate = z.infer<typeof FindingCreate>;

export const FindingUpdate = FindingCreate.partial().extend({
  /**
   * The commit that fixed it. Recorded as a **SHA, not a link**: the commit may not be ingested
   * yet, and refusing to record a fix until ingest catches up would lose the one moment somebody
   * knows the answer (FRM-REQ-117, FRM-REQ-119).
   */
  fixedCommitSha: z.string().regex(/^[0-9a-f]{7,40}$/i).nullish(),
});
export type FindingUpdate = z.infer<typeof FindingUpdate>;

/** `foreman_findings` / `GET /api/findings`. Cross-project by default — that is the whole point. */
export const FindingsInput = z.object({
  project: ProjectCode.optional().describe('Narrow to one project'),
  // A group to narrow to — GRP-n, slug or `ungrouped` (FRM-ADR-024). Undescribed: the tool budget
  // is full, and `foreman_portfolio`'s own `group` already says what one is.
  group: GroupArg.optional(),
  severity: Severity.optional(),
  status: FindingStatus.optional().describe('Defaults to open'),
  lens: z.string().max(40).optional().describe('security, accessibility, operability, …'),
  limit: z.number().int().min(1).max(200).default(50),
});
export type FindingsInput = z.infer<typeof FindingsInput>;
