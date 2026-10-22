import type { IdeaCommentCreate, IdeaScoreInput, ProjectIdeaFund } from '@foreman/shared';
import type { Db } from '../db.js';
import { record, type Actor } from './audit.js';
import { Conflict, Invalid, NotFound } from './errors.js';

/**
 * Scoring, discussion and funding on project ideas (FRM-ADR-016, FRM-ADR-017).
 *
 * Built for the innovation board and then found to be just as useful alone. **Scoring and
 * discussion work in both modes**: on a solo instance they are your own impact/effort read on an
 * idea and your thoughts log about it, which is the same record with one author instead of five.
 * Only **funding** is the board's, along with members and invitations, and those routes still
 * answer 404 in `solo`.
 *
 * **Three rules carry the weight, and all three are about who sees what.**
 *
 * 1. A submission is visible to everyone signed in. An innovation fund whose submissions are
 *    private produces the same idea six times and never lets anyone build on anyone else's.
 * 2. Scores are reviewers-only until the decision is made. A board that scores in public scores
 *    politically, and a submitter watching their idea sit at 2.1 learns nothing they can act on.
 * 3. The decision and its reason are public the moment they exist. This is the half people
 *    actually need, and the half most boards never write down.
 */

/** What a reviewer sees on a submission, and what a submitter does not. */
export interface ScoreSummary {
  readonly count: number;
  readonly impact: number | null;
  readonly effort: number | null;
  /** Impact over effort. The board's ranking, and the only derived number here. */
  readonly ratio: number | null;
}

export function summarise(
  scores: readonly { impact: number; effort: number }[],
): ScoreSummary {
  if (scores.length === 0) return { count: 0, impact: null, effort: null, ratio: null };
  const mean = (pick: (s: { impact: number; effort: number }) => number) =>
    scores.reduce((total, s) => total + pick(s), 0) / scores.length;
  const impact = mean((s) => s.impact);
  const effort = mean((s) => s.effort);
  return {
    count: scores.length,
    impact: Math.round(impact * 10) / 10,
    effort: Math.round(effort * 10) / 10,
    // Effort is 1–5 and never zero, so this cannot divide by zero — but it is rounded to two
    // places rather than shown raw, because 2.3333333 reads as precision that is not there.
    ratio: Math.round((impact / effort) * 100) / 100,
  };
}

async function liveIdea(db: Db, humanId: string) {
  const idea = await db.projectIdea.findFirst({ where: { humanId, deletedAt: null } });
  if (idea === null) throw new NotFound(humanId);
  return idea;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

export async function scoresFor(db: Db, humanId: string) {
  const idea = await liveIdea(db, humanId);
  const rows = await db.ideaScore.findMany({
    where: { projectIdeaId: idea.id },
    orderBy: { updatedAt: 'desc' },
    include: { user: { select: { id: true, displayName: true } } },
  });
  return { summary: summarise(rows), scores: rows };
}

/**
 * Score a submission, or change your mind about it.
 *
 * Upsert on `(idea, reviewer)`: scoring twice is reconsidering, not voting twice. The unique
 * index makes that true in the database rather than only in this function.
 */
export async function score(
  db: Db,
  actor: Actor,
  userId: string,
  humanId: string,
  input: IdeaScoreInput,
) {
  const idea = await liveIdea(db, humanId);
  // A decided submission is a record, not a poll. Scoring one after the fact changes a number
  // that was used to make a decision that has already been made.
  if (idea.status === 'funded' || idea.status === 'rejected' || idea.status === 'converted') {
    throw new Conflict(`${humanId} has been decided — its scores are the record of why`);
  }

  return db.$transaction(async (tx) => {
    const saved = await tx.ideaScore.upsert({
      where: { projectIdeaId_userId: { projectIdeaId: idea.id, userId } },
      update: { impact: input.impact, effort: input.effort, note: input.note ?? null },
      create: {
        projectIdeaId: idea.id,
        userId,
        impact: input.impact,
        effort: input.effort,
        ...(input.note === undefined ? {} : { note: input.note }),
      },
      include: { user: { select: { id: true, displayName: true } } },
    });

    const event = await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'idea_score',
      entityId: saved.id,
      entityHumanId: humanId,
      after: { impact: saved.impact, effort: saved.effort },
    });
    return { ...saved, auditEventIds: [event] };
  });
}

// ─── Discussion ──────────────────────────────────────────────────────────────

