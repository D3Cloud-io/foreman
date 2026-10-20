import { parseHumanId } from '@foreman/shared';
import type { Db } from '../db.js';
import type { EntityType, ReferenceKind } from '../generated/prisma/enums.js';
import { record, type Actor, type TransactionClient } from './audit.js';
import { getByHumanId } from './entities.js';
import { Invalid } from './errors.js';

/**
 * Citations between entities.
 *
 * A `reference` row is what makes backlinks possible and what coverage is computed from. Two kinds
 * of link are more than a citation and are kept in their own columns as well: task↔requirement is a
 * `task_requirement` row (it is how coverage is counted), and ADR↔ADR is an `adr_relation` (it is
 * how a superseded decision knows what replaced it). The `reference` row is written either way, so
 * the backlinks are uniform.
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
}

export type LinkKind = ReferenceKind | 'extends';

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
  /** `extends` is an ADR relation and not a reference kind; every other kind is both. */
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
    referenceKind: kind === 'extends' ? 'relates' : kind,
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
 * Two of them are shared. Every task→requirement kind writes the one `task_requirement` row, and
 * every ADR→ADR kind but supersedes writes the one `extends` relation, so a pair cited two ways
 * holds one of each for both. Recording which rows an event touched is what lets undo reverse that
 * event and nothing else — removing the shared row with the second citation would lose the first
 * one's coverage while its reference stayed, which is a partial reversal no one would see.
 */
export interface LinkRows {
  readonly reference: boolean;
  readonly taskRequirement: boolean;
  readonly taskDependency: boolean;
  readonly adrRelation: boolean;
  /** The mirror a supersedes link writes on the ADR it replaces. */
  readonly supersededBy: boolean;
}

export const LINK_ROWS = [
  'reference',
  'taskRequirement',
  'taskDependency',
  'adrRelation',
  'supersededBy',
] as const satisfies readonly (keyof LinkRows)[];

export function anyRow(rows: LinkRows): boolean {
  return LINK_ROWS.some((row) => rows[row]);
}

/** `supersedes` is its own ADR relation; every other kind between two ADRs is kept as `extends`. */
function relationKindOf(kind: LinkKind): 'supersedes' | 'extends' {
  return kind === 'supersedes' ? 'supersedes' : 'extends';
}

/** Which of the link's rows exist now. */
export async function rowsPresent(tx: TransactionClient, r: ResolvedLink): Promise<LinkRows> {
  const { fromType, toType, fromId, toId, referenceKind } = r;
  const isTaskRequirement = fromType === 'task' && toType === 'requirement';
  const isAdrPair = fromType === 'adr' && toType === 'adr';

  const [reference, taskRequirement, taskDependency, adrRelation, supersededBy] = await Promise.all([
    tx.reference.findUnique({
      where: { fromType_fromId_toType_toId_kind: { fromType, fromId, toType, toId, kind: referenceKind } },
      select: { id: true },
    }),
    isTaskRequirement
      ? tx.taskRequirement.findUnique({
          where: { taskId_requirementId: { taskId: fromId, requirementId: toId } },
          select: { taskId: true },
        })
      : null,
    r.kind === 'depends_on'
      ? tx.taskDependency.findUnique({
          where: { taskId_dependsOnId: { taskId: fromId, dependsOnId: toId } },
          select: { taskId: true },
        })
      : null,
    isAdrPair
      ? tx.adrRelation.findUnique({
          where: {
            adrId_relatedAdrId_kind: { adrId: fromId, relatedAdrId: toId, kind: relationKindOf(r.kind) },
          },
          select: { adrId: true },
        })
      : null,
    isAdrPair && r.kind === 'supersedes'
      ? tx.adrRelation.findUnique({
          where: { adrId_relatedAdrId_kind: { adrId: toId, relatedAdrId: fromId, kind: 'superseded_by' } },
          select: { adrId: true },
        })
      : null,
  ]);

  return {
    reference: reference !== null,
    taskRequirement: taskRequirement !== null,
    taskDependency: taskDependency !== null,
    adrRelation: adrRelation !== null,
    supersededBy: supersededBy !== null,
  };
}

/**
 * Whether another kind of link between the same pair still needs a shared row: any other
 * task→requirement reference needs the `task_requirement` row, and any other ADR→ADR reference
 * kept as the same relation needs that relation.
 */
async function sharedRowsCited(
  tx: TransactionClient,
  r: ResolvedLink,
): Promise<{ taskRequirement: boolean; adrRelation: boolean }> {
  const { fromType, toType, fromId, toId, referenceKind } = r;
  if (!(fromType === 'task' && toType === 'requirement') && !(fromType === 'adr' && toType === 'adr')) {
    return { taskRequirement: false, adrRelation: false };
  }

  const others = await tx.reference.findMany({
    where: { fromType, fromId, toType, toId, kind: { not: referenceKind } },
    select: { kind: true },
  });
  if (fromType === 'task') return { taskRequirement: others.length > 0, adrRelation: false };

  const relation = relationKindOf(r.kind);
  return { taskRequirement: false, adrRelation: others.some((o) => relationKindOf(o.kind) === relation) };
}

/**
 * Write the link's rows, without an audit event: the caller records what the write *was*.
 *
 * `created` is whether the reference row is new, which is what the API has always answered.
 * `rows` is which rows are new, which is what undo needs: it removes those and no others, and a
 * link that wrote none has nothing to reverse.
 */
