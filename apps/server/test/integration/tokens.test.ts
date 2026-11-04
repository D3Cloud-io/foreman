import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * Scoped API tokens (T-2.6).
 *
 * The exit demo's last line: use a read-only token on a write route, and see it refused **and
 * audited**. A denial that leaves no trace is a denial nobody learns from.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'tokens@example.com';
const PASSWORD = 'a-password-for-the-token-tests';
const CODE = 'TOK';

/** Poll until a fire-and-forget write lands, rather than sleeping a guessed interval. */
async function waitFor<T>(read: () => Promise<T | undefined>, what: string, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(url === undefined)('scoped API tokens', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;

  const asUser = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}/api${path}`, { ...init, headers });
  };

  const asToken = (token: string, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}/api${path}`, { ...init, headers });
  };

  const issue = async (name: string, scopes: string[]): Promise<{ id: string; token: string }> => {
    const res = await asUser('/tokens', {
      method: 'POST',
      body: JSON.stringify({ name, scopes }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; token: string };
  };

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

    await db.user.deleteMany({ where: { email: EMAIL } });
    const user = await db.user.create({
      data: { email: EMAIL, displayName: 'Tokens', status: 'active' },
    });
    await setPassword({ db, config }, user.id, PASSWORD);

    server = await new Promise<Server>((resolve) => {
      const s = createApp({ config, db }).listen(0, () => { resolve(s); });
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
  });

  beforeEach(async () => {
    await db.apiToken.deleteMany({ where: { name: { startsWith: 'test:' } } });
    await db.auditEvent.deleteMany({ where: { entityType: 'api_token' } });
    await db.project.deleteMany({ where: { code: CODE } });
    await asUser('/projects', { method: 'POST', body: JSON.stringify({ code: CODE, name: 'Tokens' }) });
  });

  afterAll(async () => {
    await db.apiToken.deleteMany({ where: { name: { startsWith: 'test:' } } });
    await db.project.deleteMany({ where: { code: CODE } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  it('shows the token once, and stores only its hash', async () => {
    const { id, token } = await issue('test:read', ['read']);
    expect(token.startsWith('frm_')).toBe(true);

    const row = await db.apiToken.findUniqueOrThrow({ where: { id } });
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // Listing shows enough to recognise it, and never enough to use it.
    const listed = (await (await asUser('/tokens')).json()) as {
      items: { prefix: string; tokenHash?: string }[];
    };
    const mine = listed.items.find((t) => t.prefix === token.slice(0, 12));
    expect(mine).toBeDefined();
    expect(mine?.tokenHash).toBeUndefined();
  });

  it('lets a read token read', async () => {
    const { token } = await issue('test:read', ['read']);
    expect((await asToken(token, `/brief/${CODE}`)).status).toBe(200);
    expect((await asToken(token, '/portfolio')).status).toBe(200);
  });

  it('refuses a read token on a write route, and audits the denial', async () => {
    const { id, token } = await issue('test:read', ['read']);

    const res = await asToken(token, `/projects/${CODE}/requirements`, {
      method: 'POST',
      body: JSON.stringify({ statement: 'Foreman shall not accept this.' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain('may not write');

    // Nothing was written.
    expect(await db.requirement.count({ where: { project: { code: CODE } } })).toBe(0);

    // And the attempt is in the trail, with what was needed and what was held.
    //
    // Polled, and matched on the event rather than taken as the newest row for this token: the
    // middleware records the denial with `void` so that a failure to write the trail can never
    // stop the denial itself, which means the 403 can arrive before the row does. Reading "the
    // most recent event" also raced the token's own creation event.
    const after = await waitFor(async () => {
      const rows = await db.auditEvent.findMany({ where: { entityId: id } });
      return rows
        .map(
          (row) => row.after as { event?: string; required?: string; held?: string[]; path?: string },
        )
        .find((a) => a.event === 'scope_denied');
    }, 'the scope denial should reach the audit trail');

    expect(after.event).toBe('scope_denied');
    expect(after.required).toBe('write');
    expect(after.held).toEqual(['read']);
    expect(after.path).toContain('requirements');
  });

  it('lets a write token write', async () => {
    const { token } = await issue('test:write', ['read', 'write']);
    const res = await asToken(token, `/projects/${CODE}/requirements`, {
      method: 'POST',
      body: JSON.stringify({ statement: 'Foreman shall accept this one.' }),
    });
    expect(res.status).toBe(201);
  });

  it('lets only an admin token mint another token (FRM-T-029)', async () => {
    const { token } = await issue('test:write', ['read', 'write']);
    const res = await asToken(token, '/tokens', {
      method: 'POST',
      body: JSON.stringify({ name: 'test:escalated', scopes: ['write'] }),
    });
    // A read-only token one request away from a write token is not a scope system.
    expect(res.status).toBe(403);
  });

  it('stops working the moment it is revoked', async () => {
    const { id, token } = await issue('test:read', ['read']);
    expect((await asToken(token, '/portfolio')).status).toBe(200);

    expect((await asUser(`/tokens/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await asToken(token, '/portfolio')).status).toBe(401);
  });

  it('stops working once it expires', async () => {
    const { id, token } = await issue('test:read', ['read']);
    await db.apiToken.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await asToken(token, '/portfolio')).status).toBe(401);
  });

  it('records when it was last used, without failing the request if it cannot', async () => {
    const { id, token } = await issue('test:read', ['read']);
    expect((await db.apiToken.findUniqueOrThrow({ where: { id } })).lastUsedAt).toBeNull();

    await asToken(token, '/portfolio');
    // Written asynchronously, so give it the tick it needs.
    await new Promise((r) => setTimeout(r, 50));
    expect((await db.apiToken.findUniqueOrThrow({ where: { id } })).lastUsedAt).not.toBeNull();
  });

  it('refuses a token that was never issued', async () => {
    expect((await asToken('frm_not-a-real-token', '/portfolio')).status).toBe(401);
  });

  it('audits issuing and revoking, recording the prefix and never the token', async () => {
    const { id, token } = await issue('test:read', ['read']);
    await asUser(`/tokens/${id}`, { method: 'DELETE' });

    const events = await db.auditEvent.findMany({
      where: { entityId: id },
      orderBy: { createdAt: 'asc' },
      select: { action: true, after: true, entityHumanId: true },
    });
    expect(events.map((e) => e.action)).toEqual(['create', 'delete']);

    const trail = JSON.stringify(events);
    // The prefix is *supposed* to be here — it is how a token is recognised in a list, and it is
    // not a secret. The token itself must not be, and it is the whole token that would be usable.
    expect(events[0]?.entityHumanId).toBe(token.slice(0, 12));
    expect(trail).not.toContain(token);
    expect(trail).not.toContain(token.slice(12));
  });
});
