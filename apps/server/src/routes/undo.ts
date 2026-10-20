import {
  AUDIT_EVENT_ID_HEADER,
  AUDIT_EVENT_IDS_HEADER,
  AuditEventsQuery,
} from '@foreman/shared';
import { Router, type RequestHandler, type Response } from 'express';
import { requireAuth, requireScope } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { auditHistory, undo, undoabilityOf } from '../domain/undo.js';
import { actorOf, handler, param, parseQuery } from './helpers.js';

/**
 * A DELETE answers 204, and a 204 has no body to carry `auditEventIds`: the console reads them
 * from `Audit-Event-Ids` instead (comma-separated, the record's own event first), with the first
 * also in `Audit-Event-Id`. A 200 with a body would break the clients and tests that rely on 204.
 */
export function noContentWithEvents(res: Response, auditEventIds: readonly string[]): void {
  const [own] = auditEventIds;
  if (own !== undefined) {
    res.setHeader(AUDIT_EVENT_ID_HEADER, own);
    res.setHeader(AUDIT_EVENT_IDS_HEADER, auditEventIds.join(','));
  }
  res.status(204).end();
}

/**
 * `POST /api/undo/:auditEventId` — reverse one mutation.
 *
 * The audit trail is not only a record; it is the mechanism. Every mutation is undoable because
 * every mutation wrote what it replaced, in the same transaction.
 */
export function undoRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);
  // Undo changes state, so it needs `write` like any other mutation.
  router.use(requireScope(db, 'write'));

  router.post(
    '/:auditEventId',
    handler(async (req, res) => {
      res.json(await undo(db, actorOf(req), param(req, 'auditEventId')));
    }),
  );

  return router;
}

/**
 * `GET /api/audit-events?entity=<humanId>&limit=` — one record's history, newest first, with which
 * events can be undone (FRM-REQ-243). A read, so the router it is mounted on must hold `read`.
 *
 * Handed out as a handler rather than a router: `undoRoutes` is mounted at `/api/undo`, which this
 * path is not under, and `findingRoutes` already sits at `/api` behind `read` and has no other
 * claim on it. If `app.ts` ever mounts this at `/api/audit-events` itself, wrap it in a router
 * with `requireAuth` and `requireScope(db, 'read')` and drop the registration in `findings.ts`.
 */
export function auditEventsHandler(db: Db): RequestHandler {
  return handler(async (req, res) => {
    const query = parseQuery(AuditEventsQuery, req, res);
    if (query === null) return;
    res.json(await auditHistory(db, query.entity, query.limit));
  });
}

/** `GET /api/audit-events/:id/undoable` — the verdict on one event, for those a history leaves unchecked. */
export function undoabilityHandler(db: Db): RequestHandler {
  return handler(async (req, res) => {
    res.json(await undoabilityOf(db, param(req, 'id')));
  });
}
