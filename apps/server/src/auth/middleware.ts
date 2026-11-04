import type { NextFunction, Request, Response } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { REVIEWS, type UserRole } from '@foreman/shared';
import type { ActorKind } from '../generated/prisma/enums.js';
import { safeEqual } from './passwords.js';
import { MCP_LOOPBACK_HEADER, MCP_LOOPBACK_SECRET, type Verifier } from './resource-server.js';
import { hashToken } from './sessions.js';
import * as sessions from './sessions.js';

/**
 * Two ways in, one identity out (API Contract): a session cookie for the console, a bearer token
 * for the MCP shim. Everything downstream reads `req.auth` and does not care which it was.
 */

export interface AuthContext {
  readonly userId: string | null;
  readonly actor: string;
  readonly actorKind: ActorKind;
  readonly sessionId?: string;
  /** A native app's session (FRM-P-14): a person, signed in on a device, with a Bearer token. */
  readonly native?: boolean;
  /** A D3 Auth token for the app's audience (FRM-T-14.3): a person, but never a console session. */
  readonly appToken?: boolean;
  /** The D3 Auth identity an app token was mapped through — what owns its push registration. */
  readonly identityId?: string;
  readonly tokenId?: string;
  readonly scopes: readonly string[];
  /**
   * The account's role (FRM-ADR-016). `null` for a token, which has scopes instead — a token is
   * not a person and has no business appearing on a board as one.
   */
  readonly role: UserRole | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export interface AuthMiddlewareDeps {
  readonly db: Db;
  readonly config: Config;
  /** Present only when D3 Auth is configured; absent Foremans offer no remote MCP (ADR-013). */
  readonly verifier?: Verifier | null;
}

/** True when cookies must carry the `Secure` attribute — that is, everywhere but local HTTP. */
export function isSecureOrigin(config: Config): boolean {
  return config.BASE_URL.startsWith('https://');
}

/**
 * Attach an auth context when one is presented. Never rejects: route guards decide what an
 * unauthenticated request means, so a public endpoint stays public.
 */
export function attachAuth({ db, config, verifier }: AuthMiddlewareDeps) {
  const secure = isSecureOrigin(config);

  return (req: Request, _res: Response, next: NextFunction): void => {
    void (async () => {
      const header = req.headers.authorization;
      if (header !== undefined && header.startsWith('Bearer ')) {
        const presented = header.slice('Bearer '.length).trim();

        // A D3 Auth access token for the remote MCP endpoint (ADR-013). Told apart by shape, not by
        // trying both: Foreman's own tokens are `frm_`-prefixed, and a JWT has three dot-separated
        // segments, so neither lookup ever sees the other's credential.
        if (verifier !== null && verifier !== undefined && !presented.startsWith('frm_') && presented.split('.').length === 3) {
          // Each path accepts exactly one audience (FRM-T-14.3): `/mcp`, and the API calls it loops
          // back, take the MCP endpoint's; every other API request takes the app's. A token for one
          // is refused on the other.
          const viaMcp = req.path === '/mcp' || req.path.startsWith('/mcp/') || req.get(MCP_LOOPBACK_HEADER) === MCP_LOOPBACK_SECRET;
          const resolved = viaMcp ? await resourceAuth(db, verifier, presented) : await appAuth(db, verifier, presented);
          // Assigned only when there is one: `exactOptionalPropertyTypes` treats an explicit
          // `undefined` as different from absent, and downstream guards test for absence.
          if (resolved !== null) req.auth = resolved;
          next();
          return;
        }

        // Neither an API token nor a JWT: a native app's session (FRM-P-14), whose access token is
        // the row's hash and opens nothing as a cookie.
        if (!presented.startsWith('frm_')) {
          const session = await sessions.resolve(db, presented, 'bearer');
          if (session !== null) {
            const user = await db.user.findUnique({ where: { id: session.userId }, select: { email: true, role: true } });
            req.auth = {
              userId: session.userId,
              actor: user?.email ?? session.userId,
              actorKind: 'user',
              sessionId: session.sessionId,
              native: true,
              scopes: ['*'],
              role: user?.role ?? null,
            };
          }
          next();
          return;
        }

        const token = await db.apiToken.findUnique({ where: { tokenHash: hashToken(presented) } });
        if (
          token !== null &&
          token.revokedAt === null &&
          (token.expiresAt === null || token.expiresAt.getTime() > Date.now()) &&
          // The lookup was by hash, so this is belt and braces against a hash collision claim.
          safeEqual(hashToken(presented), token.tokenHash)
        ) {
          // Last-used is advisory; a failed write must not fail the request.
          void db.apiToken
            .update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
            .catch(() => undefined);
          req.auth = {
            userId: null,
            actor: token.name,
            actorKind: 'mcp',
            tokenId: token.id,
            scopes: token.scopes,
            role: null,
          };
        }
        next();
        return;
      }

      const cookie = sessions.readCookie(req, secure);
      if (cookie !== null) {
        const session = await sessions.resolve(db, cookie);
        if (session !== null) {
          const user = await db.user.findUnique({
            where: { id: session.userId },
            select: { email: true, role: true },
          });
          req.auth = {
            userId: session.userId,
            actor: user?.email ?? session.userId,
            actorKind: 'user',
            sessionId: session.sessionId,
            scopes: ['*'],
            // Read per request rather than baked into the session, so a role change takes effect
            // on the next click instead of the next sign-in. Demoting somebody who is mid-session
            // is exactly when you need it to land.
            role: user?.role ?? null,
          };
        }
      }
      next();
    })().catch(next);
  };
}

/**
 * A verified D3 Auth token resolved to the Foreman account it is linked to.
 *
 * **Linked, never matched.** The identity must already exist for `(iss, sub)` — the same rule the
 * console's callback follows (ADR-004). A token arriving with a familiar email provisions nothing
 * and adopts nothing; if no identity is linked, this is not an identity Foreman knows, and the
 * request simply carries no auth.
 */
async function resourceAuth(
  db: Db,
  verifier: Verifier,
  presented: string,
): Promise<AuthContext | null> {
  let token;
  try {
    token = await verifier.verify(presented);
  } catch {
    // Wrong audience, wrong issuer, expired or forged — all the same answer, and none of them
    // worth telling the caller apart.
    return null;
  }

  const identity = await db.identity.findUnique({
    where: { iss_sub: { iss: token.iss, sub: token.sub } },
    select: { userId: true, user: { select: { email: true, status: true } } },
  });
  if (identity === null || identity.user.status !== 'active') return null;

  return {
    userId: identity.userId,
    actor: identity.user.email,
    // `mcp`, not `user`: the audit trail should say a tool did this, even though a person
    // authorized it. The console is the only surface that counts as the person acting directly.
    actorKind: 'mcp',
    // Deliberately not `admin`, and never `*`: a remote token must not mint other tokens or manage
    // accounts, whoever is holding it. The console remains the only place that can.
    scopes: ['read', 'write'],
    // Null for the same reason: a remote token acts with scopes, not with the seniority of
    // whoever minted it. Reviewing and deciding are things a person does in the console.
    role: null,
  };
}

/**
 * A verified D3 Auth token for **the app's** audience (FRM-T-14.3): D3 Constellation acting as the
 * person it signed in. Linked by `(iss, sub)` and nothing else, like every D3 Auth path.
 *
 * It reads and writes as that person, with their role — but it is never a console session: no
 * `sessionId`, and never `admin` — so the console-only routes (tokens, TOTP) refuse it, and an app
 * token can never mint an API token, whoever is holding it.
 */
async function appAuth(db: Db, verifier: Verifier, presented: string): Promise<AuthContext | null> {
  let token;
  try {
    token = await verifier.verify(presented, 'app');
  } catch {
    return null;
  }
  const identity = await db.identity.findUnique({
    where: { iss_sub: { iss: token.iss, sub: token.sub } },
    select: { id: true, userId: true, user: { select: { email: true, status: true, role: true, deletedAt: true } } },
  });
  if (identity === null || identity.user.status !== 'active' || identity.user.deletedAt !== null) return null;
  return {
    userId: identity.userId,
    actor: identity.user.email,
    actorKind: 'user',
    appToken: true,
    identityId: identity.id,
    scopes: ['read', 'write'],
    role: identity.user.role,
  };
}

/**
 * Guard: the caller's role must be one of these (FRM-ADR-016).
 *
 * Separate from `requireScope`, and not a re-spelling of it. A scope says what a *credential* may
 * do; a role says what a *person* may do. A token with `write` may create a submission and must
 * never decide one, which is a sentence neither concept can express alone.
 *
 * In `solo` mode this passes anything authenticated: the single operator is the admin, and a
 * guard that can only ever say yes is better stated once here than scattered as conditionals.
 */
export function requireRole(config: Pick<Config, 'FOREMAN_MODE'>, ...allowed: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.auth === undefined) {
      res.status(401).json({ error: 'authentication required' });
      return;
    }
    if (config.FOREMAN_MODE === 'solo') {
      next();
      return;
    }
    if (req.auth.role === null || !allowed.includes(req.auth.role)) {
      // What was needed, not merely "no": the reader is a colleague who will otherwise ask.
      res.status(403).json({
        error: `this needs the ${allowed.join(' or ')} role`,
      });
      return;
    }
    next();
  };
}

