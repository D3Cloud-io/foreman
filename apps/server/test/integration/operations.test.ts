import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMailer, type Alert } from '../../src/adapters/mail.js';
import { createDb, type Db } from '../../src/db.js';
import { health, standingFailures } from '../../src/domain/operations.js';
import { alertOnStall, buildRegistry, drainOne, enqueue, weekKey } from '../../src/jobs/index.js';
import { logger } from '../../src/logger.js';

/**
 * Operations: the dump, the drill, health, and alerts (T-7.4 … T-7.7).
 *
 * **The drill actually restores.** FRM-REQ-145 is satisfied by performing a restore, not by
 * writing a runbook — Bindery's own code review found a drill "verified by grepping", and that
 * finding is free to inherit.
 */

const url = process.env['DATABASE_URL'];

/**
 * `pg_dump` and `psql` live in the server *image*, not on a developer's Mac — Postgres runs in a
 * container here. These tests exercise the real binaries, so they skip where the binaries are
 * absent and CI (which runs them in the image) is where they must pass.
 *
 * The drill itself is performed against the running container:
 * `docker compose exec server node dist/cli/run-job.js restore-drill`.
 */
/**
 * Present *and* the right major version — the two are not the same thing.
 *
 * `pg_dump` 18 against a PostgreSQL 16 server produces a dump that begins `SET transaction_timeout
 * = 0;`, a setting that did not exist before 17. Restoring it with `ON_ERROR_STOP=1` fails on the
 * fourth line, so a mismatched client yields dumps that cannot be restored — the precise failure
 * ADR-007 exists to prevent. Both images pin `postgresql-client-${POSTGRES_MAJOR}` and assert the
 * version at build time, so this can only bite a developer whose host tools have moved ahead.
 * Skipping with a reason beats failing with a psql error that names none of this.
 */
function pgToolsMatchServer(): boolean {
  const dump = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (dump.error !== undefined || dump.status !== 0) return false;

  const client = / (\d+)\./.exec(dump.stdout)?.[1];
  const server = spawnSync('psql', [url ?? '', '-tAc', 'show server_version'], { encoding: 'utf8' });
  if (server.status !== 0) return false;

  const major = /^(\d+)\./.exec(server.stdout.trim())?.[1];
  if (client !== undefined && major !== undefined && client !== major) {
    console.warn(
      `operations: skipping the dump and drill tests — pg_dump is ${client}, the server is ${major}.`,
    );
    return false;
  }
  return client !== undefined && client === major;
}
const PG = pgToolsMatchServer();

