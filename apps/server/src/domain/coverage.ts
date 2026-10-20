import type { Db } from '../db.js';
import type { ScreenVerdictKind, TaskStatus } from '../generated/prisma/enums.js';
import type { TransactionClient } from './audit.js';
import { Conflict, NotFound } from './errors.js';

/**
 * Coverage and the exit gate (T-3.4, T-3.6 — FRM-REQ-053, FRM-REQ-054, FRM-REQ-056).
 *
 * This is where the hand-maintained traceability matrix dies. Nobody updates a matrix in a document
 * after the third week; a query cannot forget.
 *
 * **Coverage counts only confirmed attributions** (ADR-005). A requirement is not covered because a
 * commit happened to touch a file a task declared — that is a coincidence, and letting a
 * coincidence close a phase is how a ledger stops being worth reading.
 */

export interface CoverageHole {
  readonly humanId: string;
  readonly statement: string;
  readonly priority: string;
  readonly reason: 'uncovered' | 'no-acceptance-test' | 'covered-by-unfinished-work';
}

export interface Coverage {
  readonly project: string;
  readonly requirements: {
    readonly total: number;
    readonly covered: number;
    readonly musts: number;
    readonly mustsCovered: number;
  };
  /** Musts with no task citing them. The number that decides whether a phase can close. */
  readonly uncoveredMusts: readonly CoverageHole[];
  /**
   * Any priority but Won't, uncovered. Worth seeing, but not blocking. A Won't has nothing to
   * build, so no task citing it is the correct state, not a hole.
   */
  readonly uncovered: readonly CoverageHole[];
  /** Requirements nothing can be checked against, which is a different kind of hole. */
  readonly withoutAcceptanceTest: readonly CoverageHole[];
  /** Work with no stated reason — the coverage hole seen from the other side. */
  readonly tasksWithoutRequirements: readonly { humanId: string; title: string }[];
  /** Statements the lint could not read as a behaviour. */
  readonly earsWarnings: readonly { humanId: string; statement: string; note: string }[];
}

const MUST = 'M';
const WONT = 'W';

export async function coverageFor(db: Db, code: string): Promise<Coverage> {
  const project = await db.project.findFirst({ where: { code, deletedAt: null } });
  if (project === null) throw new NotFound(`project ${code}`);

  const requirements = await db.requirement.findMany({
    where: { projectId: project.id, deletedAt: null },
    orderBy: { seq: 'asc' },
    include: {
      tasks: {
        select: { task: { select: { humanId: true, status: true, deletedAt: true } } },
      },
    },
  });

  const hole = (r: (typeof requirements)[number], reason: CoverageHole['reason']): CoverageHole => ({
    humanId: r.humanId,
    statement: r.statement,
    priority: r.priority,
    reason,
  });

  const uncovered: CoverageHole[] = [];
  const uncoveredMusts: CoverageHole[] = [];
  const withoutAcceptanceTest: CoverageHole[] = [];
  const earsWarnings: { humanId: string; statement: string; note: string }[] = [];
  let covered = 0;
  let musts = 0;
  let mustsCovered = 0;

  for (const requirement of requirements) {
    // A soft-deleted task covers nothing.
    const citing = requirement.tasks.filter((t) => t.task.deletedAt === null);
    const isCovered = citing.length > 0;
    const isMust = requirement.priority === MUST;

    if (isCovered) covered += 1;
    if (isMust) musts += 1;
    if (isMust && isCovered) mustsCovered += 1;

    if (!isCovered && requirement.priority !== WONT) {
      uncovered.push(hole(requirement, 'uncovered'));
      if (isMust) uncoveredMusts.push(hole(requirement, 'uncovered'));
    }

    if (requirement.acceptanceTest === null || requirement.acceptanceTest.trim() === '') {
      withoutAcceptanceTest.push(hole(requirement, 'no-acceptance-test'));
    }

    // The verdict is `earsLintOk`; the note only explains it. Requiring both meant a requirement
    // that failed the lint with no note was reported as no warning at all — which is how 210
    // imported requirements showed an attention badge apiece on the Requirements screen while
    // `foreman_coverage` answered `earsWarnings: []`. A missing explanation is worth saying out
    // loud, not worth hiding the finding over.
    if (!requirement.earsLintOk) {
      earsWarnings.push({
        humanId: requirement.humanId,
        statement: requirement.statement,
        note: requirement.earsLintNote ?? 'the lint could not read this as a behaviour',
      });
    }
  }

  const orphanTasks = await db.task.findMany({
    where: {
      projectId: project.id,
      deletedAt: null,
      requirements: { none: {} },
      // A cancelled task needs no reason: it was abandoned, which is itself the reason.
      status: { not: 'cancelled' },
    },
    orderBy: { humanId: 'asc' },
    select: { humanId: true, title: true },
  });

  return {
    project: project.code,
    requirements: { total: requirements.length, covered, musts, mustsCovered },
    uncoveredMusts,
    uncovered,
    withoutAcceptanceTest,
    tasksWithoutRequirements: orphanTasks,
    earsWarnings,
  };
}

