import { GROUP_PREFIX, GUIDELINE_PREFIX, parseAnyId, PROJECT_IDEA_PREFIX } from '@foreman/shared';
import type { Db } from '../db.js';
import type { EntityType } from '../generated/prisma/enums.js';
import { NotFound } from './errors.js';
import { findGroup, getGroup } from './groups.js';
import { screenByHumanId } from './screens.js';

/** How a dependency edge names the task at its other end. */
const EDGE = { humanId: true, title: true, status: true } as const;

/**
 * One entity by human ID, with what cites it.
 *
 * `BND-REQ-021` resolves with no other context — that is the whole argument of ADR-008 — so this is
 * the endpoint that argument pays for. The type segment says which table to look in, which means no
 * fan-out across nine of them for every lookup.
 */

/** The type segment of a human ID, to the entity it names. */
const BY_TYPE: Record<string, EntityType> = {
  REQ: 'requirement',
  T: 'task',
  P: 'phase',
  ADR: 'adr',
  D: 'decision',
  R: 'risk',
  // Every audit's findings share the entity; the prefix says which audit produced them.
  CR: 'finding',
  DA: 'finding',
  FR: 'finding',
  API: 'finding',
  AUD: 'audit',
  IDEA: 'idea',
  // A screen of a project's UI (FRM-REQ-189). Its detail carries every version; `foreman_get`
  // adds the current proposal and latest capture as images (FRM-REQ-198).
  SCR: 'screen',
  // The one entry whose ID carries no project code: a project idea belongs to no project, which
  // is the entire point of it (FRM-ADR-015).
  [PROJECT_IDEA_PREFIX]: 'project_idea',
  // The other codeless one: a guideline applies to every project and so belongs to none.
  [GUIDELINE_PREFIX]: 'guideline',
  // And a group, the family projects belong to (FRM-REQ-239): it comes back as the group, its
  // projects in order and the active guidelines that apply to it — `GET /api/groups/:id`'s shape.
  [GROUP_PREFIX]: 'group',
};

export interface EntityResult {
  readonly type: EntityType;
  readonly humanId: string;
  /** Null for a project idea, which is the only entity that belongs to no project. */
  readonly projectCode: string | null;
  readonly entity: Record<string, unknown>;
  /** What cites this: the reason the `reference` table exists. */
  readonly backlinks: readonly {
    readonly fromType: string;
    readonly humanId: string | null;
    readonly title: string;
    readonly kind: string;
  }[];
}

export async function getByHumanId(
  db: Db,
  humanId: string,
  options: { backlinks?: boolean } = {},
): Promise<EntityResult> {
  // `parseAnyId`, not `parseHumanId`: this is the one place that has to take both an ID that
  // names a project and the one kind that cannot.
  const parsed = parseAnyId(humanId);
  if (parsed === null) {
    // Not a lookup failure: an unprefixed ID is ambiguous by construction, and saying so is more
    // useful than "not found".
    throw new NotFound(
      `${humanId} is not a human ID Foreman issues (expected BND-REQ-021, PI-007, GL-004 or GRP-001)`,
    );
  }

  const type = BY_TYPE[parsed.type];
  if (type === undefined) throw new NotFound(`${humanId} names no kind of entity Foreman knows`);

  const found = await findOne(db, type, humanId);
  if (found === null) throw new NotFound(humanId);

  return {
    type,
    humanId,
    projectCode: parsed.code,
    entity: found.entity,
    backlinks: options.backlinks === false ? [] : await citations(db, type, found.id),
  };
}

