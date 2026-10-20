import { parseHumanId } from '@foreman/shared';
import type { Db } from '../db.js';
import type { EntityType, ReferenceKind } from '../generated/prisma/enums.js';
import { record, type Actor, type TransactionClient } from './audit.js';
import { getByHumanId } from './entities.js';
import { Invalid } from './errors.js';

/**
 * Citations between entities.
 *
 * A `reference` row is what makes backlinks possible. Some kinds of link are more than a citation
 * and are kept in their own columns as well: a task that satisfies a requirement is a
 * `task_requirement` row (it is how coverage is counted), and an ADR that extends or supersedes
 * another is an `adr_relation` (it is how a superseded decision knows what replaced it). The
 * `reference` row is written either way, so the backlinks are uniform. Any other kind — a task
 * that relates to a requirement, an ADR that violates another — is its reference alone: a citation
 * is not coverage, and not an edge in the ADR graph.
 *
 * A third is task→task `depends_on`, kept in `task_dependency` because that is what the brief reads
 * to decide a task is ready (FRM-REQ-179). It is the one link that can be *refused* on its shape
 * rather than its existence: an edge to itself, to another project, or one that closes a cycle
 * would leave a task that can never be offered, and nothing would say why (FRM-REQ-180).
 */

/** The entity a human ID's type segment names. */
function typeOf(humanId: string): EntityType {
  const parsed = parseHumanId(humanId);
  if (parsed === null) throw new Invalid(`${humanId} is not a project-prefixed human ID`);

  const map: Record<string, EntityType> = {
    REQ: 'requirement',
    T: 'task',
    P: 'phase',
    ADR: 'adr',
    D: 'decision',
    R: 'risk',
    CR: 'finding',
    DA: 'finding',
    FR: 'finding',
    API: 'finding',
    AUD: 'audit',
    // So `foreman_link BND-SCR-001 relates BND-REQ-012` records what a screen serves (FRM-REQ-189).
    SCR: 'screen',
  };
  const type = map[parsed.type];
  if (type === undefined) throw new Invalid(`${humanId} names no kind of entity Foreman knows`);
  return type;
}

/**
 * The chain of dependencies from `startId` to `goalId`, as human IDs from start to goal inclusive,
 * or null when there is none. Adding `goal depends_on start` closes
 * a cycle exactly when this finds a path, and the path is what the refusal shows, because "would
 * create a cycle" without the cycle leaves the reader to go and find it.
 */
async function pathBetween(
  tx: TransactionClient,
  startId: string,
  goalId: string,
): Promise<string[] | null> {
  const cameFrom = new Map<string, string | null>([[startId, null]]);
  let frontier = [startId];

  while (frontier.length > 0) {
    const edges = await tx.taskDependency.findMany({
      where: { taskId: { in: frontier } },
      select: { taskId: true, dependsOnId: true },
    });
    const next: string[] = [];
    for (const edge of edges) {
      if (cameFrom.has(edge.dependsOnId)) continue;
      cameFrom.set(edge.dependsOnId, edge.taskId);
      next.push(edge.dependsOnId);
    }
    if (cameFrom.has(goalId)) {
      const ids: string[] = [];
      for (let at: string | null = goalId; at !== null; at = cameFrom.get(at) ?? null) ids.unshift(at);
      const tasks = await tx.task.findMany({
        where: { id: { in: ids } },
        select: { id: true, humanId: true },
      });
      const humanIds = new Map(tasks.map((t) => [t.id, t.humanId]));
      return ids.map((id) => humanIds.get(id) ?? id);
    }
    frontier = next;
  }
  return null;
}

export interface LinkResult {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly created: boolean;
  /** The audit event this link or unlink wrote (FRM-REQ-243). */
  readonly auditEventIds: string[];
}

/** Every link kind is a reference kind, so each writes and removes a reference row of its own. */
export type LinkKind = ReferenceKind;

/** A link with both ends looked up: what every write below needs, resolved outside the transaction. */
export interface ResolvedLink {
  readonly from: string;
  readonly to: string;
  readonly kind: LinkKind;
  readonly fromType: EntityType;
  readonly toType: EntityType;
  readonly fromId: string;
  readonly toId: string;
  /** Kept for the depends_on check, which only a write makes: removing a bad edge is never refused. */
  readonly fromProjectId: unknown;
  readonly toProjectId: unknown;
  /**
   * The link's own reference kind, which is its kind. `extends` was stored as `relates` until
   * FRM-T-11.3, so the two kinds shared a row and undoing either took the other's.
   */
  readonly referenceKind: ReferenceKind;
}

