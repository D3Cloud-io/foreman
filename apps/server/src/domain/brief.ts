import type { GuidelineSummary } from '@foreman/shared';
import type { Db, Prisma } from '../db.js';
import { driftFor, type DriftCategory } from './drift.js';
import { NotFound } from './errors.js';
import { activeGuidelineSummaries } from './guidelines.js';
import { phaseInFlight } from './wherewestand.js';

/**
 * The session brief (FRM-REQ-082, FRM-REQ-083, FRM-REQ-092) — the most-used path in the system.
 *
 * It replaces what `/start-development` does by reading a dozen files: one call, a few hundred
 * tokens, and work begins from accurate state rather than from a multi-file read.
 *
 * Two rules shape everything here:
 *
 * 1. **A blocked task never appears among the next tasks.** "What should I work on" that answers
 *    with something you cannot work on is worse than no answer, because it costs the reader the
 *    time to find out.
 * 2. **An unconfirmed attribution is never truth** (ADR-005). Nothing below counts a
 *    `commit_task` row with `confirmed = false`: a file-path coincidence must never make work look
 *    complete, and the brief is exactly where that lie would be believed.
 */

/** What the brief will return at most, per list. The budget is the feature, not a limitation. */
const NEXT_TASKS = 5;
const CRITICAL_FINDINGS = 5;
const RECENT_COMMITS = 3;

/**
 * A `todo` task is ready when nothing it depends on is still unfinished (FRM-REQ-179). Done and
 * cancelled both release it — a cancelled prerequisite is one nobody is going to do, and holding
 * its dependents forever would hide them. A deleted one releases it for the same reason.
 *
 * `in_progress` is deliberately not held back: someone started it, and the brief saying so is the
 * truth even when they started early.
 */
const READY = {
  dependsOn: { none: { dependsOn: { deletedAt: null, status: { notIn: ['done', 'cancelled'] } } } },
} as const satisfies Prisma.TaskWhereInput;

export interface Brief {
  readonly project: {
    readonly code: string;
    readonly name: string;
    readonly lifecycle: string;
    readonly pitch: string | null;
  };
  readonly activePhase: {
    readonly humanId: string;
    readonly number: string;
    readonly name: string;
    readonly objective: string | null;
    readonly exitDemo: string | null;
    /** A cancelled task is closed, like a done one: a phase of done and cancelled work is 100%. */
    readonly tasks: { readonly done: number; readonly cancelled: number; readonly total: number };
  } | null;
  /** Ready to pick up: never blocked, never done, never waiting on an unfinished dependency. */
  readonly nextTasks: readonly {
    readonly humanId: string;
    readonly title: string;
    readonly status: string;
    readonly size: string | null;
    readonly doneWhen: string | null;
    /**
     * Whether the task has a body to read. The body itself stays out — the brief is read every
     * session and kept short; `foreman_get` on the task returns it.
     */
    readonly hasBody: boolean;
    readonly requirements: readonly string[];
  }[];
  /**
   * `todo` tasks in the active phase held back because something they depend on is unfinished. A
   * count, not a list: they are not actionable, and `foreman_get` on the phase shows the graph.
   */
  readonly waitingOnDependencies: number;
  /** Named separately, because a blocked task is a thing to unblock, not a thing to do. */
  readonly blocked: readonly {
    readonly humanId: string;
    readonly title: string;
    readonly reason: string | null;
  }[];
  readonly openCriticals: readonly {
    readonly humanId: string;
    readonly severity: string;
    readonly title: string;
    readonly location: string | null;
  }[];
  readonly ci: {
    readonly conclusion: string | null;
    readonly commitSha: string | null;
    readonly at: string | null;
    /** True when nothing has been ingested — "unknown" is an honest answer, not a failure. */
    readonly unknown: boolean;
  };
  /**
   * Attributions waiting to be confirmed or rejected. Proposals, not facts (ADR-005) — and not
   * drift, which is why it sits beside the breakdown rather than inside it: a number inside
   * `drift` that the total does not include is exactly the disagreement below exists to prevent.
   */
  readonly unconfirmedAttributions: number;
  readonly drift: {
    /**
     * The drift engine's own count per category — the same `counts` the drift screen shows.
     *
     * Until 2026-09-24 this was three counts the brief computed for itself beside a total it read
     * from the engine: DI reported `0 / 0 / 0` over a total of 204 (199 tasks citing nothing, five
     * uncited ADRs), and once those were fixed, five uncovered requirements over a total of 0 — all
     * five Won'ts, which drift rightly does not count. A breakdown that does not sum to its total is
     * two answers to one question.
     */
    readonly counts: Readonly<Record<DriftCategory, number>>;
    /**
     * Everything the drift engine finds, as one number (FRM-REQ-128). The sum of `counts`.
     *
     * Read from the same engine the drift screen and the portfolio badge use, so the three can
     * never disagree — and two of Foreman's own numbers disagreeing is the fastest way for it to
     * stop being believed.
     */
    readonly total: number;
  };
  readonly recentCommits: readonly {
    readonly sha: string;
    readonly message: string;
    readonly at: string;
  }[];
  /**
   * The ecosystem's standing decisions (FRM-REQ-187): every active guideline, as its ID, title and
   * decision. Here so that the one call a session starts with also tells it the house rules —
   * `foreman_get GL-004` has the reasoning. Identical in every project's brief, and budgeted on its
   * own (`GUIDELINES_TOKEN_BUDGET`) rather than against the project's state.
   */
  readonly guidelines: readonly GuidelineSummary[];
}