// ─── The exit gate ─────────────────────────────────────────────────────────

export interface GateFailure {
  readonly kind:
    | 'uncovered-must'
    | 'unfinished-task'
    | 'open-critical'
    | 'screen-unreviewed'
    | 'screen-drifted';
  readonly humanId: string;
  readonly detail: string;
}

export interface GateResult {
  readonly phase: string;
  readonly passed: boolean;
  /** Each failure names the thing that failed — never "the gate failed". */
  readonly failures: readonly GateFailure[];
}

/**
 * Can this phase be called complete?
 *
 * **Every failure names the requirement, task or finding responsible** (FRM-REQ-056). "The exit gate
 * failed" tells somebody to go looking; naming the three Musts with no task tells them what to do.
 *
 * Takes a transaction as readily as the client: the status rollup asks it from inside the
 * transaction that closed the phase's last task.
 */
export async function exitGate(
  db: TransactionClient,
  phaseHumanId: string,
): Promise<GateResult> {
  const phase = await db.phase.findFirst({
    where: { humanId: phaseHumanId, deletedAt: null },
    include: { project: { select: { id: true, code: true } } },
  });
  if (phase === null) throw new NotFound(phaseHumanId);

  const failures: GateFailure[] = [];

  // 1. Musts assigned to this phase that no task covers.
  const musts = await db.requirement.findMany({
    where: { phaseId: phase.id, deletedAt: null, priority: MUST },
    include: { tasks: { select: { task: { select: { deletedAt: true } } } } },
  });
  for (const must of musts) {
    if (must.tasks.filter((t) => t.task.deletedAt === null).length === 0) {
      failures.push({
        kind: 'uncovered-must',
        humanId: must.humanId,
        detail: `no task satisfies it — ${must.statement.slice(0, 90)}`,
      });
    }
  }

  // 2. Work in the phase that is neither done nor deliberately abandoned.
  const unfinished = await db.task.findMany({
    where: {
      phaseId: phase.id,
      deletedAt: null,
      status: { in: ['todo', 'in_progress', 'blocked'] },
    },
    orderBy: { humanId: 'asc' },
    select: { humanId: true, title: true, status: true, blockedReason: true },
  });
  for (const task of unfinished) {
    failures.push({
      kind: 'unfinished-task',
      humanId: task.humanId,
      detail:
        task.status === 'blocked'
          ? `blocked — ${task.blockedReason ?? 'no reason recorded'}`
          : `${task.status} — ${task.title}`,
    });
  }

  // 3. Criticals found during this phase and still open.
  const criticals = await db.finding.findMany({
    where: {
      phaseId: phase.id,
      deletedAt: null,
      status: 'open',
      severity: { in: ['critical', 'high'] },
    },
    orderBy: { humanId: 'asc' },
    select: { humanId: true, title: true, severity: true },
  });
  for (const finding of criticals) {
    failures.push({
      kind: 'open-critical',
      humanId: finding.humanId,
      detail: `${finding.severity} and still open — ${finding.title}`,
    });
  }

  // 4. Screens linked to the phase whose latest capture nobody has judged, or judged drifted-fix
  //    (FRM-REQ-200). A screen with no capture at all does not block here: nothing was built to
  //    judge, and "built but never captured" is the drift engine's to say (FRM-REQ-201).
  for (const screen of await screenStates(db, phase.project.id)) {
    if (!screen.phaseIds.has(phase.id) || screen.capture === null) continue;
    if (screen.capture.verdict === null) {
      failures.push({
        kind: 'screen-unreviewed',
        humanId: screen.humanId,
        detail: `${screen.name}: its latest capture has not been reviewed`,
      });
    } else if (screen.capture.verdict === 'drifted_fix') {
      failures.push({
        kind: 'screen-drifted',
        humanId: screen.humanId,
        detail: `${screen.name}: its latest capture is marked drifted-fix`,
      });
    }
  }

  return { phase: phaseHumanId, passed: failures.length === 0, failures };
}

export interface ScreenState {
  readonly humanId: string;
  readonly name: string;
  /**
   * The newest capture across every viewport and theme, and the newest verdict on it — or null for
   * a screen never captured. Only the latest counts: an old drifted-fix is history once a newer
   * capture exists, and the newer one starts unreviewed.
   */
  readonly capture: { readonly verdict: ScreenVerdictKind | null } | null;
  /** Phases the screen serves: through a task in the phase, or a requirement assigned to it. */
  readonly phaseIds: ReadonlySet<string>;
  /** Statuses of the linked tasks, for "built" (a done task) in the drift engine. */
  readonly taskStatuses: readonly TaskStatus[];
}

/**
 * Every live screen of a project with its latest capture's verdict and what it is linked to — the
 * one read the exit gate (FRM-REQ-200) and the drift engine (FRM-REQ-201) share, so a screen cannot
 * block a gate and not show as drift, or the reverse.
 *
 * Three queries however many screens there are. Only `relates` links count: a `cites` is a
 * component gap pointing at a design-system requirement, which says nothing about a phase.
 */
