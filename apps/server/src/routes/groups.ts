import {
  GroupCreate,
  GroupOrder,
  GroupProjectsMove,
  GroupProjectsOrder,
  GroupUpdate,
} from '@foreman/shared';
import { Router } from 'express';
import { requireAuth, requireScope } from '../auth/middleware.js';
import type { Db } from '../db.js';
import {
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  moveProjects,
  reorderGroups,
  reorderProjects,
  updateGroup,
} from '../domain/groups.js';
import { actorOf, handler, param, parseBody } from './helpers.js';
import { noContentWithEvents } from './undo.js';

/**
 * Groups (FRM-ADR-024, FRM-REQ-221 … FRM-REQ-227). No project in the path, because a group has
 * none — the same shape as `/api/guidelines`.
 *
 * `:id` is a `GRP-001` or a slug. `ungrouped` is the projects in no group: not a group, so it can
 * be read and ordered and moved into, and never renamed or deleted — and no group can take the
 * slug, so the path is never ambiguous.
 */
const UNGROUPED = 'ungrouped';

export function groupRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);
  router.use(requireScope(db, 'read'));
  const canWrite = requireScope(db, 'write');

  /** `null` for the ungrouped, else the reference as given. */
  const targetOf = (id: string): string | null => (id === UNGROUPED ? null : id);

  router.get(
    '/',
    handler(async (_req, res) => {
      res.json(await listGroups(db));
    }),
  );

  router.post(
    '/',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(GroupCreate, req, res);
      if (body === null) return;
      res.status(201).json(await createGroup(db, actorOf(req), body));
    }),
  );

  // Before `/:id`, though only a POST: `order` is a word here, not a slug.
  router.post(
    '/order',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(GroupOrder, req, res);
      if (body === null) return;
      res.json(await reorderGroups(db, actorOf(req), body.order));
    }),
  );

  router.get(
    '/:id',
    handler(async (req, res) => {
      const id = param(req, 'id');
      if (id === UNGROUPED) {
        res.json((await listGroups(db)).ungrouped);
        return;
      }
      res.json(await getGroup(db, id));
    }),
  );

  router.patch(
    '/:id',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(GroupUpdate, req, res);
      if (body === null) return;
      res.json(await updateGroup(db, actorOf(req), param(req, 'id'), body));
    }),
  );

  router.delete(
    '/:id',
    canWrite,
    handler(async (req, res) => {
      noContentWithEvents(res, await deleteGroup(db, actorOf(req), param(req, 'id')));
    }),
  );

  router.post(
    '/:id/projects',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(GroupProjectsMove, req, res);
      if (body === null) return;
      res.json(
        await moveProjects(db, actorOf(req), targetOf(param(req, 'id')), body.projects, body.position),
      );
    }),
  );

  router.post(
    '/:id/projects/order',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(GroupProjectsOrder, req, res);
      if (body === null) return;
      res.json(await reorderProjects(db, actorOf(req), targetOf(param(req, 'id')), body.order));
    }),
  );

  return router;
}