export async function buildBrief(db: Db, code: string): Promise<Brief> {
  const project = await db.project.findFirst({ where: { code, deletedAt: null } });
  if (project === null) throw new NotFound(`project ${code}`);

  // One definition, shared with the portfolio. See `wherewestand.ts` for why it is not inline.
  const activePhase = await phaseInFlight(db, project.id);

  const [nextTasks, waiting, blocked, criticals, latestCheck, unconfirmed, drift, commits] =
    await Promise.all([
      db.task.findMany({
        where: {
          projectId: project.id,
          deletedAt: null,
          // Never blocked, and never waiting on unfinished work. This is the requirement,
          // expressed where it is enforced.
          OR: [{ status: 'in_progress' }, { status: 'todo', ...READY }],
          ...(activePhase === null ? {} : { phaseId: activePhase.id }),
        },
        orderBy: [{ status: 'desc' }, { sortOrder: 'asc' }],
        take: NEXT_TASKS,
        include: { requirements: { select: { requirement: { select: { humanId: true } } } } },
      }),
      db.task.count({
        where: {
          projectId: project.id,
          deletedAt: null,
          status: 'todo',
          NOT: READY,
          ...(activePhase === null ? {} : { phaseId: activePhase.id }),
        },
      }),
      db.task.findMany({
        where: { projectId: project.id, deletedAt: null, status: 'blocked' },
        orderBy: { sortOrder: 'asc' },
        take: NEXT_TASKS,
        select: { humanId: true, title: true, blockedReason: true },
      }),
      db.finding.findMany({
        where: {
          projectId: project.id,
          deletedAt: null,
          status: 'open',
          severity: { in: ['critical', 'high'] },
        },
        orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
        take: CRITICAL_FINDINGS,
        select: {
          humanId: true,
          severity: true,
          title: true,
          locationRaw: true,
        },
      }),
      db.checkRun.findFirst({
        where: { repo: { projectId: project.id }, completedAt: { not: null } },
        orderBy: { completedAt: 'desc' },
        select: { conclusion: true, commitSha: true, completedAt: true },
      }),
      db.commitTask.count({
        where: {
          confirmed: false,
          rejectedAt: null,
          task: { projectId: project.id, deletedAt: null },
        },
      }),
      driftFor(db, project.code),
      db.commit.findMany({
        where: { repo: { projectId: project.id } },
        orderBy: { committedAt: 'desc' },
        take: RECENT_COMMITS,
        select: { sha: true, message: true, committedAt: true },
      }),
    ]);

  const phaseTasks =
    activePhase === null
      ? { done: 0, cancelled: 0, total: 0 }
      : {
          done: await db.task.count({
            where: { phaseId: activePhase.id, status: 'done', deletedAt: null },
          }),
          cancelled: await db.task.count({
            where: { phaseId: activePhase.id, status: 'cancelled', deletedAt: null },
          }),
          total: await db.task.count({ where: { phaseId: activePhase.id, deletedAt: null } }),
        };

  return {
    project: {
      code: project.code,
      name: project.name,
      lifecycle: project.lifecycle,
      pitch: project.pitch,
    },
    activePhase:
      activePhase === null
        ? null
        : {
            humanId: activePhase.humanId,
            number: activePhase.number.toString(),
            name: activePhase.name,
            objective: activePhase.objective,
            exitDemo: activePhase.exitDemo,
            tasks: phaseTasks,
          },
    nextTasks: nextTasks.map((task) => ({
      humanId: task.humanId,
      title: task.title,
      status: task.status,
      size: task.size,
      doneWhen: task.doneWhen,
      hasBody: task.body !== null,
      requirements: task.requirements.map((r) => r.requirement.humanId),
    })),
    waitingOnDependencies: waiting,
    blocked: blocked.map((task) => ({
      humanId: task.humanId,
      title: task.title,
      reason: task.blockedReason,
    })),
    openCriticals: criticals.map((finding) => ({
      humanId: finding.humanId,
      severity: finding.severity,
      title: finding.title,
      // The raw location, as written. It may name several files; the brief shows what the
      // author wrote rather than the first row of a parse.
      location: finding.locationRaw,
    })),
    ci: {
      conclusion: latestCheck?.conclusion ?? null,
      commitSha: latestCheck?.commitSha ?? null,
      at: latestCheck?.completedAt?.toISOString() ?? null,
      // Grey, not red: nothing ingested is not the same as a failing build.
      unknown: latestCheck === null,
    },
    unconfirmedAttributions: unconfirmed,
    drift: { counts: drift.counts, total: drift.total },
    recentCommits: commits.map((commit) => ({
      sha: commit.sha.slice(0, 7),
      message: commit.message.split('\n')[0] ?? '',
      at: commit.committedAt.toISOString(),
    })),
    guidelines: await activeGuidelineSummaries(db),
  };
}

/**
 * A rough token count for the brief, used by the test that keeps it inside its budget.
 *
 * Four characters per token is the usual approximation for English JSON, and it is deliberately
 * crude: the point is to notice a brief that has doubled, not to bill anybody for it.
 */
export function approximateTokens(payload: unknown): number {
  return Math.ceil(JSON.stringify(payload).length / 4);
}

/** The ceiling. A brief that costs more than this has stopped being a brief. */
export const BRIEF_TOKEN_BUDGET = 900;

/**
 * The guidelines' own ceiling, separate from the brief's. They are the same in every brief and grow
 * with the ecosystem rather than with a project, so counting them against the project's budget
 * would make every project's brief fail the day somebody writes a twentieth rule. Exceeding this
 * one means the decisions have stopped being one-liners.
 */
export const GUIDELINES_TOKEN_BUDGET = 1500;