/** Whether the caller may review — score, comment internally, and decide. */
export function reviews(
  config: Pick<Config, 'FOREMAN_MODE'>,
  auth: AuthContext | undefined,
): boolean {
  if (auth === undefined) return false;
  if (config.FOREMAN_MODE === 'solo') return true;
  return auth.role !== null && REVIEWS.includes(auth.role);
}

/** Guard: a request without an identity gets 401 and nothing else. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.auth === undefined) {
    res.status(401).json({ error: 'authentication required' });
    return;
  }
  next();
}

/**
 * The scopes a token may hold. `read` answers questions; `write` changes state; `admin` manages
 * tokens and accounts. A session always holds all three — the operator signing in is the owner —
 * and a token holds only what it was issued with (FRM-REQ-025, FRM-REQ-026, FRM-REQ-027).
 */
export const SCOPES = ['read', 'write', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

export function hasScope(auth: AuthContext | undefined, scope: Scope): boolean {
  if (auth === undefined) return false;
  // A signed-in user is the operator. Tokens are the things that are scoped.
  if (auth.scopes.includes('*')) return true;
  return auth.scopes.includes(scope);
}

/**
 * Guard a route by scope. **A denial is audited**, because a read-only token being used on a write
 * route is either a misconfiguration worth finding or an attempt worth seeing — and either way,
 * silence is the wrong answer.
 */
export function requireScope(db: Db, scope: Scope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (hasScope(req.auth, scope)) {
      next();
      return;
    }

    const auth = req.auth;
    void db.auditEvent
      .create({
        data: {
          actor: auth?.actor ?? 'anonymous',
          actorKind: auth?.actorKind ?? 'system',
          action: 'update',
          entityType: 'api_token',
          entityId: auth?.tokenId ?? '00000000-0000-7000-8000-000000000000',
          after: {
            event: 'scope_denied',
            required: scope,
            held: auth?.scopes ?? [],
            method: req.method,
            path: req.path,
          },
        },
      })
      // The denial itself must still happen even if recording it fails.
      .catch(() => undefined);

    res.status(403).json({ error: `this token may not ${scope}` });
  };
}

