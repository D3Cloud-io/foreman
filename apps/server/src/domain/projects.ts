import {
  lintEars,
  type PhaseCreate,
  type PhaseUpdate,
  type ProjectCreate,
  type ProjectUpdate,
  type RequirementCreate,
  type RequirementUpdate,
  type TaskCreate,
  type TaskUpdate,
} from '@foreman/shared';
import type { Db } from '../db.js';
import { eventIds, record, type Actor } from './audit.js';
import { Conflict, Invalid, NotFound } from './errors.js';
import { exitGate, GateRefused } from './coverage.js';
import { groupForProject, lockGroups, settleProjects } from './groups.js';
import { allocate, nextTaskPosition, phaseHumanId, taskHumanId } from './humanId.js';
import { rollupPhase, rollupProject, rollupTaskPhases } from './rollup.js';

/**
 * The spine's write paths.
 *
 * Every mutation here runs in a transaction with its own `audit_event`, because "every mutation,
 * no exceptions" is only true if the record cannot fail separately from the change.
 */

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

export async function findProject(db: Db, code: string) {
  const project = await db.project.findFirst({ where: { code, deletedAt: null } });
  if (project === null) throw new NotFound(`project ${code}`);
  return project;
}

export async function createProject(db: Db, actor: Actor, input: ProjectCreate) {
  const existing = await db.project.findUnique({ where: { code: input.code } });
  // A duplicate code is refused rather than disambiguated: the code is what every ID embeds.
  if (existing !== null) throw new Conflict(`project code ${input.code} is already in use`);

  return db.$transaction(async (tx) => {
    // In a group, or among the ungrouped, and at the end of it either way (FRM-REQ-223). The lock
    // first: the position is read-then-write, and a move may be renumbering the same group.
    await lockGroups(tx);
    const group =
      input.group === undefined || input.group === null
        ? null
        : await groupForProject(tx, input.group);
    const created = await tx.project.create({
      data: {
        groupId: group?.id ?? null,
        // Past the end; `settleProjects` makes it exactly the next index.
        groupPosition: 2_000_000_000,
        code: input.code,
        name: input.name,
        slug: input.slug ?? slugify(input.name),
        ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle } : {}),
        ...(input.pitch !== undefined ? { pitch: input.pitch } : {}),
        ...(input.vaultPath !== undefined ? { vaultPath: input.vaultPath } : {}),
      },
      select: { id: true },
    });
    const shifted = await settleProjects(tx, actor, group?.id ?? null, {
      cause: `${input.code} created`,
      place: { ids: [created.id] },
    });
    const project = await tx.project.findUniqueOrThrow({ where: { id: created.id } });
    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'project',
      entityId: project.id,
      entityHumanId: project.code,
      after: project,
    });
    // The project's own event first, then the renumbering it caused (FRM-T-18.3).
    return { ...project, auditEventIds: eventIds(event, shifted) };
  });
}

export async function updateProject(db: Db, actor: Actor, code: string, input: ProjectUpdate) {
  return db.$transaction(async (tx) => {
    // The lock, then the row. Every write to a project's group or place holds the same lock, so
    // the row read here is the real prior state: both the move decision and the event's `before`
    // come from it, never from a read made before some other move committed.
    await lockGroups(tx);
    // And the row: a lifecycle rollup takes it without the group lock (`rollupProject`).
    await tx.$queryRaw`SELECT id FROM project WHERE code = ${code} AND deleted_at IS NULL FOR UPDATE`;
    const before = await tx.project.findFirst({ where: { code, deletedAt: null } });
    if (before === null) throw new NotFound(`project ${code}`);

    // A new group is a move: the project joins the end of it, the group it left closes up, and the
    // event's before and after carry both groups, so undoing it moves the project back
    // (FRM-REQ-225).
    let groupId = before.groupId;
    if (input.group !== undefined) {
      const group = input.group === null ? null : await groupForProject(tx, input.group);
      groupId = group?.id ?? null;
    }
    const moved = groupId !== before.groupId;

    await tx.project.update({
      where: { id: before.id },
      // `code` is not in the update shape at all, so there is nothing here to guard against.
      data: {
        ...(moved ? { groupId } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle } : {}),
        ...(input.pitch !== undefined ? { pitch: input.pitch } : {}),
        ...(input.vaultPath !== undefined ? { vaultPath: input.vaultPath } : {}),
      },
    });
    const shifted: (string | null)[] = [];
    if (moved) {
      const cause = `${code} moved`;
      shifted.push(await settleProjects(tx, actor, groupId, { cause, place: { ids: [before.id] } }));
      shifted.push(await settleProjects(tx, actor, before.groupId, { cause }));
    }
    const project = await tx.project.findUniqueOrThrow({ where: { id: before.id } });
    const event = await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'project',
      entityId: project.id,
      entityHumanId: project.code,
      before,
      after: project,
    });
    return { ...project, auditEventIds: eventIds(event, ...shifted) };
  });
}

