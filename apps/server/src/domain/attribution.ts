import { parseHumanId } from '@foreman/shared';
import { type Db, type Prisma } from '../db.js';
import type { AttributionSource } from '../generated/prisma/enums.js';
import { record, type Actor } from './audit.js';
import { NotFound } from './errors.js';

/**
 * Attributing a commit to the work it was done for (T-5.7, FRM-REQ-106, FRM-REQ-107).
 *
 * This is the piece the red team rewrote, and it is worth saying why in the file itself.
 *
 * The plan specified **file-path overlap** as the primary mechanism: a task declares the files it
 * will touch, and a commit touching those files is attributed to it. Measured against the real
 * corpus, only **60 of 363** tasks declare files at all — 17% — and twelve scopes of work have no
 * task IDs in them whatsoever. The feature would have shipped, worked exactly as designed, and
 * produced almost nothing (RT-01).
 *
 * What the corpus does have is commit messages that cite the task: **55% in D3 Auth**. So the
 * order is now:
 *
 * | Rank | Signal | What it is |
 * |:-:|---|---|
 * | 1 | agent-declared, via `foreman_attribute` | a fact — Claude knows what it was working on |
 * | 2 | the commit message citing `T-13.9` | an exact match, high confidence |
 * | 3 | file overlap with a task's declared paths | a hint, and never more |
 *
 * **Every one of these is a proposal until a person confirms it** (FRM-REQ-108). The precedence
 * decides which proposal is offered, not which one is true.
 */

/** Confidence per signal. Ordered, and the numbers are the precedence made explicit. */
export const CONFIDENCE: Record<AttributionSource, number> = {
  declared: 1,
  message: 0.9,
  file_overlap: 0.3,
};

export interface Proposal {
  readonly taskHumanId: string;
  readonly source: AttributionSource;
  readonly confidence: number;
  /** What was seen. Kept so a person confirming can check rather than trust. */
  readonly evidence: Record<string, unknown>;
}

/**
 * Human IDs in a commit subject or body.
 *
 * **Both forms.** Foreman's IDs are project-prefixed (`BND-T-13.9`, ADR-008), but not one real
 * commit message in three repositories writes them that way — they all say `T-13.9`, because the
 * person typing knows which repository they are in. A parser that only accepted the canonical form
 * would have scored zero on the entire corpus it was built for.
 */
const PREFIXED = /\b([A-Z][A-Z0-9]{1,7})-(T|REQ|P|ADR)-(\d+(?:\.\d+)?)\b/g;
const BARE = /(?<![A-Z0-9-])(T|REQ|P|ADR)-(\d+(?:\.\d+)?)\b/g;

export interface CitedId {
  readonly humanId: string;
  /** True when the message wrote the project code itself rather than relying on the repo. */
  readonly explicit: boolean;
}

export function parseCitations(message: string, projectCode: string): CitedId[] {
  const found = new Map<string, CitedId>();

  for (const match of message.matchAll(PREFIXED)) {
    const [whole, code] = match;
    // A prefixed ID naming another project is a cross-reference, not this commit's work.
    if (code === projectCode) found.set(whole, { humanId: whole, explicit: true });
  }

  for (const match of message.matchAll(BARE)) {
    const [, type, seq] = match;
    if (type === undefined || seq === undefined) continue;
    const humanId = `${projectCode}-${type}-${normalizeSeq(type, seq)}`;
    // An explicit citation of the same thing already recorded it; do not downgrade it.
    if (!found.has(humanId)) found.set(humanId, { humanId, explicit: false });
  }

  return [...found.values()];
}

/**
 * Requirements are zero-padded to three (`REQ-007`); task IDs carry their phase and are not
 * (`T-13.9`). A message saying `REQ-7` means `REQ-007`, and failing to match that is a miss
 * nobody would ever diagnose.
 */
function normalizeSeq(type: string, seq: string): string {
  if (seq.includes('.')) return seq;
  return type === 'T' ? seq : seq.padStart(3, '0');
}

export interface CommitForAttribution {
  readonly id: string;
  readonly sha: string;
  readonly message: string;
  readonly files: readonly string[];
}

/**
 * Everything this commit could plausibly belong to, best first.
 *
 * Returns proposals rather than writing them, so the ranking is testable without a database and
 * the caller decides what to do with a weak hint.
 */
