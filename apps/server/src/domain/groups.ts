import {
  formatGroupId,
  GROUP_ID_RE,
  groupSlug,
  type GroupCreate,
  type GroupDetail,
  type GroupListing,
  type GroupProject,
  type GroupUpdate,
  type GroupWithProjects,
  type UngroupedEntry,
} from '@foreman/shared';
import type { Db } from '../db.js';
import { record, scrub, type Actor, type TransactionClient } from './audit.js';
import { Conflict, ConflictWith, Invalid, NotFound } from './errors.js';

/**
 * Groups — the families one Foreman holds (FRM-ADR-024, FRM-REQ-221 … FRM-REQ-227).
 *
 * A group partitions projects: `project.group_id` is one column, so a project is in at most one,
 * and a project in none is *Ungrouped* and listed last. Order is a position on each group and a
 * position on each project within its group (or among the ungrouped), and **positions are dense**:
 * always exactly 0..n-1, renumbered in the same transaction as every create, move, delete and undo
 * (`settleProjects`, `settleGroups`). A position is therefore an index, which is what lets an undo
 * put a project back "where it was" after others have come and gone. The migration backfilled the
 * existing projects in code order, and the two writers that insert a project row directly — the
 * importer's upsert and the example seed — settle it with `settleInserted`. A row written past
 * all of this (a test fixture) is healed by the next settle of its group, which orders by
 * position, then code.
 *
 * **Every write that reads or changes membership or order takes `lockGroups` before its first
 * read** — create, update, move, reorder, delete, soft delete and undo alike — and a write that
 * snapshots a project row also locks that row, because a lifecycle rollup takes it without the
 * group lock. Under READ COMMITTED a row read before the lock is a row another writer may have
 * replaced, and recording it as `before` is what broke the audit chain.
 *
 * Every write here takes one transaction-scoped advisory lock first. A name's uniqueness among
 * live groups, a slug's, and "the next position in this group" are all read-then-write, and a
 * soft-deleted group keeps its row, so no unique index can say them; serialising the few writes
 * that touch them is what can.
 *
 * Undo (FRM-REQ-225): a create, an update and a delete are ordinary entity events the generic undo
 * reverses, with the guards in `guardUndo` for what a group's row alone cannot see. A move is the
 * moved project's own `update`, so the project's undo reverses it, putting it back at its old
 * index (clamped) and closing up the group it leaves (`finishUndo`). A reorder is one event
 * holding every position it changed, and `undoReorder` puts them back — refused, like every undo,
 * when any of them has moved since. The renumbering a move or delete causes is recorded too, as a
 * reorder event naming its `cause`; undo refuses that one and points at the cause instead.
 */

type Client = Db | TransactionClient;

const GROUP_SELECT = {
  id: true,
  humanId: true,
  name: true,
  slug: true,
  description: true,
  siteUrl: true,
  accent: true,
  position: true,
  createdAt: true,
  updatedAt: true,
} as const;

const PROJECT_SELECT = {
  code: true,
  name: true,
  slug: true,
  lifecycle: true,
  pitch: true,
  groupId: true,
  groupPosition: true,
} as const;

