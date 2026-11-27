import { readFileSync, readdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, mountedRoutes, type MountedRoute } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * Route enumeration (T-2.1, T-2.11).
 *
 * Both of these assert something about **every** route, present and future, which is the only kind
 * of guarantee worth making here. A test that checks the routes that exist today passes forever
 * while the route added next week quietly breaks the rule.
 */

const url = process.env['DATABASE_URL'];

/** Deliberately public, each for a stated reason. Anything else must authenticate. */
const PUBLIC = new Set([
  'GET /healthz', // liveness, for the container
  'GET /readyz', // readiness, for the container
  'GET /health', // operational view; carries counts, never content
  'POST /auth/login', // the thing you use to become authenticated
  // Accepting an invitation: the person has no account yet, which is the entire point of it.
  // The token from their email is the credential, and it is single-use, hashed and time-boxed.
  'POST /auth/invite/accept',
  'POST /auth/logout', // must work whatever state the session is in
  'GET /auth/session', // answers 401 as its normal negative case
  'GET /auth/oidc/start', // a redirect to the provider
  'GET /auth/oidc/callback', // the provider's redirect back
  'POST /auth/oidc/logout', // as above
  'POST /webhooks/github', // HMAC-verified, not cookie-authenticated
  // The D3 App contract (FRM-P-14): each carries its own credential in the body or header.
  'POST /auth/native/signin', // the native app's way to become authenticated
  'POST /auth/native/refresh', // the refresh token is the credential
  'POST /auth/native/link', // a D3 Auth token plus this account's password and code
  'POST /auth/native/invite', // the invitation's token, then the challenge it answers (FRM-T-15.2)
  'PUT /uploads/:token', // a one-use upload link: the link is the credential, and it only adds one file (FRM-REQ-256)
]);

describe.skipIf(url === undefined)('every route, not only the ones tested individually', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let routes: readonly MountedRoute[];

  beforeAll(async () => {
    const config: Config = loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'http://localhost:3200',
      DATABASE_URL: url ?? '',
      KEK: Buffer.alloc(32, 1).toString('base64'),
      PEPPER: Buffer.alloc(32, 2).toString('base64'),
      COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
    });
    db = createDb(url ?? '');
    const app = createApp({ config, db });
    routes = mountedRoutes(app);

    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => { resolve(s); });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    origin = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  it('enumerates the routes, so the checks below cannot pass by finding none', () => {
    expect(routes.length).toBeGreaterThan(15);
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    // A few that certainly exist, proving the manifest covers every mounted router.
    expect(keys).toContain('POST /auth/login');
    expect(keys).toContain('GET /api/projects/:code');
    expect(keys).toContain('POST /api/undo/:auditEventId');
  });

  describe('no unauthenticated route beyond health and the webhook (FRM-REQ-028)', () => {
    it('lists every public route deliberately', () => {
      const publicRoutes = routes.filter((route) => PUBLIC.has(`${route.method} ${route.path}`));
      // Each one in the allowlist that actually exists is accounted for above, with its reason.
      expect(publicRoutes.length).toBeGreaterThan(0);
    });

    it('refuses an anonymous request to every other route', async () => {
      const guarded = routes.filter((route) => !PUBLIC.has(`${route.method} ${route.path}`));
      expect(guarded.length).toBeGreaterThan(8);

      const leaked: string[] = [];
      for (const route of guarded) {
        // A concrete URL for a parameterised path. It need not exist: an unauthenticated request
        // must be refused before anything is looked up.
        const path = route.path
          .replace(':code', 'NOPE')
          .replace(':humanId', 'NOPE-REQ-001')
          .replace(':auditEventId', '01a0b000-0000-7000-8000-000000000000')
          .replace(/:[A-Za-z]+/g, 'x');

        const res = await fetch(`${origin}${path}`, {
          method: route.method,
          ...(route.method === 'POST' || route.method === 'PATCH'
            ? { headers: { 'content-type': 'application/json' }, body: '{}' }
            : {}),
        });

        // 401 is the only correct answer. A 404 would mean the lookup happened first, which leaks
        // whether a thing exists to somebody who should not be asking.
        if (res.status !== 401) {
          leaked.push(`${route.method} ${route.path} answered ${String(res.status)}`);
        }
      }

      expect(leaked).toEqual([]);
    });
  });

  describe('every mutating route audits (FRM-REQ-136)', () => {
    it('routes every mutation through the audited domain layer', () => {
      const routesDir = resolve(import.meta.dirname, '../../src/routes');
      const files = readdirSync(routesDir).filter((f) => f.endsWith('.ts'));

      const offenders: string[] = [];
      for (const file of files) {
        const source = readFileSync(join(routesDir, file), 'utf8');
        // A route file may not reach Prisma directly for a write. Writes go through the domain
        // layer, which is where the audit event is written in the same transaction.
        const directWrites = [
          /\bdb\.\w+\.create\(/,
          /\bdb\.\w+\.update\(/,
          /\bdb\.\w+\.delete\(/,
          /\bdb\.\w+\.upsert\(/,
          /\bdb\.\w+\.createMany\(/,
          /\bdb\.\w+\.updateMany\(/,
          /\bdb\.\w+\.deleteMany\(/,
        ];
        for (const pattern of directWrites) {
          if (pattern.test(source)) offenders.push(`${file}: ${pattern.source}`);
        }
      }

      expect(
        offenders,
        'a route wrote to the database directly; writes belong in the domain layer, where the ' +
          'audit event is written in the same transaction',
      ).toEqual([]);
    });

    it('writes an audit event for each of create, update and delete', async () => {
      // Does its own mutating, rather than depending on what another suite happened to leave
      // behind: a test that only passes when the whole file set runs is a test that will one day
      // fail for a reason nobody can find.
      const { createProject, updateProject } = await import('../../src/domain/projects.js');
      const { softDelete } = await import('../../src/domain/undo.js');
      const actor = { actor: 'route-enumeration', actorKind: 'system' as const };

      await db.project.deleteMany({ where: { code: 'AUD' } });
      const project = await createProject(db, actor, { code: 'AUD', name: 'Audit Enumeration' });
      await updateProject(db, actor, 'AUD', { name: 'Renamed' });

      const requirement = await db.requirement.create({
        data: {
          projectId: project.id,
          humanId: 'AUD-REQ-001',
          seq: 1,
          statement: 'Foreman shall audit every mutation.',
        },
      });
      await softDelete(db, actor, 'requirement', requirement.humanId);

      const events = await db.auditEvent.findMany({
        where: { actor: 'route-enumeration' },
        select: { action: true },
      });
      const seen = new Set(events.map((e) => e.action));
      for (const action of ['create', 'update', 'delete'] as const) {
        expect(seen.has(action), `no ${action} was audited`).toBe(true);
      }

      await db.project.deleteMany({ where: { code: 'AUD' } });
      await db.auditEvent.deleteMany({ where: { actor: 'route-enumeration' } });
    });
  });
});
