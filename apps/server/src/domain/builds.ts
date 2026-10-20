import {
  BUILD_CONCLUSION,
  buildCheckName,
  type BuildResultInput,
} from '@foreman/shared';
import type { Db } from '../db.js';
import type { BuildResult, CheckRun } from '../generated/prisma/client.js';
import { record, type Actor, type TransactionClient } from './audit.js';
import { Conflict, Invalid } from './errors.js';
import { findProject } from './projects.js';

/**
 * A build result from an authorized deployer, recorded as its commit's CI state (FRM-T-008,
 * FRM-REQ-182).
 *
 * **Its conclusion is written as a check run** — the same row a GitHub check becomes — named
 * `shipyard/build/<app>`. The brief's `ci`, the portfolio and the activity screen all read "the
 * latest completed check run", so they show a Shipyard build without knowing it came from anywhere
 * but GitHub.
 *
 * **Which builds have been heard of is a separate record**, `build_result`, unique on the build ID.
 * The check run cannot be that record: a rebuild of the same commit and app replaces its
 * conclusion, so once build B has superseded build A, the check run no longer says A was ever
 * seen — and a replay of A would re-apply A's result. A build ID found in `build_result` changes
 * nothing, however long ago it was posted and whatever has happened since.
 *
 * **Of two results for one commit and app, the one that finished later wins**, whatever order they
 * arrive in. An outbox drains in order only until it retries; a result that finished earlier than
 * the one already shown is recorded, and the check run keeps the newer conclusion.
 *
 * A commit Foreman has not ingested is accepted, not refused. A check run's SHA is deliberately not
 * a foreign key — GitHub's check runs arrive before their push as often as after — and ingest
 * writes no stub commit for them either. When the commit lands it is simply the commit that check
 * run was about. Refusing would make Shipyard's outbox retry a build forever whenever the GitHub
 * App was slow, and inventing a commit would put a row with no message or author in the history.
 */

/**
 * `created` — a new check run; `updated` — it replaced an older result on the check run;
 * `superseded` — recorded, but a result that finished later already stands; `unchanged` — this
 * build ID was recorded before, and nothing was written.
 */
export type BuildOutcome = 'created' | 'updated' | 'superseded' | 'unchanged';

export interface BuildRecorded {
  readonly outcome: BuildOutcome;
  /** The check run the build reports on, as it stands now. */
  readonly checkRun: CheckRun | null;
  readonly repo: string;
  /** Whether this build's result is the one its check run shows (or showed when it arrived). */
  readonly applied: boolean;
  /** Whether Foreman has ingested the commit itself yet. */
  readonly commitKnown: boolean;
}

type Seen = BuildResult & { repo: { fullName: string } };