export async function writeLink(
  tx: TransactionClient,
  r: ResolvedLink,
): Promise<{ created: boolean; rows: LinkRows }> {
  const { from, to, kind, fromType, toType, fromId, toId, referenceKind } = r;
  // `createMany` with `skipDuplicates` answers how many rows it wrote, where an upsert cannot.
  let taskDependency = false;
  let taskRequirement = false;
  let adrRelation = false;
  let supersededBy = false;

  if (kind === 'depends_on') {
    assertDependable(r);
    // Inside the transaction, so two edges written at once cannot each pass the check and
    // together close a loop the check was there to refuse.
    const loop = await pathBetween(tx, toId, fromId);
    if (loop !== null) {
      throw new Invalid(
        `${from} depends_on ${to} would close a cycle: ${[from, ...loop].join(' → ')}`,
      );
    }
    taskDependency =
      (
        await tx.taskDependency.createMany({
          data: [{ taskId: fromId, dependsOnId: toId }],
          skipDuplicates: true,
        })
      ).count > 0;
  }

  const existing = await tx.reference.findUnique({
    where: {
      fromType_fromId_toType_toId_kind: { fromType, fromId, toType, toId, kind: referenceKind },
    },
  });

  if (existing === null) {
    await tx.reference.create({
      data: { fromType, fromId, toType, toId, kind: referenceKind, citedAs: to },
    });
  }

  // Coverage counts `task_requirement`, not references, so the link has to land there too.
  if (fromType === 'task' && toType === 'requirement') {
    taskRequirement =
      (
        await tx.taskRequirement.createMany({
          data: [{ taskId: fromId, requirementId: toId }],
          skipDuplicates: true,
        })
      ).count > 0;
  }

  if (fromType === 'adr' && toType === 'adr') {
    const relationKind = relationKindOf(kind);
    adrRelation =
      (
        await tx.adrRelation.createMany({
          data: [{ adrId: fromId, relatedAdrId: toId, kind: relationKind }],
          skipDuplicates: true,
        })
      ).count > 0;
    // A supersedes edge is also a status change on the ADR it replaces.
    if (relationKind === 'supersedes') {
      await tx.adr.update({ where: { id: toId }, data: { status: 'superseded' } });
      supersededBy =
        (
          await tx.adrRelation.createMany({
            data: [{ adrId: toId, relatedAdrId: fromId, kind: 'superseded_by' }],
            skipDuplicates: true,
          })
        ).count > 0;
    }
  }

  return {
    created: existing === null,
    rows: { reference: existing === null, taskRequirement, taskDependency, adrRelation, supersededBy },
  };
}

/**
 * Remove the link's rows, without an audit event, and answer which rows went.
 *
 * `only` narrows it to the rows one event wrote, which is how undo reverses that event and no more.
 * Either way a shared row stays while another kind of link between the pair still needs it.
 */
export async function removeLink(
  tx: TransactionClient,
  r: ResolvedLink,
  only?: LinkRows,
): Promise<LinkRows> {
  const { kind, fromType, toType, fromId, toId, referenceKind } = r;
  const may = (row: keyof LinkRows) => only === undefined || only[row];
  const cited = await sharedRowsCited(tx, r);

  let reference = false;
  let taskRequirement = false;
  let taskDependency = false;
  let adrRelation = false;

  if (may('reference')) {
    reference =
      (await tx.reference.deleteMany({ where: { fromType, fromId, toType, toId, kind: referenceKind } }))
        .count > 0;
  }
  if (fromType === 'task' && toType === 'requirement' && may('taskRequirement') && !cited.taskRequirement) {
    taskRequirement =
      (await tx.taskRequirement.deleteMany({ where: { taskId: fromId, requirementId: toId } })).count > 0;
  }
  if (fromType === 'adr' && toType === 'adr' && may('adrRelation') && !cited.adrRelation) {
    adrRelation =
      (
        await tx.adrRelation.deleteMany({
          where: { adrId: fromId, relatedAdrId: toId, kind: relationKindOf(kind) },
        })
      ).count > 0;
  }
  if (kind === 'depends_on' && may('taskDependency')) {
    taskDependency =
      (await tx.taskDependency.deleteMany({ where: { taskId: fromId, dependsOnId: toId } })).count > 0;
  }
  // The superseded_by mirror is left where it is, as unlink always has: the replaced ADR's status
  // does not move back either, and the two should agree.
  return { reference, taskRequirement, taskDependency, adrRelation, supersededBy: false };
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

    await record(tx, {
      ...actor,
      action: 'create',
      entityType: resolved.fromType,
      entityId: resolved.fromId,
      entityHumanId: from,
      // `rows` is what lets undo reverse this link and no other: a repeat of one already there
      // wrote nothing, and a second kind of citation did not write the row the first one shares.
      after: { event: 'link', to, kind, changed: anyRow(rows), rows },
    });

    return { from, to, kind, created };
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
    const rows = await removeLink(tx, resolved);
    const removed = anyRow(rows);

    await record(tx, {
      ...actor,
      action: 'delete',
      entityType: resolved.fromType,
      entityId: resolved.fromId,
      entityHumanId: from,
      // Recorded in full, because an unlink is what `POST /undo` has to be able to put back.
      before: { event: 'link', to, kind },
      // `changed`, as on a link: an unlink of something not linked has nothing to put back.
      after: { event: 'unlink', to, kind, changed: removed, rows },
    });

    return { from, to, kind, created: false, removed } as LinkResult;
  });
}
