import type { GroupAccent, ScopedGuidelineSummary } from '@foreman/shared';
import type { Db } from '../db.js';
import { phaseInFlight } from './wherewestand.js';
import { driftFor, type DriftCategory } from './drift.js';
import { NotFound } from './errors.js';
import { findGroup, listGroups } from './groups.js';
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
      const [phase, open, blocked, done, cancelled, criticals, check, unconfirmed, drift, lastCommit] =
        await Promise.all([
          // The same definition the brief uses. Taking `status: 'active'` alone said `null` for
          // every one of the nine projects imported at the cutover, while the brief beside it
          // named a phase for each — one question, two surfaces, two answers.
          phaseInFlight(db, project.id),
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

const UNGROUPED = 'ungrouped';

export async function groupedPortfolio(db: Db, groupRef?: string): Promise<Portfolio> {
  const ref = groupRef?.trim();
  const narrowed = ref === undefined || ref.length === 0 ? undefined : ref;
  const onlyUngrouped = narrowed?.toLowerCase() === UNGROUPED;
  const only = narrowed === undefined || onlyUngrouped ? null : await findGroup(db, narrowed);
  if (narrowed !== undefined && !onlyUngrouped && only === null) {
    throw new NotFound(`group ${narrowed}`);
  }

  const listing = await listGroups(db);
  const sections = listing.items.filter((group) => only === null || group.id === only.id);
  const wanted =
    narrowed === undefined
      ? undefined
      : (onlyUngrouped ? listing.ungrouped.projects : (sections[0]?.projects ?? [])).map((p) => p.code);

  const [rows, guidelines] = await Promise.all([
    portfolio(db, wanted),
    scopedGuidelineSummaries(
      db,
      narrowed === undefined ? undefined : { groupId: only === null ? null : only.id },
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
