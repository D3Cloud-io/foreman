import { z } from 'zod';
import { GroupAccent, Priority, Size } from '../enums.js';
import { AnyId, HumanId, parseAnyId, ProjectCode } from '../ids.js';
import { GroupArg } from './groups.js';
import { IdeaFieldKey } from './record.js';
import { TASK_BODY_MAX, TaskFiles } from './spine.js';

/**
 * The write surface, shared by the API and the MCP shim (FRM-REQ-089, FRM-REQ-090, FRM-REQ-091).
 *
 * The gate rules live here rather than in the shim, because "which changes need asking about" is a
 * property of the change, not of the surface making it. A console that skipped a confirmation the
 * shim insists on would be the same product answering the same question two ways.
 */

/**
 * What `foreman_create` can make.
 *
 * `project` is here because its absence was an asymmetry rather than a boundary: the first write
 * of any greenfield plan is the one write the MCP surface could not do, so a planning session had
 * to drop to `curl` for its opening move and then switch back. ADR-002 caps the *verb* surface,
 * not the kinds one verb reaches.
 *
 * `idea` is here for the same reason: an idea is a title and a line of what it buys, so `text`
 * says all of it and `foreman_update` can write the rest.
 *
 * `screen` is here because a screen is a name and a route (FRM-REQ-189); its proposals, captures
 * and components arrive through the API with a write token, from the Figma import and CI.
 *
 * `group` is here because a group is a name and three optional lines (FRM-REQ-238, FRM-ADR-024):
 * the ceiling is full, so the family a project belongs to is made by the verb that makes projects.
 *
 * ADRs, risks, decisions and terms are deliberately still absent. Each is a record with a body —
 * context, decision and consequences on an ADR; likelihood, impact and a tripwire on a risk — and
 * `foreman_update` cannot write any of those fields. Creating one over MCP would make a titled
 * shell nothing could then fill in, which is worse than not offering it.
 */
export const CreatableKind = z.enum([
  'project',
  'requirement',
  'task',
  'phase',
  'idea',
  'project_idea',
  'screen',
  'group',
]);
export type CreatableKind = z.infer<typeof CreatableKind>;

/**
 * An object argument that arrived as its own JSON text, parsed back into the object.
 *
 * A client holding a tool list from before a field existed does not know the field is an object,
 * so it sends what it was given as a string — which is how the first ten project ideas bounced off
 * `canvas` on 2026-09-24, the day it shipped. Anything that is not a JSON object is passed through
 * untouched, so the error the schema then gives is the one it would have given anyway.
 */
function fromJsonText(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trimStart().startsWith('{')) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/**
 * What each kind of entity takes from `foreman_create`, beyond `project`, `kind` and `text`.
 *
 * **A field a kind does not store is refused, by name — never dropped.** Every field here used to
 * be accepted for every kind and silently ignored by the ones with nowhere to put it: on
 * 2026-10-12 twenty FLR task bodies were written, reported as created, and lost, because a task had
 * no body. Silent loss is the worst outcome a write can have, so the table is the contract and the
 * refinement below enforces it; adding a column to a kind means adding its field here.
 */
export const CREATE_FIELDS: Readonly<Record<CreatableKind, readonly string[]>> = {
  project: ['pitch', 'group'],
  project_idea: ['pitch', 'canvas'],
  requirement: ['priority', 'phase'],
  task: ['body', 'doneWhen', 'size', 'phase', 'satisfies'],
  phase: ['number', 'size'],
  idea: ['body'],
  screen: ['route'],
  // `text` is its name and `pitch` its one-line description: a group's line, like a project's.
  group: ['pitch', 'siteUrl', 'accent'],
};

/** The kinds that belong to no project, so a `project` code given for one is refused. */
const PROJECTLESS: Readonly<Partial<Record<CreatableKind, string>>> = {
  project_idea:
    'a project idea belongs to no project — it is a candidate for one. Convert it from ' +
    'the console when it becomes real, which is when the code is decided',
  group:
    'a group belongs to no project — projects belong to it. Give a project its group with ' +
    'foreman_create kind project or foreman_update on the project',
};

const ALWAYS_CREATE = new Set(['project', 'kind', 'text']);

