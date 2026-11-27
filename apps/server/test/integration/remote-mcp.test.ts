import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { ResourceToken, Verifier } from '../../src/auth/resource-server.js';
import { TokenRejected } from '../../src/auth/resource-server.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * The remote MCP endpoint as an OAuth 2.1 resource server (ADR-013).
 *
 * The endpoint is public, and it fronts every project's internals. What keeps that honest is the
 * audience rule: a token is acceptable only if D3 Auth issued it *for Foreman*. The verifier is
 * stubbed here so the tests can assert what the route does with each verdict — the real one's job
 * is to reach that verdict, and it is exercised against a live issuer by d3-auth's own suite.
 */

const url = process.env['DATABASE_URL'];
const ISS = 'https://auth.example.test';
const EMAIL = 'remote-mcp@example.com';

/** Accepts exactly one token, the way the real verifier accepts exactly one audience. */
function stubVerifier(accepted: string, token: ResourceToken): Verifier {
  return {
    verify(presented: string): Promise<ResourceToken> {
      if (presented !== accepted) {
        // Wrong audience, wrong issuer, expired, forged: one answer for all of them.
        return Promise.reject(new TokenRejected('not for this resource'));
      }
      return Promise.resolve(token);
    },
  };
}

describe.skipIf(url === undefined)('the remote MCP endpoint', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let userId: string;

  const GOOD = 'a.good.token';

  beforeAll(async () => {
    const config: Config = loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'https://foreman.example.test',
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
        displayName: 'Remote',
        status: 'active',
        identities: { create: { iss: ISS, sub: 'sub-remote', claims: {} } },
      },
    });
    userId = user.id;

    const verifier = stubVerifier(GOOD, {
      sub: 'sub-remote',
      iss: ISS,
      scopes: ['openid', 'profile'],
      email: EMAIL,
    });

    server = await new Promise<Server>((resolve) => {
      const s = createApp({ config, db, verifier }).listen(0, () => { resolve(s); });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    origin = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await db.identity.deleteMany({ where: { iss: ISS } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  const call = (token?: string) =>
    fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

  describe('discovery', () => {
    it('serves the protected-resource document as JSON, not as the console', async () => {
      const res = await fetch(`${origin}/.well-known/oauth-protected-resource`);

      // The regression: the SPA catch-all answered every unmatched path with index.html and a 200,
      // so a client probing discovery got a webpage — which looks like success and parses as noise.
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');

      const doc = (await res.json()) as { resource: string; authorization_servers: string[] };
      expect(doc.resource).toBe('https://foreman.example.test/mcp');
      expect(doc.authorization_servers).toEqual([ISS]);
    });

    it('serves it at the path-suffixed location the spec tells clients to try', async () => {
      const res = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { resource: string }).resource).toContain('/mcp');
    });

    it('404s an unknown well-known document rather than handing back HTML', async () => {
      const res = await fetch(`${origin}/.well-known/openid-configuration`);

      // Foreman is not an authorization server. Saying so plainly beats a 200 full of markup.
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
    });
  });

  describe('the challenge', () => {
    it('refuses an anonymous call and says where to authenticate', async () => {
      const res = await call();
      expect(res.status).toBe(401);

      // Without `resource_metadata` a connector has nothing to go on; this header is the whole
      // discovery entry point for a client that guessed nothing.
      const challenge = res.headers.get('www-authenticate') ?? '';
      expect(challenge).toContain('Bearer');
      expect(challenge).toContain('resource_metadata="https://foreman.example.test/.well-known/oauth-protected-resource"');
    });

    it('refuses a token the verifier does not accept', async () => {
      // The audience rule, from the route's side: a token for another resource server is simply
      // not an identity here. Anything else would make every D3 Auth token a Foreman token.
      expect((await call('a.different.token')).status).toBe(401);
    });

    it('refuses a token whose identity is not linked to any account', async () => {
      await db.identity.deleteMany({ where: { iss: ISS } });
      expect((await call(GOOD)).status).toBe(401);

      // Restored for the tests below; the account itself was never in question.
      await db.identity.create({
        data: { userId, iss: ISS, sub: 'sub-remote', claims: {} },
      });
    });

    it('refuses a suspended account, even with a perfectly good token', async () => {
      await db.user.update({ where: { id: userId }, data: { status: 'suspended' } });
      expect((await call(GOOD)).status).toBe(401);
      await db.user.update({ where: { id: userId }, data: { status: 'active' } });
    });
  });

  describe('a token that is for Foreman', () => {
    it('speaks MCP and lists the same tools the shim serves', async () => {
      const res = await call(GOOD);
      expect(res.status, await res.clone().text()).toBe(200);

      // The transport answers as an SSE stream or as JSON depending on what was accepted; the
      // payload is the JSON-RPC result either way, so read the text and find it.
      const body = await res.text();
      const line = body.split('\n').find((l) => l.includes('"result"')) ?? body;
      const payload = JSON.parse(line.replace(/^data: /, '')) as {
        result?: { tools?: { name: string }[] };
      };

      const tools = payload.result?.tools ?? [];
      expect(tools.length).toBeGreaterThan(0);
      // Same surface as stdio, because it is literally the same server (ADR-013) — and still
      // inside the budget ADR-002 set.
      expect(tools.length).toBeLessThanOrEqual(12);
      expect(tools.map((t) => t.name)).toContain('foreman_portfolio');
    });

    it('reaches the API as the linked account, through the ordinary guards', async () => {
      // The loopback call carries the caller's own token and re-enters the normal request path,
      // so this answering at all is the evidence that there is no second authorization surface.
      const res = await call(GOOD);
      const body = await res.text();
      expect(body).not.toContain('authentication required');
      expect(body).not.toContain('this token may not');
    });
  });

  describe('what it will not do', () => {
    /** One JSON-RPC call over /mcp, as the linked account, answered as its `result`. */
    const rpc = async (method: string, params: unknown) => {
      const res = await fetch(`${origin}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${GOOD}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const body = await res.text();
      const line = body.split('\n').find((l) => l.includes('"result"')) ?? body;
      return (JSON.parse(line.replace(/^data: /, '')) as { result: { content: { text: string }[]; isError?: boolean } }).result;
    };

    it('never reads its own disk to attach a file: it hands back a one-use upload command (FRM-ADR-026)', async () => {
      const created = await rpc('tools/call', {
        name: 'foreman_create',
        arguments: { kind: 'project_idea', text: 'RMCP attach target' },
      });
      const idea = (JSON.parse(created.content[0]?.text ?? '{}') as { humanId: string }).humanId;
      expect(idea).toMatch(/^PI-\d+$/);

      // A real file on the server's own disk, named the way an attacker would want it read.
      const result = await rpc('tools/call', {
        name: 'foreman_update',
        arguments: { id: idea, attach: '/etc/hosts.txt' },
      });
      expect(result.isError ?? false, result.content[0]?.text).toBe(false);
      const answer = JSON.parse(result.content[0]?.text ?? '{}') as { attached: boolean; command: string };
      expect(answer.attached).toBe(false);
      expect(answer.command).toMatch(/^curl --fail-with-body -sS -T '\/etc\/hosts.txt' 'https:\/\/foreman.example.test\/uploads\/frmup_/);
      // Nothing was filed: the server sent no bytes of its own anywhere.
      const target = await db.projectIdea.findFirst({ where: { humanId: idea } });
      expect(await db.attachment.count({ where: { entityId: target?.id ?? '' } })).toBe(0);

      await db.attachmentTicket.deleteMany({ where: { entityHumanId: idea } });
      await db.auditEvent.deleteMany({ where: { OR: [{ entityType: 'attachment_ticket', actor: EMAIL }, { entityHumanId: idea }] } });
      await db.projectIdea.deleteMany({ where: { title: 'RMCP attach target' } });
    });

    it('answers GET and DELETE plainly, because it keeps no session', async () => {
      for (const method of ['GET', 'DELETE']) {
        const res = await fetch(`${origin}/mcp`, {
          method,
          headers: { authorization: `Bearer ${GOOD}` },
        });
        expect(res.status, method).toBe(405);
      }
    });

    it('does not let a Foreman scoped token reach it as if it were a D3 Auth one', async () => {
      // The two credentials are told apart by shape. An `frm_` token is not a JWT and must not be
      // fed to the verifier, or a lookup failure in one path could become an acceptance in the other.
      expect((await call('frm_not_a_jwt_at_all')).status).toBe(401);
    });
  });
});
