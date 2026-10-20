import { expect, test } from '@playwright/test';

/**
 * Ideas, from the console (FRM-REQ-153 … FRM-REQ-158).
 *
 * The screen exists so a thought that is not yet a plan has somewhere to live other than a
 * document nobody opens. What is worth asserting end to end is therefore not that a row appears —
 * the integration tests cover the record — but the two things only this surface does: it makes
 * the reason for a parked or rejected idea unavoidable, and it does not pretend the prose
 * document it succeeds no longer exists.
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

/** A title nothing else uses, so a run does not collide with the seed or with a previous run. */
const title = () => `Idea from an e2e run ${String(Date.now())}`;

test.describe('ideas (S-27)', () => {
  test('is reachable from inside the project, not only by URL', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP');

    // Every section screen was a dead end before the redesign. This one arrives with the sidebar
    // already knowing where it sits.
    // Behind the project's Knowledge row since FRM-T-16.4, which keeps the sidebar to 900px.
    await page.getByRole('button', { name: 'Knowledge' }).click();
    await page.getByRole('link', { name: 'Ideas', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ideas', level: 1 })).toBeVisible();
  });

  test('takes a new idea with a title alone', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/ideas');
    const text = title();

    await page.getByRole('button', { name: 'New idea' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(text);
    await page.getByRole('button', { name: 'Save' }).click();

    // It lands as `new`, because nobody has judged it — the status is not on the create form at
    // all, so a decision cannot be recorded that was never made.
    const card = page.getByRole('group', { name: new RegExp(`: ${text}$`) });
    await expect(card).toBeVisible();
    await expect(card.getByText('new', { exact: true })).toBeVisible();
  });

  test('will not park an idea that does not say why', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/ideas');
    const text = title();

    await page.getByRole('button', { name: 'New idea' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(text);
    await page.getByRole('button', { name: 'Save' }).click();

    // That idea's own Edit. Every card has one, so the button has to be reached through the card
    // rather than by position — an earlier version of this test picked the last Edit on the page
    // and quietly parked a different idea, which the next test then failed on.
    const card = page.getByRole('group', { name: new RegExp(`: ${text}$`) });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('combobox', { name: 'Status' }).click();
    await page.getByRole('option', { name: 'Parked' }).click();

    // The field appears because the status needs it — it is not always on the form, which is how
    // a required field stops being read.
    await expect(page.getByRole('textbox', { name: 'Why' })).toBeVisible();

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('An idea that is parked has to say why.')).toBeVisible();

    await page.getByRole('textbox', { name: 'Why' }).fill('Not while the cutover is settling.');
    await page.getByRole('button', { name: 'Save' }).click();

    // And the reason is on the card afterwards, not one click away: somebody about to raise this
    // again should not have to open anything to find out it was already considered.
    await expect(card.getByText('Not while the cutover is settling.')).toBeVisible();
    await expect(card.getByText('parked', { exact: true })).toBeVisible();
  });

  test('links to the ideas document it succeeds', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/ideas');

    // Four real projects wrote a "Feature Ideas & Future Development" document before ideas were
    // records. The screen that replaces it has to be able to reach it, or the reasoning in it is
    // quietly stranded.
    const link = page.getByRole('link', { name: /Feature ideas/i });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/projects\/EXMP\/documents\/[0-9a-f-]+$/);
  });

  test('filters to one status, and back', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/ideas');

    // Filtering against an idea this test creates, rather than against a seeded one: the seed is
    // shared with every other test in this file, and one of them changes a status.
    const text = title();
    await page.getByRole('button', { name: 'New idea' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(text);
    await page.getByRole('button', { name: 'Save' }).click();

    const mine = page.getByRole('group', { name: new RegExp(`: ${text}$`) });
    const accepted = page.getByRole('group', { name: /A keyboard palette/ });
    await expect(mine).toBeVisible();

    const onlyNew = page.getByRole('button', { name: /^New \d/ });
    await onlyNew.click();
    await expect(onlyNew).toHaveAttribute('aria-pressed', 'true');
    await expect(mine).toBeVisible();
    await expect(accepted).toBeHidden();

    // A second press clears it. A filter you can only set is a filter that traps you.
    await onlyNew.click();
    await expect(onlyNew).toHaveAttribute('aria-pressed', 'false');
    await expect(accepted).toBeVisible();
  });
});
