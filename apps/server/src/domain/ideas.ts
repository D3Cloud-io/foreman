import { IDEA_NEEDS_REASON, type IdeaCreate, type IdeaStatus, type IdeaUpdate } from '@foreman/shared';
import type { Db } from '../db.js';
import { record, type Actor } from './audit.js';
import { Invalid, NotFound } from './errors.js';
import { allocate } from './humanId.js';
import { findProject } from './projects.js';

/**
 * Ideas — a thing somebody might build, before it is a plan
 * (FRM-REQ-153 … FRM-REQ-158).
 *
 * The shape is taken from the "Feature Ideas & Future Development" documents four projects already
 * carry, rather than invented: each sorts its entries into **Accepted**, **Parked** — *"good ideas,
 * deliberately not now"* — and **Rejected**, under the heading *"do not re-litigate these"*. So
 * those are the statuses, plus `new` for one nobody has judged.
 *
 * **A parked or rejected idea must say why.** That is the one rule here worth its weight: the
 * value of writing a rejection down is entirely that it is not re-argued six months later by
 * somebody who cannot tell it was already considered. Without the reason, a rejected idea is
 * indistinguishable from a forgotten one, and the list slowly refills with things already decided.
 * Same rule, and the same failure, as a blocked task that does not say what is blocking it.
 */

/** The fields any surface reads. Kept here so the console and the MCP cannot drift apart. */
const SELECT = {
  id: true,
  humanId: true,
  title: true,
  body: true,
  status: true,
  reason: true,
  decidedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function ideasFor(db: Db, code: string) {
  const project = await findProject(db, code);
  return db.idea.findMany({
    where: { projectId: project.id, deletedAt: null },
    // Untriaged first: the list exists to be worked through, and the ones nobody has judged are
    // the only ones that need anybody. Then newest, because an old idea nobody picked is noise.
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    select: SELECT,
  });
}

/** Every project's ideas at once — the cross-project view, as the findings inbox is for findings. */
export async function allIdeas(db: Db, status?: IdeaStatus) {
  return db.idea.findMany({
    where: { deletedAt: null, ...(status === undefined ? {} : { status }) },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    select: { ...SELECT, project: { select: { code: true, name: true } } },
  });
}

export async function createIdea(db: Db, actor: Actor, code: string, input: IdeaCreate) {
  const project = await findProject(db, code);

  return db.$transaction(async (tx) => {
    const { humanId, seq } = await allocate(tx, project, 'idea');
    const idea = await tx.idea.create({
      data: {
        projectId: project.id,
        humanId,
        seq,
        title: input.title,
        ...(input.body === undefined ? {} : { body: input.body }),
      },
      select: SELECT,
    });

    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'idea',
      entityId: idea.id,
      entityHumanId: humanId,
      after: idea,
    });
    return { ...idea, auditEventIds: [event] };
  });
}

export async function updateIdea(db: Db, actor: Actor, humanId: string, input: IdeaUpdate) {
  const before = await db.idea.findFirst({ where: { humanId, deletedAt: null } });
  if (before === null) throw new NotFound(humanId);

  // Checked against the merged state, not the patch: a request that sets only the status would
  // otherwise pass while leaving the previous reason — or none — attached to a new decision.
  const status = input.status ?? before.status;
  const reason = input.reason === undefined ? before.reason : input.reason;
  if (IDEA_NEEDS_REASON.includes(status) && (reason === null || reason.trim().length === 0)) {
    throw new Invalid(`an idea that is ${status} must say why`, [
      { path: 'reason', message: `required when the status is ${status}` },
    ]);
  }

  return db.$transaction(async (tx) => {
    const idea = await tx.idea.update({
      where: { id: before.id },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.reason === undefined ? {} : { reason: input.reason ?? null }),
        // Back to `new` is a real move — reconsidering something — and it un-decides it rather
        // than leaving a date saying somebody ruled on this.
        ...(input.status === undefined
          ? {}
          : { decidedAt: input.status === 'new' ? null : (before.decidedAt ?? new Date()) }),
        // Leaving a judged state retires the reason it carried, so "deliberately not now" does
        // not linger on an idea that has since been accepted.
        ...(input.status !== undefined &&
        input.status === 'new' &&
        input.reason === undefined
          ? { reason: null }
          : {}),
      },
      select: SELECT,
    });

    const event = await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'idea',
      entityId: idea.id,
      entityHumanId: humanId,
      before,
      after: idea,
    });
    return { ...idea, auditEventIds: [event] };
  });
}