async function findOne(
  db: Db,
  type: EntityType,
  humanId: string,
): Promise<{ id: string; entity: Record<string, unknown> } | null> {
  const where = { humanId, deletedAt: null };

  switch (type) {
    case 'requirement': {
      const row = await db.requirement.findFirst({
        where,
        include: {
          phase: { select: { humanId: true, name: true } },
          tasks: { select: { task: { select: { humanId: true, title: true, status: true } } } },
        },
      });
      return row === null
        ? null
        : { id: row.id, entity: { ...row, tasks: row.tasks.map((t) => t.task) } };
    }
    case 'task': {
      const row = await db.task.findFirst({
        where,
        include: {
          phase: { select: { humanId: true, name: true } },
          files: { select: { path: true } },
          requirements: {
            select: { requirement: { select: { humanId: true, statement: true } } },
          },
          dependsOn: { where: { dependsOn: { deletedAt: null } }, select: { dependsOn: { select: EDGE } } },
          dependedOnBy: { where: { task: { deletedAt: null } }, select: { task: { select: EDGE } } },
          // Where this shipped (FRM-T-006, SHP-REQ-088): newest first, capped — a task deployed
          // dozens of times over its life does not need the whole history in one call.
          deployments: {
            orderBy: { deployment: { deployedAt: 'desc' } },
            take: 20,
            select: {
              deployment: {
                select: { environment: true, imageSha: true, schemaRevision: true, deployedAt: true },
              },
            },
          },
        },
      });
      return row === null
        ? null
        : {
            id: row.id,
            entity: {
              ...row,
              files: row.files.map((f) => f.path),
              requirements: row.requirements.map((r) => r.requirement),
              // Both directions (FRM-REQ-181): what this waits on, and what waits on it.
              dependsOn: row.dependsOn.map((d) => d.dependsOn),
              dependedOnBy: row.dependedOnBy.map((d) => d.task),
              deployments: row.deployments.map((d) => d.deployment),
            },
          };
    }
    case 'phase': {
      const row = await db.phase.findFirst({
        where,
        include: {
          // The phase's whole dependency graph in one call (FRM-REQ-181): enough for a planner to
          // order the work into waves and keep two parallel tasks off the same file.
          tasks: {
            where: { deletedAt: null },
            orderBy: { sortOrder: 'asc' },
            select: {
              humanId: true,
              title: true,
              status: true,
              size: true,
              doneWhen: true,
              files: { select: { path: true } },
              dependsOn: {
                where: { dependsOn: { deletedAt: null } },
                select: { dependsOn: { select: { humanId: true } } },
              },
            },
          },
        },
      });
      return row === null
        ? null
        : {
            id: row.id,
            entity: {
              ...row,
              number: row.number.toString(),
              tasks: row.tasks.map((task) => ({
                ...task,
                files: task.files.map((f) => f.path),
                dependsOn: task.dependsOn.map((d) => d.dependsOn.humanId),
              })),
            },
          };
    }
    case 'adr': {
      const row = await db.adr.findFirst({
        where,
        include: {
          relations: { select: { kind: true, relatedAdr: { select: { humanId: true, title: true } } } },
        },
      });
      return row === null ? null : { id: row.id, entity: row };
    }
    case 'decision': {
      const row = await db.decision.findFirst({ where });
      return row === null ? null : { id: row.id, entity: row };
    }
    case 'risk': {
      const row = await db.risk.findFirst({ where });
      return row === null ? null : { id: row.id, entity: row };
    }
    case 'idea': {
      const row = await db.idea.findFirst({ where });
      return row === null ? null : { id: row.id, entity: row };
    }
    case 'project_idea': {
      const row = await db.projectIdea.findFirst({
        where,
        include: { project: { select: { code: true, name: true, lifecycle: true } } },
      });
      return row === null ? null : { id: row.id, entity: row };
    }
    case 'guideline': {
      const row = await db.guideline.findFirst({ where });
      return row === null ? null : { id: row.id, entity: row };
    }
    case 'group': {
      const row = await findGroup(db, humanId);
      return row === null ? null : { id: row.id, entity: { ...(await getGroup(db, humanId)) } };
    }
    case 'finding': {
      const row = await db.finding.findFirst({
        where,
        include: {
          requirement: { select: { humanId: true, statement: true } },
          adr: { select: { humanId: true, title: true } },
        },
      });
      return row === null ? null : { id: row.id, entity: row };
    }
    case 'screen':
      return screenByHumanId(db, humanId);
    case 'audit': {
      const row = await db.audit.findFirst({
        where,
        include: { findings: { select: { humanId: true, severity: true, status: true, title: true } } },
      });
      return row === null ? null : { id: row.id, entity: row };
    }
    default:
      return null;
  }
}

/** Everything that cites this entity, resolved to something readable. */
async function citations(db: Db, type: EntityType, id: string) {
  const references = await db.reference.findMany({
    where: { toType: type, toId: id },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return Promise.all(
    references.map(async (reference) => {
      const source = await findOneById(db, reference.fromType, reference.fromId);
      return {
        fromType: reference.fromType,
        humanId: source?.humanId ?? null,
        title: source?.title ?? '(deleted)',
        kind: reference.kind,
      };
    }),
  );
}

async function findOneById(
  db: Db,
  type: EntityType,
  id: string,
): Promise<{ humanId: string; title: string } | null> {
  switch (type) {
    case 'requirement': {
      const row = await db.requirement.findUnique({ where: { id } });
      return row === null ? null : { humanId: row.humanId, title: row.statement.slice(0, 120) };
    }
    case 'task': {
      const row = await db.task.findUnique({ where: { id } });
      return row === null ? null : { humanId: row.humanId, title: row.title };
    }
    case 'adr': {
      const row = await db.adr.findUnique({ where: { id } });
      return row === null ? null : { humanId: row.humanId, title: row.title };
    }
    case 'finding': {
      const row = await db.finding.findUnique({ where: { id } });
      return row === null ? null : { humanId: row.humanId, title: row.title };
    }
    case 'screen': {
      // A gap citing a DS requirement shows the screen in that requirement's backlinks (FRM-REQ-199).
      const row = await db.screen.findUnique({ where: { id } });
      return row === null ? null : { humanId: row.humanId, title: row.name };
    }
    case 'document_section': {
      const row = await db.documentSection.findUnique({
        where: { id },
        include: { document: { select: { title: true } } },
      });
      return row === null
        ? null
        : { humanId: row.key, title: `${row.document.title} — ${row.heading}` };
    }
    default:
      return null;
  }
}
