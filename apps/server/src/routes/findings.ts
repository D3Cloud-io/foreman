import {
  AuditCreate,
  AuditUpdate,
  FindingCreate,
  FindingsInput,
  FindingUpdate,
  PageQuery,
} from '@foreman/shared';
import { Router } from 'express';
import { z } from 'zod';
import { IdeaStatus } from '@foreman/shared';
import { allIdeas } from '../domain/ideas.js';
import { requireAuth, requireScope } from '../auth/middleware.js';
import type { Db } from '../db.js';
import {
  createAudit,
  createFinding,
  fixStateFor,
  inbox,
  updateAudit,
  updateFinding,
} from '../domain/findings.js';
import { findProject } from '../domain/projects.js';
import { resolveScope, scopeCodes } from '../domain/scope.js';
import { recurrencesOf, regressionWatch } from '../domain/recurrence.js';
import { actorOf, handler, param, parseBody, parseQuery } from './helpers.js';
import { auditEventsHandler } from './undo.js';

/**
 * Findings over HTTP, and the one route that is deliberately cross-project.
 *
 * `GET /api/findings` is mounted outside `/projects/:code` because scoping it to a project would
 * make the inbox answer a question nobody has. "Every open Critical, all projects, ranked" is the
 * question (FRM-REQ-120), and it is the one the vault could never answer.
 */
export function findingRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);
  // Read-only: every write goes through a project, because a finding belongs to one.
  router.use(requireScope(db, 'read'));

  // One record's history and what of it can be undone (FRM-T-18.3). Behind `read`, above.
  router.get('/audit-events', auditEventsHandler(db));

  // ─── The cross-project inbox (T-6.6) ─────────────────────────────────────

  /**
   * The same shape as `FindingsInput`, with `limit` coerced.
   *
   * The tool's schema must keep `limit` a number — it becomes JSON Schema, and a client sending a
   * string there would be wrong. A query string has no numbers at all, so the HTTP side coerces.
   * One contract, two encodings.
   */
  const FindingsQuery = FindingsInput.extend({
    limit: z.coerce.number().int().min(1).max(200).default(50),
  });

  /**
   * Every project's ideas at once.
   *
   * Alongside the findings inbox rather than in its own file, because it is the same shape of
   * thing: a per-project record whose value is mostly in reading all of them together. "What
   * could we build next, anywhere" is not a question a project-scoped list answers.
   */
  router.get(
    '/ideas',
    handler(async (req, res) => {
      const query = parseQuery(z.object({ status: IdeaStatus.optional() }), req, res);
      if (query === null) return;
      const items = await allIdeas(db, query.status);
      res.json({ items, nextCursor: null, total: items.length });
    }),
  );

  router.get(
    '/findings',
    handler(async (req, res) => {
      const query = parseQuery(FindingsQuery, req, res);
      if (query === null) return;

      // Narrowed to a group's projects when `?group=` names one (FRM-T-17.4); unknown is a 404.
      const scope = await resolveScope(db, query.group);
      // `total` counts the whole matching set, not the page: the sidebar's badge reads it with
      // `limit=1` (FRM-REQ-242). `counts` is the same set per severity, ignoring the severity
      // filter, for the chips above the table.
      const { items, total, counts } = await inbox(db, {
        project: query.project,
        codes: scopeCodes(scope),
        severity: query.severity,
        status: query.status,
        lens: query.lens,
        limit: query.limit,
      });
      res.json({ items, nextCursor: null, total, counts });
    }),
  );

  router.get(
    '/findings/:humanId',
    handler(async (req, res) => {
      const humanId = param(req, 'humanId');
      const finding = await db.finding.findFirst({
        where: { humanId, deletedAt: null },
        include: {
          project: { select: { code: true, name: true } },
          audit: { select: { humanId: true, kind: true, runDate: true, verdict: true } },
          locations: { orderBy: { sortOrder: 'asc' } },
          adr: { select: { humanId: true, title: true } },
          requirement: { select: { humanId: true, statement: true } },
          phase: { select: { humanId: true, name: true } },
        },
      });
      if (finding === null) {
        res.status(404).json({ error: `no finding called ${humanId}` });
        return;
      }

      res.json({ ...finding, fix: await fixStateFor(db, finding) });
    }),
  );

  /** Candidate recurrences in other projects — proposed, never judged (FRM-REQ-122). */
  router.get(
    '/findings/:humanId/recurrences',
    handler(async (req, res) => {
      res.json(await recurrencesOf(db, param(req, 'humanId')));
    }),
  );

  router.get(
    '/regression-watch',
    handler(async (req, res) => {
      const code = typeof req.query['project'] === 'string' ? req.query['project'] : undefined;
      const items = await regressionWatch(db, code);
      res.json({ items, nextCursor: null, total: items.length });
    }),
  );

  return router;
}

/** The per-project half: creating audits and findings, and listing a project's own. */
export function projectFindingRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);
  router.use(requireScope(db, 'read'));
  const canWrite = requireScope(db, 'write');

  const FindingQuery = PageQuery.extend({
    severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    status: z.enum(['open', 'fixed', 'deferred', 'skipped', 'wont_fix']).optional(),
    lens: z.string().max(40).optional(),
    audit: z.string().optional(),
  });

  router.get(
    '/:code/findings',
    handler(async (req, res) => {
      const query = parseQuery(FindingQuery, req, res);
      if (query === null) return;
      const project = await findProject(db, param(req, 'code'));

      const filters = {
        projectId: project.id,
        deletedAt: null,
        ...(query.severity === undefined ? {} : { severity: query.severity }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.lens === undefined ? {} : { lenses: { has: query.lens } }),
        ...(query.audit === undefined ? {} : { audit: { humanId: query.audit } }),
      };

      const [items, total] = await Promise.all([
        db.finding.findMany({
          where: filters,
          orderBy: [{ severity: 'asc' }, { humanId: 'asc' }],
          take: query.limit,
          include: {
            audit: { select: { humanId: true, kind: true } },
            locations: { orderBy: { sortOrder: 'asc' } },
          },
        }),
        db.finding.count({ where: filters }),
      ]);

      res.json({ items, nextCursor: null, total });
    }),
  );

  router.post(
    '/:code/findings',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(FindingCreate, req, res);
      if (body === null) return;
      res.status(201).json(await createFinding(db, actorOf(req), param(req, 'code'), body));
    }),
  );

  router.patch(
    '/:code/findings/:humanId',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(FindingUpdate, req, res);
      if (body === null) return;
      res.json(await updateFinding(db, actorOf(req), param(req, 'humanId'), body));
    }),
  );

  router.post(
    '/:code/audits',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(AuditCreate, req, res);
      if (body === null) return;
      res.status(201).json(await createAudit(db, actorOf(req), param(req, 'code'), body));
    }),
  );

  router.patch(
    '/:code/audits/:humanId',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(AuditUpdate, req, res);
      if (body === null) return;
      res.json(await updateAudit(db, actorOf(req), param(req, 'humanId'), body));
    }),
  );

  return router;
}
