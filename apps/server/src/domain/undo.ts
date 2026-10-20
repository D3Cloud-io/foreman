import type { Db } from '../db.js';
import type { EntityType } from '../generated/prisma/enums.js';
import { record, scrub, type Actor, type TransactionClient } from './audit.js';
import { Conflict, Invalid, NotFound } from './errors.js';
import {
  derivedFields,
  finishUndo,
  guardUndo,
  isReorderEvent,
  lockGroups,
  settleProjects,
  undoReorder,
} from './groups.js';
import {
  anyRow,
  LINK_ROWS,
  removeLink,
  resolveLink,
  rowsPresent,
  writeLink,
  type LinkKind,
  type LinkRows,
  type ResolvedLink,
} from './links.js';
import { rollupAfter } from './rollup.js';

/**
 * Soft delete and undo (FRM-REQ-138, FRM-REQ-139, FRM-REQ-140).
 *
 * **Nothing is unrecoverable.** Delete sets `deleted_at`; it never removes a row. Undo replays an
 * audit event's `before` — which is why the event is written in the same transaction as the change
 * it records, and why a mutation that cannot be recorded does not happen.
 *
 * The rule that makes undo safe: **a reversal is refused when the current state is not what the
 * event left behind.** Undoing a change that something else has since changed again would silently
 * discard the later edit, which is a worse outcome than refusing.
 */

/** The entity types that can be soft-deleted and restored, and the model each maps to. */
const UNDOABLE = [
  'project',
  'phase',
  'requirement',
  'task',
  'adr',
  'decision',
  'risk',
  'term',
  'document',
  'document_section',
  'finding',
  'audit',
  'tech_item',
  'idea',
  'project_idea',
  'guideline',
  // The screen row only. Its versions, verdicts and components are append-only history.
  'screen',
  // A family of projects (FRM-ADR-024). Its reorders are their own events — see `undoReorder`.
  'group',
] as const;

export type UndoableType = (typeof UNDOABLE)[number];

export function isUndoable(type: EntityType): type is UndoableType {
  return (UNDOABLE as readonly string[]).includes(type);
}

/** Prisma has no dynamic model access that keeps its types, so the mapping is written out once. */
function model(tx: TransactionClient, type: UndoableType) {
  switch (type) {
    case 'project':
      return tx.project;
    case 'phase':
      return tx.phase;
    case 'requirement':
      return tx.requirement;
    case 'task':
      return tx.task;
    case 'adr':
      return tx.adr;
    case 'decision':
      return tx.decision;
    case 'risk':
      return tx.risk;
    case 'term':
      return tx.term;
    case 'document':
      return tx.document;
    case 'document_section':
      return tx.documentSection;
    case 'finding':
      return tx.finding;
    case 'audit':
      return tx.audit;
    case 'tech_item':
      return tx.techItem;
    case 'idea':
      return tx.idea;
    case 'project_idea':
      return tx.projectIdea;
    case 'guideline':
      return tx.guideline;
    case 'screen':
      return tx.screen;
    case 'group':
      return tx.projectGroup;
  }
}

/** Fields never written back by an undo: identity, and the timestamps the database owns. */
const NOT_RESTORED = new Set(['id', 'createdAt', 'updatedAt', 'humanId', 'code', 'seq']);

/**
 * Soft-delete an entity. The row stays, `deleted_at` is set, and the event carries the whole row so
 * undo has something to restore from.
 */
export async function softDelete(
  db: Db,
  actor: Actor,
  type: UndoableType,
  humanId: string,
): Promise<{ id: string }> {
  return db.$transaction(async (tx) => {
    const table = model(tx, type);
    const before = (await (table as { findFirst: (args: unknown) => Promise<unknown> }).findFirst({
      where: { humanId, deletedAt: null },
    })) as Record<string, unknown> | null;
    if (before === null) throw new NotFound(humanId);

    const id = String(before['id']);
    // A project leaving its group's order: the lock first, so the renumbering below is not racing
    // a move (FRM-REQ-226).
    if (type === 'project') await lockGroups(tx);
    await (table as { update: (args: unknown) => Promise<unknown> }).update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await record(tx, {
      ...actor,
      action: 'delete',
      entityType: type,
      entityId: id,
      entityHumanId: humanId,
      before,
      after: { deleted: true },
    });
    if (type === 'project') {
      const groupId = typeof before['groupId'] === 'string' ? before['groupId'] : null;
      await settleProjects(tx, actor, groupId, { cause: `${humanId} deleted` });
    }
    // A deleted task stops counting toward its phase; a deleted phase toward its project.
    await rollupAfter(tx, actor, type, before, { ...before, deletedAt: new Date() }, humanId);
    return { id };
  });
}

