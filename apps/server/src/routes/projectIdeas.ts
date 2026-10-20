import {
  IdeaCommentCreate,
  IdeaCommentUpdate,
  IdeaScoreInput,
  ProjectIdeaConvert,
  ProjectIdeaCreate,
  ProjectIdeaStatus,
  ProjectIdeaUpdate,
} from '@foreman/shared';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, requireScope, reviews } from '../auth/middleware.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import {
  allProjectIdeas,
  convertProjectIdea,
  createProjectIdea,
  findProjectIdea,
  updateProjectIdea,
} from '../domain/projectIdeas.js';
import {
  comment,
  commentsFor,
  deleteComment,
  editComment,
  score,
  scoresFor,
} from '../domain/board.js';
import { softDelete } from '../domain/undo.js';
import { actorOf, handler, param, parseBody, parseQuery } from './helpers.js';
import { noContentWithEvents } from './undo.js';

/**
 * Project ideas (FRM-REQ-159 … FRM-REQ-164).
 *
 * The only record with no project in its path, because it has no project. `/api/project-ideas`,
 * not `/api/projects/:code/…`, and that difference in the URL is the same difference the whole
 * feature exists to express.
 */
export function projectIdeaRoutes(db: Db, config: Config): Router {
  const router = Router();
  router.use(requireAuth);
  const canWrite = requireScope(db, 'write');

  router.get(
    '/',
    handler(async (req, res) => {
      const query = parseQuery(z.object({ status: ProjectIdeaStatus.optional() }), req, res);
      if (query === null) return;
      const items = await allProjectIdeas(db, {
        ...(query.status === undefined ? {} : { status: query.status }),
        canReview: reviews(config, req.auth),
      });
      res.json({ items, nextCursor: null, total: items.length });
    }),
  );

  router.get(
    '/:humanId',
    handler(async (req, res) => {
      res.json(await findProjectIdea(db, param(req, 'humanId')));
    }),
  );

  router.post(
    '/',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(ProjectIdeaCreate, req, res);
      if (body === null) return;
      // Anyone signed in may submit, including a submitter — that is the point of a fund board.
      res
        .status(201)
        .json(await createProjectIdea(db, actorOf(req), body, req.auth?.userId ?? null));
    }),
  );

  router.patch(
    '/:humanId',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(ProjectIdeaUpdate, req, res);
      if (body === null) return;
      const humanId = param(req, 'humanId');

      // A submitter edits their own wording; deciding is the board's. Checked against the row
      // rather than the request, because the request is exactly what cannot be trusted here.
      if (!reviews(config, req.auth)) {
        const idea = await findProjectIdea(db, humanId);
        if (idea.submittedBy?.id !== req.auth?.userId) {
          res.status(403).json({ error: 'this is somebody else’s submission' });
          return;
        }
        if (body.status !== undefined || body.reason !== undefined) {
          res.status(403).json({ error: 'only a reviewer can decide a submission' });
          return;
        }
      }
      res.json(await updateProjectIdea(db, actorOf(req), humanId, body));
    }),
  );

  /**
   * The moment the idea becomes real, and the only way `status` reaches `converted`.
   *
   * A POST to a sub-path rather than a PATCH setting a status, because it is not a status change:
   * it creates a project, and a request that creates something the caller did not name is not an
   * update. The response carries both, so the caller can go straight to the new project.
   */
  router.post(
    '/:humanId/convert',
    canWrite,
    requireRole(config, 'admin', 'reviewer'),
    handler(async (req, res) => {
      const body = parseBody(ProjectIdeaConvert, req, res);
      if (body === null) return;
      res.status(201).json(await convertProjectIdea(db, actorOf(req), param(req, 'humanId'), body));
    }),
  );

  router.delete(
    '/:humanId',
    canWrite,
    handler(async (req, res) => {
      const humanId = param(req, 'humanId');
      if (!reviews(config, req.auth)) {
        const idea = await findProjectIdea(db, humanId);
        if (idea.submittedBy?.id !== req.auth?.userId) {
          res.status(403).json({ error: 'this is somebody else’s submission' });
          return;
        }
      }
      const { auditEventIds } = await softDelete(db, actorOf(req), 'project_idea', humanId);
      noContentWithEvents(res, auditEventIds);
    }),
  );

  // ── Scoring (FRM-ADR-017) ────────────────────────────────────────────────
  // Both modes. On a board, each reviewer's read and the board's mean; on a solo instance, your
  // own impact/effort read on an idea — the same record with one author.

  router.get(
    '/:humanId/scores',
    requireRole(config, 'admin', 'reviewer'),
    handler(async (req, res) => {
      res.json(await scoresFor(db, param(req, 'humanId')));
    }),
  );

  router.put(
    '/:humanId/scores',
    canWrite,
    requireRole(config, 'admin', 'reviewer'),
    handler(async (req, res) => {
      const body = parseBody(IdeaScoreInput, req, res);
      if (body === null) return;
      const userId = req.auth?.userId;
      if (userId === null || userId === undefined) {
        // A token has scopes, not judgement. A score is recorded against a person, so there is
        // nobody here to record it against.
        res.status(403).json({ error: 'a token cannot score an idea' });
        return;
      }
      res.json(await score(db, actorOf(req), userId, param(req, 'humanId'), body));
    }),
  );

  // ── Thoughts and discussion (FRM-ADR-017) ────────────────────────────────
  // One table, two readings: a solo instance's running log of what you thought and when, and a
  // board's discussion with its board-only half.

  router.get(
    '/:humanId/comments',
    handler(async (req, res) => {
      const items = await commentsFor(db, param(req, 'humanId'), reviews(config, req.auth));
      res.json({ items, nextCursor: null, total: items.length });
    }),
  );

  router.post(
    '/:humanId/comments',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(IdeaCommentCreate, req, res);
      if (body === null) return;
      const userId = req.auth?.userId;
      if (userId === null || userId === undefined) {
        res.status(403).json({ error: 'a token cannot write a thought — it has nobody to sign it' });
        return;
      }
      const saved = await comment(
        db,
        actorOf(req),
        userId,
        param(req, 'humanId'),
        body,
        reviews(config, req.auth),
      );
      res.status(201).json(saved);
    }),
  );

  router.patch(
    '/:humanId/comments/:commentId',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(IdeaCommentUpdate, req, res);
      if (body === null) return;
      const userId = req.auth?.userId;
      if (userId === null || userId === undefined) {
        res.status(403).json({ error: 'a token cannot reword a thought' });
        return;
      }
      res.json(await editComment(db, actorOf(req), userId, param(req, 'commentId'), body.body));
    }),
  );

  router.delete(
    '/:humanId/comments/:commentId',
    canWrite,
    handler(async (req, res) => {
      const userId = req.auth?.userId;
      if (userId === null || userId === undefined) {
        res.status(403).json({ error: 'a token cannot withdraw a thought' });
        return;
      }
      res.json(
        await deleteComment(
          db,
          actorOf(req),
          userId,
          param(req, 'commentId'),
          req.auth?.role === 'admin',
        ),
      );
    }),
  );

  return router;
}