// ─── Phases ────────────────────────────────────────────────────────────────

export async function createPhase(db: Db, actor: Actor, code: string, input: PhaseCreate) {
  const project = await findProject(db, code);

  const clash = await db.phase.findFirst({
    where: { projectId: project.id, number: input.number, deletedAt: null },
  });
  if (clash !== null) throw new Conflict(`${code} already has a phase numbered ${String(input.number)}`);

  return db.$transaction(async (tx) => {
    // Appended to the end of the build order by default. `sortOrder` is independent of `number`
    // precisely so a phase can be inserted out of numeric order later.
    const last = await tx.phase.findFirst({
      where: { projectId: project.id },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    const sortOrder = input.sortOrder ?? (last === null ? 0 : last.sortOrder + 1);

    const phase = await tx.phase.create({
      data: {
        projectId: project.id,
        humanId: phaseHumanId(project.code, input.number),
        number: input.number,
        sortOrder,
        name: input.name,
        ...(input.objective !== undefined ? { objective: input.objective } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.exitDemo !== undefined ? { exitDemo: input.exitDemo } : {}),
        ...(input.size !== undefined ? { size: input.size } : {}),
      },
    });
    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'phase',
      entityId: phase.id,
      entityHumanId: phase.humanId,
      after: phase,
    });
    return { ...phase, auditEventIds: [event] };
  });
}

export async function updatePhase(db: Db, actor: Actor, humanId: string, input: PhaseUpdate) {
  const before = await db.phase.findFirst({ where: { humanId, deletedAt: null } });
  if (before === null) throw new NotFound(humanId);

  // Completing a phase runs its exit gate (FRM-REQ-037, FRM-REQ-056). A phase that closes over an
  // uncovered Must is a phase whose "done" means nothing, and the refusal names every reason.
  if (input.status === 'complete' && before.status !== 'complete') {
    const gate = await exitGate(db, humanId);
    if (!gate.passed) throw new GateRefused(gate);
  }

  // The number is part of the human ID, and the ID is immutable (ADR-008). Renumbering a phase
  // would leave `BND-P-8.5` naming a phase that is no longer 8.5.
  // `before.number` is a Prisma Decimal; the input is a plain number.
  if (input.number !== undefined && input.number !== Number(before.number)) {
    throw new Conflict(
      `${humanId} cannot be renumbered: its human ID embeds the number, and every citation of it would then point at something else`,
    );
  }

  return db.$transaction(async (tx) => {
    const phase = await tx.phase.update({
      where: { id: before.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.objective !== undefined ? { objective: input.objective } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.exitDemo !== undefined ? { exitDemo: input.exitDemo } : {}),
        ...(input.size !== undefined ? { size: input.size } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        // A phase that starts or finishes is a date somebody will ask about later.
        ...(input.status === 'active' && before.startedAt === null ? { startedAt: new Date() } : {}),
        ...(input.status === 'complete' ? { completedAt: new Date() } : {}),
      },
    });
    const event = await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'phase',
      entityId: phase.id,
      entityHumanId: phase.humanId,
      before,
      after: phase,
    });
    const events: string[] = [];
    const rolledUp =
      phase.status === before.status
        ? []
        : await rollupProject(tx, actor, phase.projectId, phase.humanId, { events });
    return { ...phase, rolledUp, auditEventIds: [event, ...events] };
  });
}

/** Phases in the order they are being built, which is not the order they are numbered. */
export async function listPhases(db: Db, code: string) {
  const project = await findProject(db, code);
  return db.phase.findMany({
    where: { projectId: project.id, deletedAt: null },
    orderBy: { sortOrder: 'asc' },
  });
}

