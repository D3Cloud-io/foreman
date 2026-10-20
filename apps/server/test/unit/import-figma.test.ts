import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FIGMA_IDS_PER_REQUEST,
  ImportUsageError,
  fetchFigmaFrames,
  parseMapping,
  planImport,
  runImport,
  type FetchLike,
} from '../../src/cli/import-figma.js';

/**
 * The Figma import (FRM-REQ-192, FRM-REQ-204), against a mocked fetch standing in for both Figma
 * and Foreman's API (FRM-ADR-023: the server never calls Figma; this CLI is a client of both).
 */

// A 1x1 transparent PNG.
const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
// The same signature with different content, so its SHA-256 differs.
const PNG_B = Buffer.concat([PNG_A, Buffer.from('b')]);
const bodyText = (init?: RequestInit): string =>
  typeof init?.body === 'string' ? init.body : '';
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const FOREMAN = 'https://foreman.test';
const FILE = 'abc123';
const ENV = { FOREMAN_URL: FOREMAN, FOREMAN_WRITE_TOKEN: 'frm_write' };
const ENV_FIGMA = { ...ENV, FIGMA_TOKEN: 'figd_secret' };

interface Proposal {
  viewport: string;
  theme: string;
  blobSha256: string;
  figmaFileKey: string | null;
  figmaNodeId: string | null;
  figmaFileVersion: string | null;
}
interface Screen {
  humanId: string;
  name: string;
  current: { proposals: Proposal[] };
}

/** An in-memory Foreman and Figma behind one fetch, recording every call. */
function world(opts: {
  screens?: Screen[];
  version?: string;
  /** node ID (colon form) -> image bytes, or null for a null URL, or an error string. */
  figmaImages?: Record<string, Buffer | null>;
  figmaErr?: string | null;
}) {
  const screens = opts.screens ?? [];
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  const blobs = new Set<string>();
  const proposals: Record<string, unknown>[] = [];
  const created: Record<string, unknown>[] = [];
  let figmaImageRequests = 0;

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const impl: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ method, url, headers });
    const u = new URL(url);

    if (u.host === 'api.figma.com') {
      if (headers['x-figma-token'] !== 'figd_secret') return json(403, { err: 'Invalid token' });
      if (u.pathname === `/v1/files/${FILE}`) {
        return json(200, { version: opts.version ?? '9001', name: 'Board' });
      }
      if (u.pathname === `/v1/images/${FILE}`) {
        figmaImageRequests += 1;
        if (opts.figmaErr) return json(200, { err: opts.figmaErr, images: {} });
        const images: Record<string, string | null> = {};
        for (const id of (u.searchParams.get('ids') ?? '').split(',')) {
          const bytes = opts.figmaImages?.[id];
          if (bytes !== undefined) images[id] = bytes === null ? null : `https://s3.test/${id}.png`;
        }
        return json(200, { err: null, images });
      }
    }
    if (u.host === 's3.test') {
      const id = u.pathname.replace(/^\//, '').replace(/\.png$/, '');
      const bytes = opts.figmaImages?.[id];
      return bytes ? new Response(new Uint8Array(bytes)) : new Response('gone', { status: 404 });
    }

    if (u.host === 'foreman.test') {
      if (headers.authorization !== 'Bearer frm_write') return json(401, { error: 'no' });
      if (u.pathname === '/api/blobs' && method === 'POST') {
        const file = (init?.body as FormData).get('file') as File;
        const bytes = Buffer.from(await file.arrayBuffer());
        const sha256 = sha(bytes);
        blobs.add(sha256);
        return json(201, { sha256, mediaType: 'image/png', byteSize: bytes.length, url: '' });
      }
      const m = /^\/api\/projects\/([A-Z0-9]+)\/screens(?:\/([A-Z0-9-]+)\/proposals)?$/.exec(u.pathname);
      if (m) {
        if (m[2] === undefined && method === 'GET') return json(200, { items: screens });
        if (m[2] === undefined && method === 'POST') {
          const body = JSON.parse(bodyText(init)) as { name: string };
          created.push(body);
          const screen: Screen = {
            humanId: `${m[1]}-SCR-${String(screens.length + 1).padStart(3, '0')}`,
            name: body.name,
            current: { proposals: [] },
          };
          screens.push(screen);
          return json(201, screen);
        }
        if (m[2] !== undefined && method === 'POST') {
          const body = JSON.parse(bodyText(init)) as Proposal;
          proposals.push({ screen: m[2], ...body });
          return json(201, { id: 'x' });
        }
      }
    }
    return json(404, { error: `unmocked ${method} ${url}` });
  };

  return {
    fetch: impl,
    calls,
    blobs,
    proposals,
    created,
    screens,
    get figmaImageRequests() {
      return figmaImageRequests;
    },
    uploads: () => calls.filter((c) => c.url.endsWith('/api/blobs')),
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'import-figma-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeMapping(mapping: unknown): Promise<string> {
  const path = join(dir, 'map.json');
  await writeFile(path, JSON.stringify(mapping));
  return path;
}