export async function screenStates(
  db: TransactionClient,
  projectId: string,
): Promise<ScreenState[]> {
  const screens = await db.screen.findMany({
    where: { projectId, deletedAt: null },
    orderBy: { seq: 'asc' },
    select: {
      id: true,
      humanId: true,
      name: true,
      versions: {
        where: { kind: 'capture' },
        // The id breaks a tie between two captures in one millisecond: UUIDv7 sorts by creation.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
        select: {
          verdicts: {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
            select: { verdict: true },
          },
        },
      },
    },
  });
  if (screens.length === 0) return [];

  // `link()` stores whichever direction it is given, so `foreman_link FRM-T-5 relates FRM-SCR-001`
  // is a task→screen row. Both directions are one link to a screen; reading only the
  // screen→X one would silently drop half of them from the gate and from drift.
  const screenIds = screens.map((s) => s.id);
  const rows = await db.reference.findMany({
    where: {
      kind: 'relates',
      OR: [
        { fromType: 'screen', fromId: { in: screenIds }, toType: { in: ['task', 'requirement'] } },
        { toType: 'screen', toId: { in: screenIds }, fromType: { in: ['task', 'requirement'] } },
      ],
    },
    select: { fromType: true, fromId: true, toType: true, toId: true },
  });
  const links = rows.map((r) =>
    r.fromType === 'screen'
      ? { screenId: r.fromId, otherType: r.toType, otherId: r.toId }
      : { screenId: r.toId, otherType: r.fromType, otherId: r.fromId },
  );
  const [tasks, requirements] = await Promise.all([
    db.task.findMany({
      where: {
        id: { in: links.filter((l) => l.otherType === 'task').map((l) => l.otherId) },
        deletedAt: null,
      },
      select: { id: true, phaseId: true, status: true },
    }),
    db.requirement.findMany({
      where: {
        id: { in: links.filter((l) => l.otherType === 'requirement').map((l) => l.otherId) },
        deletedAt: null,
      },
      select: { id: true, phaseId: true },
    }),
  ]);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const requirementById = new Map(requirements.map((r) => [r.id, r]));

  return screens.map((screen) => {
    const phaseIds = new Set<string>();
    const taskStatuses: TaskStatus[] = [];
    for (const l of links) {
      if (l.screenId !== screen.id) continue;
      if (l.otherType === 'task') {
        const task = taskById.get(l.otherId);
        if (task === undefined) continue;
        taskStatuses.push(task.status);
        if (task.phaseId !== null) phaseIds.add(task.phaseId);
      } else {
        const phaseId = requirementById.get(l.otherId)?.phaseId;
        if (phaseId !== null && phaseId !== undefined) phaseIds.add(phaseId);
      }
    }
    const latest = screen.versions[0];
    return {
      humanId: screen.humanId,
      name: screen.name,
      capture: latest === undefined ? null : { verdict: latest.verdicts[0]?.verdict ?? null },
      phaseIds,
      taskStatuses,
    };
  });
}

/** Thrown when a phase is asked to complete and the gate says no. Carries every reason. */
export class GateRefused extends Conflict {
  constructor(readonly result: GateResult) {
    super(
      `${result.phase} cannot be completed: ${String(result.failures.length)} ` +
        `${result.failures.length === 1 ? 'thing is' : 'things are'} in the way`,
    );
    this.name = 'GateRefused';
  }
}

/**
 * The traceability matrix (T-3.5, FRM-REQ-055) — generated, never maintained.
 *
 * One row per requirement, the tasks that satisfy it, and the phase it belongs to. This is the
 * document that used to be kept by hand and was wrong within a fortnight.
 */
export async function traceabilityMatrix(db: Db, code: string) {
  const project = await db.project.findFirst({ where: { code, deletedAt: null } });
  if (project === null) throw new NotFound(`project ${code}`);

  const requirements = await db.requirement.findMany({
    where: { projectId: project.id, deletedAt: null },
    orderBy: { seq: 'asc' },
    include: {
      phase: { select: { humanId: true, number: true, name: true } },
      tasks: {
        select: {
          task: { select: { humanId: true, title: true, status: true, deletedAt: true } },
        },
      },
    },
  });

  return requirements.map((requirement) => ({
    humanId: requirement.humanId,
    statement: requirement.statement,
    priority: requirement.priority,
    earsPattern: requirement.earsPattern,
    earsLintOk: requirement.earsLintOk,
    acceptanceTest: requirement.acceptanceTest,
    phase:
      requirement.phase === null
        ? null
        : {
            humanId: requirement.phase.humanId,
            number: requirement.phase.number.toString(),
            name: requirement.phase.name,
          },
    satisfiedBy: requirement.tasks
      .filter((t) => t.task.deletedAt === null)
      .map((t) => ({ humanId: t.task.humanId, title: t.task.title, status: t.task.status })),
  }));
}
