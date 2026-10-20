import { PortfolioInput } from '@foreman/shared';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireScope } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { getByHumanId } from '../domain/entities.js';
import { groupedPortfolio } from '../domain/portfolio.js';
import { resolveScope, scopeCodes } from '../domain/scope.js';
import { resourceCatalogue } from '../domain/resources.js';
import { SEARCHABLE, search } from '../domain/search.js';
import { handler, param, parseQuery } from './helpers.js';

/**
 * Cross-project reads: the portfolio, and typed search.
 *
 * These are the two that answer "where is everything" and "where is that thing I remember" — the
 * questions the vault could only answer by opening files.
 */

const SearchQuery = z.object({
  q: z.string().min(1).max(200),
  /** Comma-separated, so a client can narrow without a repeated parameter. */
  types: z.string().optional(),
  project: z.string().optional(),
  /** A group to narrow to — `GRP-n`, slug or `ungrouped` (FRM-T-17.4). */
  group: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export function searchRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);
  router.use(requireScope(db, 'read'));

  /**
   * Every document and section in every project, as a URI (T-4.9).
   *
   * Cross-project because that is how a client lists resources: once, at connect time, not per
   * project as it discovers them.
   */
  router.get(
    '/resources',
    handler(async (_req, res) => {
      const items = await resourceCatalogue(db);
      res.json({ items, nextCursor: null, total: items.length });
    }),
  );

  router.get(
    '/search',
    handler(async (req, res) => {
      const query = parseQuery(SearchQuery, req, res);
      if (query === null) return;

      const requested = query.types
        ?.split(',')
        .map((t) => t.trim())
        .filter((t): t is (typeof SEARCHABLE)[number] =>
          (SEARCHABLE as readonly string[]).includes(t),
        );

      const codes = scopeCodes(await resolveScope(db, query.group));
      const hits = await search(db, query.q, {
        ...(requested !== undefined && requested.length > 0 ? { types: requested } : {}),
        ...(query.project === undefined ? {} : { projectCode: query.project }),
        ...(codes === undefined ? {} : { projectCodes: codes }),
        limit: query.limit,
      });
      res.json({ items: hits, nextCursor: null, total: hits.length });
    }),
  );

  router.get(
    '/portfolio',
    handler(async (req, res) => {
      const query = parseQuery(PortfolioInput, req, res);
      if (query === null) return;
      // The guidelines ride along, each with its scope (FRM-REQ-187, FRM-REQ-237): the portfolio
      // is the cross-project read, and a session that starts there rather than in one project's
      // brief should get them too.
      res.json(await groupedPortfolio(db, query.group));
    }),
  );

  router.get(
    '/entities/:humanId',
    handler(async (req, res) => {
      const backlinks = req.query['backlinks'] !== 'false';
      res.json(await getByHumanId(db, param(req, 'humanId'), { backlinks }));
    }),
  );

  return router;
}
