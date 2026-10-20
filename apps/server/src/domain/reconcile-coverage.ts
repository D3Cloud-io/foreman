import type { Db } from '../db.js';
import { record, type Actor, type TransactionClient } from './audit.js';

/**
 * Clean up the rows the old `link()` wrote for a link kind that did not own them (FRM-T-024).
 *
 * Until FRM-T-11.3 a link wrote a `task_requirement` row for *every* task→requirement kind, so a
 * `relates` or `violates` link counted as coverage, and an `extends` adr_relation for every
 * ADR→ADR kind but `supersedes`. An `extends` link was stored as a `relates` reference beside its
 * relation. FRM-T-11.3 stopped all three at the write; this removes what was already written, and
 * nothing it cannot prove came from there.
 *
 * **Three kinds of leftover, each with its own proof:**
 *
 * 1. A `task_requirement` row no `satisfies` reference backs. Removed only when a `relates` or
 *    `violates` reference for the pair says a non-satisfies link could have written it, and none of
 *    the other ways a row is written explains it: the task's creation (its `create` event's
 *    `requirements`), a task update that set `requirementIds` (an `update` event whose `after` has
 *    the row and whose `before` did not, or had an older one), or the importer. The importer leaves
 *    no audit trail, so a task with no creation event is the importer's (or the example seed's), and
 *    on such a task a row is the link's only when it is no older than the first relates or violates
 *    link on record for the pair: the importer's upsert never rewrites a row, so a row it wrote is
 *    older than any link made since. With no link on record, a row on an imported task is kept.
 * 2. An `extends` adr_relation with no `extends` reference but a `relates` or `violates` one. The
 *    FRM-T-11.3 backfill gave every relation an extends link or no link at all left behind its
 *    `extends` reference, so one without it is what a relates or violates link left. Kept when an
 *    extends link is on record anyway, or when nothing explains the relation.
 * 3. The `relates` twin of an old extends link: a `relates` reference beside an `extends` one for
 *    the same ADR pair, where the audit trail has an extends link written by the old code (its
 *    event records no `rows`) and no relates link or unlink at all. A relates link on record is a
 *    person's citation and stays.
 *
 * Every removal writes its own `audit_event`, carrying the removed row in `before` and the link
 * that would put it back in `after.restoreWith`. **A report is the same code as the write**: all of
 * it runs in one transaction, rolled back unless `write` is set, so the report is exactly what
 * `--write` would do. Idempotent: a second run removes nothing.
 */

export const RECONCILE_COVERAGE_ACTOR: Actor = { actor: 'reconcile-coverage', actorKind: 'system' };

/**
 * A row created within this long after a link event can be that link's. The old `link()` wrote the
 * row and its event in one transaction, which Prisma ends after five seconds by default.
 */
export const LINK_WINDOW_MS = 5_000;

export interface ReconciledPair {
  /** The task or ADR the row starts from. */
  readonly from: string;
  /** The requirement or ADR it points at. */
  readonly to: string;
  readonly reason: string;
}

export interface ReconcileSection {
  /** Rows the right reference backs, and so were never in question. */
  readonly backed: number;
  readonly removed: readonly ReconciledPair[];
  readonly kept: readonly ReconciledPair[];
}

export interface CoverageReconciliation {
  readonly written: boolean;
  readonly taskRequirements: ReconcileSection;
  readonly adrRelations: ReconcileSection;
  readonly relatesTwins: ReconcileSection;
}

export interface ReconcileCoverageOptions {
  readonly write: boolean;
  /** A project code, to reconcile one project; every project otherwise. */
  readonly project?: string | undefined;
}

class DryRun extends Error {}

interface LinkEventSeen {
  readonly entityId: string;
  readonly to: string;
  readonly kind: string;
  readonly action: 'link' | 'unlink';
  /** Written by the code before FRM-T-11.3, which did not record which rows it wrote. */
  readonly legacy: boolean;
  readonly createdAt: Date;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The link or unlink an audit event records, or null for any other event. */
function linkEventOf(event: {
  entityId: string;
  action: string;
  after: unknown;
  createdAt: Date;
}): LinkEventSeen | null {
  const after = asRecord(event.after);
  if (after === null) return null;
  const marker = after['event'];
  const to = after['to'];
  const kind = after['kind'];
  if (typeof to !== 'string' || typeof kind !== 'string') return null;
  const action =
    event.action === 'create' && marker === 'link'
      ? 'link'
      : event.action === 'delete' && marker === 'unlink'
        ? 'unlink'
        : null;
  if (action === null) return null;
  return { entityId: event.entityId, to, kind, action, legacy: !('rows' in after), createdAt: event.createdAt };
}

/** The `requirements` a task snapshot in an audit event carries, by requirement ID → row createdAt. */
function requirementsOf(snapshot: unknown): Map<string, string> | null {
  const rows = asRecord(snapshot)?.['requirements'];
  if (!Array.isArray(rows)) return null;
  const out = new Map<string, string>();
  for (const row of rows) {
    const fields = asRecord(row);
    const id = fields?.['requirementId'];
    const createdAt = fields?.['createdAt'];
    if (typeof id === 'string') out.set(id, typeof createdAt === 'string' ? createdAt : '');
  }
  return out;
}

const pairKey = (from: string, to: string) => `${from}\u0000${to}`;

const byPair = (a: ReconciledPair, b: ReconciledPair) =>
  a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from);