/**
 * Whether the caller is a person at the console — a session cookie — rather than a credential.
 *
 * **Not the same question as "is there a `userId`?"** A D3 Auth token for `/mcp` resolves to a
 * real account and carries its `userId`, but it is a credential narrowed to `read`/`write`.
 * Asking for a `userId` let it through every console-only route, where it could mint itself an
 * `admin` token or reset the account's TOTP — undoing the narrowing in one request.
 */
export function isConsoleSession(auth: AuthContext | undefined): boolean {
  // A native session is a person signed in with their own password and code (FRM-T-14.3), so it
  // counts; an app token from D3 Auth carries no sessionId and never does.
  return (
    auth !== undefined &&
    auth.actorKind === 'user' &&
    auth.sessionId !== undefined &&
    auth.userId !== null &&
    auth.appToken !== true
  );
}

/**
 * Guard: console-only routes — tokens, TOTP enrolment. No bearer credential passes, whether a
 * scoped `frm_` token or a D3 Auth token for the remote MCP endpoint, however it is scoped.
 */
export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!isConsoleSession(req.auth)) {
    res.status(401).json({ error: 'a signed-in user is required' });
    return;
  }
  next();
}

/**
 * Guard: who may issue a token (FRM-T-029). A console session, or an `admin`-scoped `frm_` token.
 *
 * Narrower than it looks. A `frm_` token is the only bearer that carries a `tokenId`: a D3 Auth
 * token for `/mcp` or for the app's audience has none, so both still get 401 here (FRM-T-010,
 * CON-ADR-003). A `frm_` token without `admin` is refused and the refusal is audited, like any
 * other scope denial. Listing and revoking keep `requireUser`.
 */
export function requireTokenIssuer(db: Db) {
  const needAdmin = requireScope(db, 'admin');
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = req.auth;
    if (isConsoleSession(auth)) {
      next();
      return;
    }
    if (auth?.tokenId === undefined || auth.appToken === true) {
      res.status(401).json({ error: 'a signed-in user is required' });
      return;
    }
    needAdmin(req, res, next);
  };
}
