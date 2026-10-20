import {
  PageQuery,
  PhaseCreate,
  PhaseUpdate,
  ProjectCreate,
  ProjectUpdate,
  RequirementCreate,
  RequirementUpdate,
  TaskCreate,
  TaskUpdate,
} from '@foreman/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db.js';
import { Invalid } from '../domain/errors.js';
import { softDelete } from '../domain/undo.js';
import {
  createPhase,
  createProject,
  createRequirement,
  createTask,
  findProject,
  listPhases,
  updatePhase,
  updateProject,
  updateRequirement,
  updateTask,
} from '../domain/projects.js';
import { requireAuth, requireScope } from '../auth/middleware.js';
import { assertFresh, setEtag } from './concurrency.js';
import {
  actorOf,
  decodeCursor,
  encodeCursor,
  handler,
  param,
  parseBody,
  parseQuery,
} from './helpers.js';

/**
 * What `foreman_create` addresses by human ID, resolved to the row IDs the create shapes take.
 *
 * The shim sends `?phase=FRM-P-3&satisfies=FRM-REQ-001,FRM-REQ-002` — Claude knows human IDs, not
 * UUIDs — and until 2026-09-24 nothing on this side read them: every task created over MCP landed
 * in the backlog citing nothing, and the response said so only to a reader who checked. An ID that
 * does not resolve is refused by name, because dropping it is the silence that hid this.
 *
 * A body that already names `phaseId` or `requirementIds` wins; the query only fills what is unset.
 * `foreman_update` moves a task or requirement the same way, with `?phase=` on the PATCH.
 */
export const CreateRefsQuery = z.object({
  phase: z.string().min(1).optional(),
  satisfies: z.string().min(1).optional(),
});

async function refsFromQuery(
  db: Db,
  code: string,
  query: z.infer<typeof CreateRefsQuery>,
): Promise<{ phaseId?: string; requirementIds?: string[] }> {
  const refs: { phaseId?: string; requirementIds?: string[] } = {};
  if (query.phase === undefined && query.satisfies === undefined) return refs;
  const project = await findProject(db, code);

  if (query.phase !== undefined) {
    const phase = await db.phase.findFirst({
      where: { projectId: project.id, humanId: query.phase, deletedAt: null },
      select: { id: true },
    });
    if (phase === null) {
      throw new Invalid(`${query.phase} is not a phase of ${code}`, [
        { path: 'phase', message: `no phase ${query.phase} in ${code}` },
      ]);
    }
    refs.phaseId = phase.id;
  }

  if (query.satisfies !== undefined) {
    const wanted = [...new Set(query.satisfies.split(',').map((id) => id.trim()).filter(Boolean))];
    const found = await db.requirement.findMany({
      where: { projectId: project.id, humanId: { in: wanted }, deletedAt: null },
      select: { id: true, humanId: true },
    });
    const missing = wanted.filter((id) => !found.some((r) => r.humanId === id));
    if (missing.length > 0) {
      throw new Invalid(`not requirements of ${code}: ${missing.join(', ')}`, [
        { path: 'satisfies', message: `no requirement ${missing.join(', ')} in ${code}` },
      ]);
    }
    refs.requirementIds = found.map((r) => r.id);
  }
  return refs;
}

/**
 * The spine over HTTP: projects, phases, requirements, tasks.
 *
 * Every list is paged — **no route returns an unbounded list** (FRM-REQ-092). One project already
 * has 439 requirements, and an endpoint that returns all of them is one that works right up until
 * the day it is asked about the real corpus.
 */

/**
 * S-13's four filters, as the server reads them.
 *
 * Exported so it can be tested without a database: it is where a query-string bug hides, and this
 * one had one. `z.coerce.boolean()` reads the string `'false'` as **true** — every non-empty string
 * is truthy — so `?uncovered=false` filtered to exactly the rows it asked to exclude. An enum
 * cannot do that, and refuses anything that is neither.
 */
export const RequirementQuery = PageQuery.extend({
  priority: z.enum(['M', 'S', 'C', 'W']).optional(),
  /** A phase ID, or `none` for the backlog — a requirement with no phase at all (T-3.1). */
  phase: z.string().optional(),
  /** Requirements no task covers — the coverage hole, which is the point of the register. */
  uncovered: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  earsLint: z.enum(['ok', 'warned']).optional(),
});

