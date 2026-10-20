import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
// Source, not the package name, as mcp.test.ts does: the package's `exports` point at `dist`.
import { createClient } from '../../../../packages/mcp/src/client.js';
import { createServer as createMcpServer } from '../../../../packages/mcp/src/server.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * Screens, end to end (FRM-T-12.2; FRM-REQ-189, 192 … 195, 198, 199).
 *
 * The whole life of one screen through the real routes: created with a project-prefixed ID, given
 * a Figma proposal with its provenance, given a second that supersedes the first while the first
 * stays readable, given a capture at a commit, judged three ways — and then read back through
 * `foreman_get` over the real MCP server, which has to hand the pictures over as images. A gap in
 * `@d3cloud/ui` cites a DS requirement and shows up in that requirement's backlinks.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'screens@example.com';
const PASSWORD = 'a-password-for-the-screen-tests';
const CODE = 'SCRT';
const DS = 'DS';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A PNG signature and filler: the blob store decides by the leading bytes. */
const png = (label: string) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(label)]);
const PROPOSAL_ONE = png('screens-test proposal one');
const PROPOSAL_TWO = png('screens-test proposal two');
const PROPOSAL_MOBILE = png('screens-test proposal mobile');
const CAPTURE = png('screens-test capture');
const NOT_AN_IMAGE = Buffer.from(JSON.stringify({ kind: 'screens-test', ok: true }));
const ALL = [PROPOSAL_ONE, PROPOSAL_TWO, PROPOSAL_MOBILE, CAPTURE, NOT_AN_IMAGE];

const COMMIT = 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678';
const FIGMA = { figmaFileKey: 'U0kWWofDq6tP5m8OljAQJW', figmaNodeId: '12:34' };

interface Version {
  id: string;
  kind: string;
  blobSha256: string;
  url: string;
  viewport: string;
  theme: string;
  status: string | null;
  figmaFileKey: string | null;
  figmaNodeId: string | null;
  figmaFileVersion: string | null;
  commitSha: string | null;
  verdicts: { verdict: string; reviewer: string; note: string | null }[];
}

interface Detail {
  humanId: string;
  name: string;
  route: string | null;
  current: { proposals: Version[]; captures: Version[] };
  proposals: Version[];
  captures: Version[];
  components: { name: string; kind: string; requirement: { humanId: string } | null }[];
  links: { humanId: string; kind: string }[];
}

