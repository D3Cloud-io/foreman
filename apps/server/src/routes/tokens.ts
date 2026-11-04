import { Router } from 'express';
import { z } from 'zod';
import { hasScope, requireTokenIssuer, requireUser, SCOPES } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { issueToken, listTokens, recordEscalationDenied, revokeToken } from '../domain/tokens.js';
import { actorOf, handler, param, parseBody } from './helpers.js';
import { noContentWithEvents } from './undo.js';

/**
 * Scoped API tokens, over HTTP.
 *
 * Listing and revoking are **console only** — `requireUser`, not `requireAuth`. Issuing is also open
 * to an `admin`-scoped `frm_` token (FRM-T-029), but only for scopes it holds itself, so a token can
 * never mint more than it is. D3 Auth tokens never issue (FRM-T-010, CON-ADR-003).
 */

const TokenCreate = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(SCOPES)).min(1).default(['read']),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

export function tokenRoutes(db: Db): Router {
  const router = Router();
  router.get(
    '/',
    requireUser,
    handler(async (_req, res) => {
      const items = await listTokens(db);
      res.json({ items, nextCursor: null, total: items.length });
    }),
  );

  router.post(
    '/',
    requireTokenIssuer(db),
    handler(async (req, res) => {
      const body = parseBody(TokenCreate, req, res);
      if (body === null) return;
      const issuer = req.auth;
      // No escalation: a token issues only what it holds. A console session holds `*`.
      const excess = body.scopes.filter((scope) => !hasScope(issuer, scope));
      if (excess.length > 0) {
        await recordEscalationDenied(db, issuer, body.scopes, req.method, req.path);
        res.status(403).json({
          error: 'a token may only issue scopes it holds',
          code: 'scope_escalation',
          requested: body.scopes,
          held: issuer?.scopes ?? [],
        });
        return;
      }
      res.status(201).json(
        await issueToken(db, actorOf(req), {
          name: body.name,
          scopes: body.scopes,
          ...(body.expiresInDays === undefined ? {} : { expiresInDays: body.expiresInDays }),
          ...(issuer?.tokenId === undefined ? {} : { issuedByTokenId: issuer.tokenId }),
        }),
      );
    }),
  );

  router.delete(
    '/:id',
    requireUser,
    handler(async (req, res) => {
      noContentWithEvents(res, (await revokeToken(db, actorOf(req), param(req, 'id'))).auditEventIds);
    }),
  );

  return router;
}