// ─── Requirements ──────────────────────────────────────────────────────────

export async function createRequirement(
  db: Db,
  actor: Actor,
  code: string,
  input: RequirementCreate,
) {
  const project = await findProject(db, code);
  // The lint warns and never blocks: an unparsed requirement is stored with its note.
  const ears = lintEars(input.statement);

  return db.$transaction(async (tx) => {
    const { humanId, seq } = await allocate(tx, project, 'requirement');
    const requirement = await tx.requirement.create({
      data: {
        projectId: project.id,
        humanId,
        seq,
        statement: input.statement,
        earsPattern: ears.pattern,
        earsLintOk: ears.ok,
        earsLintNote: ears.note ?? null,
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
        ...(input.acceptanceTest !== undefined ? { acceptanceTest: input.acceptanceTest } : {}),
        phaseId: input.phaseId ?? null,
      },
    });
    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'requirement',
      entityId: requirement.id,
      entityHumanId: requirement.humanId,
      after: requirement,
    });
    return { ...requirement, auditEventIds: [event] };
  });
}

export async function updateRequirement(
  db: Db,
  actor: Actor,
  humanId: string,
  input: RequirementUpdate,
) {
  const before = await db.requirement.findFirst({ where: { humanId, deletedAt: null } });
  if (before === null) throw new NotFound(humanId);

  const ears = input.statement === undefined ? null : lintEars(input.statement);

  return db.$transaction(async (tx) => {
    const requirement = await tx.requirement.update({
      where: { id: before.id },
      data: {
        ...(input.statement !== undefined ? { statement: input.statement } : {}),
        ...(ears !== null
          ? { earsPattern: ears.pattern, earsLintOk: ears.ok, earsLintNote: ears.note ?? null }
          : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
        ...(input.acceptanceTest !== undefined ? { acceptanceTest: input.acceptanceTest } : {}),
        ...(input.phaseId !== undefined ? { phaseId: input.phaseId ?? null } : {}),
      },
    });
    const event = await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'requirement',
      entityId: requirement.id,
      entityHumanId: requirement.humanId,
      before,
      after: requirement,
    });
    return { ...requirement, auditEventIds: [event] };
  });
}

// ─── Tasks ─────────────────────────────────────────────────────────────────

/**
 * A task body as stored: Markdown, or null when there is none. A blank body is no body — the
 * console clears the field by sending an empty string, and a task "with a body" of three spaces
 * would say there was context to read when there is not.
 */
function bodyOf(body: string | null): string | null {
  return body === null || body.trim().length === 0 ? null : body;
}

export async function createTask(db: Db, actor: Actor, code: string, input: TaskCreate) {
  const project = await findProject(db, code);

  const phaseId = input.phaseId ?? null;
  const phase =
    phaseId === null
      ? null
      : await db.phase.findFirst({ where: { id: phaseId, projectId: project.id } });
  if (phaseId !== null && phase === null) {
    throw new Invalid('that phase does not belong to this project', [
      { path: 'phaseId', message: 'not a phase of this project' },
    ]);
  }

  if (input.requirementIds !== undefined && input.requirementIds.length > 0) {
    const owned = await db.requirement.count({
      where: { id: { in: input.requirementIds }, projectId: project.id, deletedAt: null },
    });
    if (owned !== input.requirementIds.length) {
      throw new Invalid('a requirement does not belong to this project', [
        { path: 'requirementIds', message: 'one or more are not requirements of this project' },
      ]);
    }
  }

  return db.$transaction(async (tx) => {
    // The task ID carries its phase and its position within it, so it is not drawn from a counter.
    // The position is the phase's high-water mark, not the sibling count: tasks move between phases
    // and keep their IDs, so the count says nothing about which numbers are free.
    const siblings = await tx.task.count({
      where: { projectId: project.id, phaseId: phase?.id ?? null },
    });
    const humanId =
      phase === null
        ? (await allocate(tx, project, 'task')).humanId
        : taskHumanId(
            project.code,
            phase.number.toString(),
            await nextTaskPosition(tx, project.id, {
              id: phase.id,
              code: project.code,
              number: phase.number.toString(),
            }),
          );

    const task = await tx.task.create({
      data: {
        projectId: project.id,
        phaseId: phase?.id ?? null,
        humanId,
        title: input.title,
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.blockedReason === undefined || input.blockedReason === null
          ? {}
          : { blockedReason: input.blockedReason }),
        ...(input.size !== undefined ? { size: input.size } : {}),
        ...(input.doneWhen !== undefined ? { doneWhen: input.doneWhen } : {}),
        ...(input.body !== undefined ? { body: bodyOf(input.body) } : {}),
        sortOrder: input.sortOrder ?? siblings,
        ...(input.files !== undefined
          ? { files: { create: input.files.map((path) => ({ path })) } }
          : {}),
        ...(input.requirementIds !== undefined
          ? {
              requirements: {
                create: input.requirementIds.map((requirementId) => ({ requirementId })),
              },
            }
          : {}),
      },
      include: { files: true, requirements: true },
    });
    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'task',
      entityId: task.id,
      entityHumanId: task.humanId,
      after: task,
    });
    // New work in a closed phase reopens it; new work that is already started starts one.
    const events: string[] = [];
    const rolledUp =
      task.phaseId === null
        ? []
        : await rollupPhase(tx, actor, task.phaseId, task.humanId, { events });
    return { ...task, rolledUp, auditEventIds: [event, ...events] };
  });
}

