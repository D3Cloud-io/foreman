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
 * Whether the link exists now: its reference row, or the row a kind keeps beside it. Either is
 * enough, because an unlink removes both and a link written some other way may have only one.
 */
export async function isLinked(tx: TransactionClient, r: ResolvedLink): Promise<boolean> {
  const reference = await tx.reference.findUnique({
    where: {
      fromType_fromId_toType_toId_kind: {
        fromType: r.fromType,
        fromId: r.fromId,
        toType: r.toType,
        toId: r.toId,
        kind: r.referenceKind,
      },
    },
    select: { id: true },
  });
  if (reference !== null) return true;

  if (r.fromType === 'task' && r.toType === 'requirement') {
    const row = await tx.taskRequirement.findUnique({
      where: { taskId_requirementId: { taskId: r.fromId, requirementId: r.toId } },
      select: { taskId: true },
    });
    if (row !== null) return true;
  }
  if (r.kind === 'depends_on') {
    const edge = await tx.taskDependency.findUnique({
      where: { taskId_dependsOnId: { taskId: r.fromId, dependsOnId: r.toId } },
      select: { taskId: true },
    });
    if (edge !== null) return true;
  }
  if (r.fromType === 'adr' && r.toType === 'adr') {
    const relation = await tx.adrRelation.findFirst({
      where: { adrId: r.fromId, relatedAdrId: r.toId },
      select: { adrId: true },
    });
    if (relation !== null) return true;
  }
  return false;
}

/**
 * Write the link's rows, without an audit event: the caller records what the write *was*.
 *
 * `created` is whether the reference row is new, which is what the API has always answered.
 * `changed` is whether *any* row is new, which is what undo needs: a link that changed nothing
 * has nothing to reverse, and reversing it would remove a link this write never made.
 */
export async function writeLink(
  tx: TransactionClient,
  r: ResolvedLink,
): Promise<{ created: boolean; changed: boolean }> {
  const { from, to, kind, fromType, toType, fromId, toId, referenceKind } = r;
  // `createMany` with `skipDuplicates` answers how many rows it wrote, where an upsert cannot.
  let written = 0;

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
    written += (
      await tx.taskDependency.createMany({
        data: [{ taskId: fromId, dependsOnId: toId }],
        skipDuplicates: true,
      })
    ).count;
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
    written += 1;
  }

  // Coverage counts `task_requirement`, not references, so the link has to land there too.
  if (fromType === 'task' && toType === 'requirement') {
    written += (
      await tx.taskRequirement.createMany({
        data: [{ taskId: fromId, requirementId: toId }],
        skipDuplicates: true,
      })
    ).count;
  }

  if (fromType === 'adr' && toType === 'adr') {
    const relationKind = kind === 'supersedes' ? 'supersedes' : 'extends';
    written += (
      await tx.adrRelation.createMany({
        data: [{ adrId: fromId, relatedAdrId: toId, kind: relationKind }],
        skipDuplicates: true,
      })
    ).count;
    // A supersedes edge is also a status change on the ADR it replaces.
    if (relationKind === 'supersedes') {
      await tx.adr.update({ where: { id: toId }, data: { status: 'superseded' } });
      written += (
        await tx.adrRelation.createMany({
          data: [{ adrId: toId, relatedAdrId: fromId, kind: 'superseded_by' }],
          skipDuplicates: true,
        })
      ).count;
    }
  }

  return { created: existing === null, changed: written > 0 };
}

/** Remove the link's rows, without an audit event. `removed` is whether there was anything to remove. */
export async function removeLink(tx: TransactionClient, r: ResolvedLink): Promise<{ removed: boolean }> {
  const { kind, fromType, toType, fromId, toId, referenceKind } = r;
  let removed = 0;

  removed += (
    await tx.reference.deleteMany({ where: { fromType, fromId, toType, toId, kind: referenceKind } })
  ).count;
  if (fromType === 'task' && toType === 'requirement') {
    removed += (await tx.taskRequirement.deleteMany({ where: { taskId: fromId, requirementId: toId } }))
      .count;
  }
  if (fromType === 'adr' && toType === 'adr') {
    removed += (await tx.adrRelation.deleteMany({ where: { adrId: fromId, relatedAdrId: toId } })).count;
  }
  if (kind === 'depends_on') {
    removed += (await tx.taskDependency.deleteMany({ where: { taskId: fromId, dependsOnId: toId } }))
      .count;
  }
  return { removed: removed > 0 };
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
    const { created, changed } = await writeLink(tx, resolved);

    await record(tx, {
      ...actor,
      action: 'create',
      entityType: resolved.fromType,
      entityId: resolved.fromId,
      entityHumanId: from,
      // `changed` is what lets undo tell a new link from a repeat of one that was already there:
      // reversing the repeat would remove the earlier link, which this event never made.
      after: { event: 'link', to, kind, changed },
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
    const { removed } = await removeLink(tx, resolved);

    await record(tx, {
      ...actor,
      action: 'delete',
      entityType: resolved.fromType,
      entityId: resolved.fromId,
      entityHumanId: from,
      // Recorded in full, because an unlink is what `POST /undo` has to be able to put back.
      before: { event: 'link', to, kind },
      // `changed`, as on a link: an unlink of something not linked has nothing to put back.
      after: { event: 'unlink', to, kind, changed: removed },
    });

    return { from, to, kind, created: false, removed } as LinkResult;
  });
}
