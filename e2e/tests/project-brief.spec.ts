import { createHmac, randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

/**
 * The project pages that show reality (FRM-T-18.8, FRM-REQ-247, board D-08).
 *
 * One header with the reality strip in it; an overview that is the brief; a phase that is its
 * server-computed exit gate; a task and a requirement with a property rail edited in place and a
 * Reality section. Everything is made for the run in its own phase of the seeded EXMP project and
 * removed afterwards, so the seed the other specs read is left as it was found.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';
const WEBHOOK_SECRET = process.env['GITHUB_WEBHOOK_SECRET'] ?? 'dev-webhook-secret';
const CODE = 'EXMP';
const RUN = Date.now().toString(36).slice(-4).toUpperCase();

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

interface Row {
  id: string;
  humanId: string;
  number?: string;
}

async function create(api: APIRequestContext, path: string, data: unknown): Promise<Row> {
  const res = await api.post(path, { data });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as Row;
}

/** A signed push of one commit to the seeded repository, as GitHub would deliver it. */
async function pushCommit(api: APIRequestContext, message: string): Promise<string> {
  const sha = randomBytes(20).toString('hex');
  const body = JSON.stringify({
    repository: { full_name: 'matdemers1/example-project' },
    ref: 'refs/heads/main',
    commits: [
      {
        id: sha,
        message,
        timestamp: new Date().toISOString(),
        author: { name: 'e2e', email: 'e2e@example.com' },
        added: [],
        modified: ['apps/server/src/app.ts'],
        removed: [],
      },
    ],
  });
  const res = await api.post('/webhooks/github', {
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-github-delivery': randomBytes(8).toString('hex'),
      'x-hub-signature-256': `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`,
    },
    data: body,
  });
  expect(res.status()).toBe(202);
  await expect
    .poll(
      async () => {
        const list = await api.get(`/api/projects/${CODE}/commits?attributed=any`);
        return ((await list.json()) as { items: { sha: string }[] }).items.some((c) => c.sha === sha);
      },
      { timeout: 90_000 },
    )
    .toBe(true);
  return sha;
}

interface BriefShape {
  activePhase: { humanId: string; number: string; name: string; tasks: { done: number; total: number } } | null;
  drift: { total: number };
  evidence: { doneWithCommit: number; done: number; since: string | null };
}

const brief = async (api: APIRequestContext): Promise<BriefShape> =>
  (await (await api.get(`/api/brief/${CODE}`)).json()) as BriefShape;

