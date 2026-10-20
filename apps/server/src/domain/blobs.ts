import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ReadStream } from 'node:fs';
import { BLOB_MEDIA_TYPES, type Blob, type BlobMediaType } from '@foreman/shared';
import { Prisma, type Db } from '../db.js';
import { record, type Actor } from './audit.js';
import { NotFound } from './errors.js';

/**
 * The blob store (FRM-REQ-190, FRM-REQ-191).
 *
 * Every uploaded image and source file is written **once**, to a directory on the host's disk,
 * under a name that is the SHA-256 of its bytes. PostgreSQL holds a row saying what the file is —
 * its type, its size, who first sent it — and never the bytes: a database that carries images
 * carries them into every dump, and the dump is the only escape hatch (ADR-007).
 *
 * The layout is flat, `<FOREMAN_BLOB_DIR>/<sha256>`, with no fan-out: the volume is expected to
 * hold screenshots and source files by the thousand, not by the million, and a flat directory is
 * one a person can list and check against the table without a script.
 */

/** Signatures recognised from the leading bytes. The client's declared type is never trusted. */
function sniffImage(bytes: Buffer): BlobMediaType | null {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= PNG.length && PNG.every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // RIFF, then a four-byte length, then WEBP: the length is skipped because it is not a signature.
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** JSON has no signature, so it is accepted only when the client says it is JSON and it parses. */
function isJson(bytes: Buffer): boolean {
  try {
    // Fatal, so bytes that are not UTF-8 are refused rather than parsed through replacement
    // characters into something that happens to be valid.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the bytes are, or null when they are none of the allowed types. A GIF, a PDF, an HTML page
 * declared as `image/png` — all null, because the decision is made from the content.
 */
export function sniffMediaType(bytes: Buffer, declared: string | undefined): BlobMediaType | null {
  const image = sniffImage(bytes);
  if (image !== null) return image;
  const type = (declared ?? '').split(';')[0]?.trim().toLowerCase();
  if (type === 'application/json' && isJson(bytes)) return 'application/json';
  return null;
}

export const ALLOWED_MEDIA_TYPES: readonly BlobMediaType[] = BLOB_MEDIA_TYPES;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSha256(value: string): boolean {
  return SHA256_HEX.test(value);
}

export function blobPath(dir: string, sha256: string): string {
  // Checked here as well as in the route: this is the one function that turns a request value into
  // a path, so it is the one place a `../` must not get past.
  if (!isSha256(sha256)) throw new NotFound(`blob ${sha256}`);
  return join(resolve(dir), sha256);
}

function shape(row: { id: string; sha256: string; mediaType: string; byteSize: number }): Blob {
  return {
    id: row.id,
    sha256: row.sha256,
    mediaType: row.mediaType as BlobMediaType,
    byteSize: row.byteSize,
    url: `/api/blobs/${row.sha256}`,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Put the bytes on disk under their hash, unless they are already there.
 *
 * Written to a temporary name in the same directory and then renamed, so a crash part-way leaves a
 * stray temporary file and never a truncated file under a final name — a name that, being a hash,
 * would otherwise be believed. Same directory because a rename is only atomic within one
 * filesystem.
 */
async function writeOnce(dir: string, sha256: string, bytes: Buffer): Promise<void> {
  const root = resolve(dir);
  const target = join(root, sha256);
  if (await exists(target)) return;

  await mkdir(root, { recursive: true });
  const temp = join(root, `.tmp-${sha256}-${randomBytes(6).toString('hex')}`);
  try {
    await writeFile(temp, bytes, { flag: 'wx' });
    // Two concurrent uploads of the same bytes both get here; the second rename replaces the first
    // with identical content, which is harmless and simpler than a lock.
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export interface StoredBlob {
  readonly blob: Blob;
  /** False when the bytes were already stored: no second row, no second file. */
  readonly created: boolean;
  /** The audit event the upload wrote (FRM-REQ-243); empty when the bytes were already stored. */
  readonly auditEventIds: string[];
}

/**
 * Store an upload once (FRM-REQ-190). The caller has already decided its type; this hashes it,
 * puts it on disk if it is not there, and records it if it is not recorded.
 *
 * The file is written **before** the row. A row without its file is a broken link; a file without
 * a row is only an orphan, and the next upload of the same bytes adopts it.
 */
export async function storeBlob(
  db: Db,
  actor: Actor,
  dir: string,
  input: { bytes: Buffer; mediaType: BlobMediaType },
): Promise<StoredBlob> {
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  await writeOnce(dir, sha256, input.bytes);

  const existing = await db.blob.findUnique({ where: { sha256 } });
  if (existing !== null) return { blob: shape(existing), created: false, auditEventIds: [] };

  try {
    const row = await db.$transaction(async (tx) => {
      const created = await tx.blob.create({
        data: {
          sha256,
          mediaType: input.mediaType,
          byteSize: input.bytes.length,
          createdBy: actor.actor,
        },
      });
      const event = await record(tx, {
        ...actor,
        action: 'create',
        entityType: 'blob',
        entityId: created.id,
        after: shape(created),
      });
      return { created, event };
    });
    return { blob: shape(row.created), created: true, auditEventIds: [row.event] };
  } catch (error) {
    // Two uploads of the same bytes raced past the lookup, and the unique index chose one. The
    // loser's answer is the winner's row — the same thing a later upload would have been told.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await db.blob.findUnique({ where: { sha256 } });
      if (winner !== null) return { blob: shape(winner), created: false, auditEventIds: [] };
    }
    throw error;
  }
}

export interface BlobRead {
  readonly mediaType: string;
  readonly byteSize: number;
  readonly stream: ReadStream;
}

/** Open a stored blob for reading. NotFound when there is no row, or the row has lost its file. */
export async function openBlob(db: Db, dir: string, sha256: string): Promise<BlobRead> {
  const row = await db.blob.findUnique({ where: { sha256 } });
  if (row === null) throw new NotFound(`blob ${sha256}`);
  const path = blobPath(dir, sha256);
  if (!(await exists(path))) throw new NotFound(`blob ${sha256}`);
  return { mediaType: row.mediaType, byteSize: row.byteSize, stream: createReadStream(path) };
}