/** Every group and project order write is serialised behind this. */
export async function lockGroups(tx: TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('foreman:project_group'))`;
}

async function nextSeq(tx: TransactionClient): Promise<number> {
  const rows = await tx.$queryRaw<{ seq: number }[]>`
    select nextval('project_group_seq')::int as seq
  `;
  const seq = rows[0]?.seq;
  if (seq === undefined) throw new Error('project_group_seq did not yield a value');
  return seq;
}

/** An empty string clears an optional field rather than storing '' as "written". */
const orNull = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim().length === 0 ? null : value.trim();

/** `GRP-001` or a slug, to the live group it names, or null. */
export async function findGroup(db: Client, ref: string) {
  const where = GROUP_ID_RE.test(ref)
    ? { humanId: ref, deletedAt: null }
    : { slug: ref.toLowerCase(), deletedAt: null };
  return db.projectGroup.findFirst({ where, select: GROUP_SELECT });
}

async function requireGroup(db: Client, ref: string) {
  const group = await findGroup(db, ref);
  if (group === null) throw new NotFound(`group ${ref}`);
  return group;
}

/**
 * The group a project write names, or 422: on a project the group is a field, so an unknown one
 * is a bad value for it rather than a missing resource.
 */
export async function groupForProject(tx: TransactionClient, ref: string) {
  const group = await findGroup(tx, ref);
  if (group === null) {
    throw new Invalid(`no group ${ref}`, [{ path: 'group', message: `${ref} is not a live group` }]);
  }
  return group;
}

/**
 * Renumber the live projects of one group — or the ungrouped, with `groupId = null` — to exactly
 * 0..n-1, in their current order (FRM-REQ-226). Positions are dense and unique, so a position is
 * an index, and "put it back where it was" still means something after other projects have come
 * and gone.
 *
 * `place` puts those projects, in the order given, at `index` (clamped; absent appends), and the
 * rest keep their relative order. The placed projects' own events record their positions; every
 * other project this shifts is recorded together in one reorder event marked with its `cause`,
 * which undo refuses in favour of the change that caused it. Returns that event's ID, if any.
 */
export async function settleProjects(
  tx: TransactionClient,
  actor: Actor,
  groupId: string | null,
  options: { cause: string; place?: { ids: readonly string[]; index?: number | undefined } },
): Promise<string | null> {
  const members = await tx.project.findMany({
    where: { groupId, deletedAt: null },
    orderBy: [{ groupPosition: 'asc' }, { code: 'asc' }],
    select: { id: true, code: true, groupPosition: true },
  });
  const placeIds = options.place?.ids ?? [];
  const rest = members.filter((m) => !placeIds.includes(m.id));
  const placed = placeIds
    .map((id) => members.find((m) => m.id === id))
    .filter((m) => m !== undefined);
  const at = Math.max(0, Math.min(options.place?.index ?? rest.length, rest.length));
  const sequence = [...rest.slice(0, at), ...placed, ...rest.slice(at)];

  const before: Record<string, number> = {};
  const after: Record<string, number> = {};
  let first: { id: string; code: string } | undefined;
  for (const [index, member] of sequence.entries()) {
    if (member.groupPosition === index) continue;
    await tx.project.update({ where: { id: member.id }, data: { groupPosition: index } });
    if (placeIds.includes(member.id)) continue;
    first ??= member;
    before[member.code] = member.groupPosition;
    after[member.code] = index;
  }
  if (first === undefined) return null;

  const group =
    groupId === null
      ? null
      : await tx.projectGroup.findUniqueOrThrow({
          where: { id: groupId },
          select: { id: true, humanId: true },
        });
  return recordReorder(tx, actor, {
    // On the group when there is one; the ungrouped have no row, so on the first project shifted.
    entityType: group === null ? 'project' : 'group',
    entityId: group?.id ?? first.id,
    entityHumanId: group?.humanId ?? first.code,
    scope: 'projects',
    group: group?.humanId ?? null,
    cause: options.cause,
    before,
    after,
  });
}

/**
 * For the two writers that insert a project row directly rather than through `createProject` —
 * the importer's upsert and the example seed — in a transaction of their own: the new project
 * goes to the end of its group's order (the ungrouped, for both) and the order is made dense.
 */
export async function settleInserted(
  db: Db,
  actor: Actor,
  projectId: string,
  cause: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockGroups(tx);
    const row = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { groupId: true } });
    await settleProjects(tx, actor, row.groupId, { cause, place: { ids: [projectId] } });
  });
}

/** The same for the groups themselves: positions exactly 0..n-1 among the live groups. */
export async function settleGroups(
  tx: TransactionClient,
  actor: Actor,
  options: { cause: string; place?: { id: string; index?: number | undefined } },
): Promise<string | null> {
  const groups = await tx.projectGroup.findMany({
    where: { deletedAt: null },
    orderBy: [{ position: 'asc' }, { seq: 'asc' }],
    select: { id: true, humanId: true, position: true },
  });
  const placedId = options.place?.id;
  const rest = groups.filter((g) => g.id !== placedId);
  const placed = groups.filter((g) => g.id === placedId);
  const at = Math.max(0, Math.min(options.place?.index ?? rest.length, rest.length));
  const sequence = [...rest.slice(0, at), ...placed, ...rest.slice(at)];

  const before: Record<string, number> = {};
  const after: Record<string, number> = {};
  let first: { id: string; humanId: string } | undefined;
  for (const [index, group] of sequence.entries()) {
    if (group.position === index) continue;
    await tx.projectGroup.update({ where: { id: group.id }, data: { position: index } });
    if (group.id === placedId) continue;
    first ??= group;
    before[group.humanId] = group.position;
    after[group.humanId] = index;
  }
  if (first === undefined) return null;
  return recordReorder(tx, actor, {
    entityType: 'group',
    entityId: first.id,
    entityHumanId: first.humanId,
    scope: 'groups',
    cause: options.cause,
    before,
    after,
  });
}

/** A live group whose name or slug a group would collide with, other than itself. */
async function clashOf(
  tx: Client,
  { name, slug, except }: { name?: string; slug?: string; except?: string },
): Promise<string | null> {
  const others = await tx.projectGroup.findMany({
    where: {
      deletedAt: null,
      ...(except === undefined ? {} : { id: { not: except } }),
      OR: [
        ...(name === undefined ? [] : [{ name: { equals: name, mode: 'insensitive' as const } }]),
        ...(slug === undefined ? [] : [{ slug }]),
      ],
    },
    select: { humanId: true, name: true, slug: true },
  });
  const hit = others[0];
  if (hit === undefined) return null;
  return name !== undefined && hit.name.toLowerCase() === name.toLowerCase()
    ? `a group named ${hit.name} already exists (${hit.humanId})`
    : `the slug ${hit.slug} is already ${hit.humanId}'s`;
}