export async function recordBuildResult(
  db: Db,
  actor: Actor,
  code: string,
  input: BuildResultInput,
): Promise<BuildRecorded> {
  const project = await findProject(db, code);
  if (input.project !== undefined && input.project.toUpperCase() !== project.code) {
    throw new Invalid(`this build names ${input.project}, but was posted to ${project.code}`, [
      { path: 'project', message: `must be ${project.code}, or left out` },
    ]);
  }

  // A replay is answered before anything else is resolved: the repositories may have changed since
  // it was first posted, and a replay must not start failing because of it.
  const earlier = await seen(db, input.buildId, project.id);
  if (earlier !== null) return replayed(db, earlier);

  const repo = await repoFor(db, project.id, project.code, input);
  const name = buildCheckName(input.app);
  const conclusion = BUILD_CONCLUSION[input.state];
  const completedAt = input.completedAt === undefined ? new Date() : new Date(input.completedAt);
  const startedAt = input.startedAt === undefined ? null : new Date(input.startedAt);

  return db.$transaction(async (tx) => {
    // Two posts of one build racing each other would both miss the lookup above; the lock makes
    // the second wait, and find the first below. Scoped to the transaction, so it is never left held.
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${`foreman:build:${input.buildId}`}))`;
    const raced = await seen(tx, input.buildId, project.id);
    if (raced !== null) return replayed(tx, raced);

    const key = { repoId_commitSha_name: { repoId: repo.id, commitSha: input.sha, name } };
    const before = await tx.checkRun.findUnique({ where: key });
    // Strictly later only: a result that finished at the same instant as the one shown is a
    // re-run reported twice, and the one reported last is the better guess.
    const stale =
      before?.completedAt !== null && before?.completedAt !== undefined && before.completedAt > completedAt;

    let checkRun: CheckRun;
    if (stale) {
      checkRun = before;
    } else {
      const fields = { conclusion, startedAt, completedAt, detailsUrl: input.url ?? null, externalId: input.buildId };
      // A rebuild of the same commit is a re-run of the same check, and replaces its conclusion —
      // what GitHub ingest does with a re-run, and what "is it green" means.
      checkRun = await tx.checkRun.upsert({
        where: key,
        create: { repoId: repo.id, commitSha: input.sha, name, ...fields },
        update: fields,
      });
      await record(tx, {
        ...actor,
        action: before === null ? 'create' : 'update',
        entityType: 'check_run',
        entityId: checkRun.id,
        entityHumanId: name,
        ...(before === null ? {} : { before }),
        after: checkRun,
      });
    }

    const build = await tx.buildResult.create({
      data: {
        buildId: input.buildId,
        projectId: project.id,
        repoId: repo.id,
        checkRunId: checkRun.id,
        app: input.app,
        commitSha: input.sha,
        state: input.state,
        conclusion,
        environment: input.environment ?? null,
        failedStage: input.failedStage ?? null,
        startedAt,
        completedAt,
        detailsUrl: input.url ?? null,
        applied: !stale,
      },
    });
    await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'build',
      entityId: build.id,
      entityHumanId: input.buildId,
      after: build,
    });

    return {
      outcome: stale ? 'superseded' : before === null ? 'created' : 'updated',
      checkRun,
      repo: repo.fullName,
      applied: !stale,
      commitKnown: await commitKnown(tx, repo.id, input.sha),
    };
  });
}

/**
 * The build already recorded under this ID, if any. A build ID is Shipyard's UUID and unique
 * across every project; one recorded for another project is a conflict, not a replay, and not
 * something to record a second time.
 */
async function seen(db: Db | TransactionClient, buildId: string, projectId: string): Promise<Seen | null> {
  const row = await db.buildResult.findUnique({
    where: { buildId },
    include: { repo: { select: { fullName: true } } },
  });
  if (row !== null && row.projectId !== projectId) {
    throw new Conflict(`build ${buildId} was already recorded for another project`);
  }
  return row;
}

async function replayed(db: Db | TransactionClient, build: Seen): Promise<BuildRecorded> {
  return {
    outcome: 'unchanged',
    checkRun:
      build.checkRunId === null ? null : await db.checkRun.findUnique({ where: { id: build.checkRunId } }),
    repo: build.repo.fullName,
    applied: build.applied,
    commitKnown: await commitKnown(db, build.repoId, build.commitSha),
  };
}

async function commitKnown(db: Db | TransactionClient, repoId: string, sha: string): Promise<boolean> {
  return (await db.commit.count({ where: { repoId, sha } })) > 0;
}

/**
 * Which of the project's repositories the commit belongs to.
 *
 * Named, it must be one of the project's own. Unnamed, it is the repository that already holds the
 * commit, or the project's only one. A project with several and a commit none of them has yet is
 * the one case that cannot be decided, and it is refused with what to send rather than guessed:
 * a check run on the wrong repository is a green light on code it never tested.
 */
async function repoFor(
  db: Db,
  projectId: string,
  code: string,
  input: BuildResultInput,
): Promise<{ id: string; fullName: string }> {
  const repos = await db.repo.findMany({
    where: { projectId, deletedAt: null },
    select: { id: true, fullName: true },
    orderBy: { fullName: 'asc' },
  });

  if (input.repo !== undefined) {
    const named = repos.find((r) => r.fullName.toLowerCase() === input.repo?.toLowerCase());
    if (named === undefined) {
      throw new Invalid(`${input.repo} is not a repository linked to ${code}`, [
        { path: 'repo', message: `link it to ${code} first, or name one of its repositories` },
      ]);
    }
    return named;
  }

  if (repos.length === 0) {
    throw new Invalid(`${code} has no linked repository, so a build has nowhere to be recorded`, [
      { path: 'repo', message: `link the repository to ${code} first` },
    ]);
  }
  if (repos.length === 1 && repos[0] !== undefined) return repos[0];

  const holding = await db.commit.findFirst({
    where: { sha: input.sha, repoId: { in: repos.map((r) => r.id) } },
    select: { repoId: true },
  });
  const found = repos.find((r) => r.id === holding?.repoId);
  if (found !== undefined) return found;

  throw new Invalid(
    `${code} links ${String(repos.length)} repositories and none has ${input.sha.slice(0, 7)} yet, so name the one that was built`,
    [{ path: 'repo', message: `one of ${repos.map((r) => r.fullName).join(', ')}` }],
  );
}
