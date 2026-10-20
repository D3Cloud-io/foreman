import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * The blob store over HTTP (FRM-REQ-190, FRM-REQ-191).
 *
 * What these assert is the store's whole promise: the same bytes are kept once — one file named by
 * their SHA-256 under FOREMAN_BLOB_DIR, one row — and only the four allowed types, under the size
 * cap, from a write-scoped credential, get in at all. Reading one back still needs a session or a
 * token.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'blobs@example.com';
const PASSWORD = 'a-password-for-the-blob-tests';
/** Small, so "over the cap" is a few kilobytes rather than ten megabytes in a test. */
const CAP = 4096;

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A real signature followed by filler: the store decides by the leading bytes, as it should. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('blob-test png body'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('blob-test jpeg body')]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x20, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
  Buffer.from('VP8 blob-test webp body'),
]);
const GIF = Buffer.from('GIF89a blob-test gif body');
const JSON_BYTES = Buffer.from(JSON.stringify({ kind: 'blob-test', ok: true }));
const BAD_JSON = Buffer.from('{ "kind": "blob-test", ');

interface StoredBlob {
  id: string;
  sha256: string;
  mediaType: string;
  byteSize: number;
  url: string;
}

describe.skipIf(url === undefined)('blobs', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;
  let blobDir: string;
  let readToken: string;
  let writeToken: string;

  /** One file in the `file` part, with whatever type the client claims for it. */
  const form = (bytes: Uint8Array, type: string, name = 'upload.bin', field = 'file') => {
    const body = new FormData();
    body.append(field, new File([bytes], name, { type }));
    return body;
  };
  const upload = (body: FormData, token: string | null = writeToken) =>
    fetch(`${origin}/api/blobs`, {
      method: 'POST',
      body,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
  const filesOnDisk = async () => (await readdir(blobDir)).sort();

  beforeAll(async () => {
    blobDir = await mkdtemp(join(tmpdir(), 'foreman-blobs-'));
    const config: Config = loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'http://localhost:3200',
      DATABASE_URL: url ?? '',
      KEK: Buffer.alloc(32, 1).toString('base64'),
      PEPPER: Buffer.alloc(32, 2).toString('base64'),
      COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
      FOREMAN_BLOB_DIR: blobDir,
      FOREMAN_BLOB_MAX_BYTES: String(CAP),
    });
    db = createDb(url ?? '');

    await db.user.deleteMany({ where: { email: EMAIL } });
    const user = await db.user.create({
      data: { email: EMAIL, displayName: 'Blobs', status: 'active' },
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

    // Real tokens, issued through the real route.
    const mint = async (name: string, scopes: string[]) => {
      const res = await fetch(`${origin}/api/tokens`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name, scopes }),
      });
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { token: string }).token;
    };
    readToken = await mint('blobs read', ['read']);
    writeToken = await mint('blobs write', ['read', 'write']);
  });

  /** Rows and files from earlier runs would turn a first upload into a second one. */
  const clean = async () => {
    const shas = [PNG, JPEG, WEBP, GIF, JSON_BYTES, BAD_JSON].map(sha);
    await db.blob.deleteMany({ where: { sha256: { in: shas } } });
    await db.auditEvent.deleteMany({ where: { entityType: 'blob', actor: { in: ['blobs write', 'blobs read', EMAIL] } } });
    await rm(blobDir, { recursive: true, force: true });
    await mkdir(blobDir, { recursive: true });
  };

  beforeAll(clean);
  afterEach(clean);

  afterAll(async () => {
    await clean();
    await rm(blobDir, { recursive: true, force: true });
    await db.apiToken.deleteMany({ where: { name: { startsWith: 'blobs ' } } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  it('stores the same PNG once: one file named by its SHA-256 under the blob dir, one row', async () => {
    const digest = sha(PNG);

    const first = await upload(form(PNG, 'image/png', 'shot.png'));
    expect(first.status, await first.clone().text()).toBe(201);
    const created = (await first.json()) as StoredBlob;
    expect(created).toMatchObject({
      sha256: digest,
      mediaType: 'image/png',
      byteSize: PNG.length,
      url: `/api/blobs/${digest}`,
    });

    const second = await upload(form(PNG, 'image/png', 'same-shot-again.png'));
    expect(second.status, await second.clone().text()).toBe(200);
    expect((await second.json()) as StoredBlob).toEqual(created);

    expect(await db.blob.count({ where: { sha256: digest } })).toBe(1);
    // Exactly one file, named by the hash, holding the bytes: no temporary left behind, no copy.
    expect(await filesOnDisk()).toEqual([digest]);
    expect(Buffer.compare(await readFile(join(blobDir, digest)), PNG)).toBe(0);

    // Recorded once, by the token that created it; the dedupe wrote nothing.
    const events = await db.auditEvent.findMany({ where: { entityType: 'blob', entityId: created.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'create', actor: 'blobs write', actorKind: 'mcp' });
  });

  it('refuses a GIF with 415 naming the allowed types, and keeps nothing', async () => {
    const res = await upload(form(GIF, 'image/gif', 'anim.gif'));
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: string; allowed: string[] };
    expect(body.allowed).toEqual(['image/png', 'image/jpeg', 'image/webp', 'application/json']);
    expect(await db.blob.count({ where: { sha256: sha(GIF) } })).toBe(0);
    expect(await filesOnDisk()).toEqual([]);
  });

  it('decides the type from the bytes, not from what the client claims', async () => {
    // A GIF calling itself a PNG is still a GIF.
    const lying = await upload(form(GIF, 'image/png', 'not-really.png'));
    expect(lying.status).toBe(415);

    // A PNG sent as an anonymous octet stream is still a PNG.
    const shy = await upload(form(PNG, 'application/octet-stream', 'mystery'));
    expect(shy.status, await shy.clone().text()).toBe(201);
    expect(((await shy.json()) as StoredBlob).mediaType).toBe('image/png');
  });

  it('refuses a file over the size cap with 413, and keeps nothing', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(CAP + 1, 0x41)]);
    const res = await upload(form(big, 'image/png', 'huge.png'));
    expect(res.status).toBe(413);
    expect(await db.blob.count({ where: { sha256: sha(big) } })).toBe(0);
    expect(await filesOnDisk()).toEqual([]);
  });

  it('refuses an upload from a read-scoped token with 403', async () => {
    const res = await upload(form(PNG, 'image/png', 'shot.png'), readToken);
    expect(res.status).toBe(403);
    expect(await db.blob.count({ where: { sha256: sha(PNG) } })).toBe(0);
    expect(await filesOnDisk()).toEqual([]);
  });

  it('refuses an anonymous upload with 401', async () => {
    const res = await upload(form(PNG, 'image/png', 'shot.png'), null);
    expect(res.status).toBe(401);
    expect(await filesOnDisk()).toEqual([]);
  });

  it('refuses a field it does not store, and a file in any part but `file`', async () => {
    const extra = form(PNG, 'image/png', 'shot.png');
    extra.append('caption', 'would be lost');
    const withField = await upload(extra);
    expect(withField.status).toBe(400);
    expect(((await withField.json()) as { error: string }).error).toContain('caption');

    const wrongPart = await upload(form(PNG, 'image/png', 'shot.png', 'image'));
    expect(wrongPart.status).toBe(400);

    expect(await db.blob.count({ where: { sha256: sha(PNG) } })).toBe(0);
  });

  it('reads a blob back only with a session or a token, with its stored type and long caching', async () => {
    const created = await upload(form(PNG, 'image/png', 'shot.png'));
    expect(created.status).toBe(201);
    const { url: path } = (await created.json()) as StoredBlob;

    const anonymous = await fetch(`${origin}${path}`);
    expect(anonymous.status).toBe(401);

    const read = await fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${readToken}` } });
    expect(read.status).toBe(200);
    expect(read.headers.get('content-type')).toBe('image/png');
    expect(read.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(read.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.compare(Buffer.from(await read.arrayBuffer()), PNG)).toBe(0);

    const viaSession = await fetch(`${origin}${path}`, { headers: { cookie } });
    expect(viaSession.status).toBe(200);
  });

  it('answers 400 for a malformed address and 404 for an unknown one', async () => {
    const auth = { authorization: `Bearer ${readToken}` };
    const malformed = await fetch(`${origin}/api/blobs/not-a-hash`, { headers: auth });
    expect(malformed.status).toBe(400);
    const upper = await fetch(`${origin}/api/blobs/${sha(PNG).toUpperCase()}`, { headers: auth });
    expect(upper.status).toBe(400);
    const unknown = await fetch(`${origin}/api/blobs/${'0'.repeat(64)}`, { headers: auth });
    expect(unknown.status).toBe(404);
  });

  it('accepts JPEG, WebP and JSON, each typed from its content', async () => {
    const cases: [Buffer, string, string][] = [
      [JPEG, 'image/jpeg', 'image/jpeg'],
      [WEBP, 'image/webp', 'image/webp'],
      [JSON_BYTES, 'application/json', 'application/json'],
    ];
    for (const [bytes, declared, expected] of cases) {
      const res = await upload(form(bytes, declared));
      expect(res.status, `${declared}: ${await res.clone().text()}`).toBe(201);
      const blob = (await res.json()) as StoredBlob;
      expect(blob).toMatchObject({ sha256: sha(bytes), mediaType: expected, byteSize: bytes.length });
    }
    expect(await filesOnDisk()).toEqual([JPEG, WEBP, JSON_BYTES].map(sha).sort());
  });

  it('refuses malformed JSON, and JSON the client did not declare as JSON', async () => {
    const malformed = await upload(form(BAD_JSON, 'application/json', 'broken.json'));
    expect(malformed.status).toBe(415);

    const undeclared = await upload(form(JSON_BYTES, 'text/plain', 'data.txt'));
    expect(undeclared.status).toBe(415);

    expect(await db.blob.count({ where: { sha256: { in: [sha(BAD_JSON), sha(JSON_BYTES)] } } })).toBe(0);
    expect(await filesOnDisk()).toEqual([]);
  });
});
