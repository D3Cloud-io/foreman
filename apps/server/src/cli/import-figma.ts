import { createHash } from 'node:crypto';
import { readFile as readFromDisk } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';

/**
 * Import Figma frames as screen proposals (FRM-REQ-192, FRM-REQ-204).
 *
 *   pnpm --filter foreman-server run import-figma -- --mapping ./figma-map.json
 *   pnpm --filter foreman-server run import-figma -- --mapping ./figma-map.json --dry-run
 *
 * **Foreman's server never calls Figma (FRM-ADR-023).** This is a client of two services: Figma
 * (optionally, when `FIGMA_TOKEN` is set) and Foreman's own REST API, exactly as a person's
 * `curl` would be. Keeping the call here means the deployed server holds no Figma credential and
 * has no outbound dependency on a third party.
 *
 * **Two ways to get the pixels.**
 *  - With `FIGMA_TOKEN`: the file's version and each frame's PNG come from Figma's REST API.
 *  - Without it: each frame names a local PNG (a Claude session exports them through the Figma MCP
 *    and fills the paths in) and the mapping states the file version the export was taken at.
 *
 * **A rerun adds nothing (FRM-REQ-204).** A frame is skipped, without an upload, when the screen's
 * current proposal for that viewport and theme already carries the same file key, node ID, file
 * version and image. The server enforces the same rule as a backstop, but it can only do so after
 * the bytes have crossed the wire; the CLI knows the SHA-256 beforehand and spares the upload.
 *
 * Nothing here logs a token. The URLs it prints are Foreman's and Figma's public API paths.
 */

// Mirrors packages/shared/src/entities/screens.ts. Copied rather than imported so that this file
// stays runnable on its own, and checked by the server on every proposal in any case.
const FIGMA_FILE_KEY = /^[A-Za-z0-9]{1,128}$/;
const FIGMA_NODE_ID = /^[A-Za-z0-9:;-]{1,200}$/;
const SCREEN_ID = /^[A-Z][A-Z0-9]*-SCR-\d+$/;
const PROJECT_CODE = /^[A-Z][A-Z0-9]*$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Figma limits the length of a URL; fifty node IDs stays well inside it. */
export const FIGMA_IDS_PER_REQUEST = 50;
const FIGMA_API = 'https://api.figma.com/v1';

/** A mistake in how the command was invoked or what the mapping says, as opposed to a failed frame. */
export class ImportUsageError extends Error {
  override readonly name = 'ImportUsageError';
}

// --- the mapping ---------------------------------------------------------------------------

const MappingFrame = z.object({
  nodeId: z.string().regex(FIGMA_NODE_ID),
  screen: z.union([
    z.string().regex(SCREEN_ID, 'a screen ID such as FRM-SCR-001'),
    z.object({ name: z.string().min(1).max(200), route: z.string().min(1).max(500).optional() }),
  ]),
  viewport: z.enum(['desktop', 'mobile']),
  theme: z.enum(['light', 'dark']),
  png: z.string().min(1).optional(),
});
export type MappingFrame = z.infer<typeof MappingFrame>;

const Mapping = z.object({
  project: z.string().regex(PROJECT_CODE),
  figmaFileKey: z.string().regex(FIGMA_FILE_KEY),
  fileVersion: z.string().min(1).max(64).optional(),
  frames: z.array(MappingFrame).min(1),
});
export type Mapping = z.infer<typeof Mapping>;