// ─── Reads ─────────────────────────────────────────────────────────────────

function asProject(row: {
  code: string;
  name: string;
  slug: string;
  lifecycle: GroupProject['lifecycle'];
  pitch: string | null;
  groupPosition: number;
}): GroupProject {
  return {
    code: row.code,
    name: row.name,
    slug: row.slug,
    lifecycle: row.lifecycle,
    pitch: row.pitch,
    position: row.groupPosition,
  };
}

type GroupRow = NonNullable<Awaited<ReturnType<typeof findGroup>>>;

function asGroup(row: GroupRow) {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/**
 * Every live group in order, each with its projects in order, and the ungrouped last
 * (FRM-REQ-226). `counts.guidelines` is the active guidelines that apply to the group's projects —
 * those for every project, and those scoped to it.
 */
export async function listGroups(db: Client): Promise<GroupListing> {
  const [groups, projects, scoped, everywhere] = await Promise.all([
    db.projectGroup.findMany({
      where: { deletedAt: null },
      orderBy: [{ position: 'asc' }, { humanId: 'asc' }],
      select: GROUP_SELECT,
    }),
    db.project.findMany({
      where: { deletedAt: null },
      orderBy: [{ groupPosition: 'asc' }, { code: 'asc' }],
      select: PROJECT_SELECT,
    }),
    db.guidelineGroup.findMany({
      where: { guideline: { deletedAt: null, status: 'active', appliesTo: 'groups' } },
      select: { groupId: true },
    }),
    db.guideline.count({ where: { deletedAt: null, status: 'active', appliesTo: 'all' } }),
  ]);

  const members = new Map<string, GroupProject[]>(groups.map((g) => [g.id, []]));
  const ungrouped: GroupProject[] = [];
  for (const project of projects) {
    // A project whose group is gone is listed as ungrouped rather than lost: the delete refuses
    // while a group holds projects, so this is a guard, not a state anything writes.
    const list = project.groupId === null ? undefined : members.get(project.groupId);
    (list ?? ungrouped).push(asProject(project));
  }

  const items: GroupWithProjects[] = groups.map((group) => {
    const list = members.get(group.id) ?? [];
    return {
      ...asGroup(group),
      projects: list,
      counts: {
        projects: list.length,
        guidelines: everywhere + scoped.filter((s) => s.groupId === group.id).length,
      },
    };
  });

  const entry: UngroupedEntry = {
    humanId: null,
    name: 'Ungrouped',
    slug: 'ungrouped',
    projects: ungrouped,
    counts: { projects: ungrouped.length },
  };
  return { items, ungrouped: entry, total: items.length };
}

/** One group by `GRP-001` or slug, with its projects and the active guidelines that apply. */
export async function getGroup(db: Db, ref: string): Promise<GroupDetail> {
  const group = await requireGroup(db, ref);
  const [projects, guidelines] = await Promise.all([
    db.project.findMany({
      where: { groupId: group.id, deletedAt: null },
      orderBy: [{ groupPosition: 'asc' }, { code: 'asc' }],
      select: PROJECT_SELECT,
    }),
    db.guideline.findMany({
      where: {
        deletedAt: null,
        status: 'active',
        OR: [{ appliesTo: 'all' }, { appliesTo: 'groups', groups: { some: { groupId: group.id } } }],
      },
      orderBy: [{ area: 'asc' }, { seq: 'asc' }],
      select: { humanId: true, title: true, decision: true, appliesTo: true },
    }),
  ]);
  return {
    ...asGroup(group),
    projects: projects.map(asProject),
    counts: { projects: projects.length, guidelines: guidelines.length },
    guidelines,
  };
}

// ─── Writes ────────────────────────────────────────────────────────────────

export async function createGroup(db: Db, actor: Actor, input: GroupCreate) {
  const slug = groupSlug(input.name);
  return db.$transaction(async (tx) => {
    await lockGroups(tx);
    const clash = await clashOf(tx, { name: input.name, slug });
    if (clash !== null) throw new Conflict(clash);

    const last = await tx.projectGroup.aggregate({
      where: { deletedAt: null },
      _max: { position: true },
    });
    const seq = await nextSeq(tx);
    const group = await tx.projectGroup.create({
      data: {
        humanId: formatGroupId(seq),
        seq,
        name: input.name,
        slug,
        description: orNull(input.description),
        siteUrl: orNull(input.siteUrl),
        ...(input.accent === undefined ? {} : { accent: input.accent }),
        // Appended: a new family goes below the ones already there until somebody moves it.
        position: last._max.position === null ? 0 : last._max.position + 1,
      },
      select: { id: true, humanId: true },
    });
    const shift = await settleGroups(tx, actor, { cause: `${group.humanId} created`, place: { id: group.id } });
    const created = await tx.projectGroup.findUniqueOrThrow({ where: { id: group.id }, select: GROUP_SELECT });
    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'group',
      entityId: created.id,
      entityHumanId: created.humanId,
      after: created,
    });
    // The events, as a move answers them, so the console's toast can offer Undo (FRM-T-17.3).
    return { ...asGroup(created), auditEventIds: [...(shift === null ? [] : [shift]), event] };
  });
}

