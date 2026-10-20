import {
  formatGuidelineId,
  type GuidelineCreate,
  type GuidelineScope,
  type GuidelineStatus,
  type BriefGuideline,
  type GuidelineSummary,
  type GuidelineUpdate,
  type ScopedGuidelineSummary,
} from '@foreman/shared';
import type { Db } from '../db.js';
import { record, type Actor, type TransactionClient } from './audit.js';
import { Invalid, NotFound } from './errors.js';
import { lockGroups } from './groups.js';

/**
 * Guidelines — standing decisions that apply to every project (FRM-REQ-186 … FRM-REQ-188).
 *
 * The ecosystem's house rules: dual login everywhere, tokens not hex, no time estimates. They used
 * to live as prose in a CLAUDE.md, where a session found them only if it happened to read the
 * right paragraph. Here each is a record with an ID, and every brief carries the active ones —
 * so starting work on any project puts them in front of whoever is doing it (FRM-REQ-187).
 *
 * Like a project idea, a guideline belongs to no project, and for the same reason its `GL-004`
 * comes from a Postgres sequence rather than a project's counter (ADR-008, ADR-015).
 */

const SELECT = {
  id: true,
  humanId: true,
  seq: true,
  title: true,
  area: true,
  decision: true,
  rationale: true,
  guidance: true,
  status: true,
  appliesTo: true,
  // The groups a scoped guideline applies to, in the groups' own order (FRM-REQ-235).
  groups: {
    where: { group: { deletedAt: null } },
    orderBy: { group: { position: 'asc' } },
    select: { group: { select: { humanId: true } } },
  },
  createdAt: true,
  updatedAt: true,
} as const;

type Row = Awaited<ReturnType<typeof readOne>>;

async function readOne(db: Db | TransactionClient, where: { id: string } | { humanId: string }) {
  return db.guideline.findFirst({ where: { ...where, deletedAt: null }, select: SELECT });
}

/** Read back what a write just wrote, inside its transaction. */
async function readView(tx: TransactionClient, id: string) {
  const row = await readOne(tx, { id });
  if (row === null) throw new Error(`guideline ${id} vanished inside its own write`);
  return view(row);
}

/** A guideline as the API returns it and its audit events record it: `groups` as `GRP-` IDs. */
function view(row: NonNullable<Row>) {
  return { ...row, groups: row.groups.map((g) => g.group.humanId) };
}

/**
 * Write a guideline's scope: `all` clears its groups, `groups` replaces them. Every group named
 * must be live — a guideline cannot name a deleted group, or one that never existed (422).
 */
async function writeScope(
  tx: TransactionClient,
  guidelineId: string,
  appliesTo: GuidelineScope,
  groups: readonly string[] | undefined,
): Promise<void> {
  await lockGroups(tx);
  const wanted = appliesTo === 'groups' ? [...(groups ?? [])] : [];
  const live = await tx.projectGroup.findMany({
    where: { humanId: { in: wanted }, deletedAt: null },
    select: { id: true, humanId: true },
  });
  const missing = wanted.filter((humanId) => !live.some((g) => g.humanId === humanId));
  if (missing.length > 0) {
    throw new Invalid(`no group ${missing.join(', ')}`, [
      { path: 'groups', message: `not live groups: ${missing.join(', ')}` },
    ]);
  }
  await tx.guideline.update({ where: { id: guidelineId }, data: { appliesTo } });
  await tx.guidelineGroup.deleteMany({ where: { guidelineId } });
  if (live.length > 0) {
    await tx.guidelineGroup.createMany({
      data: live.map((g) => ({ guidelineId, groupId: g.id })),
    });
  }
}

async function nextSeq(tx: TransactionClient): Promise<number> {
  const rows = await tx.$queryRaw<{ seq: number }[]>`
    select nextval('guideline_seq')::int as seq
  `;
  const seq = rows[0]?.seq;
  if (seq === undefined) throw new Error('guideline_seq did not yield a value');
  return seq;
}

/** An empty string clears an optional section rather than storing '' as "written". */
const orNull = (value: string): string | null => (value.trim().length === 0 ? null : value);

export async function allGuidelines(db: Db, options: { status?: GuidelineStatus } = {}) {
  const rows = await db.guideline.findMany({
    where: { deletedAt: null, ...(options.status === undefined ? {} : { status: options.status }) },
    // Active above retired (the enum is ordered that way), then grouped by area, then in the
    // order they were written — the first rule in an area is usually the one the rest refine.
    orderBy: [{ status: 'asc' }, { area: 'asc' }, { seq: 'asc' }],
    select: SELECT,
  });
  return rows.map(view);
}

/**
 * The line a brief and the portfolio carry for each active guideline.
 *
 * Title and decision only: the rationale and guidance can run to pages, and a brief is read at the
 * start of every session whether or not any of it is relevant. `foreman_get GL-004` has the rest.
 */
export async function activeGuidelineSummaries(db: Db): Promise<GuidelineSummary[]> {
  return db.guideline.findMany({
    where: { deletedAt: null, status: 'active' },
    orderBy: [{ area: 'asc' }, { seq: 'asc' }],
    select: { humanId: true, title: true, decision: true },
  });
}

