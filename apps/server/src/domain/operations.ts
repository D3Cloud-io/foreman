import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../db.js';

/**
 * Operations: what Foreman is made of, and whether Foreman itself is well (T-7.3, T-7.4).
 */

// ─── Tech inventory (T-7.3, FRM-REQ-130, FRM-REQ-131) ───────────────────────

export interface TechRow {
  readonly name: string;
  readonly category: string;
  readonly version: string | null;
  readonly role: string | null;
  readonly projects: { code: string; version: string | null }[];
}

/**
 * Every technology, and which projects use it at which version.
 *
 * Read across projects rather than per project, because the question that matters is "who else is
 * on Postgres 16" — a per-project list is just the manifest you already have.
 */
export async function techInventory(db: Db): Promise<TechRow[]> {
  const items = await db.techItem.findMany({
    where: { deletedAt: null, project: { deletedAt: null } },
    include: { project: { select: { code: true } } },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  });

  const byName = new Map<string, TechRow>();
  for (const item of items) {
    const existing = byName.get(item.name);
    const use = { code: item.project.code, version: item.version };

    byName.set(
      item.name,
      existing === undefined
        ? {
            name: item.name,
            category: item.category,
            version: item.version,
            role: item.role,
            projects: [use],
          }
        : { ...existing, projects: [...existing.projects, use] },
    );
  }

  return [...byName.values()].sort(
    (a, b) => b.projects.length - a.projects.length || a.name.localeCompare(b.name),
  );
}

/**
 * Versions of one technology that disagree across projects.
 *
 * The reason an inventory is worth keeping: four projects on three versions of the same thing is a
 * fact nobody notices until one of them cannot be upgraded.
 */
export function versionSpread(rows: readonly TechRow[]): TechRow[] {
  return rows.filter((row) => {
    const versions = new Set(row.projects.map((p) => p.version ?? 'unknown'));
    return versions.size > 1;
  });
}

// ─── Health (T-7.4, FRM-REQ-142) ───────────────────────────────────────────

export interface Health {
  readonly queue: {
    readonly queued: number;
    readonly running: number;
    /** Failed jobs still standing: see `standingFailures`. */
    readonly failed: number;
    /** The oldest thing still waiting. A queue with depth 3 and an eight-hour-old head is stalled. */
    readonly oldestQueuedAt: string | null;
    readonly stalled: boolean;
  };
  readonly stageFailures: { jobKind: string; stage: string; error: string; at: string }[];
  readonly lastIngest: string | null;
  readonly lastReconcile: string | null;
  readonly lastBackup: { at: string; path: string; bytes: number } | null;
  readonly lastRestoreDrill: string | null;
  /** Everything above, reduced to the one question: is anything wrong? */
  readonly ok: boolean;
  readonly problems: string[];
}

/** A queue whose head has waited this long is not busy, it is stuck. */
const STALL_AFTER_MS = 30 * 60 * 1000;

/** A backup older than this means last night's did not run. */
const BACKUP_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

/**
 * Failed jobs that nothing has since put right (FRM-T-18.18).
 *
 * A failed job stops counting once a later job of the same kind, about the same subject, has
 * succeeded: tonight's reconcile of a repository answers last night's failed one, and nothing
 * else does. The subject is the repository a job reads (`payload.repoId`) where it has one; a job
 * with none, like the nightly dump, is answered by the next of its kind. Nothing retries or
 * clears a failed row, so counting every one ever kept `/health` red over a single old failure,
 * and with it every deploy that probes it.
 */
export async function standingFailures(db: Db): Promise<number> {
  const [row] = await db.$queryRaw<{ count: bigint }[]>`
    select count(*) as count from job failed
    where failed.status = 'failed'
      and not exists (
        select 1 from job later
        where later.kind = failed.kind
          and later.status = 'succeeded'
          and later.payload->>'repoId' is not distinct from failed.payload->>'repoId'
          and coalesce(later.finished_at, later.updated_at) > coalesce(failed.finished_at, failed.updated_at)
      )`;
  return Number(row?.count ?? 0);
}

export interface HealthOptions {
  readonly backupDir?: string | undefined;
  readonly now?: Date | undefined;
}

export async function health(db: Db, options: HealthOptions = {}): Promise<Health> {
  const now = options.now ?? new Date();

  const [queued, running, failed, oldest, lastIngestJob, lastReconcileJob, failures] =
    await Promise.all([
      db.job.count({ where: { status: 'queued' } }),
      db.job.count({ where: { status: 'running' } }),
      standingFailures(db),
      db.job.findFirst({
        where: { status: 'queued' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      db.job.findFirst({
        where: { kind: { startsWith: 'ingest' }, status: 'succeeded' },
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true },
      }),
      db.job.findFirst({
        where: { kind: 'reconcile-repo', status: 'succeeded' },
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true },
      }),
      db.jobStage.findMany({
        where: { status: 'failed' },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        include: { job: { select: { kind: true } } },
      }),
    ]);

  const stalled =
    oldest !== null && now.getTime() - oldest.createdAt.getTime() > STALL_AFTER_MS;

  const lastBackup = await latestBackup(options.backupDir);
  const lastDrill = await db.job.findFirst({
    where: { kind: 'restore-drill', status: 'succeeded' },
    orderBy: { updatedAt: 'desc' },
    select: { updatedAt: true },
  });

  const problems: string[] = [];
  if (stalled) {
    problems.push(
      `The queue has not moved: its oldest job has waited since ${oldest.createdAt.toISOString()}.`,
    );
  }
  if (failed > 0) problems.push(`${String(failed)} job${failed === 1 ? '' : 's'} failed.`);
  if (lastBackup === null) {
    problems.push('No database dump has ever been taken.');
  } else if (now.getTime() - new Date(lastBackup.at).getTime() > BACKUP_STALE_AFTER_MS) {
    problems.push(`The most recent dump is from ${lastBackup.at.slice(0, 10)}.`);
  }
  if (lastDrill === null) {
    // R-04: after cutover the dump and this drill are the entire recovery story, and an untested
    // backup is not a backup.
    problems.push('No restore drill has been performed. An untested backup is not a backup.');
  }

  return {
    queue: {
      queued,
      running,
      failed,
      oldestQueuedAt: oldest?.createdAt.toISOString() ?? null,
      stalled,
    },
    stageFailures: failures.map((stage) => ({
      jobKind: stage.job.kind,
      stage: stage.name,
      error: (stage.lastError ?? '').slice(0, 300),
      at: stage.updatedAt.toISOString(),
    })),
    lastIngest: lastIngestJob?.updatedAt.toISOString() ?? null,
    lastReconcile: lastReconcileJob?.updatedAt.toISOString() ?? null,
    lastBackup,
    lastRestoreDrill: lastDrill?.updatedAt.toISOString() ?? null,
    ok: problems.length === 0,
    problems,
  };
}

/** The newest dump on disk. Read from the directory rather than from a table: the file is truth. */
async function latestBackup(
  dir: string | undefined,
): Promise<{ at: string; path: string; bytes: number } | null> {
  if (dir === undefined) return null;

  try {
    const entries = await readdir(dir);
    const dumps = entries.filter((name) => name.endsWith('.sql') || name.endsWith('.sql.gz'));
    if (dumps.length === 0) return null;

    const stats = await Promise.all(
      dumps.map(async (name) => {
        const path = join(dir, name);
        const info = await stat(path);
        return { at: info.mtime.toISOString(), path, bytes: info.size };
      }),
    );
    return stats.sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
  } catch {
    // An unreadable backup directory is itself worth surfacing, and `problems` says so above.
    return null;
  }
}
