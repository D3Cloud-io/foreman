import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from 'express';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { schemaRevision } from './boot.js';
import { logger } from './logger.js';
import { attachAuth } from './auth/middleware.js';
import { mcpRoutes } from './routes/mcp.js';
import { manifestRoutes, nativeRoutes, problem } from './routes/native.js';
import { pushRoutes } from './routes/push.js';
import { createVerifier, protectedResourceMetadata, type Verifier } from './auth/resource-server.js';
import { authRoutes } from './routes/auth.js';
import { oidcRoutes } from './routes/oidc.js';
import { projectRoutes } from './routes/projects.js';
import { briefRoutes } from './routes/brief.js';
import { searchRoutes } from './routes/search.js';
import { coverageRoutes } from './routes/coverage.js';
import { recordRoutes } from './routes/record.js';
import { findingRoutes, projectFindingRoutes } from './routes/findings.js';
import { operationsRoutes } from './routes/operations.js';
import { realityRoutes } from './routes/reality.js';
import { webhookRoutes } from './routes/webhooks.js';
import { buildRegistry, type JobRegistry } from './jobs/index.js';
import { linkRoutes } from './routes/links.js';
import { guidelineRoutes } from './routes/guidelines.js';
import { groupRoutes } from './routes/groups.js';
import { blobRoutes } from './routes/blobs.js';
import { screenRoutes } from './routes/screens.js';
import { projectIdeaRoutes } from './routes/projectIdeas.js';
import { boardRoutes } from './routes/board.js';
import { tokenRoutes } from './routes/tokens.js';
import { undoRoutes } from './routes/undo.js';
import type { OidcClient } from './auth/oidc.js';

export interface MountedRoute {
  readonly method: string;
  readonly path: string;
}

/**
 * Every route the app mounts, recorded as it is mounted.
 *
 * Express 5 does not expose a router's mount path statically — it is compiled into a matcher — so
 * reconstructing the surface by introspection means parsing regexps. Declaring it here instead is
 * both simpler and more honest: the app states what it serves, and the route-enumeration tests
 * check that every one of them behaves (T-2.1, T-2.11).
 */
export function mountedRoutes(app: Express): readonly MountedRoute[] {
  return (app as Express & { locals: { foremanRoutes?: MountedRoute[] } }).locals.foremanRoutes ?? [];
}

function mount(app: Express, prefix: string, router: Router): void {
  app.use(prefix, router);

  const routes = ((app.locals as { foremanRoutes?: MountedRoute[] }).foremanRoutes ??= []);
  const stack = (router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] })
    .stack;

  for (const layer of stack) {
    if (layer.route === undefined) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (!enabled) continue;
      const path = `${prefix}${layer.route.path}`.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
      routes.push({ method: method.toUpperCase(), path });
    }
  }
}

export interface AppDeps {
  readonly config: Config;
  readonly db: Db;
  /**
   * Null when D3 Auth is not configured, or was unreachable at boot. The console then shows one
   * login button instead of two, and nothing else changes (FRM-REQ-017).
   */
  readonly oidc?: OidcClient | null;
  /** Shared with the worker in production; built here when absent. Swapped in tests. */
  readonly registry?: JobRegistry;
  /** Injected by tests; built from config otherwise (ADR-013). */
  readonly verifier?: Verifier | null;
}

/**
 * The Express app. Routes arrive in Phase 1; what exists here from Phase 0 is what the Compose
 * healthchecks and the tunnel need.
 */
