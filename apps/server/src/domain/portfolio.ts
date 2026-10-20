import type { GroupAccent, ScopedGuidelineSummary } from '@foreman/shared';
import type { Db, Prisma } from '../db.js';
import { phaseInFlight } from './wherewestand.js';
import { driftFor, type DriftCategory } from './drift.js';
import { listGroups } from './groups.js';
import { resolveScope, scopeCodes } from './scope.js';
import { scopedGuidelineSummaries } from './guidelines.js';

/**
 * The portfolio — one row per project, answering "where is everything" at a glance
 * (FRM-REQ-133).
 *
 * **Every column is populated or explicitly unknown.** A blank cell and a zero mean different
 * things, and a portfolio that renders "0 criticals" for a project nothing has ever been ingested
 * for is worse than one that says it does not know: the first is a wrong answer delivered
 * confidently.
 */

export interface PortfolioRow {
  readonly code: string;
  readonly name: string;
  readonly lifecycle: string;
  /** The family it belongs to (FRM-ADR-024), by the names a link uses, or null for none. */
  readonly group: PortfolioGroupRef | null;
  readonly phase: { readonly humanId: string; readonly number: string; readonly name: string } | null;
  readonly tasks: {
    readonly open: number;
    readonly blocked: number;
    readonly done: number;
    /** Closed like `done`. Left out, a project of done and cancelled work read as unfinished. */
    readonly cancelled: number;
  };
  readonly openCriticals: number;
  readonly ci: { readonly conclusion: string | null; readonly unknown: boolean };
  /**
   * CI as the ledger says it, in three words (FRM-REQ-245): `never` is a project nothing was ever
   * ingested for — not passing, not failing, not asked. Derived from `ci`, so the two cannot
   * disagree.
   */
  readonly ciState: CiState;
  /**
   * The first thing to pick up in the active phase, or null (FRM-REQ-245). The brief's own first
   * next task: an in-progress task first, then a todo with nothing unfinished under it, never a
   * blocked one — see `nextTaskFor`.
   */
  readonly nextTask: { readonly humanId: string; readonly title: string } | null;
  /**
   * What is running, and how far main has moved on. Null when nothing has been recorded as
   * deployed. `ahead` is the commits on the project's repos made after the deployed one, or null
   * when the deployed SHA is not a commit Foreman knows — unknown, which is not zero.
   */
  readonly deployed: {
    readonly sha: string;
    readonly at: string;
    readonly ahead: number | null;
  } | null;
  /** Proposals awaiting review (ADR-005). Not drift, so not inside it — see `Brief`. */
  readonly unconfirmedAttributions: number;
  readonly drift: {
    /** The drift engine's own per-category counts; they sum to `total`. */
    readonly counts: Readonly<Record<DriftCategory, number>>;
    /** The badge (FRM-REQ-127). The same engine the drift screen reads, so they cannot disagree. */
    readonly total: number;
  };
  readonly lastActivityAt: string | null;
}

export type CiState = 'passing' | 'failing' | 'never';

/** A run that failed. The console's `readCi` says the same two words, and so does this. */
export function ciStateOf(ci: { conclusion: string | null; unknown: boolean }): CiState {
  if (ci.unknown) return 'never';
  return ci.conclusion === 'failure' || ci.conclusion === 'timed_out' ? 'failing' : 'passing';
}

/**
 * A `todo` task is ready when nothing it depends on is unfinished — the brief's own `READY`
 * (FRM-REQ-179), written out here because that constant is not exported. `portfolio.test.ts`
 * asserts the two pick the same task, so a change to one that misses the other fails there.
 */
const READY = {
  dependsOn: { none: { dependsOn: { deletedAt: null, status: { notIn: ['done', 'cancelled'] } } } },
} as const satisfies Prisma.TaskWhereInput;

/** The first next task the brief would name for a project in `phaseId`, or null. */
async function nextTaskFor(
  db: Db,
  projectId: string,
  phaseId: string | null,
): Promise<{ humanId: string; title: string } | null> {
  const task = await db.task.findFirst({
    where: {
      projectId,
      deletedAt: null,
      OR: [{ status: 'in_progress' }, { status: 'todo', ...READY }],
      ...(phaseId === null ? {} : { phaseId }),
    },
    orderBy: [{ status: 'desc' }, { sortOrder: 'asc' }],
    select: { humanId: true, title: true },
  });
  return task;
}