/**
 * The fields a group's update event records. Not `position`: order is changed by a reorder, which
 * records its own event, and a snapshot carrying it would make every later reorder look like an
 * edit the rename's undo would discard.
 */
function editable(row: GroupRow): Omit<GroupRow, 'position'> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== 'position'),
  ) as Omit<GroupRow, 'position'>;
}

export async function updateGroup(db: Db, actor: Actor, ref: string, input: GroupUpdate) {
  return db.$transaction(async (tx) => {
    await lockGroups(tx);
    const before = await requireGroup(tx, ref);
    if (input.name !== undefined && input.name.toLowerCase() !== before.name.toLowerCase()) {
      // The slug stays: it is in every link to the group. Only the name is checked.
      const clash = await clashOf(tx, { name: input.name, except: before.id });
      if (clash !== null) throw new Conflict(clash);
    }
    const after = await tx.projectGroup.update({
      where: { id: before.id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: orNull(input.description) }),
        ...(input.siteUrl === undefined ? {} : { siteUrl: orNull(input.siteUrl) }),
        ...(input.accent === undefined ? {} : { accent: input.accent }),
      },
      select: GROUP_SELECT,
    });
    const event = await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'group',
      entityId: after.id,
      entityHumanId: after.humanId,
      before: editable(before),
      after: editable(after),
    });
    return { ...asGroup(after), auditEventIds: [event] };
  });
}

/** Live projects in a group, and live guidelines that name it: what a delete must not orphan. */
async function holdings(tx: Client, groupId: string) {
  const [projects, guidelines] = await Promise.all([
    tx.project.findMany({
      where: { groupId, deletedAt: null },
      orderBy: [{ groupPosition: 'asc' }, { code: 'asc' }],
      select: { code: true },
    }),
    tx.guideline.findMany({
      where: { deletedAt: null, groups: { some: { groupId } } },
      orderBy: { seq: 'asc' },
      select: { humanId: true },
    }),
  ]);
  return { projects: projects.map((p) => p.code), guidelines: guidelines.map((g) => g.humanId) };
}

function refuseHeld(humanId: string, held: { projects: string[]; guidelines: string[] }, verb: string) {
  if (held.projects.length === 0 && held.guidelines.length === 0) return;
  const reasons = [
    ...(held.projects.length === 0
      ? []
      : [`it still holds ${held.projects.join(', ')} — move them to another group or to Ungrouped first`]),
    ...(held.guidelines.length === 0
      ? []
      : [`${held.guidelines.join(', ')} ${held.guidelines.length === 1 ? 'applies' : 'apply'} to it — change their scope first`]),
  ];
  throw new ConflictWith(`${humanId} cannot be ${verb}: ${reasons.join('; ')}`, held);
}

/**
 * Soft-delete an empty group (FRM-REQ-227). One that still holds projects is refused, naming
 * them; so is one a guideline is scoped to, because a guideline may never name a deleted group.
 */
export async function deleteGroup(db: Db, actor: Actor, ref: string): Promise<string[]> {
  return db.$transaction(async (tx) => {
    await lockGroups(tx);
    const found = await requireGroup(tx, ref);
    refuseHeld(found.humanId, await holdings(tx, found.id), 'deleted');

    const before = await tx.projectGroup.findUniqueOrThrow({ where: { id: found.id } });
    await tx.projectGroup.update({ where: { id: found.id }, data: { deletedAt: new Date() } });
    const event = await record(tx, {
      ...actor,
      action: 'delete',
      entityType: 'group',
      entityId: found.id,
      entityHumanId: found.humanId,
      before,
      after: { deleted: true },
    });
    // The groups below it close the gap, so positions stay 0..n-1.
    const shift = await settleGroups(tx, actor, { cause: `${found.humanId} deleted` });
    // The delete's own event first, then the renumbering it caused (FRM-T-18.3).
    return [event, ...(shift === null ? [] : [shift])];
  });
}

// ─── Order ─────────────────────────────────────────────────────────────────

/** A reorder's event: every position it changed, keyed by GRP- ID or project code. */
interface ReorderSnapshot {
  readonly event: 'reorder';
  readonly scope: 'groups' | 'projects';
  /** For a projects reorder: the group, or null for the ungrouped. */
  readonly group?: string | null;
  /** A renumbering another change made — a move, a delete, an undo — names it here. */
  readonly cause?: string;
  readonly positions: Readonly<Record<string, number>>;
}

