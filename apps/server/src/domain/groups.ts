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
 * position on each project within its group (or among the ungrouped); ties are broken by code, so
 * projects written before groups existed — all at position 0 — list exactly as they used to.
 *
 * Every write here takes one transaction-scoped advisory lock first. A name's uniqueness among
 * live groups, a slug's, and "the next position in this group" are all read-then-write, and a
 * soft-deleted group keeps its row, so no unique index can say them; serialising the few writes
 * that touch them is what can.
 *
 * Undo (FRM-REQ-225): a create, an update and a delete are ordinary entity events the generic undo
 * reverses, with the guards in `guardUndo` for what a group's row alone cannot see. A move is the
 * moved project's own `update`, so the project's undo reverses it. A reorder is one event holding
 * every position it changed, before and after, and `undoReorder` puts them back — refused, like
 * every undo, when any of them has moved since.
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

/** The position after the last project in a group, or among the ungrouped. */
export async function nextGroupPosition(tx: TransactionClient, groupId: string | null): Promise<number> {
  const last = await tx.project.aggregate({
    where: { groupId, deletedAt: null },
    _max: { groupPosition: true },
  });
  const max = last._max.groupPosition;
  return max === null ? 0 : max + 1;
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
      select: GROUP_SELECT,
    });
    await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'group',
      entityId: group.id,
      entityHumanId: group.humanId,
      after: group,
    });
    return asGroup(group);
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
    await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'group',
      entityId: after.id,
      entityHumanId: after.humanId,
      before: editable(before),
      after: editable(after),
    });
    return asGroup(after);
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
export async function deleteGroup(db: Db, actor: Actor, ref: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockGroups(tx);
    const found = await requireGroup(tx, ref);
    refuseHeld(found.humanId, await holdings(tx, found.id), 'deleted');

    const before = await tx.projectGroup.findUniqueOrThrow({ where: { id: found.id } });
    await tx.projectGroup.update({ where: { id: found.id }, data: { deletedAt: new Date() } });
    await record(tx, {
      ...actor,
      action: 'delete',
      entityType: 'group',
      entityId: found.id,
      entityHumanId: found.humanId,
      before,
      after: { deleted: true },
    });
  });
}

// ─── Order ─────────────────────────────────────────────────────────────────

/** A reorder's event: every position it changed, keyed by GRP- ID or project code. */
interface ReorderSnapshot {
  readonly event: 'reorder';
  readonly scope: 'groups' | 'projects';
  /** For a projects reorder: the group, or null for the ungrouped. */
  readonly group?: string | null;
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
    before: Record<string, number>;
    after: Record<string, number>;
  },
): Promise<string> {
  const base = {
    event: 'reorder' as const,
    scope: input.scope,
    ...(input.scope === 'projects' ? { group: input.group ?? null } : {}),
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
 * Each moved project is its own `update` event with the whole row before and after, so the
 * project's undo reverses the move (FRM-REQ-225). Without `position` they are appended, in the
 * order given. With one, the group is renumbered around them, and the projects already there that
 * shift are recorded together as one reorder event.
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

    const moving = await tx.project.findMany({ where: { code: { in: [...codes] }, deletedAt: null } });
    const unknown = codes.filter((code) => !moving.some((p) => p.code === code));
    if (unknown.length > 0) {
      throw new Invalid(`no project ${unknown.join(', ')}`, [
        { path: 'projects', message: `not live projects: ${unknown.join(', ')}` },
      ]);
    }
    const byCode = new Map(moving.map((p) => [p.code, p]));
    const ordered = codes.map((code) => byCode.get(code)).filter((p) => p !== undefined);

    const staying = await tx.project.findMany({
      where: { groupId, deletedAt: null, code: { notIn: [...codes] } },
      orderBy: [{ groupPosition: 'asc' }, { code: 'asc' }],
      select: { id: true, code: true, groupPosition: true },
    });

    // Where each project ends up.
    const placed = new Map<string, number>();
    const shifted: { id: string; code: string; from: number; to: number }[] = [];
    if (position === undefined) {
      const start = await nextGroupPosition(tx, groupId);
      // A project already in this group keeps its place when nothing says where to put it.
      let next = start;
      for (const project of ordered) {
        if (project.groupId === groupId) placed.set(project.code, project.groupPosition);
        else placed.set(project.code, next++);
      }
    } else {
      const at = Math.min(position, staying.length);
      const sequence = [
        ...staying.slice(0, at).map((p) => p.code),
        ...ordered.map((p) => p.code),
        ...staying.slice(at).map((p) => p.code),
      ];
      for (const [index, code] of sequence.entries()) placed.set(code, index);
      for (const project of staying) {
        const to = placed.get(project.code) ?? project.groupPosition;
        if (to !== project.groupPosition) {
          shifted.push({ id: project.id, code: project.code, from: project.groupPosition, to });
        }
      }
    }

    const events: string[] = [];
    for (const project of ordered) {
      const to = placed.get(project.code) ?? 0;
      if (project.groupId === groupId && project.groupPosition === to) continue;
      const after = await tx.project.update({
        where: { id: project.id },
        data: { groupId, groupPosition: to },
      });
      events.push(
        await record(tx, {
          ...actor,
          action: 'update',
          entityType: 'project',
          entityId: project.id,
          entityHumanId: project.code,
          before: project,
          after,
        }),
      );
    }

    for (const project of shifted) {
      await tx.project.update({ where: { id: project.id }, data: { groupPosition: project.to } });
    }
    const firstShifted = shifted[0];
    if (firstShifted !== undefined) {
      events.push(
        await recordReorder(tx, actor, {
          entityType: group === null ? 'project' : 'group',
          entityId: group?.id ?? firstShifted.id,
          entityHumanId: group?.humanId ?? firstShifted.code,
          scope: 'projects',
          group: group?.humanId ?? null,
          before: Object.fromEntries(shifted.map((p) => [p.code, p.from])),
          after: Object.fromEntries(shifted.map((p) => [p.code, p.to])),
        }),
      );
    }
    return events;
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
 * show: the groups around it. Called inside the undo's transaction, before it writes.
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
  const { type, action, current, data, before, after } = input;
  if (type === 'group' || type === 'project' || type === 'guideline') await lockGroups(tx);

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

/** After a guideline's update is undone: its groups, which are rows, not a column, put back. */
export async function finishUndo(
  tx: TransactionClient,
  input: { type: string; action: string; entityId: string; before: Record<string, unknown> | null },
): Promise<void> {
  const { type, action, entityId, before } = input;
  if (type !== 'guideline' || (action !== 'update' && action !== 'restore')) return;
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
}

/**
 * The fields of a snapshot an undo leaves alone when the event did not change them: a project's
 * place in its groups, and a group's position. Order changes through its own events, so a rename
 * stays undoable after a reorder — comparing them would report the reorder as an edit the
 * rename's undo would discard.
 */
export const ORDER_FIELDS: Readonly<Record<string, readonly string[]>> = {
  project: ['groupId', 'groupPosition'],
  group: ['position'],
};

export function unchangedOrderFields(
  type: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Set<string> {
  const fields = ORDER_FIELDS[type] ?? [];
  return new Set(
    fields.filter(
      (field) => JSON.stringify(scrub(before?.[field])) === JSON.stringify(scrub(after?.[field])),
    ),
  );
}
