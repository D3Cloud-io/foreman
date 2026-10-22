import { spawnSync } from 'node:child_process';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_EVENT_IDS_HEADER } from '@foreman/shared';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { Portfolio } from '../../src/domain/portfolio.js';

/**
 * Sample projects (FRM-T-18.9, FRM-REQ-248).
 *
 * The example seed makes EXMP and NBR, and both say they are samples: on the project reads and on
 * every portfolio row, so the console can label them and leave them out of Home's figures. No write
 * takes the flag — not the API, not `foreman_create` — so a real project cannot become removable.
 * Removing one is the soft delete every record takes, and Undo brings it back; a real project is
 * refused by name.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'samples@example.com';
const PASSWORD = 'a-password-for-the-sample-tests';
const REAL = 'SMPR';
const SAMPLES = ['EXMP', 'NBR'];

const ENV = {
  NODE_ENV: 'test',
  BASE_URL: 'http://localhost:3200',
  DATABASE_URL: url ?? '',
  KEK: Buffer.alloc(32, 1).toString('base64'),
  PEPPER: Buffer.alloc(32, 2).toString('base64'),
  COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
};

describe.skipIf(url === undefined)('sample projects', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;

  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${origin}/api${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    const config: Config = loadConfig(ENV);
    db = createDb(url ?? '');

    // The seed itself, as the CLI runs it: what it writes is the property under test.
    const seeded = spawnSync('node', ['--import', 'tsx', 'src/cli/seed-example.ts'], {
      cwd: join(import.meta.dirname, '../..'),
      env: { ...process.env, ...ENV, OPERATOR_EMAIL: '' },
      encoding: 'utf8',
    });
    expect(seeded.status, `${seeded.stderr}${seeded.stdout}`).toBe(0);

    await db.project.deleteMany({ where: { code: REAL } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    const user = await db.user.create({ data: { email: EMAIL, displayName: 'Samples', status: 'active' } });
    await setPassword({ db, config }, user.id, PASSWORD);

    const app = createApp({ db, config });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => {
        resolve(s);
      });
    });
    const address = server.address();
    origin = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`;

    const login = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

    const created = await call('POST', '/projects', { code: REAL, name: 'A real one' });
    expect(created.status, await created.text()).toBe(201);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    // Hard, as delete-example does: the seed's codes must be free for the next seed.
    await db.project.deleteMany({ where: { code: { in: [...SAMPLES, REAL] } } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await db.$disconnect();
  });

  it('seeds EXMP and NBR as samples, and a project made through the API is not one', async () => {
    const rows = await db.project.findMany({ where: { code: { in: [...SAMPLES, REAL] } }, select: { code: true, sample: true } });
    expect(Object.fromEntries(rows.map((row) => [row.code, row.sample]))).toEqual({ EXMP: true, NBR: true, [REAL]: false });
  });

  it('says so on the project reads and on every portfolio row', async () => {
    const one = (await (await call('GET', '/projects/EXMP')).json()) as { sample: boolean };
    expect(one.sample).toBe(true);
    const list = (await (await call('GET', '/projects?limit=200')).json()) as { items: { code: string; sample: boolean }[] };
    expect(list.items.find((row) => row.code === REAL)?.sample).toBe(false);
    expect(list.items.find((row) => row.code === 'NBR')?.sample).toBe(true);

    const portfolio = (await (await call('GET', '/portfolio')).json()) as Portfolio;
    const flags = Object.fromEntries(portfolio.items.map((row) => [row.code, row.sample]));
    expect(flags).toMatchObject({ EXMP: true, NBR: true, [REAL]: false });
    // Still every project: the portfolio counts samples; it is the console that leaves them out.
    expect(portfolio.total).toBe(portfolio.items.length);
    expect(portfolio.items.some((row) => row.code === 'EXMP')).toBe(true);
  });

  it('takes the flag from no write: creating or updating with it is refused by name', async () => {
    const create = await call('POST', '/projects', { code: 'SMPX', name: 'Sneaky', sample: true });
    expect(create.status).toBe(400);
    expect(await create.text()).toContain('sample');
    const update = await call('PATCH', `/projects/${REAL}`, { sample: true });
    expect(update.status).toBe(400);
    expect((await db.project.findUniqueOrThrow({ where: { code: REAL } })).sample).toBe(false);
  });

  it('refuses to remove a real project, and says why', async () => {
    const res = await call('DELETE', `/projects/${REAL}`);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('not a sample project');
    expect((await db.project.findUniqueOrThrow({ where: { code: REAL } })).deletedAt).toBeNull();
  });

  it('removes a sample with a soft delete, audited, and Undo brings it back', async () => {
    const res = await call('DELETE', '/projects/NBR');
    expect(res.status).toBe(204);
    const ids = (res.headers.get(AUDIT_EVENT_IDS_HEADER) ?? '').split(',').filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);

    const row = await db.project.findUniqueOrThrow({ where: { code: 'NBR' } });
    expect(row.deletedAt).not.toBeNull();
    const event = await db.auditEvent.findUniqueOrThrow({ where: { id: ids[0] ?? '' } });
    expect(event).toMatchObject({ action: 'delete', entityType: 'project', entityHumanId: 'NBR' });

    const after = (await (await call('GET', '/portfolio')).json()) as Portfolio;
    expect(after.items.some((item) => item.code === 'NBR')).toBe(false);

    // As the console's Undo does (`undoAll`): the delete's own event puts it back, group place and
    // all; a renumbering it caused is reversed by that, and refuses on its own.
    const undo = await call('POST', `/undo/${ids[0] ?? ''}`);
    expect(undo.status, await undo.text()).toBe(200);
    const back = await db.project.findUniqueOrThrow({ where: { code: 'NBR' } });
    expect(back.deletedAt).toBeNull();
    expect(back.sample).toBe(true);
  });
});
