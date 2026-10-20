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

export async function link(
  db: Db,
  actor: Actor,
  from: string,
  to: string,
  kind: ReferenceKind | 'extends',
): Promise<LinkResult> {
  const fromType = typeOf(from);
  const toType = typeOf(to);

  // Both must exist. A citation of something absent is not a link, it is a typo.
  const [source, target] = await Promise.all([
    getByHumanId(db, from, { backlinks: false }),
    getByHumanId(db, to, { backlinks: false }),
  ]);
  const fromId = String(source.entity['id']);
  const toId = String(target.entity['id']);

  if (kind === 'depends_on') {
    if (fromType !== 'task' || toType !== 'task') {
      throw new Invalid(`depends_on links a task to a task; ${from} → ${to} is not that`);
    }
    if (fromId === toId) throw new Invalid(`${from} cannot depend on itself`);
    if (source.entity['projectId'] !== target.entity['projectId']) {
      throw new Invalid(
        `${from} and ${to} are in different projects; a dependency stays inside one, because ` +
          'the brief that honours it is per project',
      );
    }
  }

  // `extends` is an ADR relation and not a reference kind; every other kind is both.
  const referenceKind: ReferenceKind = kind === 'extends' ? 'relates' : kind;

  return db.$transaction(async (tx) => {
    if (kind === 'depends_on') {
      // Inside the transaction, so two edges written at once cannot each pass the check and
      // together close a loop the check was there to refuse.
      const loop = await pathBetween(tx, toId, fromId);
      if (loop !== null) {
        throw new Invalid(
          `${from} depends_on ${to} would close a cycle: ${[from, ...loop].join(' → ')}`,
        );
      }
      await tx.taskDependency.upsert({
        where: { taskId_dependsOnId: { taskId: fromId, dependsOnId: toId } },
        create: { taskId: fromId, dependsOnId: toId },
        update: {},
      });
    }

    const existing = await tx.reference.findUnique({
      where: {
        fromType_fromId_toType_toId_kind: {
          fromType,
          fromId,
          toType,
          toId,
          kind: referenceKind,
        },
      },
    });

    if (existing === null) {
      await tx.reference.create({
        data: { fromType, fromId, toType, toId, kind: referenceKind, citedAs: to },
      });
    }

    // Coverage counts `task_requirement`, not references, so the link has to land there too.
    if (fromType === 'task' && toType === 'requirement') {
      await tx.taskRequirement.upsert({
        where: { taskId_requirementId: { taskId: fromId, requirementId: toId } },
        create: { taskId: fromId, requirementId: toId },
        update: {},
      });
    }

    if (fromType === 'adr' && toType === 'adr') {
      const relationKind = kind === 'supersedes' ? 'supersedes' : 'extends';
      await tx.adrRelation.upsert({
        where: { adrId_relatedAdrId_kind: { adrId: fromId, relatedAdrId: toId, kind: relationKind } },
        create: { adrId: fromId, relatedAdrId: toId, kind: relationKind },
        update: {},
      });
      // A supersedes edge is also a status change on the ADR it replaces.
      if (relationKind === 'supersedes') {
        await tx.adr.update({ where: { id: toId }, data: { status: 'superseded' } });
        await tx.adrRelation.upsert({
          where: {
            adrId_relatedAdrId_kind: { adrId: toId, relatedAdrId: fromId, kind: 'superseded_by' },
          },
          create: { adrId: toId, relatedAdrId: fromId, kind: 'superseded_by' },
          update: {},
        });
      }
    }

    await record(tx, {
      ...actor,
      action: 'create',
      entityType: fromType,
      entityId: fromId,
      entityHumanId: from,
      after: { event: 'link', to, kind },
    });

    return { from, to, kind, created: existing === null };
  });
}

export async function unlink(
  db: Db,
  actor: Actor,
  from: string,
  to: string,
  kind: ReferenceKind | 'extends',
): Promise<LinkResult> {
  const fromType = typeOf(from);
  const toType = typeOf(to);

  const [source, target] = await Promise.all([
    getByHumanId(db, from, { backlinks: false }),
    getByHumanId(db, to, { backlinks: false }),
  ]);
  const fromId = String(source.entity['id']);
  const toId = String(target.entity['id']);
  const referenceKind: ReferenceKind = kind === 'extends' ? 'relates' : kind;

  return db.$transaction(async (tx) => {
    const { count } = await tx.reference.deleteMany({
      where: { fromType, fromId, toType, toId, kind: referenceKind },
    });

    if (fromType === 'task' && toType === 'requirement') {
      await tx.taskRequirement.deleteMany({ where: { taskId: fromId, requirementId: toId } });
    }
    if (fromType === 'adr' && toType === 'adr') {
      await tx.adrRelation.deleteMany({ where: { adrId: fromId, relatedAdrId: toId } });
    }
    if (kind === 'depends_on') {
      await tx.taskDependency.deleteMany({ where: { taskId: fromId, dependsOnId: toId } });
    }

    await record(tx, {
      ...actor,
      action: 'delete',
      entityType: fromType,
      entityId: fromId,
      entityHumanId: from,
      // Recorded in full, because an unlink is what `POST /undo` has to be able to put back.
      before: { event: 'link', to, kind },
      after: { event: 'unlink', to, kind },
    });

    return { from, to, kind, created: false, removed: count > 0 } as LinkResult;
  });
}
