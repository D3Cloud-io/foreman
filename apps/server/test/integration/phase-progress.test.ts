import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { Brief } from '../../src/domain/brief.js';
import { phaseProgress } from '../../src/domain/wherewestand.js';

/**
 * FRM-REQ-242 / FRM-DA-003: a count is computed from the complete set it describes.
 *
 * Bindery has 212 tasks; the Phases screen counted one page of 200 in the browser and drew Phase 9
 * as "No tasks · planned" while the overview said 8 of 12. Here the project is 212 tasks, the
 * phase that falls past the 200 mark is the one asserted, and the per-phase counts must equal the
 * overview's (the brief's) for the same phase.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'phase-progress@example.com';
const PASSWORD = 'a-password-for-the-phase-progress-tests';
const CODE = 'PHP';

interface ProgressItem {
  humanId: string;
  tasks: { done: number; cancelled: number; total: number };
}

describe.skipIf(url === undefined)('per-phase progress (FRM-REQ-242)', () => {
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

    await db.user.deleteMany({ where: { email: EMAIL } });
    const user = await db.user.create({
      data: { email: EMAIL, displayName: 'Phase progress', status: 'active' },
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
    await db.project.deleteMany({ where: { code: CODE } });
    const project = await db.project.create({
      data: { code: CODE, name: 'Phase Progress', slug: 'phase-progress', lifecycle: 'building' },
    });
    const early = await db.phase.create({
      data: { projectId: project.id, humanId: `${CODE}-P-1`, number: 1, sortOrder: 1, name: 'Early', status: 'complete' },
    });
    const late = await db.phase.create({
      data: { projectId: project.id, humanId: `${CODE}-P-9`, number: 9, sortOrder: 2, name: 'Late', status: 'active' },
    });
    await db.phase.create({
      data: { projectId: project.id, humanId: `${CODE}-P-10`, number: 10, sortOrder: 3, name: 'Empty', status: 'planned' },
    });

    // 200 tasks in the early phase fill the page the browser used to read; the late phase's 12
    // (8 done, 1 cancelled, 3 open) are all past it. 212 in all, like Bindery.
    const tasks = [
      ...Array.from({ length: 200 }, (_, i) => ({
        projectId: project.id,
        phaseId: early.id,
        humanId: `${CODE}-T-1.${String(i + 1)}`,
        title: `Early ${String(i + 1)}`,
        status: 'done' as const,
        sortOrder: i,
      })),
      ...Array.from({ length: 12 }, (_, i) => ({
        projectId: project.id,
        phaseId: late.id,
        humanId: `${CODE}-T-9.${String(i + 1)}`,
        title: `Late ${String(i + 1)}`,
        status: i < 8 ? ('done' as const) : i === 8 ? ('cancelled' as const) : ('todo' as const),
        sortOrder: i,
      })),
    ];
    await db.task.createMany({ data: tasks });
    // A deleted task is in no count.
    await db.task.create({
      data: {
        projectId: project.id,
        phaseId: late.id,
        humanId: `${CODE}-T-9.99`,
        title: 'Deleted',
        status: 'done',
        deletedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  it('counts every phase from the whole set, past the 200-task page', async () => {
    const progress = await get<{ items: ProgressItem[]; total: number }>(`/projects/${CODE}/phases`);
    const byId = new Map(progress.items.map((item) => [item.humanId, item.tasks]));

    expect(progress.total).toBe(3);
    expect(byId.get(`${CODE}-P-1`)).toEqual({ done: 200, cancelled: 0, total: 200 });
    expect(byId.get(`${CODE}-P-9`)).toEqual({ done: 8, cancelled: 1, total: 12 });
    expect(byId.get(`${CODE}-P-10`)).toEqual({ done: 0, cancelled: 0, total: 0 });
  });

  it('agrees with the overview, which reads the same phase', async () => {
    const brief = await get<Brief>(`/brief/${CODE}`);
    const progress = await get<{ items: ProgressItem[] }>(`/projects/${CODE}/phases`);

    expect(brief.activePhase?.humanId).toBe(`${CODE}-P-9`);
    const phase = progress.items.find((item) => item.humanId === brief.activePhase?.humanId);
    expect(phase?.tasks).toEqual(brief.activePhase?.tasks);
  });

  it('serves the same counts on the phases list as phaseProgress() computes, for every phase', async () => {
    const project = await db.project.findFirstOrThrow({ where: { code: CODE } });
    const expected = await phaseProgress(db, project.id);
    const phases = await get<{ items: (ProgressItem & { id: string })[] }>(`/projects/${CODE}/phases`);

    expect(phases.items.map((item) => item.humanId)).toEqual([`${CODE}-P-1`, `${CODE}-P-9`, `${CODE}-P-10`]);
    for (const item of phases.items) {
      expect(item.tasks).toEqual(expected.get(item.id) ?? { done: 0, cancelled: 0, total: 0 });
    }
  });
});
