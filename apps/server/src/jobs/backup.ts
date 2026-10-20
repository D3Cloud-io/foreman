import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  link,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { createGzip } from 'node:zlib';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ALERTS, type Mailer } from '../adapters/mail.js';
import type { Config } from '../config.js';
import { isSha256 } from '../domain/blobs.js';
import type { JobDefinition } from './types.js';

/**
 * The nightly dump, and the drill that proves it (T-7.6, T-7.7, FRM-REQ-144, FRM-REQ-145).
 *
 * ADR-007: the database dump is the **only** escape hatch. After cutover there is no markdown
 * mirror behind Foreman, so this file is the entire recovery story — which is why the drill exists
 * and why its absence is a problem the health screen reports out loud.
 *
 * T-12.5 widened "the database" to "the database and its blobs" (FRM-REQ-202, FRM-REQ-203). Uploaded
 * images and source files live as files under `FOREMAN_BLOB_DIR`, never in the dump (that is the
 * point of the blob store), so a dump alone restores rows that name files nobody has. A backup set
 * is therefore a pair: `foreman-<stamp>.sql.gz` and `foreman-<stamp>.blobs/` beside it.
 *
 * Bindery's own code review found a restore drill "verified by grepping" rather than by running.
 * That finding is free to inherit: `restore-drill` below actually restores into a scratch database
 * and queries it.
 */

export interface BackupDeps {
  readonly config: Pick<Config, 'DATABASE_URL' | 'BACKUP_DIR' | 'BACKUP_RETENTION_DAYS'> &
    // Optional so a caller that has no blob store — an older test config, a tool that only dumps —
    // still backs up. Unset means zero blobs; it never means "skip the check on rows that exist".
    Partial<Pick<Config, 'FOREMAN_BLOB_DIR'>>;
  readonly mailer?: Mailer | undefined;
}

/** Run a command, collecting stderr so a failure says what went wrong rather than "exit 1". */
function run(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; stdout?: NodeJS.WritableStream } = {},
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: { ...process.env, ...options.env },
      stdio: ['ignore', options.stdout === undefined ? 'ignore' : 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (options.stdout !== undefined && child.stdout !== null) {
      pipeline(child.stdout, options.stdout).catch(reject);
    }

    child.on('error', reject);
    child.on('close', (code) => { resolve({ code: code ?? 1, stderr: stderr.slice(-4000) }); });
  });
}

/** Collect a child's stdout as text; `run` only keeps stderr, and the drill needs the rows. */
function collector(): { sink: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  return { sink, text: () => Buffer.concat(chunks).toString('utf8') };
}

/** A dump's paired blob directory: same basename, `.blobs` instead of `.sql.gz`. */
const DUMP_SUFFIX = '.sql.gz';
const BLOBS_SUFFIX = '.blobs';
/** A set being written. Never renamed into place until complete, so it can never pass for a set. */
const PARTIAL_SUFFIX = '.blobs.partial';

const isDump = (name: string) => name.startsWith('foreman-') && name.endsWith(DUMP_SUFFIX);
export const blobsDirFor = (dumpPath: string) =>
  `${dumpPath.slice(0, -DUMP_SUFFIX.length)}${BLOBS_SUFFIX}`;

async function sizeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    // A directory that does not exist holds zero blobs. That is a normal state for a fresh
    // install, not an error — but any other failure (permissions, I/O) must still be loud.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export interface CopyBlobsResult {
  /** Blob files now in the destination. */
  readonly total: number;
  /** Bytes copied from the source; hardlinked files cost nothing and are not counted. */
  readonly copiedBytes: number;
  readonly copied: number;
  readonly linked: number;
  /** Source entries ignored because their name is not a SHA-256 (the store's `.tmp-*` files). */
  readonly ignored: number;
}

/**
 * Copy every blob file from `src` into `dest` (FRM-REQ-202).
 *
 * Blobs are content-addressed and immutable — a name is the hash of its bytes — so a file already
 * in the previous backup set is, by construction, the same file. Those are hardlinked rather than
 * copied, which makes a nightly set cost only what was uploaded since the last one. When the link
 * cannot be made (a different filesystem) the file is copied; the result is the same bytes and
 * only the cost differs. New files are always a real copy, never a link into the live volume, so
 * a backup set does not share an inode with the thing it protects.
 *
 * A file the store is still writing is a `.tmp-*` name, not a hash, so it is ignored: the store
 * renames it into place only when whole.
 */