export async function proposalsFor(
  db: Db,
  projectId: string,
  projectCode: string,
  commit: CommitForAttribution,
): Promise<Proposal[]> {
  const cited = parseCitations(commit.message, projectCode);
  const out: Proposal[] = [];

  // ─── Signal 2: the message ───────────────────────────────────────────────
  const taskIds = cited.filter((c) => parseHumanId(c.humanId)?.type === 'T');
  if (taskIds.length > 0) {
    const tasks = await db.task.findMany({
      where: { projectId, deletedAt: null, humanId: { in: taskIds.map((c) => c.humanId) } },
      select: { humanId: true },
    });
    for (const task of tasks) {
      out.push({
        taskHumanId: task.humanId,
        source: 'message',
        confidence: CONFIDENCE.message,
        evidence: {
          citedAs: taskIds.find((c) => c.humanId === task.humanId)?.explicit === true
            ? task.humanId
            : task.humanId.slice(projectCode.length + 1),
          subject: commit.message.split('\n')[0]?.slice(0, 200) ?? '',
        },
      });
    }
  }

  // A requirement cited with no task is still a signal: the tasks satisfying that requirement are
  // the work it names. Weaker than naming the task, and marked as such.
  const requirementIds = cited.filter((c) => parseHumanId(c.humanId)?.type === 'REQ');
  if (requirementIds.length > 0 && out.length === 0) {
    const viaRequirement = await db.task.findMany({
      where: {
        projectId,
        deletedAt: null,
        requirements: {
          some: { requirement: { humanId: { in: requirementIds.map((c) => c.humanId) }, deletedAt: null } },
        },
      },
      select: { humanId: true },
    });
    for (const task of viaRequirement) {
      out.push({
        taskHumanId: task.humanId,
        source: 'message',
        // Below a direct task citation: the commit named the *why*, and the task is an inference
        // from it. Two tasks may satisfy one requirement.
        confidence: CONFIDENCE.message - 0.2,
        evidence: { viaRequirement: requirementIds.map((c) => c.humanId) },
      });
    }
  }

  // ─── Signal 3: file overlap ──────────────────────────────────────────────
  //
  // Last, and weak on purpose. Two tasks touching `apps/server/src/app.ts` is the normal case, not
  // the exception — this proposes, and a person decides.
  if (commit.files.length > 0) {
    const declared = await db.taskFile.findMany({
      where: {
        path: { in: [...commit.files] },
        task: { projectId, deletedAt: null },
      },
      select: { path: true, task: { select: { humanId: true } } },
    });

    const byTask = new Map<string, string[]>();
    for (const row of declared) {
      byTask.set(row.task.humanId, [...(byTask.get(row.task.humanId) ?? []), row.path]);
    }

    for (const [humanId, paths] of byTask) {
      // A task already proposed by a stronger signal is not proposed again by a weaker one.
      if (out.some((p) => p.taskHumanId === humanId)) continue;
      out.push({
        taskHumanId: humanId,
        source: 'file_overlap',
        confidence: CONFIDENCE.file_overlap,
        evidence: { paths },
      });
    }
  }

  // Deterministic under conflict: confidence first, then the ID, so two signals disagreeing
  // always resolve the same way rather than by whichever query returned first.
  return out.sort(
    (a, b) => b.confidence - a.confidence || a.taskHumanId.localeCompare(b.taskHumanId),
  );
}

/**
 * Record proposals against a commit.
 *
 * **Never `confirmed: true`.** There is no argument to this function that could make it write one,
 * which is the point: confirmation is a separate act, by a person or by Claude declaring what it
 * did (FRM-REQ-108, FRM-REQ-109).
 */
export async function proposeAttributions(
  db: Db,
  commitId: string,
  proposals: readonly Proposal[],
): Promise<number> {
  let written = 0;

  for (const proposal of proposals) {
    const task = await db.task.findFirst({
      where: { humanId: proposal.taskHumanId, deletedAt: null },
      select: { id: true },
    });
    if (task === null) continue;

    const existing = await db.commitTask.findUnique({
      where: { commitId_taskId: { commitId, taskId: task.id } },
      select: { confirmed: true, rejectedAt: true },
    });

    // A rejected proposal stays rejected. Re-proposing what somebody has already turned down is
    // how a review queue becomes something people stop reading.
    if (existing !== null && existing.rejectedAt !== null) continue;
    // A confirmed attribution is a fact; a fresh proposal must not downgrade it.
    if (existing?.confirmed === true) continue;

    await db.commitTask.upsert({
      where: { commitId_taskId: { commitId, taskId: task.id } },
      create: {
        commitId,
        taskId: task.id,
        source: proposal.source,
        confidence: proposal.confidence,
        evidence: proposal.evidence as Prisma.InputJsonObject,
      },
      update: {
        source: proposal.source,
        confidence: proposal.confidence,
        evidence: proposal.evidence as Prisma.InputJsonObject,
      },
    });
    written += 1;
  }

  return written;
}

