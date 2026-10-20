import type { Db } from '../db.js';
import type { EntityType } from '../generated/prisma/enums.js';
import type { AuditEventEntry, AuditEventsResponse, AuditEventUndoability } from '@foreman/shared';
import { eventIds, record, scrub, summarize, type Actor, type TransactionClient } from './audit.js';
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
import { afterSectionUndo } from './documents.js';
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

/**
 * The kinds whose writes read or change group membership and order: a write to one of them takes
 * the group lock **before its first read**, so what it reads is what every other such write left.
 * Under READ COMMITTED a row read before the lock is a row a move may already have replaced.
 */
const GROUPED: ReadonlySet<string> = new Set(['project', 'group', 'guideline']);

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
): Promise<{ id: string; auditEventIds: string[] }> {
  return db.$transaction(async (tx) => {
    // The lock before the read: the row this records as `before`, and the group it leaves, must be
    // the ones no move has replaced (FRM-REQ-226).
    if (GROUPED.has(type)) await lockGroups(tx);
    const table = model(tx, type);
    if (type === 'project') {
      await tx.$queryRaw`SELECT id FROM project WHERE code = ${humanId} AND deleted_at IS NULL FOR UPDATE`;
    }
    const before = (await (table as { findFirst: (args: unknown) => Promise<unknown> }).findFirst({
      // A project is named by its code; everything else here by its human ID.
      where: type === 'project' ? { code: humanId, deletedAt: null } : { humanId, deletedAt: null },
    })) as Record<string, unknown> | null;
    if (before === null) throw new NotFound(humanId);

    const id = String(before['id']);
    await (table as { update: (args: unknown) => Promise<unknown> }).update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    const event = await record(tx, {
      ...actor,
      action: 'delete',
      entityType: type,
      entityId: id,
      entityHumanId: humanId,
      before,
      after: { deleted: true },
    });
    let shifted: string | null = null;
    if (type === 'project') {
      const groupId = typeof before['groupId'] === 'string' ? before['groupId'] : null;
      shifted = await settleProjects(tx, actor, groupId, { cause: `${humanId} deleted` });
    }
    // A deleted task stops counting toward its phase; a deleted phase toward its project.
    const events: string[] = [];
    await rollupAfter(tx, actor, type, before, { ...before, deletedAt: new Date() }, humanId, {
      events,
    });
    // The record's own event first, then what moved because it went (FRM-REQ-243).
    return { id, auditEventIds: eventIds(event, shifted, ...events) };
  });
}

/**
 * A transaction that answers the group advisory lock without taking it. `undoReorder` (groups.ts)
 * takes the lock itself; in a dry run that would let a read-only caller queue every group write.
 */
function withoutGroupLock(tx: TransactionClient): TransactionClient {
  return new Proxy(tx, {
    get(target, property) {
      if (property === '$executeRaw') {
        return (strings: TemplateStringsArray, ...values: unknown[]) =>
          strings.join('').includes('pg_advisory_xact_lock')
            ? Promise.resolve(0)
            : (target.$executeRaw as (...args: unknown[]) => unknown)(strings, ...values);
      }
      return Reflect.get(target, property) as unknown;
    },
  });
}

export interface UndoResult {
  readonly undid: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityHumanId: string | null;
  readonly reversalEventId: string;
  /** The reversal, then any rollup it caused: every event this undo wrote, in order. */
  readonly auditEventIds: string[];
}

/**
 * Thrown at the end of a dry run, inside the transaction, so everything the undo wrote is rolled
 * back. Reaching it means every check passed.
 */
class DryRunPassed extends Error {
  constructor() {
    super('dry run: every check passed');
    this.name = 'DryRunPassed';
  }
}

/** Who a dry run says it is. Nothing is written, so it is never recorded. */
const DRY_RUN_ACTOR: Actor = { actor: 'dry-run', actorKind: 'system' };

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
  return undoEvent(db, actor, event, false);
}

/**
 * Whether one event could be undone right now, and if not, why — by running the undo itself with
 * every write rolled back (FRM-T-18.3). It is the same code path, not a copy of its checks, so
 * what it says and what `POST /api/undo/:id` does cannot drift apart.
 *
 * Only a refusal is an answer. Anything else going wrong is a fault, and is thrown.
 */
export async function checkUndo(
  db: Db,
  event: AuditEventRow,
): Promise<{ undoable: true } | { undoable: false; reason: string }> {
  try {
    await undoEvent(db, DRY_RUN_ACTOR, event, true);
  } catch (error) {
    if (error instanceof DryRunPassed) return { undoable: true };
    if (error instanceof Conflict || error instanceof NotFound) {
      return { undoable: false, reason: error.message };
    }
    throw error;
  }
  // `undoEvent` always ends in `DryRunPassed` or a refusal when dry; this is unreachable.
  throw new Error('a dry run finished without a verdict');
}

