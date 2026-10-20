import { Router } from 'express';
import { requireAuth, requireScope } from '../auth/middleware.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { z } from 'zod';
import { driftAcross, driftFor } from '../domain/drift.js';
import { resolveScope } from '../domain/scope.js';
import { health, techInventory, versionSpread } from '../domain/operations.js';
import { handler, param, parseQuery } from './helpers.js';

/**
 * Drift, the tech inventory and health — the three things Foreman says without being asked.
 */
export function operationsRoutes(db: Db, config: Config): Router {
  const router = Router();
  router.use(requireAuth);
  router.use(requireScope(db, 'read'));

  router.get(
    '/projects/:code/drift',
    handler(async (req, res) => {
      res.json(await driftFor(db, param(req, 'code')));
    }),
  );

  /**
   * Drift across projects, narrowed by `?group=` — a `GRP-n`, slug or `ungrouped` — the way the
   * portfolio and the findings inbox are (FRM-T-17.4). An unknown group is a 404.
   */
  router.get(
    '/drift',
    handler(async (req, res) => {
      const query = parseQuery(z.object({ group: z.string().optional() }), req, res);
      if (query === null) return;
      res.json(await driftAcross(db, await resolveScope(db, query.group)));
    }),
  );

  router.get(
    '/tech',
    handler(async (_req, res) => {
      const items = await techInventory(db);
      res.json({
        items,
        // The reason an inventory is worth keeping: four projects on three versions of one thing
        // is a fact nobody notices until one of them cannot be upgraded.
        disagreements: versionSpread(items),
        nextCursor: null,
        total: items.length,
      });
    }),
  );

  router.get(
    '/health-report',
    handler(async (_req, res) => {
      res.json(await health(db, { backupDir: config.BACKUP_DIR }));
    }),
  );

  return router;
}
