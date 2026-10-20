import type { Db } from '../db.js';
import { adrGraph } from './record.js';
import { exitGate, screenStates, type GateFailure } from './coverage.js';
import { findProject } from './projects.js';

/**
 * Drift: the difference between what the plan says and what is true (T-7.1).
 *
 * **One query layer over six categories, not five features.** They are rendered three ways — the
 * drift view, a portfolio badge and a line in the brief — and if each surface computed its own,
 * the badge would eventually disagree with the screen it links to. Disagreement between two of
 * Foreman's own numbers is the fastest way to stop being believed.
 *
 * | Category | What it means |
 * |---|---|
 * | Coverage hole | A Must with no task, or a task citing no requirement |
 * | Stale task | `in_progress` with no commits touching its declared files |
 * | Fired tripwire | A risk whose named condition has been met |
 * | Failed exit gate | A phase marked complete that would not pass its gate today |
 * | Orphan ADR | Accepted but uncited, or a broken/circular supersedes chain |
 * | Screen drift | A screen judged drifted-fix, or built (a done task) and never captured |
 */

export type DriftCategory =
  | 'coverage-hole'
  | 'stale-task'
  | 'fired-tripwire'
  | 'failed-exit-gate'
  | 'orphan-adr'
  | 'screen-drift';

export interface DriftItem {
  readonly category: DriftCategory;
  /** The entity drifting. Named, always — "there is drift" sends somebody looking. */
  readonly humanId: string;
  readonly title: string;
  /** What is wrong, in a sentence somebody can act on. */
  readonly detail: string;
}

export interface Drift {
  readonly project: string;
  readonly total: number;
  readonly counts: Record<DriftCategory, number>;
  readonly items: readonly DriftItem[];
}

/**
 * How long an `in_progress` task may go without matching activity before it is stale.
 *
 * Fourteen days rather than two: a task picked up on Friday and left over a fortnight's holiday is
 * not drift. The signal worth having is "this was started in April and nothing has touched it",
 * and a threshold short enough to fire on a normal week is one that gets ignored.
 */
const STALE_AFTER_DAYS = 14;

/** A failed gate's reasons in a few words each, for a drift line that names them all. */
const GATE_REASON: Record<GateFailure['kind'], string> = {
  'no-exit-demo': 'no exit demo',
  'uncovered-must': 'no task',
  'no-acceptance-test': 'no acceptance test',
  'unfinished-task': 'unfinished',
  'open-critical': 'open finding',
  'screen-unreviewed': 'capture unreviewed',
  'screen-drifted': 'drifted-fix',
};