export async function updateTask(db: Db, actor: Actor, humanId: string, input: TaskUpdate) {
  const before = await db.task.findFirst({
    where: { humanId, deletedAt: null },
    include: { files: true, requirements: true },
  });
  if (before === null) throw new NotFound(humanId);

  // The schema enforces "blocked needs a reason" on a complete body; a partial update can set the
  // status alone, so the rule is checked against the merged state rather than the patch.
  const status = input.status ?? before.status;
  const reason = input.blockedReason === undefined ? before.blockedReason : input.blockedReason;
  if (status === 'blocked' && (reason === null || reason.trim().length === 0)) {
    throw new Invalid('a blocked task must say what is blocking it', [
      { path: 'blockedReason', message: 'required when the status is blocked' },
    ]);
  }

  return db.$transaction(async (tx) => {
    const task = await tx.task.update({
      where: { id: before.id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.phaseId !== undefined ? { phaseId: input.phaseId ?? null } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.blockedReason !== undefined ? { blockedReason: input.blockedReason ?? null } : {}),
        // Leaving `blocked` retires the reason. A task that is moving again and still carries
        // "waiting on the GitHub App installation" reads, to anyone who finds it later, as a
        // task that is still waiting — and the reason is only ever rendered beside the status,
        // so nothing would have shown the contradiction. Only when the caller did not say:
        // an explicit `blockedReason` in the same patch is a deliberate act and wins.
        ...(input.status !== undefined &&
        input.status !== 'blocked' &&
        before.status === 'blocked' &&
        input.blockedReason === undefined
          ? { blockedReason: null }
          : {}),
        ...(input.size !== undefined ? { size: input.size } : {}),
        ...(input.doneWhen !== undefined ? { doneWhen: input.doneWhen } : {}),
        ...(input.body !== undefined ? { body: bodyOf(input.body) } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        // A status change is also a timestamp: "when did this start" is asked constantly.
        ...(input.status === 'in_progress' && before.startedAt === null
          ? { startedAt: new Date() }
          : {}),
        ...(input.status === 'done' ? { completedAt: new Date() } : {}),
        ...(input.files !== undefined
          ? { files: { deleteMany: {}, create: input.files.map((path) => ({ path })) } }
          : {}),
        ...(input.requirementIds !== undefined
          ? {
              requirements: {
                deleteMany: {},
                create: input.requirementIds.map((requirementId) => ({ requirementId })),
              },
            }
          : {}),
      },
      include: { files: true, requirements: true },
    });
    const event = await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'task',
      entityId: task.id,
      entityHumanId: task.humanId,
      before,
      after: task,
    });
    // The task's own event first, then each phase and project it moved, in the order they moved.
    const events: string[] = [];
    const rolledUp = await rollupTaskPhases(tx, actor, before, task, { events });
    return { ...task, rolledUp, auditEventIds: [event, ...events] };
  });
}
