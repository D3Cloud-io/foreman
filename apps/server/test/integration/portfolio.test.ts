import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { approximateTokens } from '../../src/domain/brief.js';
import type { PortfolioRow } from '../../src/domain/portfolio.js';
import type { SearchHit } from '../../src/domain/search.js';

/**
 * The portfolio and typed search (T-1.8) — "where is everything", and "where is that thing I
 * remember".
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'portfolio@example.com';
const PASSWORD = 'a-password-for-the-portfolio-tests';
/**
 * What one project may cost in `foreman_portfolio`'s answer, in the brief's own approximation
 * (characters / 4). Measured at ~145 with the ledger fields; the ceiling leaves room for a field but
 * not for a second copy of anything. The guidelines list is shared, so it sits in the average too.
 */
const PORTFOLIO_TOKENS_PER_PROJECT = 200;
const CODES = ['PFA', 'PFB', 'PFC', 'PFD', 'PFE'];

describe.skipIf(url === undefined)('portfolio and search', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;

  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${origin}/api${path}`, { headers: { cookie } });
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

    await db.project.deleteMany({ where: { code: { in: CODES } } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    const user = await db.user.create({
      data: { email: EMAIL, displayName: 'Portfolio', status: 'active' },
    });
    await setPassword({ db, config }, user.id, PASSWORD);

    // PFA: mid-flight, with an active phase, a critical, CI, and a coverage hole.
    const a = await db.project.create({
      data: { code: 'PFA', name: 'Alpha', slug: 'alpha', lifecycle: 'building' },
    });
    const phase = await db.phase.create({
      data: {
        projectId: a.id,
        humanId: 'PFA-P-2',
        number: 2,
        sortOrder: 2,
        name: 'Ingest',
        status: 'active',
        objective: 'Take GitHub reality in through a webhook.',
      },
    });
    await db.task.createMany({
      data: [
        { projectId: a.id, phaseId: phase.id, humanId: 'PFA-T-2.1', title: 'Receive the webhook', status: 'done' },
        { projectId: a.id, phaseId: phase.id, humanId: 'PFA-T-2.2', title: 'Verify the HMAC signature', status: 'todo' },
        {
          projectId: a.id,
          phaseId: phase.id,
          humanId: 'PFA-T-2.3',
          title: 'Backfill old commits',
          status: 'blocked',
          blockedReason: 'The App is not installed on the repo yet.',
        },
      ],
    });
    await db.requirement.createMany({
      data: [
        { projectId: a.id, humanId: 'PFA-REQ-001', seq: 1, statement: 'Foreman shall verify the HMAC signature of every webhook.' },
        { projectId: a.id, humanId: 'PFA-REQ-002', seq: 2, statement: 'Foreman shall use pg_trgm for fuzzy matching.' },
      ],
    });
    await db.finding.create({
      data: {
        projectId: a.id,
        humanId: 'PFA-CR-001',
        title: 'The webhook accepts an unsigned payload',
        severity: 'critical',
        status: 'open',
        observedMd: 'A request with no signature header is processed as though it were signed.',
      },
    });
    await db.adr.create({
      data: {
        projectId: a.id,
        humanId: 'PFA-ADR-001',
        number: 1,
        title: 'Search uses pg_trgm rather than a search engine',
        status: 'accepted',
        decisionAbstract: 'Trigram indexes in the database we already run, not a second service.',
      },
    });
    const repo = await db.repo.create({ data: { projectId: a.id, fullName: 'test/alpha' } });
    await db.checkRun.create({
      data: {
        repoId: repo.id,
        commitSha: 'a'.repeat(40),
        name: 'ci',
        conclusion: 'failure',
        completedAt: new Date(),
      },
    });
    await db.commit.create({
      data: {
        repoId: repo.id,
        sha: 'b'.repeat(40),
        message: 'Verify the signature',
        author: 'tester',
        committedAt: new Date(),
      },
    });

    // Main has moved one commit past the one that shipped (FRM-T-18.6).
    await db.commit.create({
      data: {
        repoId: repo.id,
        sha: 'c'.repeat(40),
        message: 'Refuse the unsigned payload',
        author: 'tester',
        committedAt: new Date(Date.now() + 3_600_000),
      },
    });
    await db.deployment.create({
      data: {
        projectId: a.id,
        environment: 'production',
        image: 'ghcr.io/test/alpha',
        imageSha: 'b'.repeat(7),
        deployedAt: new Date(),
      },
    });

    // PFB: planned, and nothing has ever been ingested for it.
    await db.project.create({
      data: { code: 'PFB', name: 'Beta', slug: 'beta', lifecycle: 'planned' },
    });

    // PFC: phases, none of them marked `active`. This is not a corner case — it is the state
    // every one of the nine projects imported at the cutover is in, because the importer does not
    // set a phase status. The portfolio read `status: 'active'` and nothing else, so it answered
    // `null` for all of them while the brief beside it named a phase.
    const c = await db.project.create({
      data: { code: 'PFC', name: 'Gamma', slug: 'gamma', lifecycle: 'building' },
    });
    const early = await db.phase.create({
      data: { projectId: c.id, humanId: 'PFC-P-1', number: 1, sortOrder: 1, name: 'Early', status: 'planned' },
    });
    const late = await db.phase.create({
      data: { projectId: c.id, humanId: 'PFC-P-4', number: 4, sortOrder: 4, name: 'Late', status: 'planned' },
    });
    await db.task.createMany({
      data: [
        // A straggler in an early phase, and real progress in a later one. "Furthest along" is
        // the point: a project with two unfinished tasks in Phase 1 and progress in Phase 4 is
        // not at Phase 1.
        { projectId: c.id, phaseId: early.id, humanId: 'PFC-T-1.1', title: 'Straggler', status: 'todo' },
        { projectId: c.id, phaseId: late.id, humanId: 'PFC-T-4.1', title: 'Landed', status: 'done' },
        { projectId: c.id, phaseId: late.id, humanId: 'PFC-T-4.2', title: 'Next', status: 'todo' },
      ],
    });

    // A deploy of a SHA Foreman never saw a commit for: how far main is ahead is unknown, not zero.
    await db.deployment.create({
      data: {
        projectId: c.id,
        environment: 'production',
        image: 'ghcr.io/test/gamma',
        imageSha: 'sha-' + 'e'.repeat(40),
        deployedAt: new Date(),
      },
    });

    // PFD: how far is "ahead" measured, and in what. Two live repos and one soft-deleted; the shipped
    // commit is in the first. Production was deployed an hour ago; staging, newer, ships another SHA.
    const shipped = new Date('2026-01-01T10:00:00.000Z');
    const at = (seconds: number) => new Date(shipped.getTime() + seconds * 1000);
    const d = await db.project.create({
      data: { code: 'PFD', name: 'Delta', slug: 'delta', lifecycle: 'deployed' },
    });
    const [main, other, gone] = await Promise.all(
      ['main', 'other', 'gone'].map((suffix) =>
        db.repo.create({
          data: {
            projectId: d.id,
            fullName: `test/delta-${suffix}`,
            ...(suffix === 'gone' ? { deletedAt: new Date() } : {}),
          },
        }),
      ),
    );
    if (main === undefined || other === undefined || gone === undefined) throw new Error('repos');
    const commit = (repoId: string, sha: string, when: Date) =>
      db.commit.create({ data: { repoId, sha, message: sha, author: 'tester', committedAt: when } });
    await commit(main.id, '1'.repeat(40), at(-60)); // older than what shipped: not ahead
    await commit(main.id, '2'.repeat(40), shipped); // the shipped commit
    await commit(main.id, '3'.repeat(40), shipped); // same second: may be after it, so it counts
    await commit(main.id, '4'.repeat(40), at(30));
    await commit(main.id, '5'.repeat(40), at(90));
    for (const n of ['6', '7', '8', '9']) await commit(other.id, n.repeat(40), at(300)); // another repo's
    await commit(gone.id, 'a'.repeat(40), at(600)); // a deleted repo's
    await commit(gone.id, 'b'.repeat(40), at(601));
    await db.deployment.create({
      data: {
        projectId: d.id,
        environment: 'production',
        image: 'ghcr.io/test/delta',
        imageSha: '2'.repeat(40),
        deployedAt: new Date(Date.now() - 3_600_000),
      },
    });
    await db.deployment.create({
      data: {
        projectId: d.id,
        environment: 'staging',
        image: 'ghcr.io/test/delta',
        imageSha: '5'.repeat(40), // newer, and in a later commit than production's
        deployedAt: new Date(),
      },
    });

    // PFE: no production deployment at all, so the newest of whatever it has stands in; and a
    // SHA that only a soft-deleted repo holds is not a commit Foreman can place.
    const e = await db.project.create({
      data: { code: 'PFE', name: 'Epsilon', slug: 'epsilon', lifecycle: 'deployed' },
    });
    const liveRepo = await db.repo.create({ data: { projectId: e.id, fullName: 'test/epsilon-live' } });
    const goneRepo = await db.repo.create({
      data: { projectId: e.id, fullName: 'test/epsilon-gone', deletedAt: new Date() },
    });
    await commit(liveRepo.id, 'c'.repeat(40), at(0));
    await commit(goneRepo.id, 'd'.repeat(40), at(0));
    await db.deployment.create({
      data: {
        projectId: e.id,
        environment: 'staging',
        image: 'ghcr.io/test/epsilon',
        imageSha: 'd'.repeat(40),
        deployedAt: new Date(Date.now() - 7_200_000),
      },
    });
    await db.deployment.create({
      data: {
        projectId: e.id,
        environment: 'preview',
        image: 'ghcr.io/test/epsilon',
        imageSha: 'c'.repeat(40),
        deployedAt: new Date(),
      },
    });

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

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: { in: CODES } } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  describe('the portfolio (FRM-REQ-133)', () => {
    it('populates every column for a project mid-flight', async () => {
      const { items } = await get<{ items: PortfolioRow[] }>('/portfolio');
      const alpha = items.find((row) => row.code === 'PFA');

      expect(alpha?.lifecycle).toBe('building');
      expect(alpha?.phase?.humanId).toBe('PFA-P-2');
      expect(alpha?.tasks).toEqual({ open: 1, blocked: 1, done: 1, cancelled: 0 });
      expect(alpha?.openCriticals).toBe(1);
      expect(alpha?.ci).toEqual({ conclusion: 'failure', unknown: false });
      // The badge's breakdown is the drift screen's, part for part, and sums to the badge.
      const screen = await get<{ counts: Record<string, number>; total: number }>(
        '/projects/PFA/drift',
      );
      expect(alpha?.drift).toEqual({ counts: screen.counts, total: screen.total });
      expect(alpha?.drift.counts['coverage-hole']).toBeGreaterThanOrEqual(2);
      expect(Object.values(alpha?.drift.counts ?? {}).reduce((a, b) => a + b, 0)).toBe(
        alpha?.drift.total,
      );
      expect(alpha?.lastActivityAt).not.toBeNull();
    });

    it('says CI is unknown rather than green for a project nothing was ingested for', async () => {
      const { items } = await get<{ items: PortfolioRow[] }>('/portfolio');
      const beta = items.find((row) => row.code === 'PFB');

      // The distinction the whole column exists for: grey is not green.
      expect(beta?.ci).toEqual({ conclusion: null, unknown: true });
      expect(beta?.phase).toBeNull();
      expect(beta?.lastActivityAt).toBeNull();
      // And a count of zero is still a count, not an absence.
      expect(beta?.tasks).toEqual({ open: 0, blocked: 0, done: 0, cancelled: 0 });
    });

    it('names the phase in flight even when none is marked active', async () => {
      // The state every imported project is in. `status: 'active'` alone answered `null` here.
      const { items } = await get<{ items: PortfolioRow[] }>('/portfolio');
      expect(items.find((row) => row.code === 'PFC')?.phase?.humanId).toBe('PFC-P-4');
    });

    it('agrees with the brief about which phase that is', async () => {
      // One question, one answer. Phase 7 learned this for drift — one engine, three surfaces,
      // and a test asserting they agree — and the same discipline belongs here: the fix that
      // taught the brief to find the furthest-along phase never reached the portfolio beside it.
      const { items } = await get<{ items: PortfolioRow[] }>('/portfolio');
      for (const code of CODES) {
        const brief = await get<{ activePhase: { humanId: string } | null }>(`/brief/${code}`);
        const row = items.find((item) => item.code === code);
        expect(row?.phase?.humanId ?? null, code).toBe(brief.activePhase?.humanId ?? null);
      }
    });
  });

  describe('the ledger columns (FRM-REQ-245, FRM-T-18.6)', () => {
    it('names the next task, the CI word and the deploy state on every row', async () => {
      const { items } = await get<{ items: PortfolioRow[] }>('/portfolio');
      const by = (code: string) => items.find((row) => row.code === code);

      expect(by('PFA')?.nextTask).toEqual({ humanId: 'PFA-T-2.2', title: 'Verify the HMAC signature' });
      expect(by('PFA')?.ciState).toBe('failing');
      // Never reported is its own word: not passing, not failing.
      expect(by('PFB')?.ciState).toBe('never');
      expect(by('PFB')?.nextTask).toBeNull();
      expect(by('PFB')?.deployed).toBeNull();
      expect(by('PFC')?.nextTask?.humanId).toBe('PFC-T-4.2');
    });

    it('counts the commits on main since the deployed SHA, and says unknown when it is not a commit', async () => {
      const { items } = await get<{ items: PortfolioRow[] }>('/portfolio');
      const alpha = items.find((row) => row.code === 'PFA')?.deployed;
      expect(alpha?.sha).toBe('b'.repeat(7));
      expect(alpha?.ahead).toBe(1);
      expect(typeof alpha?.at).toBe('string');
      // Unknown is not zero: nothing says the project is up to date.
      expect(items.find((row) => row.code === 'PFC')?.deployed?.ahead).toBeNull();
    });

    it('measures ahead within the repo that holds the shipped commit, from live repos, in commit order', async () => {
      const { items } = await get<{ items: PortfolioRow[] }>('/portfolio');
      const delta = items.find((row) => row.code === 'PFD')?.deployed;
      // Production's SHA, not the newer staging one's.
      expect(delta?.sha).toBe('2'.repeat(40));
      // In the shipped commit's repo only: the same-second commit, +30s and +90s. Not the older one,
      // not the four in the other repo, not the two in the deleted repo.
      expect(delta?.ahead).toBe(3);
    });

    it('falls back to the newest deployment when there is no production one, and never places a SHA in a deleted repo', async () => {
      const { items } = await get<{ items: PortfolioRow[] }>('/portfolio');
      const epsilon = items.find((row) => row.code === 'PFE')?.deployed;
      // The preview deploy is the newest; its commit is in the live repo, and nothing is after it.
      expect(epsilon?.sha).toBe('c'.repeat(40));
      expect(epsilon?.ahead).toBe(0);
    });

    it('says CI is "other", not passing, for a run that neither passed nor failed', async () => {
      const repo = await db.repo.findFirstOrThrow({ where: { fullName: 'test/epsilon-live' } });
      await db.checkRun.create({
        data: { repoId: repo.id, commitSha: 'c'.repeat(40), name: 'ci', conclusion: 'cancelled', completedAt: new Date() },
      });
      const { items } = await get<{ items: PortfolioRow[] }>('/portfolio');
      const epsilon = items.find((row) => row.code === 'PFE');
      expect(epsilon?.ciState).toBe('other');
      expect(epsilon?.ci).toEqual({ conclusion: 'cancelled', unknown: false });
    });

    it('keeps foreman_portfolio inside a stated size per project', async () => {
      // `foreman_portfolio` returns this answer without `items` (packages/mcp/src/tools). A row grew by
      // three fields in FRM-T-18.6, and the answer is read in every session, so its cost per project
      // is pinned: a field added later has to fit, or say why it does not.
      const answer = await get<Record<string, unknown> & { items: PortfolioRow[] }>('/portfolio');
      const { items, ...mcp } = answer;
      const perProject = approximateTokens(mcp) / Math.max(items.length, 1);
      expect(perProject).toBeLessThan(PORTFOLIO_TOKENS_PER_PROJECT);
    });

    it('agrees with the brief about what is next, and never names a blocked task', async () => {
      const { items } = await get<{ items: PortfolioRow[] }>('/portfolio');
      for (const code of CODES) {
        const brief = await get<{ nextTasks: { humanId: string; title: string }[] }>(`/brief/${code}`);
        const row = items.find((item) => item.code === code);
        expect(row?.nextTask?.humanId ?? null, code).toBe(brief.nextTasks[0]?.humanId ?? null);
        expect(row?.nextTask?.humanId).not.toBe('PFA-T-2.3');
      }
    });

    it('carries the new fields in the grouped sections too, one answer however it is read', async () => {
      const grouped = await get<{
        items: PortfolioRow[];
        groups: { projects: PortfolioRow[] }[];
        ungrouped: { projects: PortfolioRow[] } | null;
      }>('/portfolio');
      const sectioned = [...grouped.groups.flatMap((g) => g.projects), ...(grouped.ungrouped?.projects ?? [])];
      for (const row of sectioned) {
        expect(row.ciState).toBe(grouped.items.find((item) => item.code === row.code)?.ciState);
        expect(row.nextTask).toEqual(grouped.items.find((item) => item.code === row.code)?.nextTask);
      }
    });
  });

  describe('typed search (FRM-REQ-085)', () => {
    it('labels every hit with what it is', async () => {
      const { items } = await get<{ items: SearchHit[] }>('/search?q=pg_trgm');
      const types = new Set(items.map((hit) => hit.type));

      // The same term, in a requirement and in the ADR that chose it — each labelled.
      expect(types.has('requirement')).toBe(true);
      expect(types.has('adr')).toBe(true);
      for (const hit of items) expect(hit.projectCode).toBe('PFA');
    });

    it('resolves a pasted human ID to exactly that thing, first', async () => {
      const { items } = await get<{ items: SearchHit[] }>('/search?q=PFA-REQ-001');
      expect(items[0]?.type).toBe('requirement');
      expect(items[0]?.humanId).toBe('PFA-REQ-001');
    });

    it('finds a finding by what was observed, not only by its title', async () => {
      const { items } = await get<{ items: SearchHit[] }>('/search?q=unsigned');
      const finding = items.find((hit) => hit.type === 'finding');
      expect(finding?.humanId).toBe('PFA-CR-001');
      expect(finding?.snippet).toContain('signature');
    });

    it('narrows by type', async () => {
      const { items } = await get<{ items: SearchHit[] }>('/search?q=signature&types=task');
      expect(items.length).toBeGreaterThan(0);
      for (const hit of items) expect(hit.type).toBe('task');
    });

    it('narrows by project', async () => {
      const { items } = await get<{ items: SearchHit[] }>('/search?q=webhook&project=PFB');
      expect(items).toEqual([]);
    });

    it('returns nothing for an empty query rather than everything', async () => {
      const res = await fetch(`${origin}/api/search?q=`, { headers: { cookie } });
      expect(res.status).toBe(400);
    });

    it('bounds the result set', async () => {
      const res = await fetch(`${origin}/api/search?q=the&limit=1000`, { headers: { cookie } });
      expect(res.status).toBe(400);
    });

    it('requires authentication', async () => {
      expect((await fetch(`${origin}/api/search?q=anything`)).status).toBe(401);
      expect((await fetch(`${origin}/api/portfolio`)).status).toBe(401);
    });
  });

  describe('get by human ID', () => {
    it('resolves a requirement, with what cites it', async () => {
      const requirement = await db.requirement.findFirstOrThrow({
        where: { humanId: 'PFA-REQ-001' },
      });
      const task = await db.task.findFirstOrThrow({ where: { humanId: 'PFA-T-2.2' } });
      await db.reference.upsert({
        where: {
          fromType_fromId_toType_toId_kind: {
            fromType: 'task',
            fromId: task.id,
            toType: 'requirement',
            toId: requirement.id,
            kind: 'satisfies',
          },
        },
        create: {
          fromType: 'task',
          fromId: task.id,
          toType: 'requirement',
          toId: requirement.id,
          kind: 'satisfies',
          citedAs: 'PFA-REQ-001',
        },
        update: {},
      });

      const result = await get<{
        type: string;
        projectCode: string;
        backlinks: { humanId: string; kind: string }[];
      }>('/entities/PFA-REQ-001');

      expect(result.type).toBe('requirement');
      expect(result.projectCode).toBe('PFA');
      expect(result.backlinks[0]?.humanId).toBe('PFA-T-2.2');
      expect(result.backlinks[0]?.kind).toBe('satisfies');
    });

    it('says why an unprefixed ID cannot resolve, rather than just "not found"', async () => {
      const res = await fetch(`${origin}/api/entities/REQ-001`, { headers: { cookie } });
      expect(res.status).toBe(404);
      // The ADR-008 argument, delivered where it is useful: the message shows the shapes that do
      // resolve rather than only saying this one did not.
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain('BND-REQ-021');
      // `PI-007` is in there too — a project idea is the one ID with no code, and a message that
      // said "project-prefixed" would now be telling half the truth.
      expect(error).toContain('PI-007');
    });

    it('404s an ID that is well-formed but names nothing', async () => {
      const res = await fetch(`${origin}/api/entities/PFA-REQ-999`, { headers: { cookie } });
      expect(res.status).toBe(404);
    });

    it('omits backlinks when they are not asked for', async () => {
      const result = await get<{ backlinks: unknown[] }>('/entities/PFA-REQ-001?backlinks=false');
      expect(result.backlinks).toEqual([]);
    });
  });
});