export function parseMapping(text: string): Mapping {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ImportUsageError(
      `the mapping is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = Mapping.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ImportUsageError(`the mapping is not valid:\n${issues}`);
  }
  return parsed.data;
}

// --- the plan ------------------------------------------------------------------------------

export interface PlannedFrame {
  frame: MappingFrame;
  /** Where its pixels come from. */
  source: 'figma' | 'local';
  /** Absolute; set when `source` is `local`. */
  localPath: string | null;
}

export interface ImportPlan {
  mapping: Mapping;
  /** True when Figma's REST API is called, for the version, the images, or both. */
  useFigma: boolean;
  /** The file version to record, or null when it is to be read from Figma. */
  version: string | null;
  frames: PlannedFrame[];
}

export interface PlanOptions {
  hasFigmaToken: boolean;
  preferLocal: boolean;
  /** The directory `png` paths are relative to: the mapping file's. */
  baseDir: string;
}

const screenKey = (frame: MappingFrame): string =>
  typeof frame.screen === 'string' ? frame.screen : `name:${frame.screen.name}`;

/**
 * Decide, before anything is fetched or written, where every frame's image and the file version
 * come from, and refuse a mapping that cannot be satisfied. A failure here costs nothing; the same
 * failure halfway through would leave half a board imported.
 */
export function planImport(mapping: Mapping, options: PlanOptions): ImportPlan {
  const seen = new Set<string>();
  const frames: PlannedFrame[] = mapping.frames.map((frame) => {
    const variant = `${screenKey(frame)}|${frame.viewport}|${frame.theme}`;
    if (seen.has(variant)) {
      throw new ImportUsageError(
        `two frames map to the same variant (${screenKey(frame)}, ${frame.viewport}, ${frame.theme}); ` +
          'the second would supersede the first',
      );
    }
    seen.add(variant);
    const local = frame.png !== undefined;
    const useLocal = local && (!options.hasFigmaToken || options.preferLocal);
    if (!useLocal && !options.hasFigmaToken) {
      throw new ImportUsageError(
        `frame ${frame.nodeId} has no "png" path and FIGMA_TOKEN is not set: ` +
          'export it (the Figma MCP or Figma itself) and name the file, or set FIGMA_TOKEN',
      );
    }
    return useLocal && frame.png !== undefined
      ? { frame, source: 'local', localPath: resolve(options.baseDir, frame.png) }
      : { frame, source: 'figma', localPath: null };
  });

  const allLocal = frames.every((f) => f.source === 'local');
  // A stated version wins when nothing is being fetched, or when the local files were exported at
  // exactly that version. Otherwise Figma's current version is the one the images are taken at.
  const stated = mapping.fileVersion ?? null;
  const askFigma =
    options.hasFigmaToken && !(stated !== null && (allLocal || options.preferLocal));
  if (!askFigma && stated === null) {
    throw new ImportUsageError(
      'without FIGMA_TOKEN the mapping must state "fileVersion": the version of the Figma file the PNGs were exported at',
    );
  }
  return {
    mapping,
    useFigma: options.hasFigmaToken && (askFigma || frames.some((f) => f.source === 'figma')),
    version: askFigma ? null : stated,
    frames,
  };
}

// --- Figma ---------------------------------------------------------------------------------

export type FetchLike = typeof fetch;

export type FrameImage = { ok: true; bytes: Buffer } | { ok: false; error: string };

export interface FigmaFrames {
  version: string;
  /** Keyed by the node ID as the mapping wrote it. */
  images: Map<string, FrameImage>;
}

/** Figma answers in `12:34`; a URL copied from the browser says `12-34`. Both name one node. */
const figmaId = (nodeId: string): string => nodeId.replace(/-/g, ':');

async function figmaJson(fetchImpl: FetchLike, url: string, token: string): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { 'X-Figma-Token': token } });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* a non-JSON error page; the status below says enough */
  }
  if (!res.ok) {
    const detail =
      typeof body === 'object' && body !== null && 'err' in body && typeof body.err === 'string'
        ? `: ${body.err}`
        : '';
    throw new Error(`Figma answered ${res.status}${detail}`);
  }
  return body;
}

/** The file's version, which changes whenever anyone saves a new named or auto version. */
export async function fetchFigmaVersion(
  fetchImpl: FetchLike,
  token: string,
  fileKey: string,
): Promise<string> {
  const body = await figmaJson(
    fetchImpl,
    `${FIGMA_API}/files/${encodeURIComponent(fileKey)}?depth=1`,
    token,
  );
  const parsed = z.object({ version: z.string().min(1).max(64) }).safeParse(body);
  if (!parsed.success) throw new Error('Figma returned a file with no usable "version"');
  return parsed.data.version;
}

/**
 * Fetch the file version and render each node to PNG at 2x. A frame that Figma cannot render
 * (an `err`, or a null URL for a node that does not exist or is invisible) is reported on that
 * frame alone; the rest still import. Only a failure to read the version is fatal, because
 * without it no proposal can carry its provenance (FRM-REQ-192).
 */
export async function fetchFigmaFrames(
  fetchImpl: FetchLike,
  options: { token: string; fileKey: string; nodeIds: readonly string[]; version?: string },
): Promise<FigmaFrames> {
  const { token, fileKey } = options;
  const version = options.version ?? (await fetchFigmaVersion(fetchImpl, token, fileKey));
  const unique = [...new Set(options.nodeIds)];
  const images = new Map<string, FrameImage>();

  for (let i = 0; i < unique.length; i += FIGMA_IDS_PER_REQUEST) {
    const chunk = unique.slice(i, i + FIGMA_IDS_PER_REQUEST);
    const ids = chunk.map((id) => encodeURIComponent(figmaId(id))).join(',');
    const fail = (error: string): void => {
      for (const id of chunk) images.set(id, { ok: false, error });
    };

    let urls: Record<string, string | null>;
    try {
      const body = await figmaJson(
        fetchImpl,
        `${FIGMA_API}/images/${encodeURIComponent(fileKey)}?ids=${ids}&format=png&scale=2`,
        token,
      );
      const parsed = z
        .object({
          err: z.string().nullish(),
          images: z.record(z.string(), z.string().nullable()).optional(),
        })
        .safeParse(body);
      if (!parsed.success) {
        fail('Figma returned an unreadable images response');
        continue;
      }
      if (parsed.data.err) {
        fail(`Figma could not render: ${parsed.data.err}`);
        continue;
      }
      urls = parsed.data.images ?? {};
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      continue;
    }

    for (const id of chunk) {
      const url = urls[figmaId(id)] ?? urls[id];
      if (url === undefined || url === null) {
        images.set(id, { ok: false, error: 'Figma returned no image for this node (does it exist?)' });
        continue;
      }
      try {
        // The render URL is a pre-signed S3 link: it needs no token and must not be sent one.
        const res = await fetchImpl(url);
        if (!res.ok) throw new Error(`downloading the image answered ${res.status}`);
        images.set(id, { ok: true, bytes: Buffer.from(await res.arrayBuffer()) });
      } catch (error) {
        images.set(id, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { version, images };
}

// --- Foreman -------------------------------------------------------------------------------

const ForemanScreen = z.object({
  humanId: z.string(),
  name: z.string(),
  current: z.object({
    proposals: z.array(
      z.object({
        viewport: z.string(),
        theme: z.string(),
        blobSha256: z.string(),
        figmaFileKey: z.string().nullable(),
        figmaNodeId: z.string().nullable(),
        figmaFileVersion: z.string().nullable(),
      }),
    ),
  }),
});
type ForemanScreen = z.infer<typeof ForemanScreen>;

class Foreman {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request(path: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const message =
        typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
          ? body.error
          : text.slice(0, 200);
      throw new Error(`Foreman answered ${res.status} for ${init.method ?? 'GET'} ${path}: ${message}`);
    }
    return { status: res.status, body };
  }

  async screens(code: string): Promise<ForemanScreen[]> {
    const { body } = await this.request(`/api/projects/${encodeURIComponent(code)}/screens`, {});
    return z.object({ items: z.array(ForemanScreen) }).parse(body).items;
  }

  async createScreen(
    code: string,
    input: { name: string; route?: string; figmaFileKey: string; figmaNodeId: string },
  ): Promise<ForemanScreen> {
    const { body } = await this.request(`/api/projects/${encodeURIComponent(code)}/screens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return ForemanScreen.parse(body);
  }

  async upload(bytes: Buffer, filename: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), filename);
    const { body } = await this.request('/api/blobs', { method: 'POST', body: form });
    return z.object({ sha256: z.string() }).parse(body).sha256;
  }

  async propose(
    code: string,
    humanId: string,
    input: {
      blobSha256: string;
      viewport: string;
      theme: string;
      figmaFileKey: string;
      figmaNodeId: string;
      figmaFileVersion: string;
    },
  ): Promise<'created' | 'unchanged'> {
    const { status } = await this.request(
      `/api/projects/${encodeURIComponent(code)}/screens/${encodeURIComponent(humanId)}/proposals`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    return status === 201 ? 'created' : 'unchanged';
  }
}