/** The newest deployment, and how many commits on main are newer than the one it shipped. */
async function deployedFor(db: Db, projectId: string): Promise<PortfolioRow['deployed']> {
  const latest = await db.deployment.findFirst({
    where: { projectId },
    orderBy: { deployedAt: 'desc' },
    select: { imageSha: true, deployedAt: true },
  });
  if (latest === null) return null;

  // An image tag can read `sha-abc1234`, and is often the short form of the commit.
  const sha = latest.imageSha.replace(/^sha-/, '').toLowerCase();
  const shipped =
    sha.length < 7
      ? null
      : await db.commit.findFirst({
          where: { repo: { projectId }, sha: { startsWith: sha }, orphanedAt: null },
          orderBy: { committedAt: 'desc' },
          select: { committedAt: true },
        });
  const ahead =
    shipped === null
      ? null
      : await db.commit.count({
          where: { repo: { projectId }, orphanedAt: null, committedAt: { gt: shipped.committedAt } },
        });
  return { sha: latest.imageSha, at: latest.deployedAt.toISOString(), ahead };
}

export async function portfolio(db: Db, codes?: string[]): Promise<PortfolioRow[]> {
  const projects = await db.project.findMany({
    where: { deletedAt: null, ...(codes === undefined ? {} : { code: { in: codes } }) },
    orderBy: { code: 'asc' },
    include: { group: { select: { humanId: true, name: true, slug: true, accent: true, deletedAt: true } } },
  });

  // One round trip per project is acceptable at this scale — there are twenty of them, not twenty
  // thousand — and it keeps each column's meaning legible. If that ever changes, this is one query.
  return Promise.all(
    projects.map(async (project): Promise<PortfolioRow> => {
      const phaseRead = phaseInFlight(db, project.id);
      const [
        phase,
        open,
        blocked,
        done,
        cancelled,
        criticals,
        check,
        unconfirmed,
        drift,
        lastCommit,
        deployed,
        nextTask,
      ] = await Promise.all([
          // The same definition the brief uses. Taking `status: 'active'` alone said `null` for
          // every one of the nine projects imported at the cutover, while the brief beside it
          // named a phase for each — one question, two surfaces, two answers.
          phaseRead,
          db.task.count({
            where: {
              projectId: project.id,
              deletedAt: null,
              status: { in: ['todo', 'in_progress'] },
            },
          }),
          db.task.count({ where: { projectId: project.id, deletedAt: null, status: 'blocked' } }),
          db.task.count({ where: { projectId: project.id, deletedAt: null, status: 'done' } }),
          db.task.count({ where: { projectId: project.id, deletedAt: null, status: 'cancelled' } }),
          db.finding.count({
            where: {
              projectId: project.id,
              deletedAt: null,
              status: 'open',
              severity: { in: ['critical', 'high'] },
            },
          }),
          db.checkRun.findFirst({
            where: { repo: { projectId: project.id }, completedAt: { not: null } },
            orderBy: { completedAt: 'desc' },
            select: { conclusion: true },
          }),
          // Unconfirmed only — a proposal is not progress (ADR-005).
          db.commitTask.count({
            where: {
              confirmed: false,
              rejectedAt: null,
              task: { projectId: project.id, deletedAt: null },
            },
          }),
          driftFor(db, project.code),
          db.commit.findFirst({
            where: { repo: { projectId: project.id } },
            orderBy: { committedAt: 'desc' },
            select: { committedAt: true },
          }),
          deployedFor(db, project.id),
          phaseRead.then((p) => nextTaskFor(db, project.id, p?.id ?? null)),
        ]);

      return {
        code: project.code,
        name: project.name,
        lifecycle: project.lifecycle,
        group:
          project.group === null || project.group.deletedAt !== null
            ? null
            : {
                humanId: project.group.humanId,
                name: project.group.name,
                slug: project.group.slug,
                accent: project.group.accent,
              },
        phase:
          phase === null
            ? null
            : { humanId: phase.humanId, number: phase.number.toString(), name: phase.name },
        tasks: { open, blocked, done, cancelled },
        openCriticals: criticals,
        ci: {
          conclusion: check?.conclusion ?? null,
          // Grey, not green: never ingested is not the same as passing.
          unknown: check === null,
        },
        ciState: ciStateOf({ conclusion: check?.conclusion ?? null, unknown: check === null }),
        nextTask,
        deployed,
        unconfirmedAttributions: unconfirmed,
        drift: { counts: drift.counts, total: drift.total },
        lastActivityAt: lastCommit?.committedAt.toISOString() ?? null,
      };
    }),
  );
}