// ─── 1. task_requirement ───────────────────────────────────────────────────

async function reconcileTaskRequirements(
  tx: TransactionClient,
  project: string | undefined,
): Promise<ReconcileSection> {
  const rows = await tx.taskRequirement.findMany({
    where: project === undefined ? {} : { task: { project: { code: project } } },
    select: {
      taskId: true,
      requirementId: true,
      createdAt: true,
      task: { select: { humanId: true } },
      requirement: { select: { humanId: true } },
    },
  });
  if (rows.length === 0) return { backed: 0, removed: [], kept: [] };

  const taskIds = [...new Set(rows.map((row) => row.taskId))];
  const references = await tx.reference.findMany({
    where: {
      fromType: 'task',
      fromId: { in: taskIds },
      toType: 'requirement',
      kind: { in: ['satisfies', 'relates', 'violates'] },
    },
    select: { fromId: true, toId: true, kind: true },
  });
  const kindsFor = new Map<string, Set<string>>();
  for (const ref of references) {
    const key = pairKey(ref.fromId, ref.toId);
    const kinds = kindsFor.get(key) ?? new Set<string>();
    kinds.add(ref.kind);
    kindsFor.set(key, kinds);
  }

  const unbacked = rows.filter((row) => !kindsFor.get(pairKey(row.taskId, row.requirementId))?.has('satisfies'));
  const backed = rows.length - unbacked.length;
  if (unbacked.length === 0) return { backed, removed: [], kept: [] };

  // What the audit trail says about each task in question: how it was made, which rows a create or
  // an update wrote on purpose, and when a relates or violates link to each requirement was first made.
  const events = await tx.auditEvent.findMany({
    where: {
      entityType: 'task',
      entityId: { in: [...new Set(unbacked.map((row) => row.taskId))] },
      action: { in: ['create', 'update'] },
    },
    select: { entityId: true, action: true, before: true, after: true, createdAt: true },
  });
  const createdByApi = new Set<string>();
  const deliberate = new Map<string, 'creation' | 'update'>();
  const firstLink = new Map<string, Date>();
  for (const event of events) {
    const seen = linkEventOf(event);
    if (seen !== null) {
      if (seen.action === 'link' && (seen.kind === 'relates' || seen.kind === 'violates')) {
        const key = pairKey(seen.entityId, seen.to);
        const earliest = firstLink.get(key);
        if (earliest === undefined || seen.createdAt < earliest) firstLink.set(key, seen.createdAt);
      }
      continue;
    }
    if (event.action === 'create') {
      createdByApi.add(event.entityId);
      for (const requirementId of requirementsOf(event.after)?.keys() ?? []) {
        deliberate.set(pairKey(event.entityId, requirementId), 'creation');
      }
      continue;
    }
    // An update snapshots every row the task has, so only a row it added or rewrote is its own.
    const before = requirementsOf(event.before);
    const after = requirementsOf(event.after);
    if (after === null) continue;
    for (const [requirementId, createdAt] of after) {
      const was = before?.get(requirementId);
      const key = pairKey(event.entityId, requirementId);
      if ((was === undefined || was !== createdAt) && !deliberate.has(key)) deliberate.set(key, 'update');
    }
  }

  const removed: ReconciledPair[] = [];
  const kept: ReconciledPair[] = [];
  for (const row of unbacked) {
    const from = row.task.humanId;
    const to = row.requirement.humanId;
    const keep = (reason: string) => kept.push({ from, to, reason });

    const kinds = kindsFor.get(pairKey(row.taskId, row.requirementId));
    const backers = ['relates', 'violates'].filter((kind) => kinds?.has(kind) === true);
    const origin = deliberate.get(pairKey(row.taskId, row.requirementId));
    if (origin === 'creation') {
      keep('written at task creation (requirementIds)');
      continue;
    }
    if (origin === 'update') {
      keep('written by a task update (requirementIds)');
      continue;
    }
    if (backers.length === 0) {
      keep('unexplained: no satisfies, relates or violates reference and no write on record');
      continue;
    }
    const linked = firstLink.get(pairKey(row.taskId, to));
    if (linked !== undefined && row.createdAt.getTime() < linked.getTime() - LINK_WINDOW_MS) {
      keep(
        `older than the first ${backers.join('/')} link (${linked.toISOString()}): ` +
          (createdByApi.has(row.taskId) ? 'written some other way' : 'written by the importer'),
      );
      continue;
    }
    if (linked === undefined && !createdByApi.has(row.taskId)) {
      keep(`task written by the importer, and no ${backers.join('/')} link on record`);
      continue;
    }

    const reason = `backed only by ${backers.join(' and ')}`;
    const went = await tx.taskRequirement.deleteMany({
      where: { taskId: row.taskId, requirementId: row.requirementId },
    });
    if (went.count === 0) continue;
    await record(tx, {
      ...RECONCILE_COVERAGE_ACTOR,
      action: 'delete',
      entityType: 'task',
      entityId: row.taskId,
      entityHumanId: from,
      before: {
        taskRequirement: { taskId: row.taskId, requirementId: row.requirementId, createdAt: row.createdAt },
        requirement: to,
      },
      after: {
        event: 'reconcile',
        cause: 'reconcile-coverage',
        removed: 'task_requirement',
        to,
        reason,
        restoreWith: `link ${from} satisfies ${to}`,
      },
    });
    removed.push({ from, to, reason });
  }

  return { backed, removed: removed.sort(byPair), kept: kept.sort(byPair) };
}