export async function commentsFor(db: Db, humanId: string, canSeeInternal: boolean) {
  const idea = await liveIdea(db, humanId);
  return db.ideaComment.findMany({
    where: {
      projectIdeaId: idea.id,
      deletedAt: null,
      // The filter is a `where`, not a `filter()` after the fact. An internal comment that reaches
      // the client and is hidden by the console has still been delivered to the submitter.
      ...(canSeeInternal ? {} : { internal: false }),
    },
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { id: true, displayName: true, role: true } } },
  });
}

export async function comment(
  db: Db,
  actor: Actor,
  userId: string,
  humanId: string,
  input: IdeaCommentCreate,
  canSeeInternal: boolean,
) {
  const idea = await liveIdea(db, humanId);
  if (input.internal && !canSeeInternal) {
    throw new Invalid('only a reviewer can leave an internal note', [
      { path: 'internal', message: 'you would not be able to read it back' },
    ]);
  }

  return db.$transaction(async (tx) => {
    const saved = await tx.ideaComment.create({
      data: { projectIdeaId: idea.id, userId, body: input.body, internal: input.internal },
      include: { user: { select: { id: true, displayName: true, role: true } } },
    });
    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'idea_comment',
      entityId: saved.id,
      entityHumanId: humanId,
      after: { internal: saved.internal },
    });
    return { ...saved, auditEventIds: [event] };
  });
}

/**
 * Reword a thought you wrote (FRM-REQ-175).
 *
 * Your own only, and not even an admin's override: withdrawing somebody's comment removes it from
 * view, which a moderator may need to do, but rewording it puts words in their mouth. The audit
 * event keeps the original, so the thread's history is still there for anybody who asks.
 */
export async function editComment(db: Db, actor: Actor, userId: string, id: string, body: string) {
  const before = await db.ideaComment.findFirst({ where: { id, deletedAt: null } });
  if (before === null) throw new NotFound(id);
  if (before.userId !== userId) {
    throw new Invalid('you can only reword your own', [
      { path: 'id', message: 'this was written by somebody else' },
    ]);
  }

  return db.$transaction(async (tx) => {
    const saved = await tx.ideaComment.update({
      where: { id },
      data: { body },
      include: { user: { select: { id: true, displayName: true, role: true } } },
    });
    const event = await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'idea_comment',
      entityId: id,
      before: { body: before.body },
      after: { body },
    });
    return { ...saved, auditEventIds: [event] };
  });
}

/** Withdraw your own comment. Soft, so the thread keeps its shape and the audit keeps the text. */
export async function deleteComment(db: Db, actor: Actor, userId: string, id: string, isAdmin: boolean) {
  const before = await db.ideaComment.findFirst({ where: { id, deletedAt: null } });
  if (before === null) throw new NotFound(id);
  if (before.userId !== userId && !isAdmin) {
    throw new Invalid('you can only withdraw your own comment', [
      { path: 'id', message: 'this comment is somebody else’s' },
    ]);
  }

  return db.$transaction(async (tx) => {
    const removed = await tx.ideaComment.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    const event = await record(tx, {
      ...actor,
      action: 'delete',
      entityType: 'idea_comment',
      entityId: id,
      before,
      after: removed,
    });
    return { deleted: id, auditEventIds: [event] };
  });
}

// ─── Funding ─────────────────────────────────────────────────────────────────

/**
 * Fund a submission (FRM-REQ-170).
 *
 * A POST to its own path rather than a status PATCH, for the same reason converting is: it is not
 * a state change with a field attached, it is a decision that commits money and must carry its
 * rationale. The reason is required, and it is public — the submitter is told, and so is everyone
 * else who might otherwise propose the same thing next quarter.
 */
export async function fund(db: Db, actor: Actor, humanId: string, input: ProjectIdeaFund) {
  const before = await liveIdea(db, humanId);
  if (before.status === 'funded') {
    throw new Conflict(`${humanId} is already funded — change the amount rather than funding twice`);
  }
  if (before.status === 'converted') {
    throw new Conflict(`${humanId} became a project already`);
  }

  return db.$transaction(async (tx) => {
    const funded = await tx.projectIdea.update({
      where: { id: before.id },
      data: {
        status: 'funded',
        fundedAmountCents: input.amountCents,
        reason: input.reason,
        decidedAt: before.decidedAt ?? new Date(),
      },
      include: { submittedBy: { select: { id: true, email: true, displayName: true } } },
    });

    await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'project_idea',
      entityId: funded.id,
      entityHumanId: humanId,
      before,
      after: funded,
    });
    return funded;
  });
}