export const CreateInput = z.strictObject({
  /**
   * Optional only because of `project_idea`, which is the one kind that belongs to no project —
   * it is a candidate *for* one. Required for every other kind, enforced below so the message
   * says which kind needed it rather than "expected string".
   */
  project: ProjectCode.optional().describe(
    'The project code, e.g. BND, or the new one for kind project. Omit for a project idea or group',
  ),
  kind: CreatableKind,
  /** What the entity says. A requirement's statement, a task's, phase's or project's name. */
  text: z.string().min(1).max(4000).describe('The statement, title or name'),
  /** A project's one-line pitch, a project idea's, or a group's one-line description. */
  pitch: z.string().max(2000).optional(),
  /**
   * Markdown. A task's body — its context, in the owner's words — or an idea's line of what it
   * buys. Refused for any other kind.
   */
  body: z.string().max(TASK_BODY_MAX).optional(),
  phase: HumanId.optional().describe('The phase to file it under'),
  priority: Priority.optional(),
  size: Size.optional(),
  doneWhen: z.string().max(2000).optional(),
  /** Phase only. Decimal is legal: a Phase 8.5 exists. */
  number: z.number().optional(),
  /** Screen only: the route it lives at. Undescribed, because the tool budget is nearly spent. */
  route: z.string().max(500).optional(),
  /** Requirements this task satisfies. */
  satisfies: z.array(HumanId).optional(),
  /**
   * Project only: the group it joins, at the end of that group's order — `GRP-001` or a slug
   * (FRM-REQ-238). Absent leaves it ungrouped. Undescribed, like `route`: the budget is spent.
   */
  group: GroupArg.optional(),
  /** Group only: its site, an absolute https URL; the API refuses anything else. */
  siteUrl: z.string().max(2000).optional(),
  /** Group only: one of the design system's product accents. Absent is `neutral`. */
  accent: GroupAccent.optional(),
  /**
   * Project idea only: its whole canvas, so one call records an idea rather than seven
   * (FRM-ADR-017). Sections are Markdown; lists are plain items — the shim gives each checklist item
   * and link the id the API wants. Excitement and the impact/effort rating are deliberately absent:
   * both are the reader's own judgement, and a tool writing them would put words in their mouth.
   */
  canvas: z
    .preprocess(fromJsonText, z.object({
      problem: z.string().max(20_000).optional(),
      audience: z.string().max(20_000).optional(),
      approach: z.string().max(20_000).optional(),
      whyNow: z.string().max(20_000).optional(),
      risks: z.string().max(20_000).optional(),
      notes: z.string().max(20_000).optional(),
      tags: z.array(z.string().max(40)).max(12).optional(),
      questions: z.array(z.string().max(500)).max(50).optional(),
      nextSteps: z.array(z.string().max(500)).max(50).optional(),
      links: z.array(z.object({ label: z.string().max(200), url: z.string().max(2000) })).max(30).optional(),
      related: z.array(z.string().max(40)).max(20).optional(),
    }))
    .optional()
    .describe('Project idea only: sections in Markdown, lists as plain items'),
}).superRefine((value, ctx) => {
  const takes = CREATE_FIELDS[value.kind];
  for (const [field, given] of Object.entries(value)) {
    if (given === undefined || ALWAYS_CREATE.has(field) || takes.includes(field)) continue;
    ctx.addIssue({
      code: 'custom',
      path: [field],
      message: `a ${value.kind} has no ${field}, so it would not be stored — leave it out`,
    });
  }

  const projectless = PROJECTLESS[value.kind];
  if (projectless !== undefined) {
    if (value.project !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['project'], message: projectless });
    }
    return;
  }
  if (value.project === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['project'],
      message: `a ${value.kind} belongs to a project, so a project code is required`,
    });
  }
});
export type CreateInput = z.infer<typeof CreateInput>;

/**
 * What each kind takes from `foreman_update`, beyond `id`, keyed by the ID's type segment.
 *
 * The same contract as `CREATE_FIELDS`: a field the kind does not store is refused by name. Before
 * this, `body` on a task or requirement, `priority` on a task, `size` on a requirement, `section`
 * on anything but a project idea, a `reason` on anything but an idea, and `text` on a phase (sent
 * as a `title` a phase does not have) all reported success and changed nothing.
 */