export interface UndoResult {
  readonly undid: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityHumanId: string | null;
  readonly reversalEventId: string;
}

/**
 * Reverse one mutation.
 *
 * Create becomes a soft delete, delete becomes a restore, and update writes `before` back. The
 * reversal is itself audited, and the original event is stamped so it cannot be undone twice.
 *
 * A link and an unlink are the exception: they are recorded as a `create` and a `delete` on the
 * entity they start from, but the link is what changed, so the link is what is reversed — see
 * `undoLink`.
 */
export async function undo(db: Db, actor: Actor, auditEventId: string): Promise<UndoResult> {
  const event = await db.auditEvent.findUnique({ where: { id: auditEventId } });
  if (event === null) throw new NotFound(`audit event ${auditEventId}`);

  if (event.undoneAt !== null) {
    throw new Conflict('that change has already been undone');
  }
  if (event.action === 'undo') {
    // Undoing an undo is a redo, and redo is not what anyone means by it. Reverse the original.
    throw new Conflict('that event is itself a reversal; undo the original change instead');
  }

  const before = event.before as Record<string, unknown> | null;
  const after = event.after as Record<string, unknown> | null;

  // A coverage cleanup removed a row no link owned (FRM-T-024). It is recorded on the entity the
  // row started from, so reversing it as an entity change would restore or delete that entity.
  // Putting the row back is a link, which the event names.
  if (after?.['event'] === 'reconcile') {
    const restoreWith = after['restoreWith'];
    throw new Conflict(
      'that was a coverage cleanup, not a change to the entity' +
        (typeof restoreWith === 'string' ? `; to put the row back, ${restoreWith}` : ''),
    );
  }

  const linkEvent = linkEventOf(event.action, after);
  if (linkEvent !== null) return undoLink(db, actor, event, linkEvent);

  // A reorder changed several rows' positions at once, and is reversed as one (FRM-REQ-226).
  if (event.action === 'update' && isReorderEvent(after)) return undoReorder(db, actor, event);

  if (!isUndoable(event.entityType)) {
    throw new Conflict(`${event.entityType} changes cannot be undone`);
  }
  const type = event.entityType;

  return db.$transaction(async (tx) => {
    const table = model(tx, type);
    const current = (await (table as { findUnique: (args: unknown) => Promise<unknown> }).findUnique(
      { where: { id: event.entityId } },
    )) as Record<string, unknown> | null;
    if (current === null) throw new NotFound(`the ${type} this change touched no longer exists`);

    let data: Record<string, unknown>;

    switch (event.action) {
      case 'create': {
        if (current['deletedAt'] !== null) {
          throw new Conflict('that creation has already been reversed: the entity is deleted');
        }
        data = { deletedAt: new Date() };
        break;
      }
      case 'delete': {
        if (current['deletedAt'] === null) {
          throw new Conflict('that deletion has already been reversed: the entity is not deleted');
        }
        data = { deletedAt: null };
        break;
      }
      case 'update':
      case 'restore': {
        if (before === null) throw new Conflict('that change recorded no previous state to restore');
        // Positions are derived (always 0..n-1) and a project's group is compared only when this
        // change made it: `finishUndo` puts the row back at its old index instead.
        const skip = derivedFields(type, before, after);
        const without = (snapshot: Record<string, unknown>) =>
          Object.fromEntries(Object.entries(snapshot).filter(([key]) => !skip.has(key)));
        assertUnchangedSince(current, after === null ? null : without(after));
        data = restorable(without(before), current);
        break;
      }
      default:
        throw new Conflict(`a ${event.action} cannot be undone`);
    }

    // What the row alone cannot show: the groups around a group, a project or a guideline.
    await guardUndo(tx, { type, action: event.action, current, data, before, after });

    await (table as { update: (args: unknown) => Promise<unknown> }).update({
      where: { id: event.entityId },
      data,
    });
    await finishUndo(tx, actor, {
      type,
      action: event.action,
      entityId: event.entityId,
      current,
      before,
      after,
    });
    // Read back after `finishUndo`, so the reversal records where the row actually ended up.
    const restored = (await (table as { findUnique: (args: unknown) => Promise<unknown> }).findUnique(
      { where: { id: event.entityId } },
    )) as Record<string, unknown>;

    const reversalId = await record(tx, {
      ...actor,
      action: 'undo',
      entityType: type,
      entityId: event.entityId,
      ...(event.entityHumanId === null ? {} : { entityHumanId: event.entityHumanId }),
      before: current,
      after: restored,
    });

    // The status beneath changed back, so what it adds up to is worked out again — itself a
    // rollup event of its own, never a silent side effect of the reversal.
    await rollupAfter(tx, actor, type, current, restored, event.entityHumanId ?? type);

    // Stamped, so the same change cannot be undone twice.
    await tx.auditEvent.update({
      where: { id: event.id },
      data: { undoneAt: new Date(), undoneByEventId: reversalId },
    });

    return {
      undid: event.id,
      action: event.action,
      entityType: type,
      entityHumanId: event.entityHumanId,
      reversalEventId: reversalId,
    };
  });
}