describe.skipIf(url === undefined)('screens', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;
  let blobDir: string;
  let readToken: string;
  let writeToken: string;
  /** Whether this file made the DS project, and so may remove it. */
  let madeDs = false;
  let dsRequirement: string;
  let ownRequirement: string;

  const call = (path: string, init: RequestInit & { token?: string | null } = {}) => {
    const headers = new Headers(init.headers);
    const token = init.token === undefined ? writeToken : init.token;
    if (token === null) headers.set('cookie', cookie);
    else headers.set('authorization', `Bearer ${token}`);
    if (init.body !== undefined && typeof init.body === 'string') {
      headers.set('content-type', 'application/json');
    }
    return fetch(`${origin}/api${path}`, { ...init, headers });
  };
  const post = (path: string, body: unknown, token?: string | null) =>
    call(path, { method: 'POST', body: JSON.stringify(body), ...(token === undefined ? {} : { token }) });
  const screens = `/projects/${CODE}/screens`;
  const detail = async (humanId: string) => {
    const res = await call(`${screens}/${humanId}`, { token: readToken });
    expect(res.status).toBe(200);
    return (await res.json()) as Detail;
  };

  async function upload(bytes: Buffer, type = 'image/png'): Promise<string> {
    const form = new FormData();
    form.append('file', new File([bytes], 'screen.png', { type }));
    const res = await call('/blobs', { method: 'POST', body: form });
    expect([200, 201]).toContain(res.status);
    return ((await res.json()) as { sha256: string }).sha256;
  }

  /** A connected MCP client over the real server, holding a real token (as mcp.test.ts does). */
  async function connect(token: string) {
    const mcp = createMcpServer({ client: createClient({ baseUrl: origin, token }) });
    const client = new Client({ name: 'screens', version: '0.0.0' }, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), mcp.connect(b)]);
    return client;
  }

  const clean = async () => {
    // The project first: its screens' versions hold the blobs by foreign key.
    await db.project.deleteMany({ where: { code: CODE } });
    if (madeDs) await db.project.deleteMany({ where: { code: DS } });
    await db.blob.deleteMany({ where: { sha256: { in: ALL.map(sha) } } });
  };

  beforeAll(async () => {
    blobDir = await mkdtemp(join(tmpdir(), 'foreman-screens-'));
    const config: Config = loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'http://localhost:3200',
      DATABASE_URL: url ?? '',
      KEK: Buffer.alloc(32, 1).toString('base64'),
      PEPPER: Buffer.alloc(32, 2).toString('base64'),
      COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
      FOREMAN_BLOB_DIR: blobDir,
    });
    db = createDb(url ?? '');
    await clean();

    await db.user.deleteMany({ where: { email: EMAIL } });
    const user = await db.user.create({
      data: { email: EMAIL, displayName: 'Screens', status: 'active' },
    });
    await setPassword({ db, config }, user.id, PASSWORD);

    server = await new Promise<Server>((resolve) => {
      const s = createApp({ config, db }).listen(0, () => {
        resolve(s);
      });
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

    const mint = async (name: string, scopes: string[]) => {
      const res = await post('/tokens', { name, scopes }, null);
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { token: string }).token;
    };
    readToken = await mint('screens read', ['read']);
    writeToken = await mint('screens write', ['read', 'write']);

    expect((await post('/projects', { code: CODE, name: 'Screens Test' })).status).toBe(201);
    const own = await post(`/projects/${CODE}/requirements`, {
      statement: 'The console shall show a screen beside its design.',
    });
    ownRequirement = ((await own.json()) as { humanId: string }).humanId;

    // The design system may already be in this database; it is only made, and later removed,
    // when it is not.
    if ((await db.project.findFirst({ where: { code: DS } })) === null) {
      expect((await post('/projects', { code: DS, name: 'Design System' })).status).toBe(201);
      madeDs = true;
    }
    const gapReq = await post(`/projects/${DS}/requirements`, {
      statement: 'The library shall provide a Timeline component.',
    });
    dsRequirement = ((await gapReq.json()) as { humanId: string }).humanId;
  });

  afterAll(async () => {
    if (!madeDs) await db.requirement.deleteMany({ where: { humanId: dsRequirement } });
    await clean();
    await db.auditEvent.deleteMany({
      where: { actor: { in: ['screens write', 'screens read', EMAIL] } },
    });
    await db.apiToken.deleteMany({ where: { name: { startsWith: 'screens ' } } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
    await rm(blobDir, { recursive: true, force: true });
  });

  const first = `${CODE}-SCR-001`;
  let proposalOne: Version;
  let capture: Version;

  it('creates a screen with a project-prefixed ID, a name and a route (FRM-REQ-189)', async () => {
    const res = await post(screens, { name: 'Project overview', route: '/projects/:code' });
    expect(res.status, await res.clone().text()).toBe(201);
    const screen = (await res.json()) as Detail;
    expect(screen.humanId).toBe(first);
    expect(screen.name).toBe('Project overview');
    expect(screen.route).toBe('/projects/:code');

    const list = (await (await call(screens, { token: readToken })).json()) as { items: Detail[] };
    expect(list.items.map((s) => s.humanId)).toContain(first);
  });

  it('refuses a field a screen does not store, and a write from a read-scoped token', async () => {
    expect((await post(screens, { name: 'X', body: 'lost' })).status).toBe(400);
    expect((await post(screens, { name: 'X' }, readToken)).status).toBe(403);
    const sha256 = await upload(PROPOSAL_ONE);
    const refused = await post(
      `${screens}/${first}/proposals`,
      { blobSha256: sha256, viewport: 'desktop', theme: 'dark', ...FIGMA, figmaFileVersion: '1' },
      readToken,
    );
    expect(refused.status).toBe(403);
  });

  it('records a proposal with its PNG and its Figma provenance (FRM-REQ-192)', async () => {
    const sha256 = await upload(PROPOSAL_ONE);
    const res = await post(`${screens}/${first}/proposals`, {
      blobSha256: sha256,
      viewport: 'desktop',
      theme: 'dark',
      ...FIGMA,
      figmaFileVersion: '100',
    });
    expect(res.status, await res.clone().text()).toBe(201);
    proposalOne = (await res.json()) as Version;
    expect(proposalOne).toMatchObject({
      kind: 'proposal',
      blobSha256: sha256,
      url: `/api/blobs/${sha256}`,
      status: 'current',
      figmaFileKey: FIGMA.figmaFileKey,
      figmaNodeId: FIGMA.figmaNodeId,
      figmaFileVersion: '100',
      commitSha: null,
    });
  });

  it('refuses a proposal with no provenance, or for an image never uploaded', async () => {
    const sha256 = sha(PROPOSAL_ONE);
    const noSource = await post(`${screens}/${first}/proposals`, {
      blobSha256: sha256,
      viewport: 'desktop',
      theme: 'dark',
    });
    expect(noSource.status).toBe(400);

    const missing = await post(`${screens}/${first}/proposals`, {
      blobSha256: sha(Buffer.from('never uploaded')),
      viewport: 'desktop',
      theme: 'dark',
      ...FIGMA,
      figmaFileVersion: '100',
    });
    expect(missing.status).toBe(422);

    const json = await upload(NOT_AN_IMAGE, 'application/json');
    const notImage = await post(`${screens}/${first}/proposals`, {
      blobSha256: json,
      viewport: 'desktop',
      theme: 'dark',
      ...FIGMA,
      figmaFileVersion: '100',
    });
    expect(notImage.status).toBe(422);
  });

  it('writes nothing when the same image at the same file version arrives again', async () => {
    const before = await db.screenVersion.count();
    const events = await db.auditEvent.count({ where: { entityType: 'screen_version' } });
    const res = await post(`${screens}/${first}/proposals`, {
      blobSha256: sha(PROPOSAL_ONE),
      viewport: 'desktop',
      theme: 'dark',
      ...FIGMA,
      figmaFileVersion: '100',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Version).id).toBe(proposalOne.id);
    expect(await db.screenVersion.count()).toBe(before);
    expect(await db.auditEvent.count({ where: { entityType: 'screen_version' } })).toBe(events);
  });

  it('supersedes the previous proposal for the same viewport and theme, and keeps it readable (FRM-REQ-193)', async () => {
    const sha256 = await upload(PROPOSAL_TWO);
    const res = await post(`${screens}/${first}/proposals`, {
      blobSha256: sha256,
      viewport: 'desktop',
      theme: 'dark',
      ...FIGMA,
      figmaFileVersion: '101',
    });
    expect(res.status).toBe(201);
    const second = (await res.json()) as Version;

    const screen = await detail(first);
    expect(screen.current.proposals.map((p) => p.id)).toEqual([second.id]);
    const old = screen.proposals.find((p) => p.id === proposalOne.id);
    expect(old?.status).toBe('superseded');
    // Readable: still listed with its provenance, and its image still served.
    expect(old?.figmaFileVersion).toBe('100');
    const image = await call(`/blobs/${proposalOne.blobSha256}`, { token: readToken });
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer()).equals(PROPOSAL_ONE)).toBe(true);
  });

  it('supersedes only within one viewport and theme', async () => {
    const sha256 = await upload(PROPOSAL_MOBILE);
    const res = await post(`${screens}/${first}/proposals`, {
      blobSha256: sha256,
      viewport: 'mobile',
      theme: 'dark',
      ...FIGMA,
      figmaFileVersion: '101',
    });
    expect(res.status).toBe(201);
    const screen = await detail(first);
    // Desktop first, whatever order they arrived in.
    expect(screen.current.proposals.map((p) => p.viewport)).toEqual(['desktop', 'mobile']);
    expect(screen.current.proposals.every((p) => p.status === 'current')).toBe(true);
  });

  it('records a capture with its commit SHA, viewport and theme (FRM-REQ-194)', async () => {
    const sha256 = await upload(CAPTURE);
    const res = await post(`${screens}/${first}/captures`, {
      blobSha256: sha256,
      viewport: 'desktop',
      theme: 'dark',
      commitSha: COMMIT,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    capture = (await res.json()) as Version;
    expect(capture).toMatchObject({
      kind: 'capture',
      blobSha256: sha256,
      viewport: 'desktop',
      theme: 'dark',
      status: null,
      commitSha: COMMIT.toLowerCase(),
    });

    expect(
      (await post(`${screens}/${first}/captures`, {
        blobSha256: sha256,
        viewport: 'desktop',
        theme: 'dark',
        commitSha: 'abc1234',
      })).status,
    ).toBe(400);
  });

  it('records each verdict on a capture, with the reviewer and a note (FRM-REQ-195)', async () => {
    const path = `${screens}/${first}/captures/${capture.id}/verdict`;
    for (const [verdict, note] of [
      ['matches', undefined],
      ['drifted_accepted', 'Spacing is tighter than the frame; accepted.'],
      ['drifted_fix', 'The header lost its border; fix it.'],
    ] as const) {
      const res = await post(path, { verdict, ...(note === undefined ? {} : { note }) });
      expect(res.status, await res.clone().text()).toBe(201);
      expect(await res.json()).toMatchObject({
        versionId: capture.id,
        verdict,
        reviewer: 'screens write',
        note: note ?? null,
      });
    }

    const screen = await detail(first);
    const judged = screen.captures.find((c) => c.id === capture.id);
    expect(judged?.verdicts.map((v) => v.verdict)).toEqual(['drifted_fix', 'drifted_accepted', 'matches']);
  });

  it('refuses a drift with no note, and a verdict on a proposal', async () => {
    expect(
      (await post(`${screens}/${first}/captures/${capture.id}/verdict`, { verdict: 'drifted_fix' }))
        .status,
    ).toBe(400);
    expect(
      (await post(`${screens}/${first}/captures/${proposalOne.id}/verdict`, { verdict: 'matches' }))
        .status,
    ).toBe(422);
  });

  it('foreman_get returns the current proposal and the latest capture as images (FRM-REQ-198)', async () => {
    const client = await connect(readToken);
    const result = await client.callTool({ name: 'foreman_get', arguments: { id: first } });
    expect(result.isError).toBeFalsy();

    const content = result.content as { type: string; text?: string; data?: string; mimeType?: string }[];
    const entity = JSON.parse(content[0]?.text ?? '{}') as { type: string; entity: Detail };
    expect(entity.type).toBe('screen');
    expect(entity.entity.humanId).toBe(first);

    const images = content.filter((part) => part.type === 'image');
    expect(images).toHaveLength(2);
    // The current desktop/dark proposal — the second one, not the superseded first — then the capture.
    expect(Buffer.from(images[0]?.data ?? '', 'base64').equals(PROPOSAL_TWO)).toBe(true);
    expect(Buffer.from(images[1]?.data ?? '', 'base64').equals(CAPTURE)).toBe(true);
    expect(images.every((image) => image.mimeType === 'image/png')).toBe(true);

    // Anything else comes back as text alone.
    const requirement = await client.callTool({ name: 'foreman_get', arguments: { id: ownRequirement } });
    expect((requirement.content as { type: string }[]).every((part) => part.type === 'text')).toBe(true);
  });

  it('records components in use and a gap that cites a DS requirement, which shows in its backlinks (FRM-REQ-199)', async () => {
    const uses = await post(`${screens}/${first}/components`, { name: 'DataGrid', kind: 'uses' });
    expect(uses.status, await uses.clone().text()).toBe(201);
    expect((await post(`${screens}/${first}/components`, { name: 'DataGrid', kind: 'uses' })).status).toBe(
      200,
    );

    const gap = await post(`${screens}/${first}/components`, {
      name: 'Timeline',
      kind: 'gap',
      requirement: dsRequirement,
    });
    expect(gap.status, await gap.clone().text()).toBe(201);
    expect(await gap.json()).toMatchObject({
      name: 'Timeline',
      kind: 'gap',
      requirement: { humanId: dsRequirement },
    });

    const screen = await detail(first);
    expect(screen.components.map((c) => `${c.kind}:${c.name}`)).toEqual(['uses:DataGrid', 'gap:Timeline']);

    const cited = await call(`/entities/${dsRequirement}`, { token: readToken });
    const { backlinks } = (await cited.json()) as {
      backlinks: { fromType: string; humanId: string | null; title: string }[];
    };
    expect(backlinks).toContainEqual(
      expect.objectContaining({ fromType: 'screen', humanId: first, title: 'Project overview' }),
    );
  });

  it('refuses a gap citing a requirement outside DS, or citing nothing', async () => {
    const outside = await post(`${screens}/${first}/components`, {
      name: 'Gantt',
      kind: 'gap',
      requirement: ownRequirement,
    });
    expect(outside.status).toBe(422);
    expect((await post(`${screens}/${first}/components`, { name: 'Gantt', kind: 'gap' })).status).toBe(400);
  });

  it('links to the requirements it serves through the links machinery (FRM-REQ-189)', async () => {
    const res = await post('/links', { from: first, to: ownRequirement, kind: 'relates' });
    expect(res.status, await res.clone().text()).toBe(200);
    const screen = await detail(first);
    expect(screen.links).toContainEqual(expect.objectContaining({ humanId: ownRequirement, kind: 'relates' }));
  });

  it('is made by foreman_create, kind screen', async () => {
    const client = await connect(writeToken);
    const result = await client.callTool({
      name: 'foreman_create',
      arguments: { project: CODE, kind: 'screen', text: 'Settings', route: '/settings' },
    });
    expect(result.isError).toBeFalsy();
    const created = JSON.parse((result.content as { text: string }[])[0]?.text ?? '{}') as Detail;
    expect(created.humanId).toBe(`${CODE}-SCR-002`);
    expect(created.route).toBe('/settings');
  });

  it('audits every mutation, soft-deletes, and undoes the delete', async () => {
    for (const entityType of ['screen', 'screen_version', 'screen_verdict', 'screen_component'] as const) {
      expect(await db.auditEvent.count({ where: { entityType } }), entityType).toBeGreaterThan(0);
    }

    const second = `${CODE}-SCR-002`;
    expect((await call(`${screens}/${second}`, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`${screens}/${second}`, { token: readToken })).status).toBe(404);
    // Soft: the row is still there.
    expect(await db.screen.count({ where: { humanId: second } })).toBe(1);

    const deletion = await db.auditEvent.findFirstOrThrow({
      where: { entityType: 'screen', entityHumanId: second, action: 'delete' },
      orderBy: { createdAt: 'desc' },
    });
    const undone = await post(`/undo/${deletion.id}`, {});
    expect(undone.status, await undone.clone().text()).toBe(200);
    expect((await call(`${screens}/${second}`, { token: readToken })).status).toBe(200);
  });
});