export async function driftFor(db: Db, code: string): Promise<Drift> {
  const project = await findProject(db, code);
  const items: DriftItem[] = [];

  // ─── 1. Coverage holes ───────────────────────────────────────────────────
  const uncoveredMusts = await db.requirement.findMany({
    where: {
      projectId: project.id,
      deletedAt: null,
      priority: 'M',
      tasks: { none: { task: { deletedAt: null } } },
    },
    select: { humanId: true, statement: true },
  });
  for (const requirement of uncoveredMusts) {
    items.push({
      category: 'coverage-hole',
      humanId: requirement.humanId,
      title: requirement.statement.slice(0, 120),
      detail: 'A Must with no task satisfying it.',
    });
  }

  const orphanTasks = await db.task.findMany({
    where: {
      projectId: project.id,
      deletedAt: null,
      requirements: { none: {} },
      // A cancelled task needs no reason: abandoning it was the reason.
      status: { notIn: ['cancelled', 'done'] },
    },
    select: { humanId: true, title: true },
  });
  for (const task of orphanTasks) {
    items.push({
      category: 'coverage-hole',
      humanId: task.humanId,
      title: task.title,
      detail: 'Work with no stated reason — it cites no requirement.',
    });
  }

  // ─── 2. Stale tasks (FRM-REQ-129) ────────────────────────────────────────
  const cutoff = new Date(Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000);
  const inProgress = await db.task.findMany({
    where: { projectId: project.id, deletedAt: null, status: 'in_progress' },
    include: { files: { select: { path: true } } },
  });

  for (const task of inProgress) {
    // Started recently enough that silence means nothing yet.
    if (task.startedAt !== null && task.startedAt > cutoff) continue;

    const paths = task.files.map((f) => f.path);
    const activity = await db.commit.count({
      where: {
        repo: { projectId: project.id, deletedAt: null },
        orphanedAt: null,
        committedAt: { gt: cutoff },
        OR: [
          // Either a commit touching a file it declared…
          ...(paths.length > 0 ? [{ files: { some: { path: { in: paths } } } }] : []),
          // …or one attributed to it, confirmed. A proposal is not activity (ADR-005).
          { attributions: { some: { task: { humanId: task.humanId }, confirmed: true } } },
        ],
      },
    });
    if (activity > 0) continue;

    items.push({
      category: 'stale-task',
      humanId: task.humanId,
      title: task.title,
      detail:
        paths.length === 0
          ? `In progress, and nothing has been attributed to it in ${String(STALE_AFTER_DAYS)} days.`
          : `In progress, and no commit has touched ${paths.join(', ')} in ${String(STALE_AFTER_DAYS)} days.`,
    });
  }

  // ─── 3. Fired tripwires (FRM-REQ-070) ────────────────────────────────────
  const fired = await db.risk.findMany({
    where: { projectId: project.id, deletedAt: null, status: 'fired' },
    select: { humanId: true, title: true, tripwire: true, firedAt: true },
  });
  for (const risk of fired) {
    items.push({
      category: 'fired-tripwire',
      humanId: risk.humanId,
      title: risk.title,
      detail:
        `The tripwire fired${risk.firedAt === null ? '' : ` on ${risk.firedAt.toISOString().slice(0, 10)}`}` +
        `: ${risk.tripwire ?? 'no condition recorded'}`,
    });
  }

  // ─── 4. Failed exit gates ────────────────────────────────────────────────
  //
  // A phase marked complete that would not pass its gate today. The gate refuses at the moment of
  // completion; this catches the ones that drifted *afterwards* — a Must added to a finished
  // phase, a task reopened — and the ones completed before the gate asked what it asks now.
  //
  // **The gate is the only rule here** (FRM-T-026). This once checked the exit demo itself, beside
  // the gate, and a phase could show as drift for a reason completing it never refused. One item
  // per phase, naming every reason the gate gives.
  const complete = await db.phase.findMany({
    where: { projectId: project.id, deletedAt: null, status: 'complete' },
    orderBy: { sortOrder: 'asc' },
    select: { humanId: true, name: true },
  });
  for (const phase of complete) {
    const gate = await exitGate(db, phase.humanId);
    if (gate.passed) continue;
    items.push({
      category: 'failed-exit-gate',
      humanId: phase.humanId,
      title: phase.name,
      detail: `Complete, but would not pass its gate today: ${gate.failures
        // The exit demo is the phase's own; every other reason names the thing in the way.
        .map((f) => (f.humanId === phase.humanId ? GATE_REASON[f.kind] : `${f.humanId} (${GATE_REASON[f.kind]})`))
        .join(', ')}`,
    });
  }

  // ─── 5. Orphan ADRs (FRM-REQ-060) ────────────────────────────────────────
  const graph = await adrGraph(db, code);
  if (graph.cycle !== null) {
    items.push({
      category: 'orphan-adr',
      humanId: graph.cycle[0] ?? '',
      title: 'A supersedes chain that loops',
      detail: `These supersede each other in a circle: ${graph.cycle.join(' → ')}`,
    });
  }

  const accepted = await db.adr.findMany({
    where: { projectId: project.id, deletedAt: null, status: 'accepted' },
    select: { id: true, humanId: true, title: true },
  });
  for (const adr of accepted) {
    const citations = await db.reference.count({ where: { toType: 'adr', toId: adr.id } });
    const relations = await db.adrRelation.count({ where: { relatedAdrId: adr.id } });
    if (citations > 0 || relations > 0) continue;

    items.push({
      category: 'orphan-adr',
      humanId: adr.humanId,
      title: adr.title,
      // Not an error — a new ADR is uncited by definition. It is worth seeing because an accepted
      // decision nothing refers to is usually one nothing is following.
      detail: 'Accepted, and nothing cites it.',
    });
  }

  // ─── 6. Screen drift (FRM-REQ-201) ───────────────────────────────────────
  //
  // The two ways a screen and its design disagree without anyone having said so: a reviewer ruled
  // the latest capture wrong and the fix has not landed, or the work is marked done and nobody
  // ever took a picture of it. A `drifted_accepted` is a decision, not drift.
  for (const screen of await screenStates(db, project.id)) {
    if (screen.capture?.verdict === 'drifted_fix') {
      items.push({
        category: 'screen-drift',
        humanId: screen.humanId,
        title: screen.name,
        detail: 'Drifted from its proposal; the fix is pending.',
      });
    } else if (screen.capture === null && screen.taskStatuses.includes('done')) {
      items.push({
        category: 'screen-drift',
        humanId: screen.humanId,
        title: screen.name,
        detail: 'Built, but never captured — nothing shows it matches its proposal.',
      });
    }
  }

  const counts: Record<DriftCategory, number> = {
    'coverage-hole': 0,
    'stale-task': 0,
    'fired-tripwire': 0,
    'failed-exit-gate': 0,
    'orphan-adr': 0,
    'screen-drift': 0,
  };
  for (const item of items) counts[item.category] += 1;

  return { project: project.code, total: items.length, counts, items };
}

/** The one number the portfolio badge and the brief both read (FRM-REQ-127, FRM-REQ-128). */
export async function driftCount(db: Db, code: string): Promise<number> {
  return (await driftFor(db, code)).total;
}
