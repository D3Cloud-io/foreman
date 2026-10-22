import { Router } from 'express';
import { requireAuth, requireScope } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { NotFound } from '../domain/errors.js';
import { driftFor, type DriftItem } from '../domain/drift.js';
import { handler, param } from './helpers.js';

/**
 * The reality behind a plan item (FRM-REQ-247): the commits, the CI results and the deployments
 * that bear on one task — or, for a requirement, on every task that satisfies it.
 *
 * `GET /api/tasks/:humanId/reality` and `GET /api/requirements/:humanId/reality`. Read-only.
 *
 * **Two kinds of attribution are returned, and each says which it is.** A confirmed one is
 * evidence; a proposed one (`confirmed: false`, not rejected) is a suggestion awaiting a person
 * (ADR-005), listed so it can be reviewed and never counted as truth. A rejected one is not
 * returned at all. An orphaned commit — a force push removed it from the remote — is history that
 * no longer exists and is left out.
 */

export interface RealityCommit {
  readonly sha: string;
  /** The first line of the message. */
  readonly message: string;
  readonly committedAt: string;
  readonly repo: string;
  /** The task this commit is attributed to — several, when a requirement's tasks share one. */
  readonly task: string;
  readonly source: string;
  readonly confidence: number;
  readonly confirmed: boolean;
  /** Which paths overlapped, or which ID the message declared. */
  readonly evidence: unknown;
  /** The deployment that shipped it, or null when none has (yet). Listed for a suggestion too, but only confirmed commits put a deployment under `deployments`. */
  readonly shippedIn: string | null;
}

export interface RealityCheck {
  readonly commitSha: string;
  readonly name: string;
  readonly conclusion: string | null;
  readonly completedAt: string | null;
  readonly detailsUrl: string | null;
}

export interface RealityDeployment {
  readonly id: string;
  readonly environment: string;
  readonly image: string;
  readonly imageSha: string;
  readonly deployedAt: string;
  /** `declared`: the deploy named the task. `image`: its image is at or after a commit of the task. */
  readonly via: 'declared' | 'image';
}

export interface Reality {
  readonly humanId: string;
  readonly commits: readonly RealityCommit[];
  readonly checks: readonly RealityCheck[];
  readonly deployments: readonly RealityDeployment[];
  /** The drift engine's own lines about this record — a stale task, a coverage hole. */
  readonly drift: readonly Pick<DriftItem, 'category' | 'detail'>[];
}

/** How many of the project's newest deployments a commit is looked for in. */
const DEPLOYMENTS_CONSIDERED = 20;

