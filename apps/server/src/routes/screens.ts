import {
  ScreenCaptureCreate,
  ScreenComponentCreate,
  ScreenCreate,
  ScreenProposalCreate,
  ScreenUpdate,
  ScreenVerdictCreate,
} from '@foreman/shared';
import { Router } from 'express';
import { requireAuth, requireScope } from '../auth/middleware.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import {
  addCapture,
  addComponent,
  addProposal,
  addVerdict,
  createScreen,
  getScreen,
  listScreens,
  screenImages,
  updateScreen,
} from '../domain/screens.js';
import { softDelete } from '../domain/undo.js';
import { actorOf, handler, param, parseBody } from './helpers.js';

/**
 * Screens over HTTP (FRM-REQ-189 … FRM-REQ-199), under `/api/projects/:code/screens`.
 *
 * The images themselves go to `POST /api/blobs` first; everything here refers to them by SHA. An
 * add that finds an identical version already there answers 200 with it rather than 201 — the
 * Figma import and CI both re-send what they sent before, and neither should grow a history of
 * duplicates for it.
 */
export function screenRoutes(db: Db, config: Config): Router {
  const router = Router();
  router.use(requireAuth);
  router.use(requireScope(db, 'read'));
  const canWrite = requireScope(db, 'write');

  router.get(
    '/:code/screens',
    handler(async (req, res) => {
      const items = await listScreens(db, param(req, 'code'));
      res.json({ items, nextCursor: null, total: items.length });
    }),
  );

  router.post(
    '/:code/screens',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(ScreenCreate, req, res);
      if (body === null) return;
      res.status(201).json(await createScreen(db, actorOf(req), param(req, 'code'), body));
    }),
  );

  router.get(
    '/:code/screens/:humanId',
    handler(async (req, res) => {
      res.json(await getScreen(db, param(req, 'code'), param(req, 'humanId')));
    }),
  );

  router.patch(
    '/:code/screens/:humanId',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(ScreenUpdate, req, res);
      if (body === null) return;
      res.json(await updateScreen(db, actorOf(req), param(req, 'code'), param(req, 'humanId'), body));
    }),
  );

  router.delete(
    '/:code/screens/:humanId',
    canWrite,
    handler(async (req, res) => {
      // Checked against the path first, so another project's screen is a 404 here too.
      await getScreen(db, param(req, 'code'), param(req, 'humanId'));
      await softDelete(db, actorOf(req), 'screen', param(req, 'humanId'));
      res.status(204).end();
    }),
  );

  /** The current proposal and latest capture, base64 — what `foreman_get` attaches (FRM-REQ-198). */
  router.get(
    '/:code/screens/:humanId/images',
    handler(async (req, res) => {
      res.json(
        await screenImages(db, config.FOREMAN_BLOB_DIR, param(req, 'code'), param(req, 'humanId')),
      );
    }),
  );

  router.post(
    '/:code/screens/:humanId/proposals',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(ScreenProposalCreate, req, res);
      if (body === null) return;
      const { value, created } = await addProposal(
        db,
        actorOf(req),
        param(req, 'code'),
        param(req, 'humanId'),
        body,
      );
      res.status(created ? 201 : 200).json(value);
    }),
  );

  router.post(
    '/:code/screens/:humanId/captures',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(ScreenCaptureCreate, req, res);
      if (body === null) return;
      const { value, created } = await addCapture(
        db,
        actorOf(req),
        param(req, 'code'),
        param(req, 'humanId'),
        body,
      );
      res.status(created ? 201 : 200).json(value);
    }),
  );

  router.post(
    '/:code/screens/:humanId/captures/:versionId/verdict',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(ScreenVerdictCreate, req, res);
      if (body === null) return;
      const versionId = param(req, 'versionId');
      // Not a UUID is not a version of anything; said here rather than as a database cast error.
      if (!/^[0-9a-f-]{36}$/i.test(versionId)) {
        res.status(404).json({ error: `capture ${versionId} not found` });
        return;
      }
      res
        .status(201)
        .json(await addVerdict(db, actorOf(req), param(req, 'code'), param(req, 'humanId'), versionId, body));
    }),
  );

  router.post(
    '/:code/screens/:humanId/components',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(ScreenComponentCreate, req, res);
      if (body === null) return;
      const { value, created } = await addComponent(
        db,
        actorOf(req),
        param(req, 'code'),
        param(req, 'humanId'),
        body,
      );
      res.status(created ? 201 : 200).json(value);
    }),
  );

  return router;
}