async function undoEvent(
  db: Db,
  actor: Actor,
  event: AuditEventRow,
  dryRun: boolean,
): Promise<UndoResult> {
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
  if (linkEvent !== null) return undoLink(db, actor, event, linkEvent, dryRun);

  // A reorder changed several rows' positions at once, and is reversed as one (FRM-REQ-226).
  if (event.action === 'update' && isReorderEvent(after)) {
    if (!dryRun) {
      const reversed = await undoReorder(db, actor, event);
      return { ...reversed, auditEventIds: [reversed.reversalEventId] };
    }
    // Its transaction lives in groups.ts, which takes only `$transaction` from the client: handed
    // one that rolls back after the callback, it runs every one of its own checks and writes
    // nothing.
    const rollsBack = {
      $transaction: (run: (tx: TransactionClient) => Promise<unknown>) =>
        db.$transaction(async (tx) => {
          await run(withoutGroupLock(tx));
          throw new DryRunPassed();
        }),
    } as unknown as Db;
    return undoReorder(rollsBack, actor, event).then(() => {
      throw new Error('a dry run of a reorder finished without a verdict');
    });
  }

  if (!isUndoable(event.entityType)) {
    throw new Conflict(`${event.entityType} changes cannot be undone`);
  }
  const type = event.entityType;

  return db.$transaction(async (tx) => {
    // The lock before any read, so `current` — what the drift check compares, what `finishUndo`
    // settles from, and the reversal's `before` — is what every other group write left.
    //
    // **Not in a dry run.** A verdict is advisory — the real undo takes the lock and checks again —
    // and `GET /api/audit-events` is a read: a caller holding only `read` must not be able to
    // queue every group write behind it by asking for a history.
    if (GROUPED.has(type) && !dryRun) await lockGroups(tx);

    // Claimed before anything is read or written: of two undos of the same change, exactly one
    // gets past this line, and the other is refused rather than reversing it a second time. A dry
    // run leaves the event alone (`undoneAt` was read above), so it never holds its row.
    if (!dryRun) {
      const claimed = await tx.auditEvent.updateMany({
        where: { id: event.id, undoneAt: null },
        data: { undoneAt: new Date() },
      });
      if (claimed.count === 0) throw new Conflict('that change has already been undone');
    }

    const table = model(tx, type);
    // The row too: a lifecycle rollup locks a project's row without the group lock, and a
    // `current` read beside one would record — and let this restore — a lifecycle it has replaced.
    if (type === 'project' && !dryRun) {
      await tx.$queryRaw`SELECT id FROM project WHERE id = ${event.entityId}::uuid FOR UPDATE`;
    }
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
    // Every check that can refuse has run; what follows only writes.
    if (dryRun) throw new DryRunPassed();

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
    // A section is read as part of its document: the document's version moves and a revision is
    // written, as for any section write, or a reader holding the old ETag never sees the undo.
    if (type === 'document_section') await afterSectionUndo(tx, actor, event.entityId);
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
    const events: string[] = [];
    await rollupAfter(tx, actor, type, current, restored, event.entityHumanId ?? type, { events });

    // Claimed above; now it says which event reversed it.
    await tx.auditEvent.update({
      where: { id: event.id },
      data: { undoneByEventId: reversalId },
    });

    return {
      undid: event.id,
      action: event.action,
      entityType: type,
      entityHumanId: event.entityHumanId,
      reversalEventId: reversalId,
      auditEventIds: [reversalId, ...events],
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

export type AuditEventRow = NonNullable<Awaited<ReturnType<Db['auditEvent']['findUnique']>>>;

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
  dryRun: boolean,
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
    if (!dryRun) {
      const claimed = await tx.auditEvent.updateMany({
        where: { id: event.id, undoneAt: null },
        data: { undoneAt: new Date() },
      });
      if (claimed.count === 0) throw new Conflict('that change has already been undone');
    }

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

    // Written back (or removed) above, with every refusal behind it.
    if (dryRun) throw new DryRunPassed();

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
      auditEventIds: [reversalId],
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How many of a history's newest events have their verdict worked out. A verdict is a rolled-back
 * transaction, so a list of two hundred is two hundred of them; the console shows the newest few
 * with Undo, and asks for any other with `undoabilityOf`.
 */
export const CHECKED_EVENTS = 10;

export const NOT_CHECKED = 'not checked — open the event to check';

/**
 * One record's history, newest first, each event saying whether it could be undone right now and
 * if not why (FRM-REQ-243).
 *
 * The record is named the way the audit trail names it: by human ID (`FRM-T-18.3`, `PI-007`,
 * `GL-004`, `GRP-001`), by project code, or — for a document, which has no human ID — by its UUID.
 * A deleted record still has a history; that is where its undo is.
 *
 * `undoable` is not recomputed from a copy of the rules: `checkUndo` runs the undo itself and rolls
 * it back. Only the newest `CHECKED_EVENTS` are checked; the rest carry `undoable: null` and the
 * reason `NOT_CHECKED`. A dry run takes no group lock and claims nothing (see `undoEvent`).
 */
export async function auditHistory(
  db: Db,
  entity: string,
  limit: number,
): Promise<AuditEventsResponse> {
  const events = await db.auditEvent.findMany({
    where: UUID.test(entity) ? { entityId: entity.toLowerCase() } : { entityHumanId: entity },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });

  const items: AuditEventEntry[] = [];
  for (const [index, event] of events.entries()) {
    const verdict = index < CHECKED_EVENTS ? await checkUndo(db, event) : null;
    items.push({
      id: event.id,
      at: event.createdAt.toISOString(),
      actor: { kind: event.actorKind, label: event.actor },
      action: event.action,
      summary: summarize({ ...event, entityType: event.entityType }),
      undoable: verdict === null ? null : verdict.undoable,
      ...(verdict === null
        ? { reason: NOT_CHECKED }
        : verdict.undoable
          ? {}
          : { reason: verdict.reason }),
    });
  }
  return { entity, items };
}

/** One event's verdict, for the ones a history did not check. NotFound for an event that is not there. */
export async function undoabilityOf(db: Db, id: string): Promise<AuditEventUndoability> {
  const event = UUID.test(id) ? await db.auditEvent.findUnique({ where: { id } }) : null;
  if (event === null) throw new NotFound(`audit event ${id}`);
  const verdict = await checkUndo(db, event);
  return { id, ...verdict };
}
