import { z } from 'zod';
import {
  EarsPattern,
  PhaseStatus,
  Priority,
  ProjectLifecycle,
  Size,
  TaskStatus,
} from '../enums.js';
import { HumanId, ProjectCode } from '../ids.js';
import { Instant, Timestamps, Uuid } from './common.js';
import { GroupRef } from './groups.js';

/**
 * The core spine: project, phase, requirement, task.
 *
 * Each entity is declared three times over — the stored shape, what may be created, and what may be
 * changed — because they genuinely differ. `project.code` is the clearest case: required on
 * creation, present on every read, and **absent from the update shape entirely**, so "you cannot
 * change a project's code" is a fact about the type rather than a rule somebody remembers
 * (FRM-REQ-031, ADR-008).
 */

// ─── Project ───────────────────────────────────────────────────────────────

export const Project = z
  .object({
    id: Uuid,
    code: ProjectCode,
    name: z.string().min(1).max(200),
    slug: z.string().min(1).max(200),
    lifecycle: ProjectLifecycle,
    pitch: z.string().max(2000).nullable(),
    vaultPath: z.string().max(1000).nullable(),
    /** The group it belongs to, or null for none (FRM-REQ-223). */
    groupId: Uuid.nullable(),
    /** Its place within its group, or among the ungrouped; ties are broken by code. */
    groupPosition: z.number().int(),
  })
  .extend(Timestamps.shape);
export type Project = z.infer<typeof Project>;

export const ProjectCreate = z.object({
  code: ProjectCode,
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'a slug is lower-case words joined by hyphens')
    .optional(),
  lifecycle: ProjectLifecycle.optional(),
  pitch: z.string().max(2000).optional(),
  vaultPath: z.string().max(1000).optional(),
  /**
   * The group the project belongs to — `GRP-001` or a slug — or null for none (FRM-REQ-223). It
   * joins the end of that group's order; `POST /api/groups/:id/projects` places it anywhere.
   */
  group: GroupRef.nullable().optional(),
});
export type ProjectCreate = z.infer<typeof ProjectCreate>;

/** No `code`. It is immutable once assigned, and every human ID in the project embeds it. */
export const ProjectUpdate = ProjectCreate.omit({ code: true }).partial();
export type ProjectUpdate = z.infer<typeof ProjectUpdate>;

// ─── Phase ─────────────────────────────────────────────────────────────────

/**
 * Whether a phase number fits the column that stores it: `numeric(6,2)`, so less than 10000 either
 * side of zero and at most two decimal places (FRM-T-027).
 *
 * Refused here rather than at the database, which answered 123456 with an overflow and the API
 * with "internal error". A third decimal is refused too: Postgres would round 1.234 to 1.23 while
 * the human ID kept `P-1.234`, and the ID would name a phase that does not exist.
 */
export function isStorablePhaseNumber(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n) < 10000 && Math.round(n * 100) / 100 === n;
}

/** A phase number as `phase.number` can hold it. See {@link isStorablePhaseNumber}. */
export const PhaseNumber = z.number().refine(isStorablePhaseNumber, {
  message: 'a phase number is less than 10000 either side of zero, with at most two decimal places',
});

/**
 * Phase numbers are decimal, and `sortOrder` is independent of them. Bindery shipped a Phase 8.5,
 * and built 0–8.5, then 9–11, then 13–16, with 12 still ahead: the order phases were built in is
 * not the order they are numbered (FRM-REQ-034, FRM-REQ-035).
 */
export const Phase = z
  .object({
    id: Uuid,
    projectId: Uuid,
    humanId: HumanId,
    number: z.number(),
    sortOrder: z.number().int(),
    name: z.string().min(1).max(200),
    objective: z.string().max(4000).nullable(),
    status: PhaseStatus,
    exitDemo: z.string().max(4000).nullable(),
    size: Size.nullable(),
    startedAt: Instant.nullable(),
    completedAt: Instant.nullable(),
  })
  .extend(Timestamps.shape);
export type Phase = z.infer<typeof Phase>;

export const PhaseCreate = z.object({
  number: PhaseNumber,
  /** Defaults to the end of the project's current order — the usual case, appending a phase. */
  sortOrder: z.number().int().optional(),
  name: z.string().min(1).max(200),
  objective: z.string().max(4000).optional(),
  status: PhaseStatus.optional(),
  exitDemo: z.string().max(4000).optional(),
  size: Size.optional(),
});
export type PhaseCreate = z.infer<typeof PhaseCreate>;

export const PhaseUpdate = PhaseCreate.partial();
export type PhaseUpdate = z.infer<typeof PhaseUpdate>;

// ─── Requirement ───────────────────────────────────────────────────────────

export const Requirement = z
  .object({
    id: Uuid,
    projectId: Uuid,
    humanId: HumanId,
    seq: z.number().int().positive(),
    statement: z.string().min(1).max(4000),
    earsPattern: EarsPattern,
    earsLintOk: z.boolean(),
    earsLintNote: z.string().max(500).nullable(),
    priority: Priority,
    source: z.string().max(200).nullable(),
    acceptanceTest: z.string().max(2000).nullable(),
    /** Null is the backlog: an unassigned requirement is legal and meaningful (FRM-REQ-036). */
    phaseId: Uuid.nullable(),
  })
  .extend(Timestamps.shape);