/** The same set, each once: anything else is refused naming what is missing and what is extra. */
function assertSameSet(given: readonly string[], current: readonly string[], what: string, path: string) {
  const have = new Set(current);
  const want = new Set(given);
  const missing = current.filter((key) => !want.has(key));
  const extra = given.filter((key) => !have.has(key));
  if (missing.length === 0 && extra.length === 0) return;
  throw new Invalid(`the order must name every ${what} exactly once`, [
    ...(missing.length === 0 ? [] : [{ path, message: `missing: ${missing.join(', ')}` }]),
    ...(extra.length === 0 ? [] : [{ path, message: `not ${what}s here: ${extra.join(', ')}` }]),
  ]);
}

/** Set every group's position to its index in `order` (FRM-REQ-226). */
export async function reorderGroups(db: Db, actor: Actor, order: readonly string[]) {
  const auditEventIds = await db.$transaction(async (tx) => {
    await lockGroups(tx);
    const groups = await tx.projectGroup.findMany({
      where: { deletedAt: null },
      select: { id: true, humanId: true, position: true },
    });
    assertSameSet(order, groups.map((g) => g.humanId), 'group', 'order');

    const byId = new Map(groups.map((g) => [g.humanId, g]));
    const before: Record<string, number> = {};
    const after: Record<string, number> = {};
    for (const [index, humanId] of order.entries()) {
      const group = byId.get(humanId);
      if (group === undefined || group.position === index) continue;
      before[humanId] = group.position;
      after[humanId] = index;
      await tx.projectGroup.update({ where: { id: group.id }, data: { position: index } });
    }
    const first = byId.get(order[0] ?? '');
    if (first === undefined || Object.keys(after).length === 0) return [];
    return [
      await recordReorder(tx, actor, {
        entityType: 'group',
        entityId: first.id,
        entityHumanId: first.humanId,
        scope: 'groups',
        before,
        after,
      }),
    ];
  });
  return { ...(await listGroups(db)), auditEventIds };
}

async function recordReorder(
  tx: TransactionClient,
  actor: Actor,
  input: {
    entityType: 'group' | 'project';
    entityId: string;
    entityHumanId: string;
    scope: 'groups' | 'projects';
    group?: string | null;
    /** Set when this renumbering is the consequence of another change, which is what undo reverses. */
    cause?: string;
    before: Record<string, number>;
    after: Record<string, number>;
  },
): Promise<string> {
  const base = {
    event: 'reorder' as const,
    scope: input.scope,
    ...(input.scope === 'projects' ? { group: input.group ?? null } : {}),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  };
  return record(tx, {
    ...actor,
    action: 'update',
    entityType: input.entityType,
    entityId: input.entityId,
    entityHumanId: input.entityHumanId,
    before: { ...base, positions: input.before } satisfies ReorderSnapshot,
    after: { ...base, positions: input.after } satisfies ReorderSnapshot,
  });
}

/** `null` for the ungrouped, else the live group. */
async function target(tx: TransactionClient, ref: string | null) {
  return ref === null ? null : requireGroup(tx, ref);
}

/** Set every project's position in a group (or among the ungrouped) to its index in `order`. */
export async function reorderProjects(
  db: Db,
  actor: Actor,
  ref: string | null,
  order: readonly string[],
) {
  const auditEventIds = await db.$transaction(async (tx) => {
    await lockGroups(tx);
    const group = await target(tx, ref);
    const members = await tx.project.findMany({
      where: { groupId: group?.id ?? null, deletedAt: null },
      select: { id: true, code: true, groupPosition: true },
    });
    assertSameSet(order, members.map((p) => p.code), `project in ${group?.humanId ?? 'Ungrouped'}`, 'order');

    const byCode = new Map(members.map((p) => [p.code, p]));
    const before: Record<string, number> = {};
    const after: Record<string, number> = {};
    for (const [index, code] of order.entries()) {
      const project = byCode.get(code);
      if (project === undefined || project.groupPosition === index) continue;
      before[code] = project.groupPosition;
      after[code] = index;
      await tx.project.update({ where: { id: project.id }, data: { groupPosition: index } });
    }
    if (Object.keys(after).length === 0) return [];
    const firstProject = byCode.get(order[0] ?? '');
    return [
      await recordReorder(tx, actor, {
        // On the group when there is one; the ungrouped have no row, so on their first project.
        entityType: group === null ? 'project' : 'group',
        entityId: group?.id ?? firstProject?.id ?? '',
        entityHumanId: group?.humanId ?? firstProject?.code ?? '',
        scope: 'projects',
        group: group?.humanId ?? null,
        before,
        after,
      }),
    ];
  });
  return { ...(await listGroups(db)), auditEventIds };
}