/**
 * The active guidelines that apply to one group's projects, as a brief carries them
 * (FRM-REQ-236): every `all` one, and those scoped to this group. `null` is the ungrouped, which
 * get only the `all` ones — a guideline scoped to groups names groups, and the ungrouped are in
 * none. A scoped one says so, so a session can tell a family's rule from the ecosystem's.
 */
export async function guidelinesForGroup(
  db: Db,
  groupId: string | null,
): Promise<BriefGuideline[]> {
  const rows = await db.guideline.findMany({
    where: {
      deletedAt: null,
      status: 'active',
      OR: [
        { appliesTo: 'all' },
        ...(groupId === null
          ? []
          : [{ appliesTo: 'groups' as const, groups: { some: { groupId } } }]),
      ],
    },
    orderBy: [{ area: 'asc' }, { seq: 'asc' }],
    select: { humanId: true, title: true, decision: true, appliesTo: true },
  });
  return rows.map(({ appliesTo, ...summary }) =>
    appliesTo === 'groups' ? { ...summary, appliesTo } : summary,
  );
}

/**
 * Every active guideline with where it applies, as the portfolio carries them (FRM-REQ-237).
 * Narrowed to a group — or to the ungrouped, with `null` — it is the ones that apply there.
 */
export async function scopedGuidelineSummaries(
  db: Db,
  narrow?: { groupId: string | null },
): Promise<ScopedGuidelineSummary[]> {
  const rows = await db.guideline.findMany({
    where: {
      deletedAt: null,
      status: 'active',
      ...(narrow === undefined
        ? {}
        : {
            OR: [
              { appliesTo: 'all' as const },
              ...(narrow.groupId === null
                ? []
                : [{ appliesTo: 'groups' as const, groups: { some: { groupId: narrow.groupId } } }]),
            ],
          }),
    },
    orderBy: [{ area: 'asc' }, { seq: 'asc' }],
    select: {
      humanId: true,
      title: true,
      decision: true,
      appliesTo: true,
      groups: SELECT.groups,
    },
  });
  return rows.map((row) => ({ ...row, groups: row.groups.map((g) => g.group.humanId) }));
}

export async function findGuideline(db: Db, humanId: string) {
  const row = await readOne(db, { humanId });
  if (row === null) throw new NotFound(humanId);
  return view(row);
}

export async function createGuideline(db: Db, actor: Actor, input: GuidelineCreate) {
  return db.$transaction(async (tx) => {
    const seq = await nextSeq(tx);
    const guideline = await tx.guideline.create({
      data: {
        humanId: formatGuidelineId(seq),
        seq,
        title: input.title,
        area: input.area,
        decision: input.decision,
        ...(input.rationale === undefined ? {} : { rationale: orNull(input.rationale) }),
        ...(input.guidance === undefined ? {} : { guidance: orNull(input.guidance) }),
      },
      select: { id: true },
    });
    if (input.appliesTo !== undefined) {
      await writeScope(tx, guideline.id, input.appliesTo, input.groups);
    }
    const created = await readView(tx, guideline.id);
    await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'guideline',
      entityId: created.id,
      entityHumanId: created.humanId,
      after: created,
    });
    return created;
  });
}

export async function updateGuideline(
  db: Db,
  actor: Actor,
  humanId: string,
  input: GuidelineUpdate,
) {
  return db.$transaction(async (tx) => {
    // The lock before the read: its groups are what a concurrent scope change or group delete left.
    await lockGroups(tx);
    const found = await readOne(tx, { humanId });
    if (found === null) throw new NotFound(humanId);
    const before = view(found);

    await tx.guideline.update({
      where: { id: before.id },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.area === undefined ? {} : { area: input.area }),
        ...(input.decision === undefined ? {} : { decision: input.decision }),
        ...(input.rationale === undefined ? {} : { rationale: orNull(input.rationale) }),
        ...(input.guidance === undefined ? {} : { guidance: orNull(input.guidance) }),
        ...(input.status === undefined ? {} : { status: input.status }),
      },
    });
    if (input.appliesTo !== undefined) {
      await writeScope(tx, before.id, input.appliesTo, input.groups);
    }
    const after = await readView(tx, before.id);
    await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'guideline',
      entityId: after.id,
      entityHumanId: after.humanId,
      before,
      after,
    });
    return after;
  });
}

/**
 * Every active guideline as one Markdown page — the `foreman://guidelines` resource.
 *
 * Headings are the IDs, so a reader can cite what it is following by the same name the console
 * shows.
 */
export async function guidelinesMarkdown(db: Db): Promise<string> {
  const rows = await db.guideline.findMany({
    where: { deletedAt: null, status: 'active' },
    orderBy: [{ area: 'asc' }, { seq: 'asc' }],
    select: SELECT,
  });
  const out: string[] = [
    '# Guidelines',
    '',
    'Standing decisions for every D3 Cloud project. Follow them unless the project records an ADR that says otherwise.',
  ];
  let area: string | null = null;
  for (const row of rows) {
    if (row.area !== area) {
      area = row.area;
      out.push('', `## ${area}`);
    }
    out.push('', `### ${row.humanId} — ${row.title}`, '', `**Decision.** ${row.decision}`);
    if (row.rationale !== null) out.push('', `**Why.** ${row.rationale}`);
    if (row.guidance !== null) out.push('', '**How to apply.**', '', row.guidance);
  }
  if (rows.length === 0) out.push('', '_No active guidelines._');
  return `${out.join('\n')}\n`;
}