const deps = (w: { fetch: FetchLike }, env: Record<string, string>) => ({
  fetch: w.fetch,
  readFile: (p: string) => readFile(p),
  env,
});

const emptyScreen = (humanId: string, name = 'Dashboard'): Screen => ({
  humanId,
  name,
  current: { proposals: [] },
});

describe('import-figma', () => {
  describe('with FIGMA_TOKEN', () => {
    it('reads the version, fetches the images, and proposes each frame with key, node and version (FRM-REQ-192, FRM-REQ-204)', async () => {
      const w = world({
        screens: [emptyScreen('FRM-SCR-001'), emptyScreen('FRM-SCR-002', 'Settings')],
        version: '777',
        figmaImages: { '12:34': PNG_A, '56:78': PNG_B },
      });
      const mapping = await writeMapping({
        project: 'FRM',
        figmaFileKey: FILE,
        frames: [
          { nodeId: '12:34', screen: 'FRM-SCR-001', viewport: 'desktop', theme: 'dark' },
          { nodeId: '56:78', screen: 'FRM-SCR-002', viewport: 'mobile', theme: 'light' },
        ],
      });

      const report = await runImport(
        { mappingPath: mapping, dryRun: false, preferLocal: false },
        deps(w, ENV_FIGMA),
      );

      expect(report).toMatchObject({ version: '777', created: 2, unchanged: 0, failed: 0 });
      expect(w.proposals).toEqual([
        {
          screen: 'FRM-SCR-001',
          blobSha256: sha(PNG_A),
          viewport: 'desktop',
          theme: 'dark',
          figmaFileKey: FILE,
          figmaNodeId: '12:34',
          figmaFileVersion: '777',
        },
        {
          screen: 'FRM-SCR-002',
          blobSha256: sha(PNG_B),
          viewport: 'mobile',
          theme: 'light',
          figmaFileKey: FILE,
          figmaNodeId: '56:78',
          figmaFileVersion: '777',
        },
      ]);
      expect([...w.blobs].sort()).toEqual([sha(PNG_A), sha(PNG_B)].sort());
      // The Figma token goes to Figma only, and Foreman's token to Foreman only.
      for (const c of w.calls) {
        const toFigma = new URL(c.url).host === 'api.figma.com';
        expect('x-figma-token' in c.headers).toBe(toFigma);
        expect(c.headers.authorization === 'Bearer frm_write').toBe(
          new URL(c.url).host === 'foreman.test',
        );
      }
    });

    it('fetches images in chunks of fifty', async () => {
      const ids = Array.from({ length: 120 }, (_, i) => `1:${String(i)}`);
      const w = world({ figmaImages: Object.fromEntries(ids.map((id) => [id, PNG_A])) });
      const out = await fetchFigmaFrames(w.fetch, {
        token: 'figd_secret',
        fileKey: FILE,
        nodeIds: ids,
      });
      expect(FIGMA_IDS_PER_REQUEST).toBe(50);
      expect(w.figmaImageRequests).toBe(3);
      expect(out.version).toBe('9001');
      expect(out.images.size).toBe(120);
      expect([...out.images.values()].every((i) => i.ok)).toBe(true);
    });

    it('asks Figma for the colon form of a node ID copied from a URL', async () => {
      const w = world({ figmaImages: { '12:34': PNG_A } });
      const out = await fetchFigmaFrames(w.fetch, {
        token: 'figd_secret',
        fileKey: FILE,
        nodeIds: ['12-34'],
      });
      expect(out.images.get('12-34')).toMatchObject({ ok: true });
    });

    it('fails only the frame Figma returns an error or a null URL for', async () => {
      const w = world({
        screens: [emptyScreen('FRM-SCR-001'), emptyScreen('FRM-SCR-002', 'Settings')],
        figmaImages: { '1:1': PNG_A, '2:2': null, '3:3': Buffer.alloc(0) },
      });
      const mapping = await writeMapping({
        project: 'FRM',
        figmaFileKey: FILE,
        frames: [
          { nodeId: '1:1', screen: 'FRM-SCR-001', viewport: 'desktop', theme: 'dark' },
          { nodeId: '2:2', screen: 'FRM-SCR-002', viewport: 'desktop', theme: 'dark' },
          { nodeId: '4:4', screen: 'FRM-SCR-002', viewport: 'mobile', theme: 'dark' },
        ],
      });
      const report = await runImport(
        { mappingPath: mapping, dryRun: false, preferLocal: false },
        deps(w, ENV_FIGMA),
      );
      expect(report).toMatchObject({ created: 1, failed: 2 });
      expect(report.results.map((r) => r.status)).toEqual(['created', 'failed', 'failed']);
      expect(report.results[1]?.detail).toMatch(/no image/);
      expect(w.proposals).toHaveLength(1);
    });

    it('fails every frame of a chunk when Figma answers with an err', async () => {
      const w = world({
        screens: [emptyScreen('FRM-SCR-001')],
        figmaErr: 'Not found',
      });
      const mapping = await writeMapping({
        project: 'FRM',
        figmaFileKey: FILE,
        frames: [{ nodeId: '1:1', screen: 'FRM-SCR-001', viewport: 'desktop', theme: 'dark' }],
      });
      const report = await runImport(
        { mappingPath: mapping, dryRun: false, preferLocal: false },
        deps(w, ENV_FIGMA),
      );
      expect(report.failed).toBe(1);
      expect(report.results[0]?.detail).toMatch(/Not found/);
    });

    it('stops with a usage error, touching nothing, when Figma refuses the token', async () => {
      const w = world({ screens: [emptyScreen('FRM-SCR-001')] });
      const mapping = await writeMapping({
        project: 'FRM',
        figmaFileKey: FILE,
        frames: [{ nodeId: '1:1', screen: 'FRM-SCR-001', viewport: 'desktop', theme: 'dark' }],
      });
      await expect(
        runImport(
          { mappingPath: mapping, dryRun: false, preferLocal: false },
          deps(w, { ...ENV, FIGMA_TOKEN: 'wrong' }),
        ),
      ).rejects.toThrow(/Invalid token/);
      expect(w.uploads()).toHaveLength(0);
    });

    it('prefers the token to a frame png, unless --prefer-local', async () => {
      const w = world({
        screens: [emptyScreen('FRM-SCR-001')],
        figmaImages: { '1:1': PNG_A },
      });
      await writeFile(join(dir, 'local.png'), PNG_B);
      const mapping = await writeMapping({
        project: 'FRM',
        figmaFileKey: FILE,
        fileVersion: '5',
        frames: [
          { nodeId: '1:1', screen: 'FRM-SCR-001', viewport: 'desktop', theme: 'dark', png: 'local.png' },
        ],
      });
      await runImport({ mappingPath: mapping, dryRun: false, preferLocal: false }, deps(w, ENV_FIGMA));
      expect(w.proposals.at(-1)).toMatchObject({ blobSha256: sha(PNG_A), figmaFileVersion: '9001' });

      const w2 = world({ screens: [emptyScreen('FRM-SCR-001')], figmaImages: { '1:1': PNG_A } });
      await runImport({ mappingPath: mapping, dryRun: false, preferLocal: true }, deps(w2, ENV_FIGMA));
      expect(w2.proposals.at(-1)).toMatchObject({ blobSha256: sha(PNG_B), figmaFileVersion: '5' });
      // Nothing was asked of Figma at all: the stated version and the local file were enough.
      expect(w2.calls.some((c) => new URL(c.url).host === 'api.figma.com')).toBe(false);
    });
  });

  describe('rerun (FRM-REQ-204)', () => {
    it('does no upload and no proposal when the version, node and image are unchanged', async () => {
      const w = world({
        screens: [emptyScreen('FRM-SCR-001')],
        version: '777',
        figmaImages: { '12:34': PNG_A },
      });
      const mapping = await writeMapping({
        project: 'FRM',
        figmaFileKey: FILE,
        frames: [{ nodeId: '12:34', screen: 'FRM-SCR-001', viewport: 'desktop', theme: 'dark' }],
      });
      const run = () =>
        runImport({ mappingPath: mapping, dryRun: false, preferLocal: false }, deps(w, ENV_FIGMA));

      // The mocked Foreman does not remember proposals; the CLI's own view of the screen does not
      // carry across runs either, so reflect what the first run wrote back into the screen list.
      expect((await run()).created).toBe(1);
      w.screens[0] = {
        ...emptyScreen('FRM-SCR-001'),
        current: {
          proposals: [
            {
              viewport: 'desktop',
              theme: 'dark',
              blobSha256: sha(PNG_A),
              figmaFileKey: FILE,
              figmaNodeId: '12:34',
              figmaFileVersion: '777',
            },
          ],
        },
      };
      const uploadsBefore = w.uploads().length;
      const proposalsBefore = w.proposals.length;

      const second = await run();
      expect(second).toMatchObject({ created: 0, unchanged: 1, failed: 0 });
      expect(w.uploads()).toHaveLength(uploadsBefore);
      expect(w.proposals).toHaveLength(proposalsBefore);
    });

    it('proposes again when the file version moves on', async () => {
      const current: Proposal = {
        viewport: 'desktop',
        theme: 'dark',
        blobSha256: sha(PNG_A),
        figmaFileKey: FILE,
        figmaNodeId: '12:34',
        figmaFileVersion: '776',
      };
      const w = world({
        screens: [{ ...emptyScreen('FRM-SCR-001'), current: { proposals: [current] } }],
        version: '777',
        figmaImages: { '12:34': PNG_A },
      });
      const mapping = await writeMapping({
        project: 'FRM',
        figmaFileKey: FILE,
        frames: [{ nodeId: '12:34', screen: 'FRM-SCR-001', viewport: 'desktop', theme: 'dark' }],
      });
      const report = await runImport(
        { mappingPath: mapping, dryRun: false, preferLocal: false },
        deps(w, ENV_FIGMA),
      );
      expect(report.created).toBe(1);
      expect(w.proposals).toHaveLength(1);
    });

    it('proposes again for the same image and version from a different node', async () => {
      const current: Proposal = {
        viewport: 'desktop',
        theme: 'dark',
        blobSha256: sha(PNG_A),
        figmaFileKey: FILE,
        figmaNodeId: '99:99',
        figmaFileVersion: '777',
      };
      const w = world({
        screens: [{ ...emptyScreen('FRM-SCR-001'), current: { proposals: [current] } }],
        version: '777',
        figmaImages: { '12:34': PNG_A },
      });
      const mapping = await writeMapping({
        project: 'FRM',
        figmaFileKey: FILE,
        frames: [{ nodeId: '12:34', screen: 'FRM-SCR-001', viewport: 'desktop', theme: 'dark' }],
      });
      const report = await runImport(
        { mappingPath: mapping, dryRun: false, preferLocal: false },
        deps(w, ENV_FIGMA),
      );
      expect(report.created).toBe(1);
    });
  });

  describe('without FIGMA_TOKEN', () => {
    it('takes local PNG paths relative to the mapping and the stated version', async () => {
      const w = world({ screens: [emptyScreen('FRM-SCR-001')] });
      await writeFile(join(dir, 'dash.png'), PNG_A);
      const mapping = await writeMapping({
        project: 'FRM',
        figmaFileKey: FILE,
        fileVersion: '4242',
        frames: [
          { nodeId: '12:34', screen: 'FRM-SCR-001', viewport: 'desktop', theme: 'dark', png: 'dash.png' },
        ],
      });
      const report = await runImport(
        { mappingPath: mapping, dryRun: false, preferLocal: false },
        deps(w, ENV),
      );
      expect(report).toMatchObject({ version: '4242', created: 1, failed: 0 });
      expect(w.proposals).toEqual([
        {
          screen: 'FRM-SCR-001',
          blobSha256: sha(PNG_A),
          viewport: 'desktop',
          theme: 'dark',
          figmaFileKey: FILE,
          figmaNodeId: '12:34',
          figmaFileVersion: '4242',
        },
      ]);
      expect(w.calls.some((c) => new URL(c.url).host === 'api.figma.com')).toBe(false);
    });

    it('says so plainly when a frame has no png', async () => {
      const w = world({ screens: [emptyScreen('FRM-SCR-001')] });
      const mapping = await writeMapping({
        project: 'FRM',
        figmaFileKey: FILE,
        fileVersion: '1',
        frames: [{ nodeId: '12:34', screen: 'FRM-SCR-001', viewport: 'desktop', theme: 'dark' }],
      });
      const run = runImport({ mappingPath: mapping, dryRun: false, preferLocal: false }, deps(w, ENV));
      await expect(run).rejects.toThrow(ImportUsageError);
      await expect(run).rejects.toThrow(/no "png" path and FIGMA_TOKEN is not set/);
      expect(w.calls).toHaveLength(0);
    });

    it('says so plainly when the mapping states no fileVersion', async () => {
      const w = world({ screens: [emptyScreen('FRM-SCR-001')] });
      await writeFile(join(dir, 'a.png'), PNG_A);
      const mapping = await writeMapping({
        project: 'FRM',
        figmaFileKey: FILE,
        frames: [
          { nodeId: '1:1', screen: 'FRM-SCR-001', viewport: 'desktop', theme: 'dark', png: 'a.png' },
        ],
      });
      await expect(
        runImport({ mappingPath: mapping, dryRun: false, preferLocal: false }, deps(w, ENV)),
      ).rejects.toThrow(/must state "fileVersion"/);
    });

    it('refuses a file that is not a PNG, and uploads nothing for it', async () => {
      const w = world({ screens: [emptyScreen('FRM-SCR-001')] });
      await writeFile(join(dir, 'fake.png'), Buffer.from('<html>not an image</html>'));
      const mapping = await writeMapping({
        project: 'FRM',
        figmaFileKey: FILE,
        fileVersion: '1',
        frames: [
          { nodeId: '1:1', screen: 'FRM-SCR-001', viewport: 'desktop', theme: 'dark', png: 'fake.png' },
        ],
      });
      const report = await runImport(
        { mappingPath: mapping, dryRun: false, preferLocal: false },
        deps(w, ENV),
      );
      expect(report.failed).toBe(1);
      expect(report.results[0]?.detail).toMatch(/not a PNG/);
      expect(w.uploads()).toHaveLength(0);
    });

    it('fails a frame whose file is missing without stopping the others', async () => {
      const w = world({ screens: [emptyScreen('FRM-SCR-001'), emptyScreen('FRM-SCR-002', 'B')] });
      await writeFile(join(dir, 'b.png'), PNG_B);
      const mapping = await writeMapping({
        project: 'FRM',
        figmaFileKey: FILE,
        fileVersion: '1',
        frames: [
          { nodeId: '1:1', screen: 'FRM-SCR-001', viewport: 'desktop', theme: 'dark', png: 'missing.png' },
          { nodeId: '2:2', screen: 'FRM-SCR-002', viewport: 'desktop', theme: 'dark', png: 'b.png' },
        ],
      });
      const report = await runImport(
        { mappingPath: mapping, dryRun: false, preferLocal: false },
        deps(w, ENV),
      );
      expect(report.results.map((r) => r.status)).toEqual(['failed', 'created']);
    });
  });

  describe('--dry-run', () => {
    it('resolves and reports, and writes nothing', async () => {
      const w = world({ screens: [emptyScreen('FRM-SCR-001')], figmaImages: { '1:1': PNG_A, '2:2': PNG_B } });
      const mapping = await writeMapping({
        project: 'FRM',
        figmaFileKey: FILE,
        frames: [
          { nodeId: '1:1', screen: 'FRM-SCR-001', viewport: 'desktop', theme: 'dark' },
          { nodeId: '2:2', screen: { name: 'Brand new' }, viewport: 'desktop', theme: 'dark' },
        ],
      });
      const report = await runImport(
        { mappingPath: mapping, dryRun: true, preferLocal: false },
        deps(w, ENV_FIGMA),
      );
      expect(report).toMatchObject({ dryRun: true, created: 2, failed: 0 });
      expect(report.results[1]?.detail).toMatch(/create the screen/);
      expect(w.uploads()).toHaveLength(0);
      expect(w.proposals).toHaveLength(0);
      expect(w.created).toHaveLength(0);
      expect(w.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });
  });

  describe('screens', () => {
    it('creates a screen the mapping names but Foreman lacks, then proposes on it', async () => {
      const w = world({ figmaImages: { '12:34': PNG_A, '12:35': PNG_B } });
      const mapping = await writeMapping({
        project: 'FRM',
        figmaFileKey: FILE,
        frames: [
          {
            nodeId: '12:34',
            screen: { name: 'Dashboard', route: '/' },
            viewport: 'desktop',
            theme: 'dark',
          },
          // Same name: the screen made for the first frame is reused, not made again.
          { nodeId: '12:35', screen: { name: 'Dashboard' }, viewport: 'mobile', theme: 'dark' },
        ],
      });
      const report = await runImport(
        { mappingPath: mapping, dryRun: false, preferLocal: false },
        deps(w, ENV_FIGMA),
      );
      expect(report).toMatchObject({ created: 2, failed: 0 });
      expect(w.created).toEqual([
        { name: 'Dashboard', route: '/', figmaFileKey: FILE, figmaNodeId: '12:34' },
      ]);
      expect(w.proposals.map((p) => p.screen)).toEqual(['FRM-SCR-001', 'FRM-SCR-001']);
    });

    it('fails a frame naming a screen ID that does not exist', async () => {
      const w = world({ figmaImages: { '1:1': PNG_A } });
      const mapping = await writeMapping({
        project: 'FRM',
        figmaFileKey: FILE,
        frames: [{ nodeId: '1:1', screen: 'FRM-SCR-099', viewport: 'desktop', theme: 'dark' }],
      });
      const report = await runImport(
        { mappingPath: mapping, dryRun: false, preferLocal: false },
        deps(w, ENV_FIGMA),
      );
      expect(report.failed).toBe(1);
      expect(report.results[0]?.detail).toMatch(/FRM-SCR-099 does not exist/);
    });
  });

  describe('the mapping', () => {
    it('refuses malformed JSON, a bad file key and a bad node ID', () => {
      expect(() => parseMapping('{nope')).toThrow(/not valid JSON/);
      expect(() =>
        parseMapping(JSON.stringify({ project: 'FRM', figmaFileKey: 'a b', frames: [] })),
      ).toThrow(/figmaFileKey/);
      expect(() =>
        parseMapping(
          JSON.stringify({
            project: 'FRM',
            figmaFileKey: FILE,
            frames: [{ nodeId: 'a/b', screen: 'FRM-SCR-001', viewport: 'desktop', theme: 'dark' }],
          }),
        ),
      ).toThrow(/nodeId/);
    });

    it('refuses two frames for one screen, viewport and theme', () => {
      const mapping = parseMapping(
        JSON.stringify({
          project: 'FRM',
          figmaFileKey: FILE,
          fileVersion: '1',
          frames: [
            { nodeId: '1:1', screen: 'FRM-SCR-001', viewport: 'desktop', theme: 'dark', png: 'a.png' },
            { nodeId: '1:2', screen: 'FRM-SCR-001', viewport: 'desktop', theme: 'dark', png: 'b.png' },
          ],
        }),
      );
      expect(() => planImport(mapping, { hasFigmaToken: false, preferLocal: false, baseDir: dir })).toThrow(
        /same variant/,
      );
    });
  });

  it('needs FOREMAN_URL and FOREMAN_WRITE_TOKEN', async () => {
    const w = world({});
    const mapping = await writeMapping({
      project: 'FRM',
      figmaFileKey: FILE,
      frames: [{ nodeId: '1:1', screen: 'FRM-SCR-001', viewport: 'desktop', theme: 'dark' }],
    });
    await expect(
      runImport({ mappingPath: mapping, dryRun: false, preferLocal: false }, deps(w, {})),
    ).rejects.toThrow(/FOREMAN_URL and FOREMAN_WRITE_TOKEN/);
  });
});