// ─── Confirming and rejecting ──────────────────────────────────────────────

export interface ConfirmResult {
  readonly commitSha: string;
  readonly taskHumanId: string;
  readonly confirmed: boolean;
  /** The audit event the decision wrote (FRM-REQ-243). */
  readonly auditEventIds: string[];
}

/**
 * Confirm an attribution — from the console, or from Claude via `foreman_attribute`.
 *
 * A declaration by the agent is confirmed on arrival: it is not an inference to be reviewed, it is
 * the one party that actually knows saying what it did.
 */
export async function confirmAttribution(
  db: Db,
  actor: Actor,
  sha: string,
  taskHumanId: string,
  options: { declared?: boolean } = {},
): Promise<ConfirmResult> {
  const commit = await db.commit.findFirst({
    where: { sha: { startsWith: sha } },
    select: { id: true, sha: true },
  });
  if (commit === null) throw new NotFound(`commit ${sha}`);

  const task = await db.task.findFirst({
    where: { humanId: taskHumanId, deletedAt: null },
    select: { id: true, humanId: true },
  });
  if (task === null) throw new NotFound(taskHumanId);

  return db.$transaction(async (tx) => {
    const before = await tx.commitTask.findUnique({
      where: { commitId_taskId: { commitId: commit.id, taskId: task.id } },
    });

    const row = await tx.commitTask.upsert({
      where: { commitId_taskId: { commitId: commit.id, taskId: task.id } },
      create: {
        commitId: commit.id,
        taskId: task.id,
        source: options.declared === true ? 'declared' : (before?.source ?? 'declared'),
        confidence: options.declared === true ? CONFIDENCE.declared : (before?.confidence ?? CONFIDENCE.declared),
        confirmed: true,
        confirmedAt: new Date(),
        confirmedBy: actor.actor,
        ...(options.declared === true ? { evidence: { declaredBy: actor.actor } } : {}),
      },
      update: {
        confirmed: true,
        confirmedAt: new Date(),
        confirmedBy: actor.actor,
        // Confirming clears a previous rejection: somebody changed their mind, which is allowed.
        rejectedAt: null,
        ...(options.declared === true
          ? { source: 'declared', confidence: CONFIDENCE.declared }
          : {}),
      },
    });

    const event = await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'commit',
      entityId: commit.id,
      entityHumanId: commit.sha.slice(0, 12),
      before,
      after: row,
    });

    return { commitSha: commit.sha, taskHumanId: task.humanId, confirmed: true, auditEventIds: [event] };
  });
}

export async function rejectAttribution(
  db: Db,
  actor: Actor,
  sha: string,
  taskHumanId: string,
): Promise<ConfirmResult> {
  const commit = await db.commit.findFirst({
    where: { sha: { startsWith: sha } },
    select: { id: true, sha: true },
  });
  if (commit === null) throw new NotFound(`commit ${sha}`);

  const task = await db.task.findFirst({
    where: { humanId: taskHumanId, deletedAt: null },
    select: { id: true, humanId: true },
  });
  if (task === null) throw new NotFound(taskHumanId);

  return db.$transaction(async (tx) => {
    const before = await tx.commitTask.findUnique({
      where: { commitId_taskId: { commitId: commit.id, taskId: task.id } },
    });
    if (before === null) throw new NotFound(`no proposal linking ${commit.sha.slice(0, 12)} to ${task.humanId}`);

    // Rejected, not deleted: the row is what stops the same proposal being made again on the next
    // reconcile, and a queue that re-offers what you turned down is one you stop reading.
    const row = await tx.commitTask.update({
      where: { commitId_taskId: { commitId: commit.id, taskId: task.id } },
      data: { confirmed: false, rejectedAt: new Date(), confirmedAt: null, confirmedBy: null },
    });

    const event = await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'commit',
      entityId: commit.id,
      entityHumanId: commit.sha.slice(0, 12),
      before,
      after: row,
    });

    return { commitSha: commit.sha, taskHumanId: task.humanId, confirmed: false, auditEventIds: [event] };
  });
}