const FINDING_FIELDS = ['text', 'fixedCommitSha'] as const;
/** Not a human ID's type segment: what a bare project code is keyed by in the tables below. */
export const PROJECT_ID_TYPE = 'PROJECT';
export const UPDATE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  REQ: ['text', 'priority', 'phase'],
  T: ['text', 'size', 'doneWhen', 'body', 'phase', 'files'],
  P: ['text', 'size'],
  CR: FINDING_FIELDS,
  DA: FINDING_FIELDS,
  FR: FINDING_FIELDS,
  API: FINDING_FIELDS,
  IDEA: ['text', 'body', 'reason'],
  PI: ['text', 'body', 'reason', 'section'],
  // A project, addressed by its bare code (FRM-REQ-238): `text` is its name, `body` its pitch,
  // and `group` moves it — to the end of that group's order, or with null out of every group.
  [PROJECT_ID_TYPE]: ['text', 'body', 'group'],
};

const KIND_NAMES: Readonly<Record<string, string>> = {
  REQ: 'requirement',
  T: 'task',
  P: 'phase',
  CR: 'finding',
  DA: 'finding',
  FR: 'finding',
  API: 'finding',
  IDEA: 'idea',
  PI: 'project idea',
  [PROJECT_ID_TYPE]: 'project',
};

/**
 * What `foreman_update` can address: any ID Foreman issues, or a project by its bare code — the
 * one entity whose identifier is not a human ID, and the one a move between groups changes.
 */
export const UpdateTarget = z
  .string()
  .refine(
    (value) => parseAnyId(value) !== null || ProjectCode.safeParse(value).success,
    'expected <CODE>-<TYPE>-<SEQ>, PI-<SEQ>, or a project code',
  );

/** The type segment of an `UpdateTarget`: an ID's own, or `PROJECT` for a bare project code. */
export function updateTargetType(value: string): string | undefined {
  const parsed = parseAnyId(value);
  if (parsed !== null) return parsed.type;
  return ProjectCode.safeParse(value).success ? PROJECT_ID_TYPE : undefined;
}

export const UpdateInput = z.strictObject({
  id: UpdateTarget.describe('The entity to change, e.g. BND-T-0.3, PI-007, or a project code'),
  text: z.string().min(1).max(4000).optional().describe('Replaces the statement, title or name'),
  priority: Priority.optional(),
  size: Size.optional(),
  doneWhen: z.string().max(2000).optional(),
  /** Markdown. A task's body, an idea's line of what it buys, or a project idea's pitch. */
  body: z.string().max(TASK_BODY_MAX).optional(),
  /**
   * Why an idea was parked or rejected.
   *
   * The whole value of writing a rejection down is that it is not re-argued six months later by
   * somebody who cannot tell it was already considered.
   */
  reason: z.string().max(1000).optional(),
  /**
   * For a project idea: which canvas section `text` writes, instead of its title (FRM-ADR-017).
   *
   * One field rather than six, because the tool ceiling is full and every field is paid for in
   * every turn's definitions. It is what lets a session say "write up the risks on PI-007" and
   * have it land in the right place on the canvas — the section list itself lives in shared.
   */
  section: IdeaFieldKey.optional().describe(
    'Project idea only: the canvas field text writes; a list takes one item per line',
  ),
  phase: HumanId.nullish().describe('Move to this phase, or null for the backlog'),
  /**
   * A finding's fixing commit, as a **SHA rather than a link** (FRM-REQ-117). Recorded here
   * because the fix verdict is only green once that SHA is ingested, and the moment somebody
   * knows the answer is the moment they close the finding — not whenever ingest catches up.
   */
  fixedCommitSha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i)
    .optional()
    .describe('For a finding: the commit that fixed it'),
  /**
   * For a task: the repo-relative paths or globs it declares against — what `/fleet-develop`
   * plans waves from (FRM-T-007). Replaces the whole list; an empty array clears it. Refused for
   * every other kind, the same shape as `phase` is refused for anything but a task or requirement.
   */
  files: TaskFiles.optional().describe(
    'Task only: replaces its declared files/globs; repo-relative',
  ),
  /** Project only: move it to this group (`GRP-001` or a slug), or null for none (FRM-REQ-238). */
  group: GroupArg.nullish().describe('GRP-n or slug; null ungroups'),
}).superRefine((value, ctx) => {
  const type = updateTargetType(value.id);
  const takes = type === undefined ? undefined : UPDATE_FIELDS[type];
  // An ID this tool cannot change at all is refused by the tool, with its own message.
  if (type === undefined || takes === undefined) return;
  for (const [field, given] of Object.entries(value)) {
    if (given === undefined || field === 'id' || takes.includes(field)) continue;
    ctx.addIssue({
      code: 'custom',
      path: [field],
      message: `${value.id} is a ${KIND_NAMES[type] ?? type}, which has no ${field} — it would not be stored`,
    });
  }
});
export type UpdateInput = z.infer<typeof UpdateInput>;

