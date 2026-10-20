import type { Db } from '../db.js';
import type { EntityType } from '../generated/prisma/enums.js';
import { record, scrub, type Actor, type TransactionClient } from './audit.js';
import { Conflict, NotFound } from './errors.js';
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
  if (!isUndoable(event.entityType)) {
    throw new Conflict(`${event.entityType} changes cannot be undone`);
  }

  const type = event.entityType;
  const before = event.before as Record<string, unknown> | null;
  const after = event.after as Record<string, unknown> | null;

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
        assertUnchangedSince(current, after);
        data = restorable(before, current);
        break;
      }
      default:
        throw new Conflict(`a ${event.action} cannot be undone`);
    }

    const restored = (await (table as { update: (args: unknown) => Promise<unknown> }).update({
      where: { id: event.entityId },
      data,
    })) as Record<string, unknown>;

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
