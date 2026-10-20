import type { PhaseStatus, ProjectLifecycle, TaskStatus } from '@foreman/shared';
import { record, type Actor, type TransactionClient } from './audit.js';
import { exitGate } from './coverage.js';

/**
 * Status rollup (FRM-REQ-183, FRM-REQ-184, FRM-REQ-185).
 *
 * Tasks are the only status anybody moves by hand in practice, so phase status and project
 * lifecycle rotted: Foreman's own FRM-P-11 read `planned` with every task done, and Postroom showed
 * thirteen `planned` phases, five of them at 100%. The brief had already stopped trusting the stored
 * value and worked out the phase in flight for itself — which is the tell that the stored value was
 * a second copy of a fact, kept by nobody.
 *
 * So the status is **derived from what is beneath it**, in the same transaction as the change that
 * moved it, and written as its own audit event so it can be read and undone like any other:
 *
 *   tasks  → phase    planned · active · complete (only through the exit gate) · cancelled
 *   phases → project  building · deployed — promotion only, never demotion
 *
 * **`parked` is the one decision a rollup never makes or unmakes.** It says "deliberately not now",
 * which no count of tasks can know. The same goes for a parked or scrapped project.
 */

const CLOSED: readonly TaskStatus[] = ['done', 'cancelled'];
/** Work somebody has actually touched. A cancelled task alone is a decision, not a start. */
const STARTED: readonly TaskStatus[] = ['in_progress', 'blocked', 'done'];

/**
 * What a phase's tasks say its status should be, before the exit gate is asked.
 *
 * Returns `null` for "leave it as it is". `complete` here is a candidate: the caller runs the gate,
 * and a phase whose gate fails stays `active` — drift and the gate itself already name why.
 */
export function phaseStatusFromTasks(
  current: PhaseStatus,
  tasks: readonly TaskStatus[],
): PhaseStatus | null {
  if (current === 'parked') return null;
  // A phase with nothing in it says nothing about itself; whatever somebody set stands.
  if (tasks.length === 0) return null;

  if (tasks.every((status) => CLOSED.includes(status))) {
    return tasks.every((status) => status === 'cancelled') ? 'cancelled' : 'complete';
  }

  if (tasks.some((status) => STARTED.includes(status))) return 'active';

  // Open work and none of it started. A phase somebody marked active by hand before touching a
  // task keeps that; one that was closed and has had all of its work reopened is planned again.
  return current === 'complete' || current === 'cancelled' ? 'planned' : null;
}

/**
 * What a project's phases say its lifecycle should be. **Promotion only**: `deployed` is a fact
 * about the world, and a new phase of planned work on a deployed project does not undeploy it.
 */
export function lifecycleFromPhases(
  current: ProjectLifecycle,
  phases: readonly PhaseStatus[],
): ProjectLifecycle | null {
  if (current === 'parked' || current === 'scrapped' || current === 'deployed') return null;
  if (phases.length === 0) return null;

  const closed = phases.every((status) => status === 'complete' || status === 'cancelled');
  if (closed && phases.includes('complete')) return 'deployed';

  if (current === 'building') return null;
  return phases.some((status) => status === 'active' || status === 'complete') ? 'building' : null;
}

/** One status that moved because something beneath it did. */
export interface RolledUp {
  readonly humanId: string;
  readonly kind: 'phase' | 'project';
  readonly from: string;
  readonly to: string;
  /** Set when the move was worked out and deliberately not made — see `promoteOnly`. */
  readonly held?: true;
}

export interface RollupOptions {
  /**
   * Never take a closed phase back to open. A live task being reopened is an event, and the phase
   * follows it; a backfill has no event, only a phase marked complete over tasks nobody ticked —
   * which is exactly what the importer left wherever the vault said "done" and the checkboxes did
   * not — and it cannot know which of the two is stale. So it reports the disagreement and holds.
   */
  readonly promoteOnly?: boolean;
  /**
   * Where to append the ID of every audit event a rollup writes, in the order written. The moves
   * themselves are returned as ever (`RolledUp` is part of the response and has no event field);
   * this is how a caller that must hand the events back — the console's Undo (FRM-REQ-243) —
   * learns them without the response shape changing.
   */
  readonly events?: string[] | undefined;
}

const CLOSED_PHASE: readonly PhaseStatus[] = ['complete', 'cancelled'];

/**
 * Who a rollup is recorded as: the system, naming the change that caused it, and carrying the
 * caller's request ID so the two events read as one act in the audit trail.
 */
function rollupActor(actor: Actor, cause: string): Actor {
  return {
    actor: `rollup via ${cause}`,
    actorKind: 'system',
    ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
  };
}

/**
 * Re-derive one phase, then its project. Call inside the transaction that changed a task.
 *
 * The phase row is locked first. Two tasks closing at once in the same phase would otherwise each
 * read the other as still open, and neither would complete it — the one outcome worse than no
 * rollup at all, because it looks like it ran.
 */