export async function copyBlobs(
  src: string,
  dest: string,
  previous?: string,
): Promise<CopyBlobsResult> {
  await mkdir(dest, { recursive: true });

  let copied = 0;
  let linked = 0;
  let copiedBytes = 0;
  let ignored = 0;

  for (const name of await listNames(src)) {
    if (!isSha256(name)) {
      ignored += 1;
      continue;
    }

    const from = join(src, name);
    const size = await sizeOf(from);
    if (size === null) {
      ignored += 1;
      continue;
    }

    const to = join(dest, name);
    if (previous !== undefined && (await sizeOf(join(previous, name))) === size) {
      try {
        await link(join(previous, name), to);
        linked += 1;
        continue;
      } catch {
        // Cross-device, or a filesystem without hardlinks: fall through to a copy.
      }
    }

    await copyFile(from, to);
    copied += 1;
    copiedBytes += size;
  }

  return { total: copied + linked, copied, linked, copiedBytes, ignored };
}

/** SHA-256 of a file, streamed: a blob may be large and the drill hashes all of them. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export interface VerifyBlobsResult {
  /** Rows checked. */
  readonly blobs: number;
  /** Rows whose file exists and hashes to its name. */
  readonly verified: number;
  readonly missing: readonly string[];
  readonly mismatched: readonly string[];
  /** Names in the directory that are not a SHA-256 — nothing wrote these. */
  readonly malformed: readonly string[];
  /** Well-formed files that no row names. Reported, never a failure: an upload that crashed
   * between the file and its row leaves one, and it is harmless. */
  readonly unreferenced: number;
}

/**
 * Check every blob row against the files in `dir` (FRM-REQ-203): the file exists, and the SHA-256
 * of its bytes equals its name. Existence alone would pass a truncated or bit-rotted copy, and a
 * restore that "works" on those is the failure this exists to catch before it is the only copy.
 */
export async function verifyBlobs(shas: readonly string[], dir: string): Promise<VerifyBlobsResult> {
  const names = new Set(await listNames(dir));
  const missing: string[] = [];
  const mismatched: string[] = [];
  let verified = 0;

  for (const sha of shas) {
    const path = join(resolve(dir), sha);
    // A row whose key is not even a hash can never match a file named by one.
    if (!isSha256(sha) || !names.has(sha) || (await sizeOf(path)) === null) {
      missing.push(sha);
      continue;
    }
    if ((await hashFile(path)) === sha) verified += 1;
    else mismatched.push(sha);
  }

  const referenced = new Set(shas);
  const malformed = [...names].filter((name) => !isSha256(name)).sort();
  const unreferenced = [...names].filter((name) => isSha256(name) && !referenced.has(name)).length;

  return { blobs: shas.length, verified, missing, mismatched, malformed, unreferenced };
}

/** The first few of a list, for an error message that names culprits without printing thousands. */
const first = (shas: readonly string[], n = 5) =>
  `${shas.slice(0, n).join(', ')}${shas.length > n ? `, … (${String(shas.length - n)} more)` : ''}`;

const stamp = (now: Date) => now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