interface LinkEvent {
  /** `link` for an event that added the link, `unlink` for one that removed it. */
  readonly event: 'link' | 'unlink';
  readonly to: string;
  readonly kind: LinkKind;
  /**
   * The rows the event wrote or removed. Absent on events written before they were recorded, which
   * cannot say whether they made the link or repeated one already there.
   */
  readonly rows: LinkRows | undefined;
  /** For an unlinked supersedes: the replaced ADR's status as the unlink left it. */
  readonly replacedStatus: string | undefined;
}

/** The `rows` an event recorded, or undefined when it recorded none or something malformed. */
function rowsOf(value: unknown): LinkRows | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const flags = value as Record<string, unknown>;
  if (!LINK_ROWS.every((row) => typeof flags[row] === 'boolean')) return undefined;
  return value as LinkRows;
}

/**
 * The link an event records, or null when it records a change to an entity row. `links.ts` marks
 * both with `event` in `after`; the action alone cannot tell a link from a creation.
 */
function linkEventOf(action: string, after: Record<string, unknown> | null): LinkEvent | null {
  const marker = after?.['event'];
  const to = after?.['to'];
  const kind = after?.['kind'];
  if (typeof to !== 'string' || typeof kind !== 'string') return null;

  const rows = rowsOf(after?.['rows']);
  const status = after?.['replacedStatus'];
  const replacedStatus = typeof status === 'string' ? status : undefined;

  if (action === 'create' && marker === 'link') {
    return { event: 'link', to, kind: kind as LinkKind, rows, replacedStatus };
  }
  if (action === 'delete' && marker === 'unlink') {
    return { event: 'unlink', to, kind: kind as LinkKind, rows, replacedStatus };
  }
  return null;
}

type AuditEventRow = NonNullable<Awaited<ReturnType<Db['auditEvent']['findUnique']>>>;

/**
 * Reverse a link by removing the rows it wrote, and an unlink by writing back the rows it removed —
 * exactly those, and never the entity row.
 *
 * The refusal rule is the same one as everywhere else, stated for a link: the link must still be
 * in the state the event left it. A link since removed, or an unlink since put back, has been
 * reversed already by someone else, and undoing it again would not restore anything.
 */