export type Requirement = z.infer<typeof Requirement>;

export const RequirementCreate = z.object({
  statement: z.string().min(1).max(4000),
  priority: Priority.optional(),
  source: z.string().max(200).optional(),
  acceptanceTest: z.string().max(2000).optional(),
  phaseId: Uuid.nullish(),
});
export type RequirementCreate = z.infer<typeof RequirementCreate>;

export const RequirementUpdate = RequirementCreate.partial();
export type RequirementUpdate = z.infer<typeof RequirementUpdate>;

// ─── Task ──────────────────────────────────────────────────────────────────

/**
 * A repo-relative path or glob a task declares against (FRM-T-007). Attribution's weakest signal
 * matches commits against these, and a match alone never marks work complete (ADR-005) — but a
 * path that could climb out of the repo (`../secrets`) or was written as absolute (`/etc/passwd`)
 * is not a repo-relative path at all, so both are refused rather than stored.
 */
export const TaskFilePath = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => !value.startsWith('/'), 'a file path is repo-relative — no leading /')
  .refine(
    (value) => !value.split('/').includes('..'),
    'a file path may not climb out of the repo with a .. segment',
  );
export type TaskFilePath = z.infer<typeof TaskFilePath>;

/** At most 100 declared files or globs per task — a scope of work, not a file manifest. */
export const TaskFiles = z.array(TaskFilePath).max(100);

/**
 * A task's body: what it is about, in Markdown — the context and the owner's words that a title and
 * a `doneWhen` have no room for (FRM-T-017).
 *
 * The cap is the one `foreman_create` and `foreman_update` advertised for `body` all along. Until
 * 2026-10-12 a task had no column for it, so a body sent with a task was accepted and dropped —
 * twenty FLR task bodies vanished that way in one session. Long-form design belongs in a document;
 * this is room for a paragraph or two of why.
 */
export const TASK_BODY_MAX = 2000;

export const Task = z
  .object({
    id: Uuid,
    projectId: Uuid,
    phaseId: Uuid.nullable(),
    humanId: HumanId,
    title: z.string().min(1).max(300),
    status: TaskStatus,
    blockedReason: z.string().max(1000).nullable(),
    size: Size.nullable(),
    doneWhen: z.string().max(2000).nullable(),
    /** What the task is about, in Markdown — context, and the owner's own words. */
    body: z.string().max(TASK_BODY_MAX).nullable(),
    sortOrder: z.number().int(),
    /** True when the importer invented the ID rather than reading one (FRM-REQ-045). */
    idSynthesized: z.boolean(),
    startedAt: Instant.nullable(),
    completedAt: Instant.nullable(),
    files: z.array(z.string()).default([]),
    /** The requirements this task satisfies. Many-to-many, in both directions. */
    requirementIds: z.array(Uuid).default([]),
  })
  .extend(Timestamps.shape);
export type Task = z.infer<typeof Task>;

const TaskFields = z.object({
  title: z.string().min(1).max(300),
  phaseId: Uuid.nullish(),
  status: TaskStatus.optional(),
  blockedReason: z.string().max(1000).nullish(),
  size: Size.optional(),
  doneWhen: z.string().max(2000).optional(),
  /** Markdown. Null or blank clears it. */
  body: z.string().max(TASK_BODY_MAX).nullish(),
  sortOrder: z.number().int().optional(),
  files: TaskFiles.optional(),
  requirementIds: z.array(Uuid).optional(),
});

/**
 * **A blocked task must say what is blocking it** (FRM-REQ-040). A board column of blocked cards
 * with no reasons is the exact failure the vault already has: you learn that work stopped, and
 * never why, and by the time you look nobody remembers.
 */
const requireBlockedReason = (
  value: { status?: unknown; blockedReason?: unknown },
  ctx: z.RefinementCtx,
): void => {
  const blocked = value.status === 'blocked';
  const reason = typeof value.blockedReason === 'string' ? value.blockedReason.trim() : '';
  if (blocked && reason.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['blockedReason'],
      message: 'a blocked task must say what is blocking it',
    });
  }
};

export const TaskCreate = TaskFields.superRefine(requireBlockedReason);
export type TaskCreate = z.infer<typeof TaskCreate>;

/**
 * Deliberately **without** the blocked-reason refinement. A patch may legitimately send
 * `{ status: 'blocked' }` alone for a task that already carries a reason, and rejecting that here
 * would refuse a correct request. The rule still holds — it is checked against the *merged* state
 * in the domain layer, which is the only place that knows what the task already says.
 */
export const TaskUpdate = TaskFields.partial();
export type TaskUpdate = z.infer<typeof TaskUpdate>;

/** The statuses a task can be in without being finished — what "next up" is drawn from. */
export const OPEN_TASK_STATUSES = ['todo', 'in_progress', 'blocked'] as const;