export const SetStatusInput = z.strictObject({
  id: AnyId,
  status: z.string().min(1).max(40).describe('The new status for this kind of entity'),
  /** Required when moving a task to `blocked`: a blocked task must say what is blocking it. */
  reason: z.string().max(1000).optional(),
}).superRefine((value, ctx) => {
  const type = parseAnyId(value.id)?.type;
  // A requirement has a priority and a phase, not a status: setting one answered success and
  // changed nothing.
  if (type === 'REQ') {
    ctx.addIssue({
      code: 'custom',
      path: ['status'],
      message: `${value.id} is a requirement, which has no status — it is covered by its tasks`,
    });
  }
  // Where a reason is kept: on an idea or a project idea, and on a task only while it is blocked.
  // Anywhere else it used to be accepted and dropped — a note on why a task was cancelled, or why
  // a finding was closed wont_fix, reported success and was never written down.
  if (value.reason === undefined) return;
  if (type === 'IDEA' || type === 'PI') return;
  if (type === 'T' && value.status === 'blocked') return;
  ctx.addIssue({
    code: 'custom',
    path: ['reason'],
    message:
      type === 'T'
        ? 'a task keeps a reason only while blocked — put the context in its body with foreman_update'
        : `${value.id} keeps no reason for a status change, so it would not be stored — leave it out`,
  });
});
export type SetStatusInput = z.infer<typeof SetStatusInput>;

/**
 * `foreman_delete` — the twelfth and last tool (ADR-002), and **ideas only**.
 *
 * ADR-002 originally made deletion absent from the shim rather than merely gated, reasoning that
 * the one surface able to delete should be the one where a person is looking at what they are
 * about to lose. That reasoning is about **citations**: deleting a requirement hides every
 * reference to it, and the loss is in the references, not the row — which is precisely what a
 * session issuing a tool call cannot see and a console screen shows.
 *
 * An idea has none. Nothing cites it, no coverage reads it, no traceability row points at it. It
 * is a title and a paragraph, and the list is only useful if pruning it is as cheap as adding to
 * it — a backlog nobody empties is a backlog nobody reads. So this is narrowed to what nothing
 * cites rather than reversed wholesale (FRM-ADR-014, raised as `proposed`): the ADR's protection
 * stays exactly where its rationale applies, and every other kind still answers "from the console".
 *
 * A **project idea** qualifies on the same test and for the same reason, and is the only kind
 * added to this list since. It is deletable here while a project is not, which is the distinction
 * the whole feature rests on: `PI-007` is a sentence somebody wrote down, and `BND` is nine
 * hundred records that cite each other.
 *
 * Soft, like every delete here — the row is hidden, its ID is never reused, and `foreman_undo`'s
 * absence is not a problem because the console's undo reads the same audit event.
 */
const DELETABLE = ['IDEA', 'PI'];

export const DeleteInput = z.strictObject({
  id: AnyId.refine((value) => DELETABLE.includes(parseAnyId(value)?.type ?? ''), {
    message:
      'only an idea or a project idea can be deleted over MCP — anything else is cited by ' +
      'something, and the console is where you can see what the deletion takes with it',
  }).describe('The idea to delete, e.g. BND-IDEA-004 or PI-007.'),
});
export type DeleteInput = z.infer<typeof DeleteInput>;

export const LinkInput = z.strictObject({
  from: HumanId,
  to: HumanId,
  /**
   * `depends_on` is task to task: `from` cannot start until `to` is done or cancelled, and the brief
   * holds it back until then (FRM-REQ-179). Same project only, never a cycle (FRM-REQ-180).
   */
  kind: z
    .enum(['satisfies', 'violates', 'relates', 'supersedes', 'extends', 'depends_on'])
    .default('relates'),
  /** Remove the link instead of adding it. Always gated: unlinking loses a citation. */
  remove: z.boolean().default(false),
});
export type LinkInput = z.infer<typeof LinkInput>;