// ─── 2 and 3. ADR → ADR ────────────────────────────────────────────────────

interface AdrGraph {
  readonly humanIdOf: Map<string, string>;
  /** Reference kinds by (from ADR id, to ADR id). */
  readonly kindsFor: Map<string, Map<string, { id: string; citedAs: string | null; createdAt: Date }>>;
  /** Link and unlink events by (from ADR id, to human ID). */
  readonly eventsFor: Map<string, LinkEventSeen[]>;
}

async function adrGraph(tx: TransactionClient, project: string | undefined): Promise<AdrGraph> {
  const adrs = await tx.adr.findMany({
    where: project === undefined ? {} : { project: { code: project } },
    select: { id: true, humanId: true },
  });
  const ids = adrs.map((adr) => adr.id);
  const humanIdOf = new Map(adrs.map((adr) => [adr.id, adr.humanId]));

  const references = await tx.reference.findMany({
    where: {
      fromType: 'adr',
      fromId: { in: ids },
      toType: 'adr',
      kind: { in: ['extends', 'relates', 'violates'] },
    },
    select: { id: true, fromId: true, toId: true, kind: true, citedAs: true, createdAt: true },
  });
  const kindsFor: AdrGraph['kindsFor'] = new Map();
  for (const ref of references) {
    const key = pairKey(ref.fromId, ref.toId);
    const kinds = kindsFor.get(key) ?? new Map<string, { id: string; citedAs: string | null; createdAt: Date }>();
    kinds.set(ref.kind, { id: ref.id, citedAs: ref.citedAs, createdAt: ref.createdAt });
    kindsFor.set(key, kinds);
  }

  // A target in another project still needs its human ID.
  const missing = [...new Set(references.map((ref) => ref.toId))].filter((id) => !humanIdOf.has(id));
  if (missing.length > 0) {
    for (const adr of await tx.adr.findMany({ where: { id: { in: missing } }, select: { id: true, humanId: true } })) {
      humanIdOf.set(adr.id, adr.humanId);
    }
  }

  const events = await tx.auditEvent.findMany({
    where: { entityType: 'adr', entityId: { in: ids }, action: { in: ['create', 'delete'] } },
    select: { entityId: true, action: true, after: true, createdAt: true },
  });
  const eventsFor: AdrGraph['eventsFor'] = new Map();
  for (const event of events) {
    const seen = linkEventOf(event);
    if (seen === null) continue;
    const key = pairKey(seen.entityId, seen.to);
    eventsFor.set(key, [...(eventsFor.get(key) ?? []), seen]);
  }

  return { humanIdOf, kindsFor, eventsFor };
}

