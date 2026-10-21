import { createHmac, randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * The Phase 5 exit demo, as a suite (S-24, T-5.9 … T-5.11).
 *
 * A commit citing a task appears as a **proposal** and the task does not move; confirming is a
 * separate act; the commits nothing explains are visible rather than quietly absent.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';

const WEBHOOK_SECRET = process.env['GITHUB_WEBHOOK_SECRET'] ?? 'dev-webhook-secret';

/**
 * Deliver a push, signed, exactly as GitHub would.
 *
 * The suite makes its own commits rather than consuming the seed's: confirming a proposal removes
 * it, so a test that spends seeded state passes once and fails on every run after. Found the hard
 * way, twice.
 */
async function pushCommit(
  request: APIRequestContext,
  message: string,
): Promise<string> {
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

  const res = await request.post('/webhooks/github', {
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-github-delivery': randomBytes(8).toString('hex'),
      'x-hub-signature-256': `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`,
    },
    data: body,
  });
  expect(res.status(), 'the webhook should accept a signed delivery').toBe(202);
  return sha;
}

/** The worker drains on its own; wait for the commit rather than guessing at a delay. */
async function waitForCommit(request: APIRequestContext, sha: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await request.get('/api/projects/EXMP/commits?attributed=any');
        const body = (await res.json()) as { items: { sha: string }[] };
        return body.items.some((c) => c.sha === sha);
      },
      { timeout: 20_000, message: `commit ${sha.slice(0, 8)} was never ingested` },
    )
    .toBe(true);
}

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

test.describe('activity (S-24)', () => {
  test('defaults to the review queue, because the job is emptying it', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/activity');

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Showing' })).toContainText(
      'Waiting to be reviewed',
    );
  });

  test('says why each attribution was proposed', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/activity');

    // Confirming a guess whose reasoning you cannot see is just clicking.
    await expect(page.getByText(/cited in the message|files overlap/).first()).toBeVisible();
  });

  test('shows the commits nothing explains, which is the coverage gap', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/activity');
    await page.getByRole('combobox', { name: 'Showing' }).click();
    await page.getByRole('option', { name: 'Nothing proposed' }).click();

    await expect(page.getByText('Tidy the imports and fix a typo')).toBeVisible();
    await expect(page.getByText(/no task cited/).first()).toBeVisible();
  });

  test('reports CI, the image SHA and the schema revision together', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/activity');

    // "What is deployed" has two answers, and the interesting failures are when they disagree.
    await expect(page.getByText('Schema', { exact: true })).toBeVisible();
    await expect(page.getByText(/^\d{14}_/)).toBeVisible();
    // Activity's own term, not the reality strip's label above it.
    await expect(page.locator('main dt:not(.fm-reality__label)', { hasText: /^CI$/ })).toBeVisible();
  });

  test('ingests a pushed commit and proposes the task it cites', async ({ page, request }) => {
    await request.post('/auth/login', { data: { email: EMAIL, password: PASSWORD } });
    const sha = await pushCommit(request, 'Real work, cited properly (T-0.1)');
    await waitForCommit(request, sha);

    await signIn(page);
    await page.goto('/projects/EXMP/activity');

    const row = page.getByRole('listitem').filter({ hasText: sha.slice(0, 12) });
    await expect(row).toBeVisible();
    // The bare form, which is the only form anybody writes.
    await expect(row.getByText('cited in the message')).toBeVisible();
    await expect(row.getByText('proposed')).toBeVisible();
  });

  test('confirms a proposal, and it leaves the queue', async ({ page, request }) => {
    await request.post('/auth/login', { data: { email: EMAIL, password: PASSWORD } });
    const sha = await pushCommit(request, 'Another piece of real work (T-0.1)');
    await waitForCommit(request, sha);

    await signIn(page);
    await page.goto('/projects/EXMP/activity');

    const row = page.getByRole('listitem').filter({ hasText: sha.slice(0, 12) });
    await row.getByRole('button', { name: /^Confirm / }).click();

    // Gone from the review queue, because the queue is the thing being emptied.
    await expect(row).toBeHidden();
  });
});

test.describe('what ingest may never do (FRM-REQ-108)', () => {
  test('a commit citing an unfinished task leaves it exactly as it was', async ({ request }) => {
    await request.post('/auth/login', { data: { email: EMAIL, password: PASSWORD } });

    // A task that is *not* done, so "still not done" afterwards means something. Asserting over
    // whatever tasks happen to carry proposals proves nothing: a commit may perfectly well cite
    // work somebody finished last week.
    const listed = await request.get('/api/projects/EXMP/tasks?limit=200');
    const tasks = ((await listed.json()) as { items: { humanId: string; status: string }[] }).items;
    const target = tasks.find((t) => t.status !== 'done' && t.status !== 'cancelled');
    expect(target, 'the seed should hold at least one unfinished task').toBeDefined();

    const bare = target?.humanId.replace(/^EXMP-/, '') ?? '';
    const sha = await pushCommit(request, `Work on ${bare}, which does not finish it`);
    await waitForCommit(request, sha);

    const after = await request.get(`/api/entities/${target?.humanId ?? ''}`);
    const entity = (await after.json()) as { entity: { status: string; completedAt: string | null } };

    // A commit is not a status transition. Nothing about ingest may advance work.
    expect(entity.entity.status).toBe(target?.status);
    expect(entity.entity.completedAt).toBeNull();

    // And the proposal exists, so this is not passing because nothing happened.
    const commits = await request.get('/api/projects/EXMP/commits?attributed=proposed');
    const body = (await commits.json()) as { items: { sha: string }[] };
    expect(body.items.some((c) => c.sha === sha)).toBe(true);
  });
});