export async function resolveLink(
  db: Db,
  from: string,
  to: string,
  kind: LinkKind,
): Promise<ResolvedLink> {
  const fromType = typeOf(from);
  const toType = typeOf(to);

  // Both must exist. A citation of something absent is not a link, it is a typo.
  const [source, target] = await Promise.all([
    getByHumanId(db, from, { backlinks: false }),
    getByHumanId(db, to, { backlinks: false }),
  ]);

  return {
    from,
    to,
    kind,
    fromType,
    toType,
    fromId: String(source.entity['id']),
    toId: String(target.entity['id']),
    fromProjectId: source.entity['projectId'],
    toProjectId: target.entity['projectId'],
    referenceKind: kind,
  };
}

/** Refuse a depends_on edge the brief could never honour: not task to task, to itself, or across projects. */
function assertDependable(r: ResolvedLink): void {
  const { from, to } = r;
  if (r.fromType !== 'task' || r.toType !== 'task') {
    throw new Invalid(`depends_on links a task to a task; ${from} → ${to} is not that`);
  }
  if (r.fromId === r.toId) throw new Invalid(`${from} cannot depend on itself`);
  if (r.fromProjectId !== r.toProjectId) {
    throw new Invalid(
      `${from} and ${to} are in different projects; a dependency stays inside one, because ` +
        'the brief that honours it is per project',
    );
  }
}

/**
 * The rows one link is kept in, as flags: which ones a write made, a removal took away, or exist now.
 *
 * **Every row has exactly one owning kind.** Each kind owns its own reference row, of its own
 * kind. Beside it, only `satisfies` writes a task's `task_requirement` row, only `depends_on` a
 * `task_dependency`, only `extends` the extends relation, and only `supersedes` the supersedes
 * relation, its `superseded_by` mirror and the replaced ADR's status. Any other kind writes its
 * reference and nothing else. A row two kinds shared had no owner: reversing either link could
 * take it while the other still stood, or leave it behind when both were gone, and coverage
 * counted a `relates` as work done. So no removal here can reach another kind's row.
 *
 * Recording which rows an event touched is what lets undo reverse that event and nothing else.
 */
export interface LinkRows {
  readonly reference: boolean;
  readonly taskRequirement: boolean;
  readonly taskDependency: boolean;
  readonly adrRelation: boolean;
  /** The mirror a supersedes link writes on the ADR it replaces. */
  readonly supersededBy: boolean;
  /** The replaced ADR's status, moved to `superseded`. */
  readonly status: boolean;
}

export const LINK_ROWS = [
  'reference',
  'taskRequirement',
  'taskDependency',
  'adrRelation',
  'supersededBy',
  'status',
] as const satisfies readonly (keyof LinkRows)[];

const ALL_ROWS: LinkRows = {
  reference: true,
  taskRequirement: true,
  taskDependency: true,
  adrRelation: true,
  supersededBy: true,
  status: true,
};

export function anyRow(rows: LinkRows): boolean {
  return LINK_ROWS.some((row) => rows[row]);
}

/** Which rows besides its reference a kind owns between these two entities. */
function owns(r: ResolvedLink): Omit<LinkRows, 'reference'> {
  const adrPair = r.fromType === 'adr' && r.toType === 'adr';
  const supersedes = adrPair && r.kind === 'supersedes';
  return {
    taskRequirement: r.fromType === 'task' && r.toType === 'requirement' && r.kind === 'satisfies',
    taskDependency: r.kind === 'depends_on',
    adrRelation: adrPair && (r.kind === 'extends' || r.kind === 'supersedes'),
    supersededBy: supersedes,
    status: supersedes,
  };
}

/** The ADR relation an owning kind is kept as. Only called for `extends` and `supersedes`. */
function relationKindOf(kind: LinkKind): 'supersedes' | 'extends' {
  return kind === 'supersedes' ? 'supersedes' : 'extends';
}