export function backupJob(deps: BackupDeps): JobDefinition {
  return {
    kind: 'backup',
    stages: [
      {
        name: 'dump',
        async run(ctx) {
          const dir = deps.config.BACKUP_DIR;
          await mkdir(dir, { recursive: true });

          const path = join(dir, `foreman-${stamp(new Date())}.sql.gz`);
          const out = createWriteStream(path);
          const gzip = createGzip();
          const compressed = pipeline(gzip, out);

          // `--no-owner` and `--no-privileges`: a dump that can only be restored as the role that
          // made it is a dump that fails on the day it is needed, on a fresh host.
          const result = await run(
            'pg_dump',
            ['--no-owner', '--no-privileges', '--format=plain', deps.config.DATABASE_URL],
            { stdout: gzip },
          );
          await compressed;

          if (result.code !== 0) {
            await unlink(path).catch(() => undefined);
            const detail = `pg_dump exited ${String(result.code)}: ${result.stderr}`;
            await deps.mailer?.send(ALERTS.backupFailed(detail));
            throw new Error(detail);
          }

          const info = await stat(path);
          // A dump that is suspiciously small is a dump that restored nothing. Caught here, where
          // the fix is cheap, rather than during a restore, where it is not.
          if (info.size < 1024) {
            await deps.mailer?.send(
              ALERTS.backupFailed(`The dump is only ${String(info.size)} bytes.`),
            );
            throw new Error(`the dump is only ${String(info.size)} bytes — that cannot be right`);
          }

          ctx.logger.info({ path, bytes: info.size }, 'database dumped');
          return { path, bytes: info.size };
        },
      },
      {
        // FRM-REQ-202. After the dump, never before: a set whose dump failed has nothing to pair
        // with, and the dump stage already alerted. A separate stage so a failure here can be
        // replayed without taking the database dump again.
        name: 'blobs',
        async run(ctx) {
          const dir = deps.config.BACKUP_DIR;
          const dump = (ctx.priorOutput['dump'] as { path?: string } | undefined)?.path;
          if (dump === undefined) throw new Error('the dump stage left no path to pair blobs with');

          const final = blobsDirFor(dump);
          const partial = `${final.slice(0, -BLOBS_SUFFIX.length)}${PARTIAL_SUFFIX}`;
          const source = deps.config.FOREMAN_BLOB_DIR ?? '';

          // The newest earlier set, to hardlink unchanged blobs from. Names sort by timestamp.
          const earlier = (await readdir(dir))
            .filter((name) => name.startsWith('foreman-') && name.endsWith(BLOBS_SUFFIX))
            .map((name) => join(dir, name))
            .filter((path) => path !== final)
            .sort()
            .pop();

          try {
            // Into a partial directory first and renamed on completion, so a copy that dies half
            // way is never mistaken for a whole set by the drill or by a person at the shell.
            await rm(partial, { recursive: true, force: true });
            // An unset or missing source copies zero files into an empty set: the pair still
            // exists, so the drill can tell "no blobs" from "a backup that forgot them".
            const result = await copyBlobs(source, partial, earlier);
            await rm(final, { recursive: true, force: true });
            await rename(partial, final);

            // Said out loud rather than skipped: "0 blobs" on a deployment that has uploaded
            // screenshots is exactly what an operator needs to be able to see.
            ctx.logger.info({ path: final, ...result }, 'blobs copied');
            return { path: final, empty: result.total === 0, ...result };
          } catch (error) {
            await rm(partial, { recursive: true, force: true }).catch(() => undefined);
            const detail = `copying blobs failed: ${error instanceof Error ? error.message : String(error)}`;
            await deps.mailer?.send(ALERTS.backupFailed(detail));
            throw new Error(detail, { cause: error });
          }
        },
      },
      {
        name: 'prune',
        async run(ctx) {
          const dir = deps.config.BACKUP_DIR;
          const keepFor = deps.config.BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
          const cutoff = Date.now() - keepFor;

          const removed: string[] = [];
          const names = await readdir(dir);
          for (const name of names) {
            if (!isDump(name)) continue;
            const path = join(dir, name);
            const info = await stat(path);
            if (info.mtime.getTime() >= cutoff) continue;
            await unlink(path);
            // A blob set outlives its dump by nothing: it is meaningless without it, and left
            // behind it would be the disk filling up with copies of nothing.
            await rm(blobsDirFor(path), { recursive: true, force: true });
            removed.push(name);
          }

          // A partial set from a copy that died, and a set whose dump is gone (pruned by hand, or
          // before this stage existed to pair them). Neither can be restored from.
          const dumps = new Set(names.filter(isDump).map((name) => blobsDirFor(name)));
          for (const name of names) {
            const stray =
              name.endsWith(PARTIAL_SUFFIX) ||
              (name.startsWith('foreman-') && name.endsWith(BLOBS_SUFFIX) && !dumps.has(name));
            if (!stray) continue;
            await rm(join(dir, name), { recursive: true, force: true });
            removed.push(name);
          }

          if (removed.length > 0) ctx.logger.info({ removed }, 'old dumps pruned');
          return { removed, retentionDays: deps.config.BACKUP_RETENTION_DAYS };
        },
      },
    ],
  };
}