async function reconcileAdrRelations(
  tx: TransactionClient,
  project: string | undefined,
  graph: AdrGraph,
): Promise<ReconcileSection> {
  const relations = await tx.adrRelation.findMany({
    where: { kind: 'extends', ...(project === undefined ? {} : { adr: { project: { code: project } } }) },
    select: {
      adrId: true,
      relatedAdrId: true,
      createdAt: true,
      adr: { select: { humanId: true } },
      relatedAdr: { select: { humanId: true } },
    },
  });

  let backed = 0;
  const removed: ReconciledPair[] = [];
  const kept: ReconciledPair[] = [];
  for (const relation of relations) {
    const from = relation.adr.humanId;
    const to = relation.relatedAdr.humanId;
    const kinds = graph.kindsFor.get(pairKey(relation.adrId, relation.relatedAdrId));
    if (kinds?.has('extends') === true) {
      backed += 1;
      continue;
    }
    const backers = ['relates', 'violates'].filter((kind) => kinds?.has(kind) === true);
    if (backers.length === 0) {
      kept.push({ from, to, reason: 'unexplained: no extends, relates or violates reference' });
      continue;
    }
    const events = graph.eventsFor.get(pairKey(relation.adrId, to)) ?? [];
    if (events.some((event) => event.action === 'link' && event.kind === 'extends')) {
      kept.push({ from, to, reason: 'an extends link is on record, but its extends reference is missing' });
      continue;
    }

    const reason = `left by a ${backers.join('/')} link; no extends reference`;
    const went = await tx.adrRelation.deleteMany({
      where: { adrId: relation.adrId, relatedAdrId: relation.relatedAdrId, kind: 'extends' },
    });
    if (went.count === 0) continue;
    await record(tx, {
      ...RECONCILE_COVERAGE_ACTOR,
      action: 'delete',
      entityType: 'adr',
      entityId: relation.adrId,
      entityHumanId: from,
      before: {
        adrRelation: {
          adrId: relation.adrId,
          relatedAdrId: relation.relatedAdrId,
          kind: 'extends',
          createdAt: relation.createdAt,
        },
        to,
      },
      after: {
        event: 'reconcile',
        cause: 'reconcile-coverage',
        removed: 'adr_relation',
        to,
        reason,
        restoreWith: `link ${from} extends ${to}`,
      },
    });
    removed.push({ from, to, reason });
  }

  return { backed, removed: removed.sort(byPair), kept: kept.sort(byPair) };
}

async function reconcileRelatesTwins(tx: TransactionClient, graph: AdrGraph): Promise<ReconcileSection> {
  const removed: ReconciledPair[] = [];
  const kept: ReconciledPair[] = [];

  for (const [key, kinds] of graph.kindsFor) {
    const relates = kinds.get('relates');
    if (relates === undefined || !kinds.has('extends')) continue;
    const [fromId = '', toId = ''] = key.split('\u0000');
    const from = graph.humanIdOf.get(fromId) ?? fromId;
    const to = graph.humanIdOf.get(toId) ?? toId;

    const events = graph.eventsFor.get(pairKey(fromId, to)) ?? [];
    if (events.some((event) => event.kind === 'relates')) {
      kept.push({ from, to, reason: 'a relates link is on record: a citation in its own right' });
      continue;
    }
    if (!events.some((event) => event.action === 'link' && event.kind === 'extends' && event.legacy)) {
      kept.push({ from, to, reason: 'no extends link from before FRM-T-11.3 on record to have written it' });
      continue;
    }

    const reason = 'the relates twin of an extends link; no relates link on record';
    const went = await tx.reference.deleteMany({ where: { id: relates.id, kind: 'relates' } });
    if (went.count === 0) continue;
    await record(tx, {
      ...RECONCILE_COVERAGE_ACTOR,
      action: 'delete',
      entityType: 'adr',
      entityId: fromId,
      entityHumanId: from,
      before: {
        reference: {
          id: relates.id,
          fromType: 'adr',
          fromId,
          toType: 'adr',
          toId,
          kind: 'relates',
          citedAs: relates.citedAs,
          createdAt: relates.createdAt,
        },
        to,
      },
      after: {
        event: 'reconcile',
        cause: 'reconcile-coverage',
        removed: 'reference',
        to,
        reason,
        restoreWith: `link ${from} relates ${to}`,
      },
    });
    removed.push({ from, to, reason });
  }

  // Twins whose pair is already clean are not worth a line; the count says they were looked at.
  return { backed: 0, removed: removed.sort(byPair), kept: kept.sort(byPair) };
}

export async function reconcileCoverage(
  db: Db,
  options: ReconcileCoverageOptions,
): Promise<CoverageReconciliation> {
  const project = options.project?.toUpperCase();
  let result: Omit<CoverageReconciliation, 'written'> | undefined;
  try {
    await db.$transaction(
      async (tx) => {
        const taskRequirements = await reconcileTaskRequirements(tx, project);
        // Read once, before either ADR pass changes anything: the two never touch the same pair.
        const graph = await adrGraph(tx, project);
        const adrRelations = await reconcileAdrRelations(tx, project, graph);
        const relatesTwins = await reconcileRelatesTwins(tx, graph);
        result = { taskRequirements, adrRelations, relatesTwins };
        if (!options.write) throw new DryRun();
      },
      { timeout: 120_000 },
    );
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
  }
  if (result === undefined) throw new Error('reconcile-coverage produced no result');
  return { written: options.write, ...result };
}