/**
 * Move projects into a group, or to the ungrouped with `ref = null` — out of whichever group held
 * them, since a project is in at most one (FRM-REQ-223).
 *
 * Each moved project is its own `update` event with the whole row before and after, both read
 * inside the lock, so the project's undo reverses the move (FRM-REQ-225). Without `position` the
 * arrivals are appended in the order given and a project already in the group keeps its place;
 * with one, every project named goes there. Both ends are renumbered 0..n-1 in the same
 * transaction, and the projects that shifts are recorded as one reorder event per group.
 */
export async function moveProjects(
  db: Db,
  actor: Actor,
  ref: string | null,
  codes: readonly string[],
  position?: number,
) {
  const auditEventIds = await db.$transaction(async (tx) => {
    await lockGroups(tx);
    const group = await target(tx, ref);
    const groupId = group?.id ?? null;

    // The rows too, in code order so two movers can never wait on each other: a lifecycle rollup
    // takes a project's row without the group lock, and `before` must be what it left.
    await tx.$queryRaw`SELECT id FROM project WHERE code = ANY(${[...codes].sort()}::text[]) AND deleted_at IS NULL ORDER BY code FOR UPDATE`;
    const moving = await tx.project.findMany({ where: { code: { in: [...codes] }, deletedAt: null } });
    const unknown = codes.filter((code) => !moving.some((p) => p.code === code));
    if (unknown.length > 0) {
      throw new Invalid(`no project ${unknown.join(', ')}`, [
        { path: 'projects', message: `not live projects: ${unknown.join(', ')}` },
      ]);
    }
    const byCode = new Map(moving.map((p) => [p.code, p]));
    const ordered = codes.map((code) => byCode.get(code)).filter((p) => p !== undefined);
    const arriving = ordered.filter((p) => p.groupId !== groupId);
    const sources = [...new Set(arriving.map((p) => p.groupId))];

    for (const project of arriving) {
      await tx.project.update({ where: { id: project.id }, data: { groupId } });
    }
    const cause = `${codes.join(', ')} moved to ${group?.humanId ?? 'Ungrouped'}`;
    const shifts = [
      await settleProjects(tx, actor, groupId, {
        cause,
        place: {
          ids: (position === undefined ? arriving : ordered).map((p) => p.id),
          index: position,
        },
      }),
    ];
    for (const source of sources) shifts.push(await settleProjects(tx, actor, source, { cause }));

    const events: string[] = [];
    for (const before of ordered) {
      const after = await tx.project.findUniqueOrThrow({ where: { id: before.id } });
      if (after.groupId === before.groupId && after.groupPosition === before.groupPosition) continue;
      events.push(
        await record(tx, {
          ...actor,
          action: 'update',
          entityType: 'project',
          entityId: before.id,
          entityHumanId: before.code,
          before,
          after,
        }),
      );
    }
    return [...events, ...shifts.filter((id) => id !== null)];
  });
  return { ...(await listGroups(db)), auditEventIds };
}

// ─── Undo ──────────────────────────────────────────────────────────────────

export function isReorderEvent(after: Record<string, unknown> | null): boolean {
  return after?.['event'] === 'reorder';
}

type AuditEventRow = NonNullable<Awaited<ReturnType<Db['auditEvent']['findUnique']>>>;

function positionsOf(snapshot: unknown): Record<string, number> {
  const positions = (snapshot as { positions?: unknown } | null)?.positions;
  if (typeof positions !== 'object' || positions === null) return {};
  return Object.fromEntries(
    Object.entries(positions as Record<string, unknown>).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  );
}

/**
 * Put back every position a reorder changed (FRM-REQ-226) — refused, naming them, when any of
 * them has moved since or is no longer where the reorder left it.
 */
