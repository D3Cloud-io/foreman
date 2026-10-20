import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db.js';
import { buildRegistry, drainOne, enqueue } from '../../src/jobs/index.js';
import { logger } from '../../src/logger.js';

/**
 * The backup carries the blobs and the drill proves it (T-12.5, FRM-REQ-202, FRM-REQ-203).
 *
 * Performed for real: pg_dump, a scratch database, the blob table read back from that scratch
 * database, and every named file hashed. A drill that only checked a directory listing would pass
 * a truncated image — the case the second and third tests below corrupt on purpose.
 */

const url = process.env['DATABASE_URL'];

/** Same guard as operations.test.ts: the tools must exist and match the server's major version. */
function pgToolsMatchServer(): boolean {
  const dump = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (dump.error !== undefined || dump.status !== 0) return false;
  const client = / (\d+)\./.exec(dump.stdout)?.[1];
  const server = spawnSync('psql', [url ?? '', '-tAc', 'show server_version'], { encoding: 'utf8' });
  if (server.status !== 0) return false;
  const major = /^(\d+)\./.exec(server.stdout.trim())?.[1];
  return client !== undefined && client === major;
}
const PG = pgToolsMatchServer();

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe.skipIf(url === undefined || !PG)('backup and drill with blobs (T-12.5)', () => {
  let db: Db;
  let root: string;
  let blobDir: string;
  let backupDir: string;
  let setDir: string;

  const one = Buffer.from('first blob, a screenshot standing in');
  const two = Buffer.from('second blob, a source file standing in');
  const oneSha = sha(one);
  const twoSha = sha(two);

  const config = () => ({
    DATABASE_URL: url ?? '',
    BACKUP_DIR: backupDir,
    BACKUP_RETENTION_DAYS: 30,
    FOREMAN_BLOB_DIR: blobDir,
  });

  async function run(kind: 'backup' | 'restore-drill') {
    const registry = buildRegistry({ config: config() as never });
    await db.job.deleteMany({ where: { kind } });
    await enqueue(db, registry, kind, {});
    const outcome = await drainOne({ db, logger, registry, workerId: 'test' });
    const job = await db.job.findFirstOrThrow({ where: { kind }, include: { stages: true } });
    return { outcome, stages: job.stages };
  }

  /** Put the paired copy right again, so each test starts from a good set. */
  async function restoreSet() {
    await writeFile(join(setDir, oneSha), one);
    await writeFile(join(setDir, twoSha), two);
  }

  beforeAll(async () => {
    db = createDb(url ?? '');
    root = await mkdtemp(join(tmpdir(), 'foreman-backup-blobs-'));
    blobDir = join(root, 'blobs');
    backupDir = join(root, 'backups');
    await mkdir(blobDir);
    await writeFile(join(blobDir, oneSha), one);
    await writeFile(join(blobDir, twoSha), two);

    // The rows the drill will read back from the restored database.
    await db.blob.deleteMany({ where: { sha256: { in: [oneSha, twoSha] } } });
    for (const [bytes, sha256] of [[one, oneSha], [two, twoSha]] as const) {
      await db.blob.create({
        data: { sha256, mediaType: 'image/png', byteSize: bytes.length, createdBy: 'backup-blobs test' },
      });
    }
  });

  afterAll(async () => {
    await db.blob.deleteMany({ where: { sha256: { in: [oneSha, twoSha] } } });
    await db.job.deleteMany({ where: { kind: { in: ['backup', 'restore-drill'] } } });
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
  });

  it('copies both blobs next to the dump, under the dump\'s own name', async () => {
    const { outcome, stages } = await run('backup');
    expect(outcome?.status, 'the backup should succeed').toBe('succeeded');
    expect(stages.map((s) => s.name).sort()).toEqual(['blobs', 'dump', 'prune']);

    const names = await readdir(backupDir);
    const dump = names.find((n) => n.endsWith('.sql.gz'));
    expect(dump).toBeDefined();
    const paired = (dump ?? '').replace(/\.sql\.gz$/, '.blobs');
    expect(names).toContain(paired);
    expect(names.some((n) => n.endsWith('.partial'))).toBe(false);

    setDir = join(backupDir, paired);
    expect((await readdir(setDir)).sort()).toEqual([oneSha, twoSha].sort());
  });

  it('passes the drill and reports how many blobs it verified', async () => {
    const { outcome, stages } = await run('restore-drill');
    expect(outcome?.status, 'the drill should verify both blobs').toBe('succeeded');
    expect(stages[0]?.output).toMatchObject({ blobs: 2, verified: 2 });
  });

  it('fails the drill, naming the blob, when a file in the backup has been corrupted', async () => {
    await writeFile(join(setDir, twoSha), 'bytes that are not the second blob');
    try {
      const { outcome, stages } = await run('restore-drill');
      expect(outcome?.status).toBe('failed');
      const error = stages[0]?.lastError ?? '';
      expect(error).toContain(twoSha);
      expect(error).toContain('do not hash to their name');
      expect(error).not.toContain(oneSha);
    } finally {
      await restoreSet();
    }
  });

  it('fails the drill, naming the blob, when a file in the backup is missing', async () => {
    await rm(join(setDir, oneSha));
    try {
      const { outcome, stages } = await run('restore-drill');
      expect(outcome?.status).toBe('failed');
      const error = stages[0]?.lastError ?? '';
      expect(error).toContain(oneSha);
      expect(error).toContain('missing');
    } finally {
      await restoreSet();
    }
  });

  it('leaves no scratch database behind after a failed drill', async () => {
    const rows = await db.$queryRaw<{ datname: string }[]>`
      select datname from pg_database where datname like 'foreman_drill_%'
    `;
    expect(rows).toEqual([]);
  });

  it('a second backup hardlinks the unchanged blobs and the drill still passes on it', async () => {
    // The dump's name has one-second resolution; wait so this set is a new one, not a rewrite.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const { outcome, stages } = await run('backup');
    expect(outcome?.status).toBe('succeeded');
    expect(stages.find((s) => s.name === 'blobs')?.output).toMatchObject({ total: 2, linked: 2, copied: 0 });

    const drill = await run('restore-drill');
    expect(drill.outcome?.status).toBe('succeeded');
    expect(drill.stages[0]?.output).toMatchObject({ blobs: 2, verified: 2 });
  });
});