describe.skipIf(url === undefined)('operations', () => {
  let db: Db;
  let backupDir: string;

  beforeAll(async () => {
    db = createDb(url ?? '');
    backupDir = await mkdtemp(join(tmpdir(), 'foreman-backup-'));
  });

  afterAll(async () => {
    await rm(backupDir, { recursive: true, force: true });
    await db.job.deleteMany({ where: { kind: { in: ['backup', 'restore-drill'] } } });
    await db.$disconnect();
  });

  const config = {
    DATABASE_URL: url ?? '',
    BACKUP_DIR: '',
    BACKUP_RETENTION_DAYS: 30,
  };

  describe.skipIf(!PG)('the nightly dump (T-7.6, FRM-REQ-144)', () => {
    it('writes a compressed dump and prunes nothing on its first run', async () => {
      const registry = buildRegistry({ config: { ...config, BACKUP_DIR: backupDir } as never });
      await enqueue(db, registry, 'backup', {});
      const outcome = await drainOne({ db, logger, registry, workerId: 'test' });

      expect(outcome?.status, 'the dump should succeed').toBe('succeeded');

      const files = (await readdir(backupDir)).filter((f) => f.endsWith('.sql.gz'));
      expect(files).toHaveLength(1);
    });

    it('prunes a dump older than the retention window', async () => {
      const stale = join(backupDir, 'foreman-2020-01-01T00-00-00.sql.gz');
      await writeFile(stale, 'x'.repeat(2048));
      // Backdate it past the window.
      const { utimes } = await import('node:fs/promises');
      const old = new Date(Date.now() - 400 * 86_400_000);
      await utimes(stale, old, old);

      const registry = buildRegistry({ config: { ...config, BACKUP_DIR: backupDir } as never });
      await db.job.deleteMany({ where: { kind: 'backup' } });
      await enqueue(db, registry, 'backup', {});
      await drainOne({ db, logger, registry, workerId: 'test' });

      const files = await readdir(backupDir);
      expect(files).not.toContain('foreman-2020-01-01T00-00-00.sql.gz');
    });
  });

  describe.skipIf(!PG)('the restore drill (T-7.7, FRM-REQ-145)', () => {
    it('restores the newest dump into a clean database and queries it', async () => {
      const registry = buildRegistry({ config: { ...config, BACKUP_DIR: backupDir } as never });
      await db.job.deleteMany({ where: { kind: 'restore-drill' } });
      await enqueue(db, registry, 'restore-drill', {});
      const outcome = await drainOne({ db, logger, registry, workerId: 'test' });

      // Performed, not documented. If this ever passes without a database being created, restored
      // and queried, the drill has become the thing it was written to replace.
      expect(outcome?.status, 'the drill should restore and verify').toBe('succeeded');

      const job = await db.job.findFirstOrThrow({
        where: { kind: 'restore-drill' },
        include: { stages: true },
      });
      const output = JSON.stringify(job.stages[0]?.output);
      expect(output).toContain('verifiedAt');
      expect(output).toContain('.sql.gz');
    });

    it('leaves no scratch database behind', async () => {
      const rows = await db.$queryRaw<{ datname: string }[]>`
        select datname from pg_database where datname like 'foreman_drill_%'
      `;
      // A drill that leaves scratch databases behind eventually fills the disk it was protecting.
      expect(rows).toEqual([]);
    });

    it('fails loudly when there is nothing to restore', async () => {
      const empty = await mkdtemp(join(tmpdir(), 'foreman-empty-'));
      const registry = buildRegistry({ config: { ...config, BACKUP_DIR: empty } as never });
      await db.job.deleteMany({ where: { kind: 'restore-drill' } });
      await enqueue(db, registry, 'restore-drill', {});
      const outcome = await drainOne({ db, logger, registry, workerId: 'test' });

      expect(outcome?.status).toBe('failed');
      await rm(empty, { recursive: true, force: true });
    });
  });

  describe('health (T-7.4, FRM-REQ-142)', () => {
    it('reports all six signals', async () => {
      // Built here rather than inherited from the dump tests above. Those only run where pg_dump
      // exists, and the drill test between them deletes every restore-drill job — so reading their
      // residue made this pass on a laptop without Postgres tools and fail in CI, which is the
      // wrong way round for a test of the health endpoint.
      const dir = await mkdtemp(join(tmpdir(), 'foreman-health-'));
      await writeFile(join(dir, 'foreman-2026-09-18T03-00-00.sql.gz'), 'not really a dump');
      await db.job.create({
        data: { kind: 'restore-drill', status: 'succeeded', payload: {} },
      });

      const report = await health(db, { backupDir: dir });

      expect(report.queue).toHaveProperty('queued');
      expect(report).toHaveProperty('stageFailures');
      expect(report).toHaveProperty('lastIngest');
      expect(report).toHaveProperty('lastReconcile');
      expect(report.lastBackup).not.toBeNull();
      expect(report.lastRestoreDrill).not.toBeNull();

      await rm(dir, { recursive: true, force: true });
    });

    it('says a never-drilled backup is a problem, in words', async () => {
      // A fresh database has taken no dump and run no drill. Both are problems, and an untested
      // backup is not a backup (R-04).
      const report = await health(db, { backupDir: join(backupDir, 'nope') });
      expect(report.ok).toBe(false);
      expect(report.problems.join(' ')).toContain('has ever been taken');
    });

    it('calls a queue with an old head stalled', async () => {
      await db.job.deleteMany({ where: { kind: 'example' } });
      const registry = buildRegistry({});
      const { id } = await enqueue(db, registry, 'example', {});
      await db.job.update({
        where: { id },
        data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      });

      const report = await health(db, { backupDir });
      // Depth alone says nothing: a queue of three is fine, and a queue of three with an
      // eight-hour-old head is stuck.
      expect(report.queue.stalled).toBe(true);
      expect(report.problems.join(' ')).toContain('has not moved');

      await db.job.deleteMany({ where: { id } });
    });

    describe('failed jobs still standing (FRM-T-18.18)', () => {
      // Its own kind, so a failure another test leaves behind cannot answer for these or be
      // answered by them.
      const KIND = 'health-reconcile-test';
      const REPO_A = '01a00000-0000-7000-8000-00000000000a';
      const REPO_B = '01a00000-0000-7000-8000-00000000000b';
      const at = (hours: number) => new Date(Date.UTC(2026, 10, 2, hours));
      const job = (status: 'failed' | 'succeeded', repoId: string, finishedAt: Date) =>
        db.job.create({ data: { kind: KIND, status, payload: { repoId }, finishedAt } });

      beforeEach(async () => {
        await db.job.deleteMany({ where: { kind: KIND } });
      });
      afterAll(async () => {
        await db.job.deleteMany({ where: { kind: KIND } });
      });

      it('stops counting a failure once a later run for the same repo succeeds', async () => {
        const before = await standingFailures(db);
        await job('failed', REPO_A, at(0));
        await job('succeeded', REPO_A, at(24));

        expect(await standingFailures(db)).toBe(before);
        const report = await health(db, { backupDir });
        expect(report.queue.failed).toBe(before);
      });

      it('keeps counting a failure nothing has succeeded after', async () => {
        const before = await standingFailures(db);
        // A success from before the failure answers nothing.
        await job('succeeded', REPO_A, at(0));
        await job('failed', REPO_A, at(24));

        expect(await standingFailures(db)).toBe(before + 1);
        const report = await health(db, { backupDir });
        expect(report.ok).toBe(false);
        expect(report.problems.join(' ')).toContain('failed');
      });

      it('keeps counting a failure for one repo when only another repo has succeeded', async () => {
        const before = await standingFailures(db);
        await job('failed', REPO_A, at(0));
        await job('succeeded', REPO_B, at(24));

        expect(await standingFailures(db)).toBe(before + 1);
      });
    });
  });

  describe('alerts (T-7.5, FRM-REQ-143)', () => {
    const collect = () => {
      const sent: Alert[] = [];
      const mailer = createMailer(
        {
          MAIL_RELAY_URL: 'https://mail.d3cloud.io/send',
          MAIL_RELAY_TOKEN: 'token',
          ALERT_TO: 'matthew@demers.dev',
          BASE_URL: 'https://foreman.d3cloud.io',
        },
        {
          fetch: ((_url: string, init: { body: string }) => {
            sent.push(JSON.parse(init.body) as Alert);
            return Promise.resolve(new Response('{}', { status: 200 }));
          }) as unknown as typeof fetch,
        },
      );
      return { sent, mailer };
    };

    it('emails when the queue has stalled', async () => {
      await db.job.deleteMany({ where: { kind: 'example' } });
      const registry = buildRegistry({});
      const { id } = await enqueue(db, registry, 'example', {});
      await db.job.update({
        where: { id },
        data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      });

      const { sent, mailer } = collect();
      const result = await alertOnStall(db, mailer);

      expect(result.alerted).toBe(true);
      expect(JSON.stringify(sent[0])).toContain('stalled');
      await db.job.deleteMany({ where: { id } });
    });

    it('does not repeat the same alert within the hour', async () => {
      await db.job.deleteMany({ where: { kind: 'example' } });
      const registry = buildRegistry({});
      const { id } = await enqueue(db, registry, 'example', {});
      await db.job.update({
        where: { id },
        data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      });

      const { sent, mailer } = collect();
      await alertOnStall(db, mailer);
      await alertOnStall(db, mailer);

      // An alert that repeats every minute trains its reader to ignore it.
      expect(sent).toHaveLength(1);
      await db.job.deleteMany({ where: { id } });
    });

    it('is silent when nothing is wrong', async () => {
      await db.job.deleteMany({ where: { status: 'queued' } });
      const { sent, mailer } = collect();
      expect((await alertOnStall(db, mailer)).alerted).toBe(false);
      expect(sent).toHaveLength(0);
    });

    it('says why, rather than throwing, when no relay is configured', async () => {
      const mailer = createMailer({
        MAIL_RELAY_URL: undefined,
        MAIL_RELAY_TOKEN: undefined,
        ALERT_TO: undefined,
        BASE_URL: 'https://foreman.d3cloud.io',
      });
      const result = await mailer.send({ kind: 'backup-failed', subject: 'x', body: 'y' });

      // A clone with no relay still runs, and the health screen shows what the email would have.
      expect(result.sent).toBe(false);
      expect(result.reason).toContain('no mail relay');
    });
  });

  describe('scheduling', () => {
    it('gives the same ISO week for two days in it, and a new one after', () => {
      expect(weekKey(new Date('2026-09-14T00:00:00Z'))).toBe(
        weekKey(new Date('2026-09-18T00:00:00Z')),
      );
      expect(weekKey(new Date('2026-09-21T00:00:00Z'))).not.toBe(
        weekKey(new Date('2026-09-18T00:00:00Z')),
      );
    });
  });
});