export async function undoReorder(db: Db, actor: Actor, event: AuditEventRow) {
  const after = event.after as Record<string, unknown> | null;
  const scope = after?.['scope'];
  const restore = positionsOf(event.before);
  const left = positionsOf(after);
  const cause = after?.['cause'];
  if (typeof cause === 'string') {
    // Positions are dense, so a renumbering is part of the change that made it: reversing it
    // alone would leave two projects in one place. The change it followed is what to undo.
    throw new Conflict(`that renumbering followed a change (${cause}); undo that change instead`);
  }

  return db.$transaction(async (tx) => {
    await lockGroups(tx);
    const claimed = await tx.auditEvent.updateMany({
      where: { id: event.id, undoneAt: null },
      data: { undoneAt: new Date() },
    });
    if (claimed.count === 0) throw new Conflict('that change has already been undone');

    const drifted: string[] = [];
    if (scope === 'groups') {
      const rows = await tx.projectGroup.findMany({
        where: { humanId: { in: Object.keys(left) }, deletedAt: null },
        select: { id: true, humanId: true, position: true },
      });
      for (const [humanId, position] of Object.entries(left)) {
        const row = rows.find((r) => r.humanId === humanId);
        if (row === undefined) drifted.push(`${humanId} has been deleted`);
        else if (row.position !== position) drifted.push(`${humanId} has moved`);
      }
      if (drifted.length > 0) {
        throw new Conflict(`that reorder cannot be undone: ${drifted.join(', ')} since`);
      }
      for (const row of rows) {
        const position = restore[row.humanId];
        if (position !== undefined) {
          await tx.projectGroup.update({ where: { id: row.id }, data: { position } });
        }
      }
    } else {
      const groupRef = after?.['group'];
      let groupId: string | null = null;
      if (typeof groupRef === 'string') {
        const group = await findGroup(tx, groupRef);
        if (group === null) {
          throw new Conflict(`that reorder cannot be undone: ${groupRef} has been deleted since`);
        }
        groupId = group.id;
      }
      const rows = await tx.project.findMany({
        where: { code: { in: Object.keys(left) }, deletedAt: null },
        select: { id: true, code: true, groupId: true, groupPosition: true },
      });
      for (const [code, position] of Object.entries(left)) {
        const row = rows.find((r) => r.code === code);
        if (row === undefined) drifted.push(`${code} has been deleted`);
        else if (row.groupId !== groupId) drifted.push(`${code} has changed group`);
        else if (row.groupPosition !== position) drifted.push(`${code} has moved`);
      }
      if (drifted.length > 0) {
        throw new Conflict(`that reorder cannot be undone: ${drifted.join(', ')} since`);
      }
      for (const row of rows) {
        const position = restore[row.code];
        if (position !== undefined) {
          await tx.project.update({ where: { id: row.id }, data: { groupPosition: position } });
        }
      }
    }

    const reversalId = await record(tx, {
      ...actor,
      action: 'undo',
      entityType: event.entityType,
      entityId: event.entityId,
      ...(event.entityHumanId === null ? {} : { entityHumanId: event.entityHumanId }),
      before: after,
      after: event.before,
    });
    await tx.auditEvent.update({ where: { id: event.id }, data: { undoneByEventId: reversalId } });
    return {
      undid: event.id,
      action: event.action,
      entityType: event.entityType,
      entityHumanId: event.entityHumanId,
      reversalEventId: reversalId,
    };
  });
}

/**
 * What a generic undo of a group, a project or a guideline must check that the row alone cannot
 * show: the groups around it. Called inside the undo's transaction, which took the group lock
 * before reading anything, before it writes.
 *
 * - A group's creation undone soft-deletes it, so it is refused while it holds projects or a
 *   guideline names it — the same rule as a delete (FRM-REQ-227).
 * - A group's deletion undone restores it, refused when a live group has since taken its name or
 *   slug; an update undone, when its old name has since been taken.
 * - A project's change undone, refused when it would put the project back into a group deleted
 *   since — so undoing a move never lands a project somewhere that is gone.
 * - A guideline's change undone, refused when its groups have changed since, or it would name a
 *   deleted group (FRM-REQ-235).
 */
export async function guardUndo(
  tx: TransactionClient,
  input: {
    type: string;
    action: string;
    current: Record<string, unknown>;
    data: Record<string, unknown>;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  },
): Promise<void> {
  // The caller holds the group lock, taken before it read `current`.
  const { type, action, current, data, before, after } = input;

  if (type === 'group') {
    const id = String(current['id']);
    const humanId = String(current['humanId']);
    if (action === 'create') {
      refuseHeld(humanId, await holdings(tx, id), 'removed by undoing its creation');
    }
    if (action === 'delete') {
      const clash = await clashOf(tx, {
        name: String(current['name']),
        slug: String(current['slug']),
        except: id,
      });
      if (clash !== null) throw new Conflict(`that deletion cannot be undone: ${clash}`);
    }
    if ((action === 'update' || action === 'restore') && typeof data['name'] === 'string') {
      const clash = await clashOf(tx, { name: data['name'], except: id });
      if (clash !== null) throw new Conflict(`that change cannot be undone: ${clash}`);
    }
    return;
  }

  if (type === 'project') {
    if (action === 'create') return;
    const groupId = 'groupId' in data ? data['groupId'] : current['groupId'];
    if (typeof groupId !== 'string') return;
    const group = await tx.projectGroup.findUnique({
      where: { id: groupId },
      select: { humanId: true, deletedAt: true },
    });
    if (group === null || group.deletedAt !== null) {
      throw new Conflict(
        `that change cannot be undone: it would put ${String(current['code'])} back in ` +
          `${group?.humanId ?? 'a group'}, which has been deleted since`,
      );
    }
    return;
  }

  if (type === 'guideline') {
    const id = String(current['id']);
    const now = await tx.guidelineGroup.findMany({
      where: { guidelineId: id },
      select: { group: { select: { humanId: true, deletedAt: true } } },
    });
    if (action === 'delete') {
      const gone = now.filter((row) => row.group.deletedAt !== null).map((row) => row.group.humanId);
      if (gone.length > 0) {
        throw new Conflict(
          `that deletion cannot be undone: the guideline applies to ${gone.join(', ')}, deleted since`,
        );
      }
      return;
    }
    if (action !== 'update' && action !== 'restore') return;
    const left = after?.['groups'];
    if (Array.isArray(left)) {
      const sorted = (list: readonly unknown[]) => JSON.stringify(list.map(String).sort());
      if (sorted(now.map((row) => row.group.humanId)) !== sorted(left)) {
        throw new Conflict(
          "that change cannot be undone: the guideline's groups have changed since, and " +
            'restoring would discard the later edit',
        );
      }
    }
    const wanted = before?.['groups'];
    if (Array.isArray(wanted) && wanted.length > 0) {
      const live = await tx.projectGroup.findMany({
        where: { humanId: { in: wanted.map(String) }, deletedAt: null },
        select: { humanId: true },
      });
      const gone = wanted.map(String).filter((h) => !live.some((g) => g.humanId === h));
      if (gone.length > 0) {
        throw new Conflict(
          `that change cannot be undone: it would scope the guideline to ${gone.join(', ')}, deleted since`,
        );
      }
    }
  }
}

