import { expect, test } from '@playwright/test';

/**
 * The Phase 6 exit demo, as a suite (S-05, S-16).
 *
 * *Ask for every open Critical across all projects and get one ranked list. Open a fixed finding
 * and see its fix commit with a CI verdict. Open another and see a proposed recurrence in a
 * different project — then show that no model was called to produce it.*
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

test.describe('the findings inbox (S-05, FRM-REQ-120)', () => {
  test('answers "every open finding, all projects" in one ranked list', async ({ page }) => {
    await signIn(page);
    await page.goto('/findings');

    await expect(page.getByRole('heading', { name: 'Findings' })).toBeVisible();

    // More than one project in one list: the whole point, and the thing the vault could not do.
    const list = page.getByRole('list', { name: 'Findings' });
    await expect(list).toBeVisible();
    const projects = (await list.locator('.fm-triage__project').allTextContents()).filter((code) =>
      /^(EXMP|NBR)$/.test(code),
    );
    expect(new Set(projects).size).toBeGreaterThan(1);

    // Ranked: the first row is the worst thing outstanding anywhere.
    const first = list.getByRole('listitem').first();
    await expect(first.getByText('critical', { exact: true })).toBeVisible();
  });

  test('narrows to criticals across every project', async ({ page }) => {
    await signIn(page);
    await page.goto('/findings?severity=critical');

    await expect(page.getByRole('combobox', { name: 'Severity' })).toContainText('Critical');
    await expect(page.getByRole('list', { name: 'Findings' })).toBeVisible();
    const severities = await page
      .getByRole('list', { name: 'Findings' })
      .locator('.fm-triage__line > :first-child')
      .allTextContents();
    expect(severities.length).toBeGreaterThan(0);
    expect(severities.every((s) => s === 'critical')).toBe(true);
  });

  test('narrows to one lens, which is how a cross-project question is actually asked', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/findings?lens=accessibility');

    // "Is this accessibility problem true anywhere else" is the question the inbox exists for.
    const lenses = page.getByRole('list', { name: 'Findings' }).locator('.fm-triage__sub');
    await expect(lenses.filter({ hasText: 'accessibility' }).first()).toBeVisible();
    await expect(lenses.filter({ hasText: 'correctness' })).toHaveCount(0);
  });

  test('shows open findings by default, not an archive', async ({ page }) => {
    await signIn(page);
    await page.goto('/findings');
    await expect(page.getByRole('combobox', { name: 'Status' })).toContainText('Open');
  });
});

test.describe('finding detail (S-16)', () => {
  test('never shows an un-ingested fix as green (FRM-REQ-119)', async ({ page }) => {
    await signIn(page);
    // The seed records a fix commit that was never ingested.
    await page.goto('/findings/EXMP-CR-002');

    await expect(page.getByText('The fix is unverified')).toBeVisible();
    await expect(page.getByText(/has not been ingested/)).toBeVisible();
    // The words that must not appear anywhere near it.
    await expect(page.getByText('CI was green on the fix')).toHaveCount(0);
  });

  test('flags a finding nobody independently verified', async ({ page }) => {
    await signIn(page);
    await page.goto('/findings/EXMP-DA-001');

    // 123 of 127 real findings are unverified. A blank field would read as "fine".
    await expect(page.getByText('Not independently verified')).toBeVisible();
  });

  test('shows every file a location names, and the prose beside it', async ({ page }) => {
    await signIn(page);
    await page.goto('/findings/EXMP-CR-001');

    // Exact: the raw location is shown underneath and contains both paths as a substring.
    await expect(page.getByText('apps/server/src/example.ts:196-206,299-310', { exact: true })).toBeVisible();
    await expect(page.getByText('apps/web/src/App.tsx:12', { exact: true })).toBeVisible();
    // The note the parse kept rather than discarded — `.first()` because the raw location is
    // shown underneath and contains the same words.
    await expect(page.getByText('— no guard').first()).toBeVisible();
  });
});

test.describe('recurrence (T-6.7, FRM-REQ-121, FRM-REQ-122)', () => {
  test('proposes the same problem in another project, with its evidence', async ({ page }) => {
    await signIn(page);
    await page.goto('/findings/EXMP-DA-001');

    const card = page.locator('section, div').filter({ hasText: 'Might this be true elsewhere?' }).last();
    await expect(card.getByRole('link', { name: 'NBR-DA-001' })).toBeVisible();
    // The evidence, not just a score: a number nobody can check is a number nobody trusts.
    await expect(page.getByText(/same lens: accessibility/)).toBeVisible();
    await expect(page.getByText(/shared words:/)).toBeVisible();
  });

  test('says on the screen that no model was called', async ({ page }) => {
    await signIn(page);
    await page.goto('/findings/EXMP-DA-001');

    await expect(page.getByText(/no model was called/)).toBeVisible();
    // And that the judging is not Foreman's.
    await expect(page.getByText(/does not decide whether these are the same problem/)).toBeVisible();
  });

  test('proposes nothing for a finding with no counterpart', async ({ page }) => {
    await signIn(page);
    await page.goto('/findings/EXMP-CR-002');
    await expect(page.getByText('No similar finding in another project')).toBeVisible();
  });

  test('the API says it too, for a caller that never sees a screen', async ({ request }) => {
    await request.post('/auth/login', { data: { email: EMAIL, password: PASSWORD } });
    const res = await request.get('/api/findings/EXMP-DA-001/recurrences');

    const body = (await res.json()) as { method: string; candidates: { project: string }[] };
    expect(body.method).toContain('no model was called');
    // Cross-project by construction: a candidate from the same project would be a duplicate.
    expect(body.candidates.every((c) => c.project !== 'EXMP')).toBe(true);
  });
});