/** Which of the link's rows exist now. A row the kind does not own is never reported present. */
export async function rowsPresent(tx: TransactionClient, r: ResolvedLink): Promise<LinkRows> {
  const { fromType, toType, fromId, toId, referenceKind } = r;
  const own = owns(r);

  const [reference, taskRequirement, taskDependency, adrRelation, supersededBy, replaced] =
    await Promise.all([
      tx.reference.findUnique({
        where: { fromType_fromId_toType_toId_kind: { fromType, fromId, toType, toId, kind: referenceKind } },
        select: { id: true },
      }),
      own.taskRequirement
        ? tx.taskRequirement.findUnique({
            where: { taskId_requirementId: { taskId: fromId, requirementId: toId } },
            select: { taskId: true },
          })
        : null,
      own.taskDependency
        ? tx.taskDependency.findUnique({
            where: { taskId_dependsOnId: { taskId: fromId, dependsOnId: toId } },
            select: { taskId: true },
          })
        : null,
      own.adrRelation
        ? tx.adrRelation.findUnique({
            where: {
              adrId_relatedAdrId_kind: { adrId: fromId, relatedAdrId: toId, kind: relationKindOf(r.kind) },
            },
            select: { adrId: true },
          })
        : null,
      own.supersededBy
        ? tx.adrRelation.findUnique({
            where: { adrId_relatedAdrId_kind: { adrId: toId, relatedAdrId: fromId, kind: 'superseded_by' } },
            select: { adrId: true },
          })
        : null,
      own.status ? tx.adr.findUnique({ where: { id: toId }, select: { status: true } }) : null,
    ]);

  return {
    reference: reference !== null,
    taskRequirement: taskRequirement !== null,
    taskDependency: taskDependency !== null,
    adrRelation: adrRelation !== null,
    supersededBy: supersededBy !== null,
    status: replaced?.status === 'superseded',
  };
}

/**
 * Write the link's rows, without an audit event: the caller records what the write *was*.
 *
 * `only` narrows it to the rows an unlink removed, which is how undo puts back exactly that and
 * nothing it never took. `created` is whether the reference row is new, which is what the API has
 * always answered; `rows` is which rows are new, which is what undo reverses.
 */
export async function writeLink(
  tx: TransactionClient,
  r: ResolvedLink,
  only: LinkRows = ALL_ROWS,
): Promise<{ created: boolean; rows: LinkRows }> {
  const { from, to, fromType, toType, fromId, toId, referenceKind } = r;
  const own = owns(r);
  const may = (row: keyof LinkRows) => only[row] && (row === 'reference' || own[row]);
  // `createMany` with `skipDuplicates` answers how many rows it wrote, where an upsert cannot.
  const wrote = (result: { count: number }) => result.count > 0;

  let taskDependency = false;
  if (may('taskDependency')) {
    assertDependable(r);
    // Inside the transaction, so two edges written at once cannot each pass the check and
    // together close a loop the check was there to refuse.
    const loop = await pathBetween(tx, toId, fromId);
    if (loop !== null) {
      throw new Invalid(
        `${from} depends_on ${to} would close a cycle: ${[from, ...loop].join(' → ')}`,
      );
    }
    taskDependency = wrote(
      await tx.taskDependency.createMany({
        data: [{ taskId: fromId, dependsOnId: toId }],
        skipDuplicates: true,
      }),
    );
  }

  let reference = false;
  if (may('reference')) {
    reference = wrote(
      await tx.reference.createMany({
        data: [{ fromType, fromId, toType, toId, kind: referenceKind, citedAs: to }],
        skipDuplicates: true,
      }),
    );
  }

  // Coverage counts `task_requirement`, not references, so a satisfies has to land there too.
  let taskRequirement = false;
  if (may('taskRequirement')) {
    taskRequirement = wrote(
      await tx.taskRequirement.createMany({
        data: [{ taskId: fromId, requirementId: toId }],
        skipDuplicates: true,
      }),
    );
  }

  let adrRelation = false;
  if (may('adrRelation')) {
    adrRelation = wrote(
      await tx.adrRelation.createMany({
        data: [{ adrId: fromId, relatedAdrId: toId, kind: relationKindOf(r.kind) }],
        skipDuplicates: true,
      }),
    );
  }
  let supersededBy = false;
  if (may('supersededBy')) {
    supersededBy = wrote(
      await tx.adrRelation.createMany({
        data: [{ adrId: toId, relatedAdrId: fromId, kind: 'superseded_by' }],
        skipDuplicates: true,
      }),
    );
  }
  // A supersedes edge is also a status change on the ADR it replaces.
  let status = false;
  if (may('status')) {
    status = wrote(
      await tx.adr.updateMany({
        where: { id: toId, status: { not: 'superseded' } },
        data: { status: 'superseded' },
      }),
    );
  }

  return {
    created: reference,
    rows: { reference, taskRequirement, taskDependency, adrRelation, supersededBy, status },
  };
}

/**
 * Remove the link's rows, without an audit event, and answer which rows went: its reference and
 * the rows its kind owns, narrowed by `only` to the rows one event wrote.
 *
 * The replaced ADR's status is never moved back: what it was before is not recorded anywhere.
 */