/**
 * `foreman_attribute` — Claude saying what a commit was for (T-5.9, FRM-REQ-109).
 *
 * This is **signal 1**, and the only one that is not an inference. Foreman's other two signals read
 * a commit message or a file list and guess; this is the one party that was actually there saying
 * what it did. So a declaration arrives confirmed, where a proposal does not.
 */
export const AttributeInput = z.strictObject({
  /** The commit. A short SHA is fine — that is what anybody has to hand. */
  sha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i, 'a commit SHA, seven characters or more'),
  task: HumanId.describe('The task this commit was work on, e.g. BND-T-13.9'),
  /** Withdraw an attribution instead of asserting one. Gated: it removes a recorded fact. */
  remove: z.boolean().default(false),
});
export type AttributeInput = z.infer<typeof AttributeInput>;

// ─── The gate ──────────────────────────────────────────────────────────────

/**
 * Task statuses in the order work moves through them. Anything that goes **backwards** in this list
 * is a regression, and a regression is asked about first.
 */
const TASK_PROGRESSION: readonly string[] = ['todo', 'in_progress', 'done'];

export interface GateDecision {
  readonly gated: boolean;
  /** Why, phrased for the person being asked. Present whenever `gated` is true. */
  readonly because?: string;
}

const ALLOWED = { gated: false } as const;

/**
 * Does this change need asking about first?
 *
 * **Forward progress does not.** Marking a task done, logging a decision, filing a finding — these
 * are the motions of working, and a confirmation on each is how a confirmation stops being read.
 * What is gated is the small set of changes that lose something: a delete, a regression, an
 * abandonment, a `Won't`, an unlink.
 */
export function gateForStatus(
  entityType: string,
  from: string | null,
  to: string,
): GateDecision {
  if (to === 'cancelled') {
    return { gated: true, because: 'Cancelling abandons the work and its history of intent.' };
  }

  if (entityType === 'task') {
    const fromIndex = from === null ? -1 : TASK_PROGRESSION.indexOf(from);
    const toIndex = TASK_PROGRESSION.indexOf(to);
    if (fromIndex > -1 && toIndex > -1 && toIndex < fromIndex) {
      return {
        gated: true,
        because: `Moving a task from ${from ?? 'unknown'} back to ${to} undoes recorded progress.`,
      };
    }
  }

  // Closing a finding as `wont_fix` is the same shape of act as cancelling: the work is not
  // done, and the record stops asking for it. `deferred` and `skipped` say "not now" and "not
  // here", which stay reversible and readable, so they are not gated.
  if (entityType === 'finding' && to === 'wont_fix') {
    return {
      gated: true,
      because: 'Closing a finding as wont_fix retires it without the work being done.',
    };
  }

  if (entityType === 'phase' && to === 'complete') {
    return {
      gated: true,
      because: 'Completing a phase runs its exit gate and closes it as the answer to "where are we".',
    };
  }

  return ALLOWED;
}

export function gateForPriority(to: string): GateDecision {
  if (to === 'W') {
    return {
      gated: true,
      because: "Setting a requirement to Won't takes it out of every coverage calculation.",
    };
  }
  return ALLOWED;
}

export function gateForDelete(): GateDecision {
  return {
    gated: true,
    because: 'Deleting hides the entity and every citation of it, though it can be undone.',
  };
}

export function gateForLink(remove: boolean): GateDecision {
  return remove
    ? { gated: true, because: 'Unlinking removes a citation, which is how coverage is computed.' }
    : ALLOWED;
}

/** Every gated reason, for the contract test that keeps the list honest. */
export const GATED_OPERATIONS = [
  'delete',
  'status:cancelled',
  'status:task-backwards',
  'status:phase-complete',
  'priority:W',
  'link:remove',
] as const;

/**
 * Withdrawing an attribution is asked about; asserting one is not.
 *
 * Declaring what a commit was for is forward progress — the motion of working, and gating it is
 * how a confirmation stops being read. Withdrawing one removes something a person may have relied
 * on when they looked at coverage.
 */
export function gateForAttribute(remove: boolean): GateDecision {
  return remove
    ? {
        gated: true,
        because:
          'Withdrawing an attribution removes a recorded link between a commit and the work it ' +
          'was for. Coverage and release notes read that link.',
      }
    : { gated: false };
}
