import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import type { OidcClient } from '../../src/auth/oidc.js';
import type { ResourceToken, Verifier } from '../../src/auth/resource-server.js';
import { TokenRejected } from '../../src/auth/resource-server.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * Console-only routes stay console-only, whoever holds the credential (FRM-T-010).
 *
 * A D3 Auth access token for `/mcp` resolves to a real account — it carries a `userId` — but it is
 * narrowed to `read`/`write` so that a remote token cannot mint other tokens or manage the account.
 * The guard on those routes used to ask only "is there a `userId`?", which a remote token answers
 * yes to. So the narrowing held on every route that checked scopes and on none that checked for a
 * person: a connector could mint itself an `admin` `frm_` token, or reset the account's TOTP.
 *
 * The question the guard must ask is "is this a console session?", and these tests ask it of all
 * three credentials Foreman accepts.
 */

const url = process.env['DATABASE_URL'];
const ISS = 'https://auth.console-only.test';
const EMAIL = 'console-only@example.com';
const PASSWORD = 'a-password-for-the-console-only-tests';
const JWT = 'a.remote.token';

function stubVerifier(token: ResourceToken): Verifier {
  return {
    verify(presented: string): Promise<ResourceToken> {
      return presented === JWT
        ? Promise.resolve(token)
        : Promise.reject(new TokenRejected('not for this resource'));
    },
  };
}

