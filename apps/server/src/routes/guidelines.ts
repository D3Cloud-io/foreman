import { GuidelineCreate, GuidelineStatus, GuidelineUpdate } from '@foreman/shared';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireScope } from '../auth/middleware.js';
import type { Db } from '../db.js';
import {
  allGuidelines,
  createGuideline,
  findGuideline,
  guidelinesMarkdown,
  updateGuideline,
} from '../domain/guidelines.js';
import { softDelete } from '../domain/undo.js';
import { actorOf, handler, param, parseBody, parseQuery } from './helpers.js';
import { noContentWithEvents } from './undo.js';

/**
 * Guidelines (FRM-REQ-186 … FRM-REQ-188). No project in the path, because a guideline has none —
 * the same shape as `/api/project-ideas`, for the same reason.
 */
export function guidelineRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);
  const canWrite = requireScope(db, 'write');

  router.get(
    '/',
    handler(async (req, res) => {
      const query = parseQuery(z.object({ status: GuidelineStatus.optional() }), req, res);
      if (query === null) return;
      const items = await allGuidelines(db, query.status === undefined ? {} : { status: query.status });
      res.json({ items, nextCursor: null, total: items.length });
    }),
  );

  // Before `/:humanId`, or `markdown` would be read as an ID.
  router.get(
    '/markdown',
    handler(async (_req, res) => {
      res.json({ markdown: await guidelinesMarkdown(db) });
    }),
  );

  router.get(
    '/:humanId',
    handler(async (req, res) => {
      res.json(await findGuideline(db, param(req, 'humanId')));
    }),
  );

  router.post(
    '/',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(GuidelineCreate, req, res);
      if (body === null) return;
      res.status(201).json(await createGuideline(db, actorOf(req), body));
    }),
  );

  router.patch(
    '/:humanId',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(GuidelineUpdate, req, res);
      if (body === null) return;
      res.json(await updateGuideline(db, actorOf(req), param(req, 'humanId'), body));
    }),
  );

  router.delete(
    '/:humanId',
    canWrite,
    handler(async (req, res) => {
      const { auditEventIds } = await softDelete(db, actorOf(req), 'guideline', param(req, 'humanId'));
      noContentWithEvents(res, auditEventIds);
    }),
  );

  return router;
}