/**
 * After the undo has written the row back, everything around it is settled.
 *
 * - A guideline's groups, which are rows rather than a column, are put back with its scope.
 * - A project whose group or place the event changed goes back to its old index in its old group,
 *   clamped and shifting the others, and the group it leaves closes up. A project whose creation
 *   is undone leaves its group's order; one whose deletion is undone rejoins it where it was.
 * - A group's creation undone closes the gap it leaves; its deletion undone rejoins where it was.
 */
export async function finishUndo(
  tx: TransactionClient,
  actor: Actor,
  input: {
    type: string;
    action: string;
    entityId: string;
    current: Record<string, unknown>;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  },
): Promise<void> {
  const { type, action, entityId, current, before, after } = input;
  const named = current['humanId'] ?? current['code'];
  const cause = `undo of a change to ${typeof named === 'string' ? named : entityId}`;

  if (type === 'guideline' && (action === 'update' || action === 'restore')) {
    const wanted = before?.['groups'];
    if (!Array.isArray(wanted)) return;
    const groups = await tx.projectGroup.findMany({
      where: { humanId: { in: wanted.map(String) }, deletedAt: null },
      select: { id: true },
    });
    await tx.guidelineGroup.deleteMany({ where: { guidelineId: entityId } });
    if (groups.length > 0) {
      await tx.guidelineGroup.createMany({
        data: groups.map((g) => ({ guidelineId: entityId, groupId: g.id })),
      });
    }
    return;
  }

  if (type === 'project') {
    const was = typeof current['groupId'] === 'string' ? current['groupId'] : null;
    const now = await tx.project.findUniqueOrThrow({
      where: { id: entityId },
      select: { groupId: true },
    });
    if (action === 'create') {
      await settleProjects(tx, actor, was, { cause });
      return;
    }
    let index: number | undefined;
    if (action === 'delete') {
      index = Number(current['groupPosition']);
    } else if (
      (action === 'update' || action === 'restore') &&
      before !== null &&
      (JSON.stringify(before['groupId']) !== JSON.stringify(after?.['groupId']) ||
        before['groupPosition'] !== after?.['groupPosition'])
    ) {
      index = Number(before['groupPosition']);
    }
    if (index === undefined) return;
    await settleProjects(tx, actor, now.groupId, {
      cause,
      place: { ids: [entityId], index: Number.isFinite(index) ? index : undefined },
    });
    if (was !== now.groupId) await settleProjects(tx, actor, was, { cause });
    return;
  }

  if (type === 'group') {
    if (action === 'create') await settleGroups(tx, actor, { cause });
    if (action === 'delete') {
      const index = Number(current['position']);
      await settleGroups(tx, actor, {
        cause,
        place: { id: entityId, index: Number.isFinite(index) ? index : undefined },
      });
    }
  }
}

/**
 * The fields of a snapshot an undo neither compares nor writes back.
 *
 * Positions are derived — always exactly 0..n-1 — so a project's `groupPosition` and a group's
 * `position` are never compared and never restored raw: `finishUndo` puts the row back at its old
 * index instead. A project's `groupId` is left alone unless the event changed it, so a rename
 * stays undoable after the project has been moved.
 */
export function derivedFields(
  type: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Set<string> {
  if (type === 'group') return new Set(['position']);
  if (type !== 'project') return new Set();
  const fields = new Set(['groupPosition']);
  if (JSON.stringify(scrub(before?.['groupId'])) === JSON.stringify(scrub(after?.['groupId']))) {
    fields.add('groupId');
  }
  return fields;
}
