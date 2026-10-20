import { Router } from 'express';
import { z } from 'zod';
import { requireUser, SCOPES } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { issueToken, listTokens, revokeToken } from '../domain/tokens.js';
import { actorOf, handler, param, parseBody } from './helpers.js';
import { noContentWithEvents } from './undo.js';

/**
 * Scoped API tokens, over HTTP.
 *
 * **Console only** — `requireUser`, not `requireAuth`: a token must not be able to mint another
 * token, or a read-only token is one request away from becoming a write token.
 */

const TokenCreate = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(SCOPES)).min(1).default(['read']),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

export function tokenRoutes(db: Db): Router {
  const router = Router();
  router.use(requireUser);

  router.get(
    '/',
    handler(async (_req, res) => {
      const items = await listTokens(db);
      res.json({ items, nextCursor: null, total: items.length });
    }),
  );

  router.post(
    '/',
    handler(async (req, res) => {
      const body = parseBody(TokenCreate, req, res);
      if (body === null) return;
      res.status(201).json(
        await issueToken(db, actorOf(req), {
          name: body.name,
          scopes: body.scopes,
          ...(body.expiresInDays === undefined ? {} : { expiresInDays: body.expiresInDays }),
        }),
      );
    }),
  );

  router.delete(
    '/:id',
    handler(async (req, res) => {
      noContentWithEvents(res, (await revokeToken(db, actorOf(req), param(req, 'id'))).auditEventIds);
    }),
  );

  return router;
}