/** A group as a portfolio row names it. */
export interface PortfolioGroupRef {
  readonly humanId: string;
  readonly name: string;
  readonly slug: string;
  readonly accent: GroupAccent;
}

/** One section of the grouped portfolio: a group, and its projects' rows in the group's order. */
export interface PortfolioGroup {
  readonly humanId: string;
  readonly name: string;
  readonly slug: string;
  readonly accent: GroupAccent;
  readonly siteUrl: string | null;
  readonly projects: readonly PortfolioRow[];
}

/** The projects in no group, listed last. Not a group: it has no ID. */
export interface PortfolioUngrouped {
  readonly humanId: null;
  readonly name: 'Ungrouped';
  readonly slug: 'ungrouped';
  readonly projects: readonly PortfolioRow[];
}

/**
 * `GET /api/portfolio` (FRM-REQ-133, FRM-REQ-237).
 *
 * `items` is the flat list it always was, in code order, so a reader that predates groups — the
 * console's dashboard and D3 Constellation's portfolio both decode `items` — reads the same answer.
 * `groups` and `ungrouped` are the same rows again, sectioned: every live group in its order with
 * its projects in theirs, and the projects in no group last (FRM-REQ-226).
 *
 * `guidelines` carries each active guideline with its scope (FRM-ADR-024).
 *
 * Narrowed to a group, everything is that group's: `items` and `groups` hold only it, `ungrouped`
 * is null, and `guidelines` are the ones that apply to it. Narrowed to `ungrouped`, `groups` is
 * empty and `guidelines` are the ones for every project. An unknown group is a 404.
 */
export interface Portfolio {
  readonly items: readonly PortfolioRow[];
  readonly nextCursor: null;
  readonly total: number;
  readonly groups: readonly PortfolioGroup[];
  readonly ungrouped: PortfolioUngrouped | null;
  readonly guidelines: readonly ScopedGuidelineSummary[];
}

export async function groupedPortfolio(db: Db, groupRef?: string): Promise<Portfolio> {
  // The same resolution findings, search and drift take (FRM-T-17.4): one meaning of a scope.
  const scope = await resolveScope(db, groupRef);
  const only = scope.kind === 'group' ? scope.group : null;
  const onlyUngrouped = scope.kind === 'ungrouped';

  const listing = await listGroups(db);
  const sections = listing.items.filter((group) => only === null || group.id === only.id);
  const wanted = scopeCodes(scope)?.slice();

  const [rows, guidelines] = await Promise.all([
    portfolio(db, wanted),
    scopedGuidelineSummaries(
      db,
      scope.kind === 'all' ? undefined : { groupId: only === null ? null : only.id },
    ),
  ]);
  const byCode = new Map(rows.map((row) => [row.code, row]));
  const rowsOf = (codes: readonly { code: string }[]): PortfolioRow[] =>
    codes.flatMap((p) => {
      const row = byCode.get(p.code);
      return row === undefined ? [] : [row];
    });

  return {
    items: rows,
    nextCursor: null,
    total: rows.length,
    groups: onlyUngrouped
      ? []
      : sections.map((group) => ({
          humanId: group.humanId,
          name: group.name,
          slug: group.slug,
          accent: group.accent,
          siteUrl: group.siteUrl,
          projects: rowsOf(group.projects),
        })),
    ungrouped:
      only === null
        ? { humanId: null, name: 'Ungrouped', slug: 'ungrouped', projects: rowsOf(listing.ungrouped.projects) }
        : null,
    guidelines,
  };
}