export function projectRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);
  // Reading needs `read`; anything that changes state needs `write`, and a denial is audited.
  router.use(requireScope(db, 'read'));
  const canWrite = requireScope(db, 'write');

  // ─── Projects ────────────────────────────────────────────────────────────

  router.get(
    '/',
    handler(async (req, res) => {
      const query = parseQuery(PageQuery, req, res);
      if (query === null) return;

      const after = decodeCursor(query.cursor);
      const projects = await db.project.findMany({
        where: { deletedAt: null, ...(after === null ? {} : { code: { gt: after } }) },
        orderBy: { code: 'asc' },
        take: query.limit + 1,
      });

      const items = projects.slice(0, query.limit);
      const hasMore = projects.length > query.limit;
      res.json({
        items,
        nextCursor: hasMore ? encodeCursor(items.at(-1)?.code ?? '') : null,
        total: await db.project.count({ where: { deletedAt: null } }),
      });
    }),
  );

  router.post(
    '/',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(ProjectCreate, req, res);
      if (body === null) return;
      const project = await createProject(db, actorOf(req), body);
      res.status(201).json(project);
    }),
  );

  router.get(
    '/:code',
    handler(async (req, res) => {
      const project = await findProject(db, param(req, 'code'));
      const [phases, requirements, tasks, openFindings, group] = await Promise.all([
        db.phase.count({ where: { projectId: project.id, deletedAt: null } }),
        db.requirement.count({ where: { projectId: project.id, deletedAt: null } }),
        db.task.count({ where: { projectId: project.id, deletedAt: null } }),
        db.finding.count({ where: { projectId: project.id, status: 'open', deletedAt: null } }),
        // The family it belongs to, by the names a link uses (FRM-ADR-024), or null for none.
        project.groupId === null
          ? null
          : db.projectGroup.findFirst({
              where: { id: project.groupId, deletedAt: null },
              select: { humanId: true, name: true, slug: true, accent: true },
            }),
      ]);
      setEtag(res, project);
      res.json({ ...project, group, counts: { phases, requirements, tasks, openFindings } });
    }),
  );

  router.patch(
    '/:code',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(ProjectUpdate, req, res);
      if (body === null) return;

      const code = param(req, 'code');
      assertFresh(req, await findProject(db, code));

      const updated = await updateProject(db, actorOf(req), code, body);
      setEtag(res, updated);
      res.json(updated);
    }),
  );

  // ─── Phases ──────────────────────────────────────────────────────────────

  router.get(
    '/:code/phases',
    handler(async (req, res) => {
      // Ordered by build order, not by number: Bindery built 0–8.5, 9–11, 13–16, with 12 ahead.
      const phases = await listPhases(db, param(req, 'code'));
      res.json({ items: phases, nextCursor: null, total: phases.length });
    }),
  );

  router.post(
    '/:code/phases',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(PhaseCreate, req, res);
      if (body === null) return;
      res.status(201).json(await createPhase(db, actorOf(req), param(req, 'code'), body));
    }),
  );

  router.patch(
    '/:code/phases/:humanId',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(PhaseUpdate, req, res);
      if (body === null) return;

      const humanId = param(req, 'humanId');
      const current = await db.phase.findFirst({ where: { humanId, deletedAt: null } });
      if (current !== null) assertFresh(req, current);

      const updated = await updatePhase(db, actorOf(req), humanId, body);
      setEtag(res, updated);
      res.json(updated);
    }),
  );

  // ─── Requirements ────────────────────────────────────────────────────────

  router.get(
    '/:code/requirements',
    handler(async (req, res) => {
      const query = parseQuery(RequirementQuery, req, res);
      if (query === null) return;
      const project = await findProject(db, param(req, 'code'));
      const after = decodeCursor(query.cursor);

      const filters = {
        projectId: project.id,
        deletedAt: null,
        ...(query.priority === undefined ? {} : { priority: query.priority }),
        ...(query.phase === undefined
          ? {}
          : query.phase === 'none'
            ? { phaseId: null }
            : { phase: { humanId: query.phase } }),
        ...(query.earsLint === undefined ? {} : { earsLintOk: query.earsLint === 'ok' }),
        // A soft-deleted task covers nothing, which is the same rule the coverage engine uses.
        ...(query.uncovered === undefined
          ? {}
          : query.uncovered
            ? { tasks: { none: { task: { deletedAt: null } } } }
            : { tasks: { some: { task: { deletedAt: null } } } }),
      };

      const [rows, total] = await Promise.all([
        db.requirement.findMany({
          where: { ...filters, ...(after === null ? {} : { seq: { gt: Number(after) } }) },
          orderBy: { seq: 'asc' },
          take: query.limit + 1,
          include: {
            phase: { select: { humanId: true, name: true } },
            tasks: {
              where: { task: { deletedAt: null } },
              select: { task: { select: { humanId: true, status: true } } },
            },
          },
        }),
        // The filtered total, not the project's: a table saying "23 of 439" while showing a
        // filtered page is a table that has lied about the size of the hole.
        db.requirement.count({ where: filters }),
      ]);

      const items = rows.slice(0, query.limit);
      res.json({
        items: items.map(({ tasks, ...row }) => ({
          ...row,
          coveredBy: tasks.length,
          satisfiedBy: tasks.map((t) => t.task),
        })),
        nextCursor:
          rows.length > query.limit ? encodeCursor(String(items.at(-1)?.seq ?? '')) : null,
        total,
      });
    }),
  );

  router.post(
    '/:code/requirements',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(RequirementCreate, req, res);
      if (body === null) return;
      const query = parseQuery(CreateRefsQuery.pick({ phase: true }), req, res);
      if (query === null) return;
      const code = param(req, 'code');
      const { phaseId } = await refsFromQuery(db, code, query);
      // The EARS lint runs inside, and warns rather than rejecting.
      res
        .status(201)
        .json(
          await createRequirement(db, actorOf(req), code, {
            ...body,
            ...(body.phaseId === undefined && phaseId !== undefined ? { phaseId } : {}),
          }),
        );
    }),
  );

  router.patch(
    '/:code/requirements/:humanId',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(RequirementUpdate, req, res);
      if (body === null) return;
      // `foreman_update` moves by human ID, as `foreman_create` files by one.
      const query = parseQuery(CreateRefsQuery.pick({ phase: true }), req, res);
      if (query === null) return;
      const { phaseId } = await refsFromQuery(db, param(req, 'code'), query);

      const humanId = param(req, 'humanId');
      const current = await db.requirement.findFirst({ where: { humanId, deletedAt: null } });
      if (current !== null) assertFresh(req, current);

      const updated = await updateRequirement(db, actorOf(req), humanId, {
        ...body,
        ...(body.phaseId === undefined && phaseId !== undefined ? { phaseId } : {}),
      });
      setEtag(res, updated);
      res.json(updated);
    }),
  );

  // ─── Tasks ───────────────────────────────────────────────────────────────

  const TaskQuery = PageQuery.extend({
    phase: z.string().optional(),
    status: z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']).optional(),
  });

  router.get(
    '/:code/tasks',
    handler(async (req, res) => {
      const query = parseQuery(TaskQuery, req, res);
      if (query === null) return;
      const project = await findProject(db, param(req, 'code'));
      const after = decodeCursor(query.cursor);

      const rows = await db.task.findMany({
        where: {
          projectId: project.id,
          deletedAt: null,
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.phase === undefined ? {} : { phase: { humanId: query.phase } }),
          ...(after === null ? {} : { humanId: { gt: after } }),
        },
        orderBy: { humanId: 'asc' },
        take: query.limit + 1,
        include: {
          files: { select: { path: true } },
          requirements: { select: { requirement: { select: { humanId: true } } } },
        },
      });

      const items = rows.slice(0, query.limit).map((row) => ({
        ...row,
        files: row.files.map((f) => f.path),
        requirements: row.requirements.map((r) => r.requirement.humanId),
      }));
      res.json({
        items,
        nextCursor: rows.length > query.limit ? encodeCursor(items.at(-1)?.humanId ?? '') : null,
        total: null,
      });
    }),
  );

  router.post(
    '/:code/tasks',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(TaskCreate, req, res);
      if (body === null) return;
      const query = parseQuery(CreateRefsQuery, req, res);
      if (query === null) return;
      const code = param(req, 'code');
      const { phaseId, requirementIds } = await refsFromQuery(db, code, query);
      res.status(201).json(
        await createTask(db, actorOf(req), code, {
          ...body,
          ...(body.phaseId === undefined && phaseId !== undefined ? { phaseId } : {}),
          ...(body.requirementIds === undefined && requirementIds !== undefined
            ? { requirementIds }
            : {}),
        }),
      );
    }),
  );

  router.patch(
    '/:code/tasks/:humanId',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(TaskUpdate, req, res);
      if (body === null) return;
      // `foreman_update` moves by human ID, as `foreman_create` files by one.
      const query = parseQuery(CreateRefsQuery.pick({ phase: true }), req, res);
      if (query === null) return;
      const { phaseId } = await refsFromQuery(db, param(req, 'code'), query);

      const humanId = param(req, 'humanId');
      const current = await db.task.findFirst({ where: { humanId, deletedAt: null } });
      if (current !== null) assertFresh(req, current);

      const updated = await updateTask(db, actorOf(req), humanId, {
        ...body,
        ...(body.phaseId === undefined && phaseId !== undefined ? { phaseId } : {}),
      });
      setEtag(res, updated);
      res.json(updated);
    }),
  );

  router.delete(
    '/:code/requirements/:humanId',
    canWrite,
    handler(async (req, res) => {
      await softDelete(db, actorOf(req), 'requirement', param(req, 'humanId'));
      res.status(204).end();
    }),
  );

  router.delete(
    '/:code/tasks/:humanId',
    canWrite,
    handler(async (req, res) => {
      await softDelete(db, actorOf(req), 'task', param(req, 'humanId'));
      res.status(204).end();
    }),
  );

  router.delete(
    '/:code/phases/:humanId',
    canWrite,
    handler(async (req, res) => {
      await softDelete(db, actorOf(req), 'phase', param(req, 'humanId'));
      res.status(204).end();
    }),
  );

  return router;
}