/**
 * The restore drill (FRM-REQ-145).
 *
 * **Performed, not documented.** It restores the newest dump into a scratch database, counts what
 * came back, and drops it. The runbook describes this; the job *is* it, which is the difference
 * between a backup that is known to work and one that is believed to.
 *
 * It also checks the blobs (FRM-REQ-203). The rows come from the **restored** database, because
 * that is the question a real restore asks: of every blob this database says it has, does the
 * paired directory hold the file, with bytes whose SHA-256 is its name? Checking the live blob
 * directory instead would prove the volume is healthy and say nothing about the backup.
 */
export function restoreDrillJob(deps: BackupDeps): JobDefinition {
  return {
    kind: 'restore-drill',
    stages: [
      {
        name: 'restore',
        async run(ctx) {
          const dir = deps.config.BACKUP_DIR;
          const dumps = (await readdir(dir))
            .filter(isDump)
            .sort()
            .reverse();

          const newest = dumps[0];
          if (newest === undefined) throw new Error('there is no dump to restore');

          // A scratch database named for this run, so a drill can never touch the real one.
          const scratch = `foreman_drill_${String(Date.now())}`;
          const admin = new URL(deps.config.DATABASE_URL);
          const adminUrl = new URL(admin.toString());
          adminUrl.pathname = '/postgres';

          const created = await run('psql', [adminUrl.toString(), '-c', `create database "${scratch}"`]);
          if (created.code !== 0) throw new Error(`could not create the scratch database: ${created.stderr}`);

          const target = new URL(admin.toString());
          target.pathname = `/${scratch}`;

          try {
            const restored = await run('sh', [
              '-c',
              `gunzip -c ${JSON.stringify(join(dir, newest))} | psql ${JSON.stringify(target.toString())} -v ON_ERROR_STOP=1`,
            ]);
            if (restored.code !== 0) {
              throw new Error(`the restore failed: ${restored.stderr}`);
            }

            // The assertion that makes this a drill rather than a file copy: the restored database
            // has to answer a question about the data.
            const counted = await run('sh', [
              '-c',
              `psql ${JSON.stringify(target.toString())} -tAc "select count(*) from project"`,
            ]);
            if (counted.code !== 0) {
              throw new Error(`the restored database would not answer a query: ${counted.stderr}`);
            }

            // FRM-REQ-203. A blob row is a promise that a file exists; the restored database
            // makes the promises and the paired directory has to keep them.
            const listed = collector();
            const selected = await run(
              'psql',
              [target.toString(), '-v', 'ON_ERROR_STOP=1', '-tAc', 'select sha256 from "blob" order by sha256'],
              { stdout: listed.sink },
            );
            if (selected.code !== 0) {
              throw new Error(`the restored database has no readable blob table: ${selected.stderr}`);
            }
            const shas = listed
              .text()
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line !== '');

            const blobs = await verifyBlobs(shas, blobsDirFor(join(dir, newest)));
            const problems: string[] = [];
            if (blobs.missing.length > 0) {
              problems.push(`${String(blobs.missing.length)} of ${String(blobs.blobs)} blobs missing: ${first(blobs.missing)}`);
            }
            if (blobs.mismatched.length > 0) {
              problems.push(
                `${String(blobs.mismatched.length)} of ${String(blobs.blobs)} blobs do not hash to their name: ${first(blobs.mismatched)}`,
              );
            }
            if (blobs.malformed.length > 0) {
              problems.push(`${String(blobs.malformed.length)} files in the blob set are not named for a SHA-256: ${first(blobs.malformed)}`);
            }
            if (problems.length > 0) {
              throw new Error(`the blobs did not survive the backup (${newest}): ${problems.join('; ')}`);
            }

            ctx.logger.info(
              { dump: newest, scratch, blobs: blobs.blobs, verified: blobs.verified, unreferenced: blobs.unreferenced },
              'restore drill succeeded',
            );
            return {
              dump: newest,
              scratch,
              verifiedAt: new Date().toISOString(),
              blobs: blobs.blobs,
              verified: blobs.verified,
              unreferenced: blobs.unreferenced,
            };
          } finally {
            // Always, even on failure: a drill that leaves scratch databases behind is one that
            // eventually fills the disk it was protecting.
            await run('psql', [adminUrl.toString(), '-c', `drop database if exists "${scratch}"`]);
          }
        },
      },
    ],
  };
}
