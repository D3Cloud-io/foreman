import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * Findings end to end (T-6.1 … T-6.9).
 *
 * The assertions the phase plan names: several line ranges in one location persist, green/red/
 * unverified each render distinctly, an un-ingested fix SHA **never** shows verified, one route
 * answers "every open Critical, all projects", and recurrence is produced with no model call.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'findings@example.com';
const PASSWORD = 'a-password-for-the-findings-tests';
const A = 'FNA';
const B = 'FNB';

describe.skipIf(url === undefined)('findings', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;

  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}/api${path}`, { ...init, headers });
  };
  const post = (path: string, body?: unknown) =>
    api(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const patch = (path: string, body: unknown) =>
    api(path, { method: 'PATCH', body: JSON.stringify(body) });
  const get = async <T>(path: string): Promise<T> => {
    const res = await api(path);
    expect(res.status, path).toBe(200);
    return (await res.json()) as T;
  };

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
    const user = await db.user.create({
      data: { email: EMAIL, displayName: 'Findings', status: 'active' },
    });
    await setPassword({ db, config }, user.id, PASSWORD);

    server = await new Promise<Server>((resolve) => {
      const s = createApp({ config, db }).listen(0, () => { resolve(s); });
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
  });

  beforeEach(async () => {
    await db.project.deleteMany({ where: { code: { in: [A, B] } } });
    await post('/projects', { code: A, name: 'Findings A' });
    await post('/projects', { code: B, name: 'Findings B' });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: { in: [A, B] } } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  interface FindingBody {
    id: string;
    humanId: string;
    severity: string;
    status: string;
    verified: string;
    locationRaw: string | null;
  }

  const makeAudit = async (code = A, kind = 'code_review') => {
    const res = await post(`/projects/${code}/audits`, { kind, scope: 'the whole project' });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; humanId: string };
  };

  const makeFinding = async (
    code: string,
    body: Record<string, unknown>,
  ): Promise<FindingBody> => {
    const res = await post(`/projects/${code}/findings`, {
      title: 'Something is wrong',
      severity: 'high',
      ...body,
    });
    expect(res.status, JSON.stringify(body)).toBe(201);
    return (await res.json()) as FindingBody;
  };

  describe('audits and findings (T-6.1, T-6.2)', () => {
    it('numbers a code review’s findings CR-nnn', async () => {
      const audit = await makeAudit();
      const finding = await makeFinding(A, { auditId: audit.id });
      expect(audit.humanId).toBe(`${A}-AUD-001`);
      expect(finding.humanId).toBe(`${A}-CR-001`);
    });

    it('numbers a design audit’s findings DA-nnn, from its own sequence', async () => {
      const review = await makeAudit(A, 'code_review');
      await makeFinding(A, { auditId: review.id });
      const design = await makeAudit(A, 'design');
      const finding = await makeFinding(A, { auditId: design.id });

      // Different prefixes, different counters: CR-001 and DA-001 coexist.
      expect(finding.humanId).toBe(`${A}-DA-001`);
    });

    it('defaults verification to unverified, which is what the corpus says', async () => {
      const finding = await makeFinding(A, {});
      // 123 of 127 real findings carry `verified: unverified`. Its absence is a state.
      expect(finding.verified).toBe('unverified');
    });

    it('stores every lens a finding was found by', async () => {
      const finding = await makeFinding(A, { lenses: ['security', 'operability'] });
      const stored = await db.finding.findFirstOrThrow({ where: { humanId: finding.humanId } });
      expect(stored.lenses).toEqual(['security', 'operability']);
    });

    it('accepts deferred, which the corpus has and the plan did not', async () => {
      const finding = await makeFinding(A, { status: 'deferred' });
      expect(finding.status).toBe('deferred');
    });
  });

  describe('locations (T-6.3, FRM-REQ-116)', () => {
    it('persists several files, each with its ranges', async () => {
      const finding = await makeFinding(A, {
        location: 'api/config.py:12-14; api/settings_store.py:70; .env.example:5,8',
      });

      const stored = await get<{ locations: { path: string; lines: string | null }[] }>(
        `/findings/${finding.humanId}`,
      );
      expect(stored.locations.map((l) => l.path)).toEqual([
        'api/config.py',
        'api/settings_store.py',
        '.env.example',
      ]);
      expect(stored.locations[2]?.lines).toBe('5,8');
    });

    it('persists several ranges within one file', async () => {
      const finding = await makeFinding(A, { location: 'api/vault/store.py:196-206,299-310' });
      const stored = await get<{ locations: { lines: string | null }[] }>(
        `/findings/${finding.humanId}`,
      );
      expect(stored.locations).toHaveLength(1);
      expect(stored.locations[0]?.lines).toBe('196-206,299-310');
    });

    it('keeps the raw string beside the parse', async () => {
      const raw = 'api/main.py (no startup check in lifespan)';
      const finding = await makeFinding(A, { location: raw });
      // The authored text says things no parse holds, and it is what a person reads.
      expect(finding.locationRaw).toBe(raw);

      const stored = await get<{ locations: { note: string | null }[] }>(
        `/findings/${finding.humanId}`,
      );
      expect(stored.locations[0]?.note).toBe('no startup check in lifespan');
    });

    it('replaces the locations when the location is edited', async () => {
      const finding = await makeFinding(A, { location: 'a/one.py:1' });
      await patch(`/projects/${A}/findings/${finding.humanId}`, { location: 'b/two.py:2' });

      const stored = await get<{ locations: { path: string }[] }>(`/findings/${finding.humanId}`);
      // Replaced, not appended: an edited location that kept the old file would point at both.
      expect(stored.locations.map((l) => l.path)).toEqual(['b/two.py']);
    });
  });

  describe('the fix verdict (T-6.4, T-6.5, FRM-REQ-118, FRM-REQ-119)', () => {
    const withRepo = async (code: string) => {
      const project = await db.project.findFirstOrThrow({ where: { code } });
      return db.repo.create({
        data: { projectId: project.id, fullName: `matdemers1/${code.toLowerCase()}` },
      });
    };

    const ingest = async (repoId: string, sha: string, checks: (string | null)[]) => {
      await db.commit.create({
        data: { repoId, sha, message: 'The fix', author: 'matt', committedAt: new Date() },
      });
      for (const [index, conclusion] of checks.entries()) {
        await db.checkRun.create({
          data: {
            repoId,
            commitSha: sha,
            name: `check-${String(index)}`,
            ...(conclusion === null
              ? {}
              : { conclusion: conclusion as 'success', completedAt: new Date() }),
          },
        });
      }
    };

    it('says none when no fix is recorded', async () => {
      const finding = await makeFinding(A, {});
      const stored = await get<{ fix: { verdict: string } }>(`/findings/${finding.humanId}`);
      expect(stored.fix.verdict).toBe('none');
    });

    it('reports an un-ingested fix commit as unverified, never green', async () => {
      const finding = await makeFinding(A, {});
      await patch(`/projects/${A}/findings/${finding.humanId}`, {
        status: 'fixed',
        fixedCommitSha: 'deadbee',
      });

      const stored = await get<{ fix: { verdict: string; ingested: boolean; detail: string } }>(
        `/findings/${finding.humanId}`,
      );
      // The requirement the phase plan singles out. The only thing worse than not knowing whether
      // a fix was tested is believing it was.
      expect(stored.fix.verdict).toBe('unverified');
      expect(stored.fix.ingested).toBe(false);
      expect(stored.fix.detail).toContain('not been ingested');
    });

    it('reports an ingested commit with no checks as unverified too', async () => {
      const repo = await withRepo(A);
      await ingest(repo.id, 'a'.repeat(40), []);
      const finding = await makeFinding(A, {});
      await patch(`/projects/${A}/findings/${finding.humanId}`, { fixedCommitSha: 'a'.repeat(7) });

      const stored = await get<{ fix: { verdict: string; ingested: boolean } }>(
        `/findings/${finding.humanId}`,
      );
      // Ingested is not the same as tested.
      expect(stored.fix.ingested).toBe(true);
      expect(stored.fix.verdict).toBe('unverified');
    });

    it('reports green when every check passed on the fix commit', async () => {
      const repo = await withRepo(A);
      await ingest(repo.id, 'b'.repeat(40), ['success', 'skipped']);
      const finding = await makeFinding(A, {});
      await patch(`/projects/${A}/findings/${finding.humanId}`, { fixedCommitSha: 'b'.repeat(12) });

      const stored = await get<{ fix: { verdict: string; detail: string } }>(
        `/findings/${finding.humanId}`,
      );
      expect(stored.fix.verdict).toBe('green');
      expect(stored.fix.detail).toContain('passed');
    });

    it('reports red, and names the check that failed', async () => {
      const repo = await withRepo(A);
      await ingest(repo.id, 'c'.repeat(40), ['success', 'failure']);
      const finding = await makeFinding(A, {});
      await patch(`/projects/${A}/findings/${finding.humanId}`, { fixedCommitSha: 'c'.repeat(12) });

      const stored = await get<{ fix: { verdict: string; detail: string } }>(
        `/findings/${finding.humanId}`,
      );
      expect(stored.fix.verdict).toBe('red');
      expect(stored.fix.detail).toContain('check-1');
    });

    it('reports running while a check has no conclusion yet', async () => {
      const repo = await withRepo(A);
      await ingest(repo.id, 'd'.repeat(40), ['success', null]);
      const finding = await makeFinding(A, {});
      await patch(`/projects/${A}/findings/${finding.humanId}`, { fixedCommitSha: 'd'.repeat(12) });

      const stored = await get<{ fix: { verdict: string } }>(`/findings/${finding.humanId}`);
      // Not green: a check still running has not passed.
      expect(stored.fix.verdict).toBe('running');
    });

    it('does not match a fix commit from another project', async () => {
      const repo = await withRepo(B);
      await ingest(repo.id, 'e'.repeat(40), ['success']);
      const finding = await makeFinding(A, {});
      await patch(`/projects/${A}/findings/${finding.humanId}`, { fixedCommitSha: 'e'.repeat(12) });

      const stored = await get<{ fix: { verdict: string } }>(`/findings/${finding.humanId}`);
      // A SHA prefix colliding across repositories must not make one project's CI answer for
      // another's fix.
      expect(stored.fix.verdict).toBe('unverified');
    });
  });

  describe('the cross-project inbox (T-6.6, FRM-REQ-120)', () => {
    it('ranks every open finding by severity, across projects', async () => {
      await makeFinding(A, { title: 'A medium in A', severity: 'medium' });
      await makeFinding(B, { title: 'A critical in B', severity: 'critical' });
      await makeFinding(A, { title: 'A high in A', severity: 'high' });

      const listed = await get<{ items: { project: string; severity: string }[] }>('/findings');
      const mine = listed.items.filter((f) => f.project === A || f.project === B);
      // Ranked by severity first — which is what makes it a triage queue rather than a list.
      expect(mine.map((f) => f.severity)).toEqual(['critical', 'high', 'medium']);
      expect(mine[0]?.project).toBe(B);
    });

    it('shows only open findings unless asked otherwise', async () => {
      const fixed = await makeFinding(A, { title: 'Already dealt with' });
      await patch(`/projects/${A}/findings/${fixed.humanId}`, { status: 'fixed' });
      await makeFinding(A, { title: 'Still outstanding' });

      const listed = await get<{ items: { humanId: string }[] }>('/findings');
      const mine = listed.items.filter((f) => f.humanId.startsWith(A));
      // An inbox showing everything ever found is an archive.
      expect(mine).toHaveLength(1);
      expect(mine[0]?.humanId).not.toBe(fixed.humanId);
    });

    it('narrows to one lens, across every project', async () => {
      await makeFinding(A, { title: 'Modal has no dialog role', lenses: ['accessibility'] });
      await makeFinding(B, { title: 'Contrast is too low', lenses: ['accessibility'] });
      await makeFinding(A, { title: 'A slow query', lenses: ['performance'] });

      const listed = await get<{ items: { title: string }[] }>('/findings?lens=accessibility');
      const mine = listed.items.filter((f) => /Modal|Contrast|slow/.test(f.title));
      expect(mine).toHaveLength(2);
    });

    it('narrows to one severity, which is the question actually asked', async () => {
      await makeFinding(A, { title: 'The worst one', severity: 'critical' });
      await makeFinding(B, { title: 'A lesser one', severity: 'low' });

      const listed = await get<{ items: { severity: string }[] }>('/findings?severity=critical');
      expect(listed.items.every((f) => f.severity === 'critical')).toBe(true);
    });

    it('counts the whole matching set in total, however small the page (FRM-REQ-242)', async () => {
      await makeFinding(A, { title: 'First critical', severity: 'critical' });
      await makeFinding(A, { title: 'Second critical', severity: 'critical' });
      await makeFinding(B, { title: 'Third critical', severity: 'critical' });
      await makeFinding(B, { title: 'Not a critical', severity: 'low' });

      // The page is one row; the total is the set the page was cut from. The sidebar badge reads
      // exactly this, so it must not be the number of rows returned.
      const page = await get<{ items: unknown[]; nextCursor: null; total: number }>(
        `/findings?severity=critical&status=open&project=${A}&limit=1`,
      );
      expect(page.items).toHaveLength(1);
      expect(page.total).toBe(2);
      expect(page.nextCursor).toBeNull();

      const both = await get<{ items: unknown[]; total: number }>(
        '/findings?severity=critical&status=open&limit=1',
      );
      expect(both.items).toHaveLength(1);
      // Other tests' projects may share the database, so the floor is ours.
      expect(both.total).toBeGreaterThanOrEqual(3);

      // Unfiltered by severity, the same project still counts its whole open set.
      const open = await get<{ total: number }>(`/findings?project=${B}&limit=1`);
      expect(open.total).toBe(2);
    });

    it('totals and counts under the lens and status filters, over the whole set', async () => {
      await makeFinding(A, { title: 'Contrast', severity: 'critical', lenses: ['accessibility'] });
      await makeFinding(A, { title: 'Focus order', severity: 'high', lenses: ['accessibility'] });
      await makeFinding(A, { title: 'Labels', severity: 'high', lenses: ['accessibility'] });
      await makeFinding(A, { title: 'Slow query', severity: 'low', lenses: ['performance'] });
      const done = await makeFinding(A, { title: 'Fixed a11y', severity: 'high', lenses: ['accessibility'] });
      await patch(`/projects/${A}/findings/${done.humanId}`, { status: 'fixed' });

      type Counted = {
        items: unknown[];
        total: number;
        counts: Record<'critical' | 'high' | 'medium' | 'low', number>;
      };
      const lens = await get<Counted>(`/findings?project=${A}&lens=accessibility&limit=1`);
      expect(lens.items).toHaveLength(1);
      expect(lens.total).toBe(3);
      expect(lens.counts).toEqual({ critical: 1, high: 2, medium: 0, low: 0 });

      // A severity filter narrows the total and the page, never the counts the chips show.
      const high = await get<Counted>(`/findings?project=${A}&lens=accessibility&severity=high&limit=1`);
      expect(high.total).toBe(2);
      expect(high.counts).toEqual({ critical: 1, high: 2, medium: 0, low: 0 });

      const fixed = await get<Counted>(`/findings?project=${A}&status=fixed&limit=1`);
      expect(fixed.total).toBe(1);
      expect(fixed.counts).toEqual({ critical: 0, high: 1, medium: 0, low: 0 });

      const open = await get<Counted>(`/findings?project=${A}&limit=1`);
      expect(open.total).toBe(4);
      expect(open.counts).toEqual({ critical: 1, high: 2, medium: 0, low: 1 });
    });
  });

  describe('recurrence (T-6.7, FRM-REQ-121, FRM-REQ-122)', () => {
    it('proposes the same shape of problem in another project', async () => {
      // The motivating real case, in miniature.
      const source = await makeFinding(A, {
        title: 'Five modal overlays have no dialog semantics',
        lenses: ['accessibility'],
        observedMd: 'Each overlay is a plain div with no role, no focus trap and no labelled title.',
        location: 'web/src/features/edit/EditPanel.tsx:353',
      });
      await makeFinding(B, {
        title: 'The confirmation overlay has no dialog role or focus trap',
        lenses: ['accessibility'],
        observedMd: 'The overlay div takes no role and traps no focus, so a screen reader walks past it.',
        location: 'web/src/features/settings/Confirm.tsx:88',
      });
      await makeFinding(B, {
        title: 'A database query runs once per row',
        lenses: ['performance'],
        observedMd: 'The loop issues a select for every row returned by the outer query.',
      });

      const result = await get<{
        candidates: {
          humanId: string;
          project: string;
          title: string;
          score: number;
          because: { lenses: string[]; words: string[] };
        }[];
        method: string;
      }>(`/findings/${source.humanId}/recurrences`);

      expect(result.candidates.length).toBeGreaterThan(0);
      const top = result.candidates[0];
      expect(top?.project).toBe(B);
      expect(top?.title ?? '').toContain('dialog role');
      // The evidence travels with the proposal: a score nobody can check is a score nobody trusts.
      expect(top?.because.lenses).toContain('accessibility');
      expect(top?.because.words.length).toBeGreaterThan(0);
    });

    it('says in its answer that no model was called', async () => {
      const source = await makeFinding(A, { title: 'Anything at all' });
      const result = await get<{ method: string }>(`/findings/${source.humanId}/recurrences`);
      // Whoever reads this is being handed something to judge; they should know nothing judged it
      // first (FRM-REQ-122).
      expect(result.method).toContain('no model was called');
    });

    it('never proposes a finding from the same project', async () => {
      const source = await makeFinding(A, {
        title: 'Modal overlays have no dialog semantics',
        lenses: ['accessibility'],
      });
      await makeFinding(A, {
        title: 'Modal overlays have no dialog semantics either',
        lenses: ['accessibility'],
      });

      const result = await get<{ candidates: { project: string }[] }>(
        `/findings/${source.humanId}/recurrences`,
      );
      // Same-project recurrence is a duplicate — a different problem, and not this one.
      expect(result.candidates.every((c) => c.project !== A)).toBe(true);
    });

    it('proposes nothing for two findings that merely share English', async () => {
      const source = await makeFinding(A, {
        title: 'The backup job stops silently when the disk fills',
        lenses: ['operability'],
        observedMd: 'The writer swallows ENOSPC and the ledger records success.',
      });
      await makeFinding(B, {
        title: 'Colour contrast on the secondary button is 3.1 to 1',
        lenses: ['accessibility'],
        observedMd: 'The token pair fails WCAG AA at small sizes.',
      });

      const result = await get<{ candidates: unknown[] }>(`/findings/${source.humanId}/recurrences`);
      // A recommender that proposes everything is one nobody opens twice.
      expect(result.candidates).toHaveLength(0);
    });
  });

  describe('the regression watch (T-6.8, FRM-REQ-123)', () => {
    it('flags a fixed finding whose file changed afterwards', async () => {
      const project = await db.project.findFirstOrThrow({ where: { code: A } });
      const repo = await db.repo.create({
        data: { projectId: project.id, fullName: 'matdemers1/fna' },
      });

      const fixedAt = new Date(Date.now() - 2 * 86_400_000);
      await db.commit.create({
        data: { repoId: repo.id, sha: 'f'.repeat(40), message: 'The fix', author: 'matt', committedAt: fixedAt },
      });

      const finding = await makeFinding(A, { location: 'api/vault/store.py:196-206' });
      await patch(`/projects/${A}/findings/${finding.humanId}`, {
        status: 'fixed',
        fixedCommitSha: 'f'.repeat(12),
      });

      // Nothing has touched the file since — no flag.
      expect((await get<{ items: unknown[] }>('/regression-watch')).items).toHaveLength(0);

      // A later commit touches the very file the finding pointed at.
      await db.commit.create({
        data: {
          repoId: repo.id,
          sha: '9'.repeat(40),
          message: 'Refactor the store',
          author: 'matt',
          committedAt: new Date(),
          files: { create: [{ path: 'api/vault/store.py', status: 'modified' }] },
        },
      });

      const flagged = await get<{ items: { humanId: string; path: string; changedBy: { message: string }[] }[] }>(
        '/regression-watch',
      );
      expect(flagged.items).toHaveLength(1);
      expect(flagged.items[0]?.humanId).toBe(finding.humanId);
      // Named, with what changed it: a flag nobody can act on is noise.
      expect(flagged.items[0]?.changedBy[0]?.message).toContain('Refactor');
    });

    it('does not flag a fix whose commit was never ingested', async () => {
      const finding = await makeFinding(A, { location: 'api/thing.py:1' });
      await patch(`/projects/${A}/findings/${finding.humanId}`, {
        status: 'fixed',
        fixedCommitSha: 'beefbee',
      });

      // Nothing to compare against. Guessing would flag every fix in the corpus.
      expect((await get<{ items: unknown[] }>('/regression-watch')).items).toHaveLength(0);
    });
  });

  describe('relations (T-6.9, FRM-REQ-124)', () => {
    it('relates a finding to the ADR it contradicts', async () => {
      const adr = await post(`/projects/${A}/adrs`, { title: 'Everything is fine' });
      const { humanId: adrId } = (await adr.json()) as { humanId: string };

      const finding = await makeFinding(A, { adr: adrId });
      const stored = await get<{ adr: { humanId: string } | null }>(`/findings/${finding.humanId}`);
      expect(stored.adr?.humanId).toBe(adrId);
    });

    it('refuses an ADR that does not exist rather than storing a dangling id', async () => {
      const res = await post(`/projects/${A}/findings`, {
        title: 'Cites nothing real',
        severity: 'low',
        adr: `${A}-ADR-999`,
      });
      expect(res.status).toBe(404);
    });

    it('turns a human ID in the observation into a backlink', async () => {
      const requirement = await post(`/projects/${A}/requirements`, {
        statement: 'Foreman shall be cited by a finding.',
      });
      const { humanId } = (await requirement.json()) as { humanId: string };

      await makeFinding(A, { observedMd: `This contradicts ${humanId} directly.` });

      const entity = await get<{ backlinks: { kind: string }[] }>(`/entities/${humanId}`);
      expect(entity.backlinks).toHaveLength(1);
      expect(entity.backlinks[0]?.kind).toBe('cites');
    });
  });
});
