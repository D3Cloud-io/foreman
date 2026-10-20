import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blobsDirFor, copyBlobs, verifyBlobs } from '../../src/jobs/backup.js';

/**
 * The blob half of the backup and the drill (FRM-REQ-202, FRM-REQ-203), on temporary directories.
 * The database half needs pg_dump and lives in the integration suite; these are the parts that are
 * only files, so they run everywhere.
 */

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('blob backup and verification', () => {
  let root: string;
  let src: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'foreman-blobs-unit-'));
    src = join(root, 'live');
    await mkdir(src);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function put(dir: string, text: string): Promise<string> {
    const name = sha(text);
    await writeFile(join(dir, name), text);
    return name;
  }

  it('pairs a dump with a directory of the same basename', () => {
    expect(blobsDirFor('/backups/foreman-2026-10-19T03-00-00.sql.gz')).toBe(
      '/backups/foreman-2026-10-19T03-00-00.blobs',
    );
  });

  describe('copyBlobs (FRM-REQ-202)', () => {
    it('copies every blob and ignores the store\'s temporary files', async () => {
      const a = await put(src, 'alpha');
      const b = await put(src, 'beta');
      await writeFile(join(src, `.tmp-${a}-abc123`), 'half written');

      const dest = join(root, 'set1');
      const result = await copyBlobs(src, dest);

      expect(result).toMatchObject({ total: 2, copied: 2, linked: 0, ignored: 1 });
      expect((await readdir(dest)).sort()).toEqual([a, b].sort());
    });

    it('treats a missing source as zero blobs, not an error', async () => {
      const dest = join(root, 'set1');
      const result = await copyBlobs(join(root, 'nonexistent'), dest);

      expect(result.total).toBe(0);
      expect(await readdir(dest)).toEqual([]);
    });

    it('treats an unset source (empty string) as zero blobs', async () => {
      const result = await copyBlobs('', join(root, 'set1'));
      expect(result.total).toBe(0);
    });

    it('hardlinks what the previous set already holds and copies only the new files', async () => {
      const a = await put(src, 'alpha');
      const first = join(root, 'set1');
      await copyBlobs(src, first);

      const b = await put(src, 'beta');
      const second = join(root, 'set2');
      const result = await copyBlobs(src, second, first);

      expect(result).toMatchObject({ total: 2, linked: 1, copied: 1 });
      // Linked from the earlier set, not from the live volume.
      expect((await stat(join(second, a))).ino).toBe((await stat(join(first, a))).ino);
      expect((await stat(join(second, a))).ino).not.toBe((await stat(join(src, a))).ino);
      expect((await stat(join(second, b))).ino).not.toBe((await stat(join(src, b))).ino);
    });

    it('copies rather than links when the previous file is a different size', async () => {
      const a = await put(src, 'alpha');
      const first = join(root, 'set1');
      await mkdir(first);
      await writeFile(join(first, a), 'truncated');

      const result = await copyBlobs(src, join(root, 'set2'), first);
      expect(result).toMatchObject({ linked: 0, copied: 1 });
    });

    it('copies the live file rather than linking a same-size corrupt one from the previous set', async () => {
      const a = await put(src, 'alpha');
      const first = join(root, 'set1');
      await mkdir(first);
      // Same length as 'alpha', different bytes: the case a size check alone would carry forward.
      await writeFile(join(first, a), 'alphx');

      const second = join(root, 'set2');
      const result = await copyBlobs(src, second, first);
      expect(result).toMatchObject({ linked: 0, copied: 1 });
      expect(await readFile(join(second, a), 'utf8')).toBe('alpha');
    });
  });

  describe('verifyBlobs (FRM-REQ-203)', () => {
    it('passes when every row has a file whose hash is its name', async () => {
      const a = await put(src, 'alpha');
      const b = await put(src, 'beta');

      const result = await verifyBlobs([a, b], src);
      expect(result).toMatchObject({ blobs: 2, verified: 2, missing: [], mismatched: [], malformed: [] });
    });

    it('passes with zero rows and a missing directory', async () => {
      const result = await verifyBlobs([], join(root, 'nonexistent'));
      expect(result).toMatchObject({ blobs: 0, verified: 0 });
    });

    it('names a row whose file is gone', async () => {
      const a = await put(src, 'alpha');
      const gone = sha('never written');

      const result = await verifyBlobs([a, gone], src);
      expect(result.verified).toBe(1);
      expect(result.missing).toEqual([gone]);
    });

    it('names a row for which the whole directory is gone', async () => {
      const a = sha('alpha');
      const result = await verifyBlobs([a], join(root, 'nonexistent'));
      expect(result.missing).toEqual([a]);
    });

    it('names a file whose bytes no longer hash to its name', async () => {
      const a = await put(src, 'alpha');
      const b = await put(src, 'beta');
      await writeFile(join(src, b), 'beta, flipped a bit');

      const result = await verifyBlobs([a, b], src);
      expect(result.verified).toBe(1);
      expect(result.mismatched).toEqual([b]);
      expect(result.missing).toEqual([]);
    });

    it('counts a same-size corruption, which existence and size checks would pass', async () => {
      const text = 'alpha';
      const a = await put(src, text);
      await writeFile(join(src, a), 'alphb');

      const result = await verifyBlobs([a], src);
      expect(result.mismatched).toEqual([a]);
    });

    it('reports files no row names without failing on them, and flags malformed names', async () => {
      const a = await put(src, 'alpha');
      await put(src, 'orphan');
      await writeFile(join(src, 'not-a-hash'), 'x');

      const result = await verifyBlobs([a], src);
      expect(result.verified).toBe(1);
      expect(result.unreferenced).toBe(1);
      expect(result.malformed).toEqual(['not-a-hash']);
    });

    it('verifies a set that copyBlobs produced', async () => {
      const a = await put(src, 'alpha');
      const b = await put(src, 'beta');
      const dest = join(root, 'set1');
      await copyBlobs(src, dest);

      expect(await verifyBlobs([a, b], dest)).toMatchObject({ verified: 2 });
    });
  });
});