export function createApp({ config, db, oidc = null, registry, verifier: given }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind the Cloudflare Tunnel, so `req.ip` must come from the proxy or every login shares one
  // throttle bucket. One hop, not `true`: trusting every hop lets a client spoof its own address.
  app.set('trust proxy', 1);
  // Before `express.json`, and with its own raw parser: the HMAC is over the exact bytes GitHub
  // sent, and a re-serialised object is not those bytes.
  const jobs = registry ?? buildRegistry({ config });
  app.use('/webhooks', webhookRoutes({ db, config, registry: jobs }));
  app.use(express.json({ limit: '2mb' }));
  // Foreman as an OAuth 2.1 resource server (ADR-013). Null when D3 Auth is unconfigured, which
  // simply means no remote MCP — the stdio shim and its scoped tokens are unaffected.
  const verifier = given === undefined ? createVerifier(config) : given;
  app.use(attachAuth({ db, config, verifier }));
  // A native client's refusals as problem+json (FRM-P-14): a Bearer that is not an `frm_` API token,
  // outside /mcp, gets 401, 403 and 429 as the contract's registered problems. Everything else keeps
  // its shape — the app reads 412 and 422 as they are.
  app.use((req, res, next) => {
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (bearer === '' || bearer.startsWith('frm_') || req.path === '/mcp' || req.path.startsWith('/mcp/')) {
      next();
      return;
    }
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      const name = res.statusCode === 401 ? 'session_revoked' : res.statusCode === 403 ? 'forbidden_role' : res.statusCode === 429 ? 'throttled' : null;
      if (name === null) return json(body);
      const message = typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : 'Refused';
      problem(res, res.statusCode, name, message);
      return res;
    };
    next();
  });
  // The D3 App contract (FRM-P-14): the manifest at the root, native sessions beside the console's.
  app.use(manifestRoutes(config, verifier !== null));
  mount(app, '/auth/native', nativeRoutes({ db, config, verifier }));
  mount(app, '/auth', authRoutes({ db, config, oidcAvailable: oidc !== null, verifier }));
  mount(app, '/auth/oidc', oidcRoutes({ db, config, client: oidc }));
  mount(app, '/api/projects', projectRoutes(db));
  mount(app, '/api/brief', briefRoutes(db));
  mount(app, '/api', searchRoutes(db));
  mount(app, '/api/undo', undoRoutes(db));
  mount(app, '/api/tokens', tokenRoutes(db));
  // Push registration for D3 Constellation (FRM-T-15.4).
  mount(app, '/api/push', pushRoutes(db, config));
  mount(app, '/api/links', linkRoutes(db));
  mount(app, '/api/project-ideas', projectIdeaRoutes(db, config));
  mount(app, '/api/guidelines', guidelineRoutes(db));
  mount(app, '/api/groups', groupRoutes(db));
  mount(app, '/api/blobs', blobRoutes(db, config));
  mount(app, '/api/board', boardRoutes(db, config));
  mount(app, '/api/projects', coverageRoutes(db));
  mount(app, '/api/projects', recordRoutes(db));
  mount(app, '/api/projects', realityRoutes(db, jobs));
  mount(app, '/api/projects', projectFindingRoutes(db));
  mount(app, '/api/projects', screenRoutes(db, config));
  mount(app, '/api', findingRoutes(db));
  mount(app, '/api', operationsRoutes(db, config));

  /** Liveness: the process is up. Deliberately touches nothing else. */
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  /** Readiness: the database answers. A server that cannot reach Postgres is not ready. */
  app.get('/readyz', async (_req, res) => {
    try {
      await db.$queryRaw`select 1`;
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false, reason: 'database unreachable' });
    }
  });

  /**
   * The operational view. Queue depth, last ingest, last backup and the running schema revision —
   * the standing rule is that a deployment can state its SHA and its schema revision.
   */
  app.get('/health', async (_req, res) => {
    const [queued, running, failed, revision] = await Promise.all([
      db.job.count({ where: { status: 'queued' } }),
      db.job.count({ where: { status: 'running' } }),
      db.job.count({ where: { status: 'failed' } }),
      schemaRevision(config.DATABASE_URL),
    ]);
    res.json({
      ok: failed === 0,
      queue: { queued, running, failed },
      schemaRevision: revision,
      oidcConfigured: config.oidcConfigured,
      // Configured and reachable are different questions, and only the second one decides
      // whether the console should offer the button.
      oidcReachable: oidc !== null,
    });
  });

  /**
   * RFC 9728 protected-resource metadata (ADR-013), served at both paths the spec tells clients to
   * try: the root, and the one suffixed with the MCP endpoint's path.
   *
   * Registered **before** the SPA fallback on purpose. The catch-all answered every unmatched path
   * with the console's `index.html` and a 200, so a client probing discovery got a webpage rather
   * than a 404 — which is worse than nothing, because it looks like a successful response.
   */
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]) {
    app.get(path, (_req, res) => {
      res.json(protectedResourceMetadata(config));
    });
  }

  // Anything else under /.well-known is a 404 in JSON, never the console: a client probing for a
  // document Foreman does not serve must be told so, not handed HTML to fail on.
  app.use('/.well-known', apiNotFound);

  // An API path that matches nothing is a 404 in JSON, not Express's default HTML page: a client
  // parsing a response should never have to guess which it got.
  // Mounted before the not-found guards and the SPA: `/mcp` is neither an API path nor a screen.
  if (verifier !== null) mount(app, '/mcp', mcpRoutes({ config }));

  app.use('/api', apiNotFound);
  app.use('/auth', apiNotFound);
  app.use('/webhooks', apiNotFound);

  // The console is served by the API, not by a second process (Architecture: one origin, one
  // cookie, no CORS). In development Vite serves it instead and CONSOLE_DIST is unset.
  const consoleDist = config.CONSOLE_DIST;
  if (consoleDist !== undefined && existsSync(consoleDist)) {
    app.use(express.static(consoleDist, { index: false, maxAge: '1h' }));
    // SPA fallback, but never for the API: a mistyped endpoint must 404, not return HTML.
    app.get(/^(?!\/(?:api|auth|webhooks|healthz|readyz|health|mcp|\.well-known)\b).*/, (_req, res) => {
      res.sendFile(join(consoleDist, 'index.html'));
    });
  }

  // Last: anything thrown or passed to next(err). Never leaks the message, which may carry a query,
  // a path, or a value from the row that failed.
  app.use(((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'unhandled request error',
    );
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal error' });
  }) as ErrorRequestHandler);

  return app;
}

function apiNotFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'not found' });
}