async function realityOfTasks(
  db: Db,
  projectId: string,
  projectCode: string,
  humanId: string,
  tasks: readonly { id: string; humanId: string }[],
): Promise<Reality> {
  const taskById = new Map(tasks.map((task) => [task.id, task.humanId]));

  const attributions =
    tasks.length === 0
      ? []
      : await db.commitTask.findMany({
          where: {
            taskId: { in: [...taskById.keys()] },
            rejectedAt: null,
            commit: { orphanedAt: null },
          },
          include: { commit: { include: { repo: { select: { fullName: true } } } } },
          orderBy: { commit: { committedAt: 'desc' } },
        });

  // The project's newest deployments, oldest first, each with the commit it shipped: a commit is
  // "in" the first deployment whose shipped commit is at or after it in the same repo.
  const recent = (
    await db.deployment.findMany({
      where: { projectId },
      orderBy: { deployedAt: 'desc' },
      take: DEPLOYMENTS_CONSIDERED,
    })
  ).reverse();
  const shipped = await Promise.all(
    recent.map(async (deployment) => {
      const sha = deployment.imageSha.replace(/^sha-/, '').toLowerCase();
      const commit =
        sha.length < 7
          ? null
          : await db.commit.findFirst({
              where: { repo: { projectId, deletedAt: null }, sha: { startsWith: sha }, orphanedAt: null },
              select: { repoId: true, committedAt: true },
            });
      return { deployment, commit };
    }),
  );

  const commits: RealityCommit[] = attributions.map((row) => {
    const home = shipped.find(
      (s) => s.commit !== null && s.commit.repoId === row.commit.repoId && s.commit.committedAt >= row.commit.committedAt,
    );
    return {
      sha: row.commit.sha,
      message: row.commit.message.split('\n')[0] ?? '',
      committedAt: row.commit.committedAt.toISOString(),
      repo: row.commit.repo.fullName,
      task: taskById.get(row.taskId) ?? '',
      source: row.source,
      confidence: Number(row.confidence),
      confirmed: row.confirmed,
      evidence: row.evidence,
      shippedIn: home?.deployment.id ?? null,
    };
  });

  const shas = [...new Set(commits.map((commit) => commit.sha))];
  const checks =
    shas.length === 0
      ? []
      : await db.checkRun.findMany({
          where: { commitSha: { in: shas }, repo: { projectId } },
          orderBy: [{ completedAt: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }],
        });

  const declared =
    tasks.length === 0
      ? []
      : await db.deployment.findMany({
          where: { projectId, tasks: { some: { taskId: { in: [...taskById.keys()] } } } },
          orderBy: { deployedAt: 'desc' },
        });
  // A deployment is "in" for a task only through a **confirmed** commit: a suggestion is not
  // evidence (ADR-005), and a suggested-only task must not show a deploy as its own.
  const byImage = new Set(
    commits.filter((commit) => commit.confirmed && commit.shippedIn !== null).map((commit) => commit.shippedIn),
  );
  const declaredIds = new Set(declared.map((deployment) => deployment.id));
  const deployments: RealityDeployment[] = [
    ...declared.map((deployment) => ({ deployment, via: 'declared' as const })),
    ...shipped
      .filter((s) => byImage.has(s.deployment.id) && !declaredIds.has(s.deployment.id))
      .map((s) => ({ deployment: s.deployment, via: 'image' as const })),
  ]
    .sort((a, b) => b.deployment.deployedAt.getTime() - a.deployment.deployedAt.getTime())
    .map(({ deployment, via }) => ({
      id: deployment.id,
      environment: deployment.environment,
      image: deployment.image,
      imageSha: deployment.imageSha,
      deployedAt: deployment.deployedAt.toISOString(),
      via,
    }));

  const drift = await driftFor(db, projectCode);
  return {
    humanId,
    commits,
    checks: checks.map((check) => ({
      commitSha: check.commitSha,
      name: check.name,
      conclusion: check.conclusion,
      completedAt: check.completedAt?.toISOString() ?? null,
      detailsUrl: check.detailsUrl,
    })),
    deployments,
    drift: drift.items
      .filter((item) => item.humanId === humanId)
      .map((item) => ({ category: item.category, detail: item.detail })),
  };
}

export function taskRealityRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);
  router.use(requireScope(db, 'read'));

  router.get(
    '/tasks/:humanId/reality',
    handler(async (req, res) => {
      const humanId = param(req, 'humanId');
      const task = await db.task.findFirst({
        where: { humanId, deletedAt: null },
        select: { id: true, humanId: true, projectId: true, project: { select: { code: true } } },
      });
      if (task === null) throw new NotFound(humanId);
      res.json(await realityOfTasks(db, task.projectId, task.project.code, task.humanId, [task]));
    }),
  );

  router.get(
    '/requirements/:humanId/reality',
    handler(async (req, res) => {
      const humanId = param(req, 'humanId');
      const requirement = await db.requirement.findFirst({
        where: { humanId, deletedAt: null },
        select: {
          humanId: true,
          projectId: true,
          project: { select: { code: true } },
          tasks: { select: { task: { select: { id: true, humanId: true, deletedAt: true } } } },
        },
      });
      if (requirement === null) throw new NotFound(humanId);
      const tasks = requirement.tasks.flatMap((link) => (link.task.deletedAt === null ? [link.task] : []));
      res.json(await realityOfTasks(db, requirement.projectId, requirement.project.code, requirement.humanId, tasks));
    }),
  );

  return router;
}
