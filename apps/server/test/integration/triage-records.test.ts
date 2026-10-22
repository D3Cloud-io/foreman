import { execFile } from 'node:child_process';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * Triage that keeps its own records (FRM-T-18.15, FRM-REQ-246).
 *
 * - A finding's won't-fix reason is its own column: `FindingUpdate.wontFixReason`, taken only when
 *   the status the write leaves is `wont_fix`, refused by name otherwise, and cleared — in the same
 *   audited write — by any status that moves away. A verdict never edits `recommendation_md`.
 * - A decision accepting drift is linked to the drifting record and category by columns, and read
 *   back by them through `GET …/decisions?acceptsDrift=1`, keyset-paged with no cap.
 * - `move-wontfix-reasons` moves what the console wrote into prose before either column existed,
 *   reporting by default and writing one audited update per record with `--write`.
 */

const run = promisify(execFile);
const url = process.env['DATABASE_URL'];
const SCRIPT = fileURLToPath(new URL('../../src/cli/move-wontfix-reasons.ts', import.meta.url));
const EMAIL = 'triage-records@example.com';
const PASSWORD = 'a-password-for-the-triage-record-tests';
const CODE = 'TRR';

const ENV = {
  ...process.env,
  BASE_URL: 'http://localhost:3200',
  DATABASE_URL: url ?? '',
  KEK: Buffer.alloc(32, 1).toString('base64'),
  PEPPER: Buffer.alloc(32, 2).toString('base64'),
  COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
};

const cli = (args: string[]) =>
  run(process.execPath, ['--import', 'tsx', SCRIPT, '--project', CODE, ...args], { env: ENV });

interface FindingBody {
  humanId: string;
  status: string;
  recommendationMd: string | null;
  wontFixReason: string | null;
  auditEventIds: string[];
}