// --- the run -------------------------------------------------------------------------------

export interface FrameResult {
  nodeId: string;
  /** The screen's human ID, or its name when it was not created (a dry run). */
  screen: string;
  viewport: string;
  theme: string;
  status: 'created' | 'unchanged' | 'failed';
  detail: string;
}

export interface ImportReport {
  version: string | null;
  dryRun: boolean;
  results: FrameResult[];
  created: number;
  unchanged: number;
  failed: number;
}

export interface RunOptions {
  mappingPath: string;
  dryRun: boolean;
  preferLocal: boolean;
}

export interface RunDeps {
  fetch: FetchLike;
  readFile: (path: string) => Promise<Buffer | Uint8Array>;
  env: Record<string, string | undefined>;
}

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const isPng = (bytes: Uint8Array): boolean =>
  bytes.length > PNG_MAGIC.length && PNG_MAGIC.equals(Buffer.from(bytes.subarray(0, PNG_MAGIC.length)));

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function runImport(options: RunOptions, deps: RunDeps): Promise<ImportReport> {
  const { env } = deps;
  const foremanUrl = env.FOREMAN_URL?.replace(/\/+$/, '');
  const foremanToken = env.FOREMAN_WRITE_TOKEN;
  if (!foremanUrl || !foremanToken) {
    throw new ImportUsageError('FOREMAN_URL and FOREMAN_WRITE_TOKEN must both be set');
  }
  const figmaToken = env.FIGMA_TOKEN ? env.FIGMA_TOKEN : null;

  const mappingPath = resolve(options.mappingPath);
  const mapping = parseMapping(Buffer.from(await deps.readFile(mappingPath)).toString('utf8'));
  const plan = planImport(mapping, {
    hasFigmaToken: figmaToken !== null,
    preferLocal: options.preferLocal,
    baseDir: dirname(mappingPath),
  });
  const code = mapping.project;
  const fileKey = mapping.figmaFileKey;
  const foreman = new Foreman(deps.fetch, foremanUrl, foremanToken);

  // The version first: a bad token or file key fails here, before any frame is touched.
  let version = plan.version;
  let figma: FigmaFrames | null = null;
  if (plan.useFigma && figmaToken !== null) {
    const figmaNodes = plan.frames.filter((f) => f.source === 'figma').map((f) => f.frame.nodeId);
    try {
      figma = await fetchFigmaFrames(deps.fetch, {
        token: figmaToken,
        fileKey,
        nodeIds: figmaNodes,
        ...(version === null ? {} : { version }),
      });
    } catch (error) {
      throw new ImportUsageError(`could not read the Figma file ${fileKey}: ${messageOf(error)}`);
    }
    version = figma.version;
  }
  if (version === null) throw new ImportUsageError('no file version could be determined');
  const fileVersion = version;

  const screens = await foreman.screens(code);
  const byId = new Map(screens.map((s) => [s.humanId, s]));
  const byName = new Map(screens.map((s) => [s.name, s]));

  const results: FrameResult[] = [];
  for (const { frame, source, localPath } of plan.frames) {
    const label = typeof frame.screen === 'string' ? frame.screen : frame.screen.name;
    const done = (status: FrameResult['status'], detail: string, screen = label): void => {
      results.push({
        nodeId: frame.nodeId,
        screen,
        viewport: frame.viewport,
        theme: frame.theme,
        status,
        detail,
      });
    };

    try {
      // 1. The pixels, and proof they are a PNG before they go anywhere near Foreman.
      let bytes: Buffer;
      if (source === 'local' && localPath !== null) {
        bytes = Buffer.from(await deps.readFile(localPath));
      } else {
        const image = figma?.images.get(frame.nodeId);
        if (image === undefined) throw new Error('no image was fetched for this frame');
        if (!image.ok) throw new Error(image.error);
        bytes = image.bytes;
      }
      if (!isPng(bytes)) {
        throw new Error(
          `${source === 'local' ? (localPath ?? 'the file') : 'the downloaded image'} is not a PNG`,
        );
      }
      const sha256 = sha256Of(bytes);

      // 2. The screen, created if the mapping names one that is not there yet.
      let screen: ForemanScreen | undefined;
      let wouldCreateScreen = false;
      if (typeof frame.screen === 'string') {
        screen = byId.get(frame.screen);
        if (screen === undefined) throw new Error(`${frame.screen} does not exist in ${code}`);
      } else {
        screen = byName.get(frame.screen.name);
        if (screen === undefined) {
          if (options.dryRun) {
            wouldCreateScreen = true;
          } else {
            screen = await foreman.createScreen(code, {
              name: frame.screen.name,
              ...(frame.screen.route === undefined ? {} : { route: frame.screen.route }),
              figmaFileKey: fileKey,
              figmaNodeId: frame.nodeId,
            });
            byId.set(screen.humanId, screen);
            byName.set(screen.name, screen);
          }
        }
      }

      // 3. Unchanged: same file, node, version and image already current for this variant.
      const current = screen?.current.proposals.find(
        (p) => p.viewport === frame.viewport && p.theme === frame.theme,
      );
      if (
        current !== undefined &&
        current.blobSha256 === sha256 &&
        current.figmaFileVersion === fileVersion &&
        current.figmaNodeId === frame.nodeId &&
        current.figmaFileKey === fileKey
      ) {
        done('unchanged', `already current at version ${fileVersion}`, screen?.humanId);
        continue;
      }

      if (options.dryRun) {
        done(
          'created',
          `dry run: would ${wouldCreateScreen ? 'create the screen, ' : ''}upload and propose at version ${fileVersion}`,
          screen?.humanId,
        );
        continue;
      }
      if (screen === undefined) throw new Error('the screen could not be resolved');

      // 4. Upload, then propose. The blob is content-addressed, so a retry is harmless.
      const uploaded = await foreman.upload(bytes, `${frame.nodeId.replace(/[^A-Za-z0-9-]/g, '_')}.png`);
      if (uploaded !== sha256) {
        throw new Error(`Foreman stored ${uploaded} but the file hashes to ${sha256}`);
      }
      const outcome = await foreman.propose(code, screen.humanId, {
        blobSha256: sha256,
        viewport: frame.viewport,
        theme: frame.theme,
        figmaFileKey: fileKey,
        figmaNodeId: frame.nodeId,
        figmaFileVersion: fileVersion,
      });
      // Keep the local view true so a later frame in this run sees what this one did.
      screen.current.proposals = [
        ...screen.current.proposals.filter(
          (p) => !(p.viewport === frame.viewport && p.theme === frame.theme),
        ),
        {
          viewport: frame.viewport,
          theme: frame.theme,
          blobSha256: sha256,
          figmaFileKey: fileKey,
          figmaNodeId: frame.nodeId,
          figmaFileVersion: fileVersion,
        },
      ];
      done(
        outcome,
        outcome === 'created' ? `proposed at version ${fileVersion}` : 'Foreman already had it',
        screen.humanId,
      );
    } catch (error) {
      done('failed', messageOf(error));
    }
  }

  const count = (status: FrameResult['status']): number =>
    results.filter((r) => r.status === status).length;
  return {
    version: fileVersion,
    dryRun: options.dryRun,
    results,
    created: count('created'),
    unchanged: count('unchanged'),
    failed: count('failed'),
  };
}