export async function removeLink(
  tx: TransactionClient,
  r: ResolvedLink,
  only: LinkRows = ALL_ROWS,
): Promise<LinkRows> {
  const { fromType, toType, fromId, toId, referenceKind } = r;
  const own = owns(r);
  const may = (row: keyof LinkRows) => only[row] && (row === 'reference' || own[row]);
  const went = (result: { count: number }) => result.count > 0;

  return {
    reference:
      may('reference') &&
      went(await tx.reference.deleteMany({ where: { fromType, fromId, toType, toId, kind: referenceKind } })),
    taskRequirement:
      may('taskRequirement') &&
      went(await tx.taskRequirement.deleteMany({ where: { taskId: fromId, requirementId: toId } })),
    taskDependency:
      may('taskDependency') &&
      went(await tx.taskDependency.deleteMany({ where: { taskId: fromId, dependsOnId: toId } })),
    adrRelation:
      may('adrRelation') &&
      went(
        await tx.adrRelation.deleteMany({
          where: { adrId: fromId, relatedAdrId: toId, kind: relationKindOf(r.kind) },
        }),
      ),
    supersededBy:
      may('supersededBy') &&
      went(
        await tx.adrRelation.deleteMany({
          where: { adrId: toId, relatedAdrId: fromId, kind: 'superseded_by' },
        }),
      ),
    status: false,
  };
}

/**
 * The rows the event that made this link wrote, or null when no event on record says.
 *
 * An unlink takes these and no more: a `task_requirement` row the task was created with, or one
 * an import wrote, was there before the satisfies and stays after it. The maker is the latest link
 * event, or undo putting one back, that wrote this link's reference.
 */
async function rowsTheLinkWrote(tx: TransactionClient, r: ResolvedLink): Promise<LinkRows | null> {
  const events = await tx.auditEvent.findMany({
    where: {
      entityType: r.fromType,
      entityId: r.fromId,
      action: { in: ['create', 'undo'] },
      undoneAt: null,
      AND: [
        { after: { path: ['event'], equals: 'link' } },
        { after: { path: ['to'], equals: r.to } },
        { after: { path: ['kind'], equals: r.kind } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    select: { after: true },
  });
  for (const event of events) {
    const rows = (event.after as { rows?: unknown } | null)?.rows;
    if (typeof rows !== 'object' || rows === null) continue;
    const flags = rows as Record<string, unknown>;
    if (flags['reference'] === true) {
      return Object.fromEntries(LINK_ROWS.map((row) => [row, flags[row] === true])) as unknown as LinkRows;
    }
  }
  return null;
}

export async function link(
  db: Db,
  actor: Actor,
  from: string,
  to: string,
  kind: LinkKind,
): Promise<LinkResult> {
  const resolved = await resolveLink(db, from, to, kind);

  return db.$transaction(async (tx) => {
    const { created, rows } = await writeLink(tx, resolved);

    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: resolved.fromType,
      entityId: resolved.fromId,
      entityHumanId: from,
      // `rows` is what lets undo reverse this link and no other: a repeat of one already there
      // wrote nothing, and a satisfies over a row the task was created with did not write it.
      after: { event: 'link', to, kind, changed: anyRow(rows), rows },
    });

    return { from, to, kind, created, auditEventIds: [event] };
  });
}

export async function unlink(
  db: Db,
  actor: Actor,
  from: string,
  to: string,
  kind: LinkKind,
): Promise<LinkResult> {
  const resolved = await resolveLink(db, from, to, kind);

  return db.$transaction(async (tx) => {
    // This kind's own reference always goes, and of the rows beside it only what the link's maker
    // wrote. With no maker on record — a link from before rows were recorded, or a coverage row a
    // task was created with — every row this kind owns goes; never a row of any other kind.
    const made = await rowsTheLinkWrote(tx, resolved);
    const rows = await removeLink(tx, resolved, made === null ? ALL_ROWS : { ...made, reference: true });
    const removed = anyRow(rows);

    // The replaced ADR's status as the unlink left it, so undo can tell if it has moved since.
    const replaced =
      owns(resolved).status
        ? await tx.adr.findUnique({ where: { id: resolved.toId }, select: { status: true } })
        : null;

    const event = await record(tx, {
      ...actor,
      action: 'delete',
      entityType: resolved.fromType,
      entityId: resolved.fromId,
      entityHumanId: from,
      // Recorded in full, because an unlink is what `POST /undo` has to be able to put back.
      before: { event: 'link', to, kind },
      // `changed`, as on a link: an unlink of something not linked has nothing to put back.
      after: {
        event: 'unlink',
        to,
        kind,
        changed: removed,
        rows,
        ...(replaced === null ? {} : { replacedStatus: replaced.status }),
      },
    });

    return { from, to, kind, created: false, removed, auditEventIds: [event] } as LinkResult;
  });
}