test.describe('project pages that show reality', () => {
  test.describe.configure({ mode: 'serial', timeout: 90_000 });

  let phase: Row;
  let other: Row;
  let must: Row;
  let done: Row;
  let todo: Row;
  const made: { path: string }[] = [];
  // One sign-in for the whole file: the server throttles logins from one address, and seven of them
  // in a few seconds is the throttle's idea of an attack, not of a test.
  let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await signIn(page);
    const api = page.request;
    cookies = await page.context().cookies();

    let created: Row | null = null;
    for (let attempt = 0; attempt < 5 && created === null; attempt += 1) {
      const number = 4000 + Math.floor(Math.random() * 4000);
      const res = await api.post(`/api/projects/${CODE}/phases`, {
        data: { number, name: `Brief e2e ${RUN}`, exitDemo: 'Show the reality strip.' },
      });
      if (res.status() === 201) created = (await res.json()) as Row;
    }
    if (created === null) throw new Error('no phase number was free');
    phase = created;
    made.push({ path: `/api/projects/${CODE}/phases/${phase.humanId}` });

    other = await create(api, `/api/projects/${CODE}/phases`, {
      number: 8000 + Math.floor(Math.random() * 1000),
      name: `Brief e2e other ${RUN}`,
    });
    made.push({ path: `/api/projects/${CODE}/phases/${other.humanId}` });

    // A Must nothing satisfies and with no acceptance test: two named failures at the gate.
    must = await create(api, `/api/projects/${CODE}/requirements`, {
      statement: 'When the brief is read, the system shall show the reality behind the plan.',
      priority: 'M',
      phaseId: phase.id,
    });
    made.push({ path: `/api/projects/${CODE}/requirements/${must.humanId}` });

    done = await create(api, `/api/projects/${CODE}/tasks`, { title: `Evidenced ${RUN}`, phaseId: phase.id });
    todo = await create(api, `/api/projects/${CODE}/tasks`, { title: `Waiting ${RUN}`, phaseId: phase.id });
    for (const task of [done, todo]) made.push({ path: `/api/projects/${CODE}/tasks/${task.humanId}` });

    // A commit citing `done` is proposed, then confirmed; only then is the task finished, so the
    // work is evidenced rather than declared.
    const sha = await pushCommit(api, `Real work on the strip (${done.humanId})`);
    const confirm = await api.post(`/api/projects/${CODE}/attributions/${sha}/confirm`, {
      data: { task: done.humanId },
    });
    expect(confirm.status(), await confirm.text()).toBe(200);
    const finished = await api.patch(`/api/projects/${CODE}/tasks/${done.humanId}`, { data: { status: 'done' } });
    expect(finished.status(), await finished.text()).toBe(200);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.context().addCookies(cookies);
    // Tasks and the requirement first, then the phases that held them.
    for (const item of [...made].reverse()) await page.request.delete(item.path);
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    await page.context().addCookies(cookies);
  });

  test('the overview carries the reality strip, with evidence as a neutral fraction', async ({ page }) => {
    await page.goto(`/projects/${CODE}`);
    const strip = page.getByRole('group', { name: 'Reality' });
    await expect(strip).toBeVisible();
    for (const label of ['In flight', 'Tasks · declared / evidenced', 'Drift', 'Critical + high', 'CI', 'Deployed vs main']) {
      await expect(strip.getByText(label, { exact: true })).toBeVisible();
    }

    const read = await brief(page.request);
    // The seeded project has confirmed attribution of its own, and the run just added one.
    expect(read.evidence.since).not.toBeNull();
    if (read.activePhase !== null) {
      await expect(strip.locator('[data-cell="tasks"]')).toHaveText(
        `${String(read.activePhase.tasks.done)} of ${String(read.activePhase.tasks.total)} done`,
      );
    }
    // The sentence, not a bar: no progress element anywhere in the strip.
    await expect(strip).toContainText(
      read.evidence.done === 0
        ? /no done work since attribution began, \d{4}-\d{2}-\d{2}/
        : new RegExp(
            `${String(read.evidence.doneWithCommit)} of ${String(read.evidence.done)} done tasks? ha(s|ve) a commit · attribution since \\d{4}-\\d{2}-\\d{2}`,
          ),
    );
    await expect(strip.getByRole('progressbar')).toHaveCount(0);
    // One header, one strip.
    await expect(page.getByRole('group', { name: 'Reality' })).toHaveCount(1);
  });

  test('the strip is on every project screen, compact, and the section tiles are gone from the overview', async ({
    page,
  }) => {
    for (const section of ['phases', 'requirements', 'drift']) {
      await page.goto(`/projects/${CODE}/${section}`);
      const strip = page.getByRole('group', { name: 'Reality' });
      await expect(strip).toBeVisible();
      await expect(strip.locator('[data-cell="tasks"]')).toBeVisible();
    }
    await page.goto(`/projects/${CODE}`);
    await expect(page.getByRole('main').getByText('Sections', { exact: true })).toHaveCount(0);
    await expect(page.locator('.fm-tile')).toHaveCount(0);
  });

  test('the overview is the brief: What’s next, What drifted, Recent reality', async ({ page }) => {
    await page.goto(`/projects/${CODE}`);
    const main = page.getByRole('main');
    await expect(main.getByText("What's next", { exact: true })).toBeVisible();
    await expect(main.getByText('What drifted', { exact: true })).toBeVisible();
    await expect(main.getByText('Recent reality', { exact: true })).toBeVisible();
    await expect(main.getByText(/Attributions waiting · \d+/)).toBeVisible();
    // At most three next tasks are named.
    expect(await main.locator('.fm-next').count()).toBeLessThanOrEqual(6);
    const read = await brief(page.request);
    if (read.drift.total > 0) {
      await expect(main.locator('.fm-drifted').first()).toBeVisible();
    }
  });

  test('the phase lists the server’s gate verbatim as required checks', async ({ page }) => {
    const res = await page.request.get(`/api/projects/${CODE}/phases/${phase.humanId}/gate`);
    const gate = (await res.json()) as { failures: { kind: string; humanId: string; detail: string }[] };
    expect(gate.failures.map((f) => f.kind)).toEqual(expect.arrayContaining(['uncovered-must', 'no-acceptance-test', 'unfinished-task']));

    await page.goto(`/projects/${CODE}/phases/${phase.humanId}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`Brief e2e ${RUN}`);
    const checks = page.getByRole('list', { name: 'Required checks' });
    await expect(checks).toBeVisible();
    // Every failure the server named, its detail unedited.
    for (const failure of gate.failures) {
      await expect(checks).toContainText(failure.detail);
    }
    const failing = new Set(gate.failures.map((f) => f.kind));
    await expect(page.getByText(`${String(7 - failing.size)} of 7 checks pass`)).toBeVisible();
    // The exit demo is recorded, so that check is met; the Must with no task is not.
    await expect(checks.locator('[data-kind="no-exit-demo"]')).toContainText('met');
    await expect(checks.locator('[data-kind="uncovered-must"]')).toContainText('not met');
    await expect(checks.locator('[data-kind="uncovered-must"]')).toContainText(must.humanId);
    // The strip rides the header here too.
    await expect(page.getByRole('group', { name: 'Reality' })).toBeVisible();
  });

  test('a task edits size and phase in place, with Undo, and lists its commits, CI and deploys', async ({ page }) => {
    await page.goto(`/tasks/${todo.humanId}`);
    await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(1);
    await expect(page.getByRole('complementary', { name: 'Properties' })).toBeVisible();

    // Everything has loaded — the strip, the Reality section — before watching for a skeleton: an
    // in-place write never shows one, but a first load always does.
    await expect(page.getByText(/No commit is attributed to this task/)).toBeVisible();
    await expect(page.getByRole('group', { name: 'Reality' }).locator('[data-cell="tasks"]')).toBeVisible();
    await page.evaluate(() => {
      const seen = { skeleton: false };
      (window as unknown as { __seen: typeof seen }).__seen = seen;
      new MutationObserver(() => {
        if (document.querySelector('.d3-skl') !== null) seen.skeleton = true;
      }).observe(document.body, { childList: true, subtree: true });
    });

    const size = page.getByRole('combobox', { name: `Size of ${todo.humanId}` });
    await size.click();
    await page.getByRole('option', { name: 'L', exact: true }).click();
    await expect(page.getByText(`${todo.humanId} sized L`)).toBeVisible();
    await expect(size).toContainText('L');
    const stored = async () =>
      ((await (await page.request.get(`/api/entities/${todo.humanId}`)).json()) as { entity: { size: string | null; phase: { humanId: string } | null } }).entity;
    expect((await stored()).size).toBe('L');

    const phaseSelect = page.getByRole('combobox', { name: `Phase of ${todo.humanId}` });
    await phaseSelect.click();
    await page.getByRole('option', { name: new RegExp(`Brief e2e other ${RUN}`) }).click();
    await expect(page.getByText(new RegExp(`${todo.humanId} moved to .*Brief e2e other ${RUN}`))).toBeVisible();
    await expect.poll(async () => (await stored()).phase?.humanId).toBe(other.humanId);

    await page.getByRole('button', { name: /^Undo/ }).click();
    await expect(page.getByText(/Undone — .* is back in/)).toBeVisible();
    await expect.poll(async () => (await stored()).phase?.humanId).toBe(phase.humanId);
    expect(await page.evaluate(() => (window as unknown as { __seen: { skeleton: boolean } }).__seen.skeleton)).toBe(false);

    // The Reality section of a task with no commit says so; the evidenced one lists its commit.
    await expect(page.getByText('Reality', { exact: true })).toBeVisible();
    await expect(page.getByText(/No commit is attributed to this task/)).toBeVisible();
    await page.goto(`/tasks/${done.humanId}`);
    await expect(page.getByText('Commits · 1 confirmed')).toBeVisible();
    await expect(page.getByText(`Real work on the strip (${done.humanId})`)).toBeVisible();
    await expect(page.getByText('confirmed', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'CI' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Deployed' })).toBeVisible();
  });

  test('a requirement edits its priority in place, with Undo, and has a Reality section', async ({ page }) => {
    await page.goto(`/requirements/${must.humanId}`);
    const priority = page.getByRole('combobox', { name: `Priority of ${must.humanId}` });
    await expect(priority).toContainText('Must');
    await priority.click();
    await page.getByRole('option', { name: 'Should' }).click();
    await expect(page.getByText(`${must.humanId} is now Should`)).toBeVisible();
    const stored = async () =>
      ((await (await page.request.get(`/api/entities/${must.humanId}`)).json()) as { entity: { priority: string } }).entity.priority;
    await expect.poll(stored).toBe('S');
    await page.getByRole('button', { name: /^Undo/ }).click();
    await expect.poll(stored).toBe('M');
    await expect(priority).toContainText('Must');
    await expect(page.getByText('Reality', { exact: true })).toBeVisible();
    await expect(page.getByText('No task satisfies this')).toBeVisible();
  });

  test('renaming a project on its overview updates the heading without a reload', async ({ page }) => {
    const code = `PB${RUN}`;
    const name = `Brief rename ${RUN}`;
    await create(page.request, '/api/projects', { code, name });
    try {
      await page.goto(`/projects/${code}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
      await page.getByRole('button', { name: 'Edit' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox', { name: 'Name' }).fill(`${name} renamed`);
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${name} renamed`);
      // The sidebar and trail re-read too (they subscribe to the brief being forgotten): the old
      // name is nowhere on the page.
      await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    } finally {
      await page.request.delete(`/api/projects/${code}`);
    }
  });
});