// --- the command ---------------------------------------------------------------------------

const USAGE =
  'usage: import-figma --mapping <file.json> [--dry-run] [--prefer-local]\n' +
  '  env: FOREMAN_URL, FOREMAN_WRITE_TOKEN; FIGMA_TOKEN (optional: fetch from Figma)\n' +
  '  --dry-run       resolve and report; upload and create nothing\n' +
  '  --prefer-local  use a frame\'s "png" even when FIGMA_TOKEN is set\n';

export function formatReport(report: ImportReport): string {
  const lines = report.results.map(
    (r) =>
      `${r.status.padEnd(9)} ${r.screen} ${r.viewport}/${r.theme} ${r.nodeId}  ${r.detail}`,
  );
  const verb = report.dryRun ? 'would create' : 'created';
  lines.push(
    `${report.dryRun ? '[dry run] ' : ''}file version ${report.version ?? '?'}: ` +
      `${report.created} ${verb}, ${report.unchanged} unchanged, ${report.failed} failed`,
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  // Some pnpm versions forward the `--` in `pnpm run import-figma -- --mapping …`; parseArgs would
  // then read every flag after it as a positional.
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift();
  const { values } = parseArgs({
    args: argv,
    options: {
      mapping: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'prefer-local': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.mapping === undefined) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  try {
    const report = await runImport(
      {
        mappingPath: values.mapping,
        dryRun: values['dry-run'],
        preferLocal: values['prefer-local'],
      },
      { fetch, readFile: (path) => readFromDisk(path), env: process.env },
    );
    process.stdout.write(`${formatReport(report)}\n`);
    if (report.failed > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`import-figma: ${messageOf(error)}\n`);
    process.exitCode = error instanceof ImportUsageError ? 2 : 1;
  }
}

// Only when run as a command: the tests import this module for its functions.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