async function undoLink(
  db: Db,
  actor: Actor,
  event: AuditEventRow,
  recorded: LinkEvent,
): Promise<UndoResult> {
  const from = event.entityHumanId;
  if (from === null) throw new Conflict('that link recorded no source to reverse it from');
  const { to, kind, rows } = recorded;

  if (rows === undefined) {
    // Written before link events said which rows they wrote. A repeat of an existing link looks the
    // same as a new one, and reversing it would remove a link this event never made.
    throw new Conflict(
      `that ${recorded.event} was recorded before Foreman noted which rows it changed, so ` +
        `undoing it could remove or restore a link it never touched; ` +
        `${recorded.event === 'link' ? 'unlink' : 'link'} ${from} and ${to} instead`,
    );
  }
  if (!anyRow(rows)) {
    throw new Conflict(
      recorded.event === 'link'
        ? `nothing to undo: ${from} was already linked to ${to} when that was recorded, and ` +
          'undoing it would remove the earlier link'
        : `nothing to undo: ${from} was not linked to ${to} when that was recorded, so there is ` +
          'no link to put back',
    );
  }
  if (recorded.event === 'link' && kind === 'supersedes') {
    // Superseding also moved the older ADR's status, and an unlink does not move it back. A
    // half-reversal that leaves the ADR marked superseded is worse than a refusal.
    throw new Conflict(
      `a supersedes link also changed ${to}'s status, which unlinking does not restore; ` +
        'reverse it in the console',
    );
  }

  // Both ends are looked up first. One deleted since is the state having moved on like any other:
  // a link to it can neither be removed nor put back.
  let resolved: ResolvedLink;
  try {
    resolved = await resolveLink(db, from, to, kind);
  } catch (error) {
    if (error instanceof NotFound) {
      throw new Conflict(`that ${recorded.event} cannot be undone: the link's entity is gone (${error.message})`);
    }
    throw error;
  }

  return db.$transaction(async (tx) => {
    // Claimed inside the transaction, so two undos of the same event at once cannot both reverse it.
    const claimed = await tx.auditEvent.updateMany({
      where: { id: event.id, undoneAt: null },
      data: { undoneAt: new Date() },
    });
    if (claimed.count === 0) throw new Conflict('that change has already been undone');

    const present = await rowsPresent(tx, resolved);
    const marker = { to, kind };

    let before: Record<string, unknown>;
    let after: Record<string, unknown>;
    if (recorded.event === 'link') {
      // Every row this link wrote must still be there; one gone means it has been unlinked since.
      if (LINK_ROWS.some((row) => rows[row] && !present[row])) {
        throw new Conflict(`that link cannot be undone: ${from} is no longer linked to ${to}`);
      }
      const removed = await removeLink(tx, resolved, rows);
      before = { event: 'link', ...marker };
      after = { event: 'unlink', ...marker, rows: removed };
    } else {
      // Every row it removed must still be gone; one back means it has been linked again since.
      if (LINK_ROWS.some((row) => rows[row] && present[row])) {
        throw new Conflict(`that unlink cannot be undone: ${from} is already linked to ${to} again`);
      }
      if (recorded.replacedStatus !== undefined) {
        // Putting a supersedes back says the older ADR was replaced. If its status has been
        // decided again since, restoring the edge would contradict that later decision.
        const replaced = await tx.adr.findUniqueOrThrow({
          where: { id: resolved.toId },
          select: { status: true },
        });
        if (replaced.status !== recorded.replacedStatus) {
          throw new Conflict(
            `that unlink cannot be undone: ${to} has been ${replaced.status} since, not ` +
              `${recorded.replacedStatus} as the unlink left it`,
          );
        }
      }
      let written: LinkRows;
      try {
        written = (await writeLink(tx, resolved, rows)).rows;
      } catch (error) {
        // A depends_on edge that was fine when it was removed may close a cycle now that other
        // edges have been added; putting it back would leave tasks the brief can never offer.
        if (error instanceof Invalid) {
          throw new Conflict(`that unlink cannot be undone: ${error.message}`);
        }
        throw error;
      }
      before = { event: 'unlink', ...marker };
      after = { event: 'link', ...marker, rows: written };
    }

    // One event, the reversal: not an undo plus a fresh link event that could itself be undone.
    const reversalId = await record(tx, {
      ...actor,
      action: 'undo',
      entityType: resolved.fromType,
      entityId: resolved.fromId,
      entityHumanId: from,
      before,
      after,
    });

    // Stamped, so the same change cannot be undone twice.
    await tx.auditEvent.update({
      where: { id: event.id },
      data: { undoneByEventId: reversalId },
    });

    return {
      undid: event.id,
      action: event.action,
      entityType: resolved.fromType,
      entityHumanId: from,
      reversalEventId: reversalId,
    };
  });
}

/**
 * Refuse a reversal when the entity has moved on since.
 *
 * Comparing against the event's own `after` is what makes this exact: if the row no longer looks
 * like what this change left behind, something else has edited it, and replaying `before` would
 * discard that edit without telling anyone.
 */
function assertUnchangedSince(current: Record<string, unknown>, after: Record<string, unknown> | null): void {
  if (after === null) return;

  const drifted: string[] = [];
  for (const [key, value] of Object.entries(after)) {
    if (NOT_RESTORED.has(key)) continue;
    // The same rule `restorable` keeps: a snapshot may carry an included relation — a task's
    // `files` and `requirements` — which the bare row read here does not have. Comparing it anyway
    // reported every task update as drifted, so no task update could ever be undone.
    if (!(key in current)) continue;
    // Compared through the same scrubber that wrote the snapshot, so a Date and its ISO string
    // are not reported as a difference.
    const now = JSON.stringify(scrub(current[key]));
    if (now !== JSON.stringify(value)) drifted.push(key);
  }

  if (drifted.length > 0) {
    throw new Conflict(
      `that change cannot be undone: ${drifted.join(', ')} ${drifted.length === 1 ? 'has' : 'have'} ` +
        'changed since, and restoring would discard the later edit',
    );
  }
}

/** The fields an undo may write back — everything it recorded, minus identity and timestamps. */
function restorable(
  before: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(before)) {
    if (NOT_RESTORED.has(key)) continue;
    // Only fields the row actually has: a snapshot may carry an included relation, which is not a
    // column and cannot be written back.
    if (!(key in current)) continue;
    if (value === '[redacted]') continue;
    data[key] = value;
  }
  return data;
}