describe.skipIf(url === undefined)('triage keeps its own records', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;

  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}${path}`, { ...init, headers });
  };
  const json = async <T>(res: Response, status = 200): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });
  const patch = (path: string, body: unknown) => api(path, { method: 'PATCH', body: JSON.stringify(body) });

  const newFinding = async (title: string) =>
    json<FindingBody>(
      await post(`/api/projects/${CODE}/findings`, { title, severity: 'high', recommendationMd: 'Scope the select.' }),
      201,
    );
  const verdict = (humanId: string, body: unknown) => patch(`/api/projects/${CODE}/findings/${humanId}`, body);
  const read = async (humanId: string) => json<FindingBody>(await api(`/api/findings/${humanId}`));

  beforeAll(async () => {
    const config: Config = loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'http://localhost:3200',
      DATABASE_URL: url ?? '',
      KEK: Buffer.alloc(32, 1).toString('base64'),
      PEPPER: Buffer.alloc(32, 2).toString('base64'),
      COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
    });
    db = createDb(url ?? '');

    await db.user.deleteMany({ where: { email: EMAIL } });
    const user = await db.user.create({ data: { email: EMAIL, displayName: 'Triage records', status: 'active' } });
    await setPassword({ db, config }, user.id, PASSWORD);
    await db.project.deleteMany({ where: { code: CODE } });

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

    await json(await post('/api/projects', { code: CODE, name: 'Triage records' }), 201);
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await db.$disconnect();
  });

  describe("a won't-fix reason in its own column", () => {
    it('keeps the reason beside the recommendation, which the verdict never edits', async () => {
      const { humanId } = await newFinding('Won’t fix, with a reason');
      const marked = await json<FindingBody>(
        await verdict(humanId, { status: 'wont_fix', wontFixReason: '  The code is being deleted.  ' }),
      );
      expect(marked.auditEventIds).toHaveLength(1);
      expect(await read(humanId)).toMatchObject({
        status: 'wont_fix',
        wontFixReason: 'The code is being deleted.',
        recommendationMd: 'Scope the select.',
      });

      // Saying it again replaces it: the verdict is idempotent, not appended.
      await json(await verdict(humanId, { status: 'wont_fix', wontFixReason: 'The code is being deleted.' }));
      // And a finding already wont_fix takes a new reason on its own.
      await json(await verdict(humanId, { wontFixReason: 'Replaced by the new router.' }));
      expect(await read(humanId)).toMatchObject({
        wontFixReason: 'Replaced by the new router.',
        recommendationMd: 'Scope the select.',
      });
    });

    it('refuses a reason, by name, for any status but wont_fix', async () => {
      const { humanId } = await newFinding('No reason for an open one');

      // The body moves the status elsewhere: refused by the schema.
      const elsewhere = await verdict(humanId, { status: 'fixed', wontFixReason: 'why' });
      expect(elsewhere.status).toBe(400);
      expect(JSON.stringify(await elsewhere.json())).toContain('wontFixReason');

      // The finding is open and the body leaves it so: refused by the server, the same way.
      const stays = await verdict(humanId, { wontFixReason: 'why' });
      expect(stays.status).toBe(400);
      const body = (await stays.json()) as { error: string; fields: { path: string }[] };
      expect(body.fields.map((f) => f.path)).toEqual(['wontFixReason']);
      expect(body.error).toContain(humanId);

      // Neither wrote anything.
      expect(await read(humanId)).toMatchObject({ status: 'open', wontFixReason: null });
      const row = await db.finding.findUniqueOrThrow({ where: { humanId }, select: { id: true } });
      const events = await db.auditEvent.count({ where: { entityId: row.id, action: 'update' } });
      expect(events).toBe(0);
    });

    it('is cleared by Reopen in the same audited write, and Undo of the Reopen puts it back', async () => {
      const { humanId } = await newFinding('Reopened after a won’t fix');
      await json(await verdict(humanId, { status: 'wont_fix', wontFixReason: 'Out of scope.' }));

      const reopened = await json<FindingBody>(await verdict(humanId, { status: 'open' }));
      expect(reopened).toMatchObject({ status: 'open', wontFixReason: null, recommendationMd: 'Scope the select.' });
      expect(reopened.auditEventIds).toHaveLength(1);
      const event = await db.auditEvent.findUniqueOrThrow({ where: { id: reopened.auditEventIds[0] ?? '' } });
      expect(event.before).toMatchObject({ status: 'wont_fix', wontFixReason: 'Out of scope.' });
      expect(event.after).toMatchObject({ status: 'open', wontFixReason: null });

      await json(await post(`/api/undo/${reopened.auditEventIds[0] ?? ''}`, {}));
      expect(await read(humanId)).toMatchObject({ status: 'wont_fix', wontFixReason: 'Out of scope.' });

      // Mark fixed moves it away too.
      await json(await verdict(humanId, { status: 'fixed' }));
      expect((await read(humanId)).wontFixReason).toBeNull();
    });
  });

  describe('a decision accepting drift, linked by relation', () => {
    it('records the link with the decision, both halves or neither, and never edits it after', async () => {
      const created = await json<{ humanId: string; acceptsDriftSubject: string; acceptsDriftCategory: string }>(
        await post(`/api/projects/${CODE}/decisions`, {
          statement: 'Accepted drift on TRR-REQ-001 (coverage-hole): A Must with no task satisfying it.',
          value: 'Accepted for now — not drift to act on',
          rationale: 'Covered elsewhere.',
          acceptsDriftSubject: 'TRR-REQ-001',
          acceptsDriftCategory: 'coverage-hole',
        }),
        201,
      );
      expect(created).toMatchObject({ acceptsDriftSubject: 'TRR-REQ-001', acceptsDriftCategory: 'coverage-hole' });

      const half = await post(`/api/projects/${CODE}/decisions`, {
        statement: 's',
        value: 'v',
        acceptsDriftSubject: 'TRR-REQ-001',
      });
      expect(half.status).toBe(400);
      expect(JSON.stringify(await half.json())).toContain('acceptsDriftCategory');

      const unknown = await post(`/api/projects/${CODE}/decisions`, {
        statement: 's',
        value: 'v',
        acceptsDriftSubject: 'TRR-REQ-001',
        acceptsDriftCategory: 'not-a-category',
      });
      expect(unknown.status).toBe(400);

      const edited = await patch(`/api/projects/${CODE}/decisions/${created.humanId}`, { acceptsDriftSubject: 'TRR-REQ-002' });
      expect(edited.status).toBe(400);
      expect(JSON.stringify(await edited.json())).toContain('acceptsDriftSubject');
    });

    it('reads every acceptance back by its link, keyset-paged past 200, and nothing else', async () => {
      const project = await db.project.findUniqueOrThrow({ where: { code: CODE } });
      // 230 acceptances, numbered so that ordering by human ID as text would put D-100 before D-20.
      await db.decision.createMany({
        data: Array.from({ length: 230 }, (_, i) => ({
          projectId: project.id,
          humanId: `${CODE}-D-${String(i + 100)}`,
          statement: `An acceptance ${String(i)}`,
          value: 'Accepted',
          acceptsDriftSubject: `${CODE}-T-${String(i)}`,
          acceptsDriftCategory: 'stale-task',
        })),
      });
      // A decision that only *says* it accepts drift is not one.
      await json(
        await post(`/api/projects/${CODE}/decisions`, { statement: 'Accepted drift on TRR-T-999 (stale-task)', value: 'v' }),
        201,
      );

      const subjects: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query = new URLSearchParams({ acceptsDrift: '1', limit: '200', ...(cursor === null ? {} : { cursor }) });
        const page: { items: { acceptsDriftSubject: string }[]; nextCursor: string | null; total: number } = await json(
          await api(`/api/projects/${CODE}/decisions?${query.toString()}`),
        );
        expect(page.total).toBe(231);
        subjects.push(...page.items.map((d) => d.acceptsDriftSubject));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null);

      expect(pages).toBe(2);
      expect(subjects).toHaveLength(231);
      expect(new Set(subjects).size).toBe(231);
      expect(subjects).not.toContain('TRR-T-999');

      const bad = await api(`/api/projects/${CODE}/decisions?acceptsDrift=1&cursor=bm9wZQ`);
      expect(bad.status).toBe(400);

      await db.decision.deleteMany({ where: { projectId: project.id, humanId: { startsWith: `${CODE}-D-` }, statement: { startsWith: 'An acceptance' } } });
    });

    it('drops an acceptance whose decision is undone', async () => {
      const made = await json<{ humanId: string; auditEventIds: string[] }>(
        await post(`/api/projects/${CODE}/decisions`, {
          statement: 'Accepted drift on TRR-REQ-050 (coverage-hole): x',
          value: 'v',
          acceptsDriftSubject: 'TRR-REQ-050',
          acceptsDriftCategory: 'coverage-hole',
        }),
        201,
      );
      const before = await json<{ items: { humanId: string }[] }>(await api(`/api/projects/${CODE}/decisions?acceptsDrift=1`));
      expect(before.items.map((d) => d.humanId)).toContain(made.humanId);
      await json(await post(`/api/undo/${made.auditEventIds[0] ?? ''}`, {}));
      const after = await json<{ items: { humanId: string }[] }>(await api(`/api/projects/${CODE}/decisions?acceptsDrift=1`));
      expect(after.items.map((d) => d.humanId)).not.toContain(made.humanId);
    });
  });

  describe('move-wontfix-reasons', () => {
    it('reports by default, then moves each appended reason into its column with an audited update', async () => {
      const wontFix = await newFinding('Ruled twice, the old way');
      const reopened = await newFinding('Reopened, the old way');
      const bare = await newFinding('No recommendation, the old way');
      const linked = await json<{ humanId: string }>(
        await post(`/api/projects/${CODE}/decisions`, {
          statement: 'Accepted drift on TRR-REQ-077 (coverage-hole): A Must with no task satisfying it.',
          value: 'Accepted for now — not drift to act on',
        }),
        201,
      );

      // What FRM-T-18.7's console wrote: appended, curly or straight, once per verdict.
      await db.finding.update({
        where: { humanId: wontFix.humanId },
        data: {
          status: 'wont_fix',
          recommendationMd: 'Scope the select.\n\n**Won’t fix** — first reason\n\n**Won\'t fix** — the latest reason',
        },
      });
      await db.finding.update({
        where: { humanId: reopened.humanId },
        data: { status: 'open', recommendationMd: 'Scope the select.\n\n**Won’t fix** — no longer true' },
      });
      await db.finding.update({
        where: { humanId: bare.humanId },
        data: { status: 'wont_fix', recommendationMd: '**Won’t fix** — nothing to recommend' },
      });

      const report = await cli([]);
      expect(report.stdout).toContain('3 finding(s)');
      expect(report.stdout).toContain(`${linked.humanId} -> TRR-REQ-077 (coverage-hole)`);
      expect(report.stdout).toContain('Nothing written');
      expect((await read(wontFix.humanId)).wontFixReason).toBeNull();

      const written = await cli(['--write']);
      expect(written.stdout).toContain('Written.');

      expect(await read(wontFix.humanId)).toMatchObject({
        status: 'wont_fix',
        recommendationMd: 'Scope the select.',
        wontFixReason: 'the latest reason',
      });
      expect(await read(reopened.humanId)).toMatchObject({
        status: 'open',
        recommendationMd: 'Scope the select.',
        wontFixReason: null,
      });
      expect(await read(bare.humanId)).toMatchObject({ recommendationMd: null, wontFixReason: 'nothing to recommend' });

      const decision = await db.decision.findUniqueOrThrow({ where: { humanId: linked.humanId } });
      expect(decision).toMatchObject({ acceptsDriftSubject: 'TRR-REQ-077', acceptsDriftCategory: 'coverage-hole' });

      // One audited update per record, as the system, naming the CLI — and undoable like any other.
      // By entity UUID: a human ID is reused when this suite's project is made again on the next run.
      const ids = [
        ...(await db.finding.findMany({
          where: { humanId: { in: [wontFix.humanId, reopened.humanId, bare.humanId] } },
          select: { id: true },
        })),
        decision,
      ].map((row) => row.id);
      const events = await db.auditEvent.findMany({ where: { entityId: { in: ids }, action: 'update' } });
      expect(events).toHaveLength(4);
      for (const event of events) {
        expect(event.actorKind).toBe('system');
        expect(event.actor).toContain('move-wontfix-reasons');
      }

      // Idempotent: nothing is left to move.
      const again = await cli(['--write']);
      expect(again.stdout).toContain('Nothing to do.');

      const event = events.find((e) => e.entityHumanId === wontFix.humanId);
      await json(await post(`/api/undo/${event?.id ?? ''}`, {}));
      expect((await read(wontFix.humanId)).recommendationMd).toContain('the latest reason');
    }, 60_000);
  });
});