export async function rollupPhase(
  tx: TransactionClient,
  actor: Actor,
  phaseId: string,
  cause: string,
  options: RollupOptions = {},
): Promise<RolledUp[]> {
  await tx.$queryRaw`SELECT id FROM phase WHERE id = ${phaseId}::uuid FOR UPDATE`;
  const phase = await tx.phase.findFirst({ where: { id: phaseId, deletedAt: null } });
  if (phase === null) return [];

  const tasks = await tx.task.findMany({
    where: { phaseId, deletedAt: null },
    select: { status: true },
  });
  let target = phaseStatusFromTasks(
    phase.status,
    tasks.map((task) => task.status),
  );

  // Completion goes through the gate, the same one a person completing it by hand faces. A phase
  // already complete is not re-gated here: drift reports a complete phase that would fail today.
  if (target === 'complete' && phase.status !== 'complete') {
    const gate = await exitGate(tx, phase.humanId);
    if (!gate.passed) target = 'active';
  }

  const moved: RolledUp[] = [];
  if (
    options.promoteOnly === true &&
    target !== null &&
    CLOSED_PHASE.includes(phase.status) &&
    !CLOSED_PHASE.includes(target)
  ) {
    moved.push({ humanId: phase.humanId, kind: 'phase', from: phase.status, to: target, held: true });
  } else if (target !== null && target !== phase.status) {
    const after = await tx.phase.update({
      where: { id: phase.id },
      data: {
        status: target,
        ...(target === 'active' && phase.startedAt === null ? { startedAt: new Date() } : {}),
        ...(target === 'complete' ? { completedAt: new Date() } : {}),
        // A reopened phase has not finished; a date saying it had would be the lie this removes.
        ...(target !== 'complete' && phase.completedAt !== null ? { completedAt: null } : {}),
      },
    });
    const eventId = await record(tx, {
      ...rollupActor(actor, cause),
      action: 'update',
      entityType: 'phase',
      entityId: phase.id,
      entityHumanId: phase.humanId,
      before: phase,
      after,
    });
    options.events?.push(eventId);
    moved.push({ humanId: phase.humanId, kind: 'phase', from: phase.status, to: target });
  }

  return [...moved, ...(await rollupProject(tx, actor, phase.projectId, cause, options))];
}

/** Re-derive a project's lifecycle from its phases. Call after any phase status change. */
export async function rollupProject(
  tx: TransactionClient,
  actor: Actor,
  projectId: string,
  cause: string,
  options: Pick<RollupOptions, 'events'> = {},
): Promise<RolledUp[]> {
  await tx.$queryRaw`SELECT id FROM project WHERE id = ${projectId}::uuid FOR UPDATE`;
  const project = await tx.project.findFirst({ where: { id: projectId, deletedAt: null } });
  if (project === null) return [];

  const phases = await tx.phase.findMany({
    where: { projectId, deletedAt: null },
    select: { status: true },
  });
  const target = lifecycleFromPhases(
    project.lifecycle,
    phases.map((phase) => phase.status),
  );
  if (target === null || target === project.lifecycle) return [];

  const after = await tx.project.update({ where: { id: project.id }, data: { lifecycle: target } });
  const eventId = await record(tx, {
    ...rollupActor(actor, cause),
    action: 'update',
    entityType: 'project',
    entityId: project.id,
    entityHumanId: project.code,
    before: project,
    after,
  });
  options.events?.push(eventId);
  return [{ humanId: project.code, kind: 'project', from: project.lifecycle, to: target }];
}

/**
 * The phases a task change can move: its own, and the one it left if it moved. Only a status or a
 * phase change can alter what a phase's tasks add up to, so a retitle rolls nothing up.
 */
export async function rollupTaskPhases(
  tx: TransactionClient,
  actor: Actor,
  before: { readonly status: string; readonly phaseId: string | null } | null,
  after: { readonly humanId: string; readonly status: string; readonly phaseId: string | null },
  options: Pick<RollupOptions, 'events'> = {},
): Promise<RolledUp[]> {
  if (before !== null && before.status === after.status && before.phaseId === after.phaseId) {
    return [];
  }
  const phases = new Set<string>();
  if (before !== null && before.phaseId !== null) phases.add(before.phaseId);
  if (after.phaseId !== null) phases.add(after.phaseId);

  const moved: RolledUp[] = [];
  for (const phaseId of phases) moved.push(...(await rollupPhase(tx, actor, phaseId, after.humanId, options)));
  return moved;
}

type Row = Record<string, unknown>;

/**
 * The rollup for a change made generically — a soft delete or an undo, which see a row of any
 * type. A task rolls up its phases; a phase rolls up its project; nothing else has a status that
 * rolls anywhere.
 */
export async function rollupAfter(
  tx: TransactionClient,
  actor: Actor,
  type: string,
  before: Row,
  after: Row,
  cause: string,
  options: Pick<RollupOptions, 'events'> = {},
): Promise<RolledUp[]> {
  if (type === 'task') {
    // A deleted task is out of the count whatever its status says, so it rolls up as if it had
    // left its phase — which is exactly what the phase sees.
    const phaseOf = (row: Row) =>
      row['deletedAt'] === null || row['deletedAt'] === undefined
        ? ((row['phaseId'] as string | null | undefined) ?? null)
        : null;
    return rollupTaskPhases(
      tx,
      actor,
      { status: String(before['status']), phaseId: phaseOf(before) },
      { humanId: cause, status: String(after['status']), phaseId: phaseOf(after) },
      options,
    );
  }
  if (type === 'phase') {
    return rollupProject(tx, actor, String(after['projectId']), cause, options);
  }
  return [];
}