describe.skipIf(url === undefined)('console-only routes', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let userId: string;
  let cookie: string;
  let adminToken: string;
  /** What `/auth/oidc/start` asked the client to link to, per call. */
  const linkRequests: (string | undefined)[] = [];

  const fakeOidc: OidcClient = {
    issuer: ISS,
    beginSignIn(linkToUserId) {
      linkRequests.push(linkToUserId);
      return Promise.resolve({ url: `${ISS}/authorize`, tx: 'tx' });
    },
    completeSignIn() {
      return Promise.reject(new Error('not exercised here'));
    },
    endSessionUrl() {
      return Promise.resolve(null);
    },
  };

  const as = (credential: { bearer: string } | { cookie: string }, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if ('bearer' in credential) headers.set('authorization', `Bearer ${credential.bearer}`);
    else headers.set('cookie', credential.cookie);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}${path}`, { ...init, headers, redirect: 'manual' });
  };

  const mintAdmin = (credential: { bearer: string } | { cookie: string }) =>
    as(credential, '/api/tokens', {
      method: 'POST',
      body: JSON.stringify({ name: 'test:console-only:minted', scopes: ['admin', 'write', 'read'] }),
    });

  beforeAll(async () => {
    const config: Config = loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'http://localhost:3200',
      DATABASE_URL: url ?? '',
      KEK: Buffer.alloc(32, 1).toString('base64'),
      PEPPER: Buffer.alloc(32, 2).toString('base64'),
      COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
      D3AUTH_ISSUER: ISS,
      D3AUTH_CLIENT_ID: 'foreman',
      D3AUTH_CLIENT_SECRET: 'not-used-here',
    });
    db = createDb(url ?? '');

    await db.identity.deleteMany({ where: { iss: ISS } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    const user = await db.user.create({
      data: {
        email: EMAIL,
        displayName: 'Console Only',
        status: 'active',
        identities: { create: { iss: ISS, sub: 'sub-console-only', claims: {} } },
      },
    });
    userId = user.id;
    await setPassword({ db, config }, user.id, PASSWORD);

    const verifier = stubVerifier({ sub: 'sub-console-only', iss: ISS, scopes: ['openid'], email: EMAIL });
    server = await new Promise<Server>((resolve) => {
      const s = createApp({ config, db, verifier, oidc: fakeOidc }).listen(0, () => { resolve(s); });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    origin = `http://127.0.0.1:${String(address.port)}`;

    const signIn = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    // The strongest `frm_` token there is, minted the legitimate way.
    const issued = await as({ cookie }, '/api/tokens', {
      method: 'POST',
      body: JSON.stringify({ name: 'test:console-only:admin', scopes: ['admin', 'write', 'read'] }),
    });
    expect(issued.status).toBe(201);
    adminToken = ((await issued.json()) as { token: string }).token;
  });

  beforeEach(async () => {
    await db.apiToken.deleteMany({ where: { name: 'test:console-only:minted' } });
    linkRequests.length = 0;
  });

  afterAll(async () => {
    await db.apiToken.deleteMany({ where: { name: { startsWith: 'test:console-only:' } } });
    await db.identity.deleteMany({ where: { iss: ISS } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  describe('a D3 Auth token for /mcp', () => {
    it('is a real identity, so the refusals below are about the route and not the token', async () => {
      expect((await as({ bearer: JWT }, '/api/portfolio')).status).toBe(200);
    });

    it('cannot mint a token, admin or otherwise', async () => {
      const res = await mintAdmin({ bearer: JWT });
      expect(res.status).toBe(401);
      expect(await db.apiToken.count({ where: { name: 'test:console-only:minted' } })).toBe(0);
    });

    it('cannot list or revoke tokens', async () => {
      expect((await as({ bearer: JWT }, '/api/tokens')).status).toBe(401);

      const target = await db.apiToken.findFirstOrThrow({ where: { name: 'test:console-only:admin' } });
      expect((await as({ bearer: JWT }, `/api/tokens/${target.id}`, { method: 'DELETE' })).status).toBe(401);
      expect((await db.apiToken.findUniqueOrThrow({ where: { id: target.id } })).revokedAt).toBeNull();
    });

    it('cannot reset or replace the account’s second factor', async () => {
      // Enrolment clears `totpConfirmedAt`, so reaching it at all switches TOTP off for the console.
      const confirmed = new Date('2026-01-01T00:00:00Z');
      await db.credential.update({ where: { userId }, data: { totpConfirmedAt: confirmed } });

      expect((await as({ bearer: JWT }, '/auth/totp/enrol', { method: 'POST' })).status).toBe(401);
      expect(
        (await as({ bearer: JWT }, '/auth/totp/confirm', {
          method: 'POST',
          body: JSON.stringify({ code: '000000' }),
        })).status,
      ).toBe(401);

      const credential = await db.credential.findUniqueOrThrow({ where: { userId } });
      expect(credential.totpConfirmedAt).toEqual(confirmed);
      await db.credential.update({ where: { userId }, data: { totpConfirmedAt: null, totpSecret: null } });
    });

    it('cannot start linking another D3 Auth identity to the account', async () => {
      // A linked identity is a way into the console. The bearer is not the console.
      await as({ bearer: JWT }, '/auth/oidc/start?link=1');
      expect(linkRequests).toEqual([undefined]);
    });
  });

  describe('an admin frm_ token (FRM-T-029)', () => {
    const issue = (bearer: string, scopes: string[]) =>
      as({ bearer }, '/api/tokens', {
        method: 'POST',
        body: JSON.stringify({ name: 'test:console-only:minted', scopes }),
      });

    it('mints a token, shown once and hashed at rest, and the audit event names the issuer', async () => {
      const res = await issue(adminToken, ['read', 'write']);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; token: string; scopes: string[] };
      expect(body.token.startsWith('frm_')).toBe(true);
      expect(body.scopes).toEqual(['read', 'write']);

      const row = await db.apiToken.findUniqueOrThrow({ where: { id: body.id } });
      expect(row.tokenHash).not.toBe(body.token);
      expect(JSON.stringify(row)).not.toContain(body.token);

      const issuerRow = await db.apiToken.findFirstOrThrow({ where: { name: 'test:console-only:admin' } });
      const event = await db.auditEvent.findFirstOrThrow({ where: { entityType: 'api_token', entityId: body.id } });
      expect(event.actor).toBe('test:console-only:admin');
      expect(event.after).toMatchObject({ issuedByTokenId: issuerRow.id });
      expect(JSON.stringify(event)).not.toContain(body.token);
    });

    it('may issue an admin token, since it holds admin itself', async () => {
      expect((await issue(adminToken, ['admin', 'write', 'read'])).status).toBe(201);
    });

    it('cannot issue scopes it does not hold: a typed 403, audited, nothing minted', async () => {
      const issued = await as({ cookie }, '/api/tokens', {
        method: 'POST',
        body: JSON.stringify({ name: 'test:console-only:limited', scopes: ['admin', 'read'] }),
      });
      const limited = ((await issued.json()) as { token: string }).token;
      const res = await issue(limited, ['admin', 'read', 'write']);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('scope_escalation');
      expect(await db.apiToken.count({ where: { name: 'test:console-only:minted' } })).toBe(0);

      const limitedRow = await db.apiToken.findFirstOrThrow({ where: { name: 'test:console-only:limited' } });
      const denied = await db.auditEvent.findFirst({
        where: { entityType: 'api_token', entityId: limitedRow.id, after: { path: ['event'], equals: 'scope_escalation_denied' } },
      });
      expect(denied).not.toBeNull();
    });

    it.each([['read'], ['write'], ['read', 'write']])('a %s-scoped token is refused', async (...scopes) => {
      const issued = await as({ cookie }, '/api/tokens', {
        method: 'POST',
        body: JSON.stringify({ name: 'test:console-only:weak', scopes }),
      });
      const weak = ((await issued.json()) as { token: string }).token;
      const res = await issue(weak, ['read']);
      expect([401, 403]).toContain(res.status);
      expect(await db.apiToken.count({ where: { name: 'test:console-only:minted' } })).toBe(0);
    });

    it('still cannot list or revoke tokens', async () => {
      expect((await as({ bearer: adminToken }, '/api/tokens')).status).toBe(401);
      const target = await db.apiToken.findFirstOrThrow({ where: { name: 'test:console-only:admin' } });
      expect((await as({ bearer: adminToken }, `/api/tokens/${target.id}`, { method: 'DELETE' })).status).toBe(401);
      expect((await db.apiToken.findUniqueOrThrow({ where: { id: target.id } })).revokedAt).toBeNull();
    });

    it('cannot reach TOTP enrolment', async () => {
      expect((await as({ bearer: adminToken }, '/auth/totp/enrol', { method: 'POST' })).status).toBe(401);
    });
  });

  describe('the console session', () => {
    it('still mints, lists and links — the control', async () => {
      expect((await mintAdmin({ cookie })).status).toBe(201);
      expect((await as({ cookie }, '/api/tokens')).status).toBe(200);

      await as({ cookie }, '/auth/oidc/start?link=1');
      expect(linkRequests).toEqual([userId]);
    });
  });
});
