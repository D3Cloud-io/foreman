import { expect, test, type Page } from '@playwright/test';

/**
 * Honest signals (FRM-T-18.2, FRM-REQ-241, FRM-DA-002).
 *
 * Every figure is needs you, clean, or not measurable yet, and an unmeasured or partly measured one
 * is never clean. Two projects are seeded with names unique to the run: one with no plan at all (the
 * Personal Website case) and one with a phase that has no exit demo.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';

const RUN = Date.now().toString(36).slice(-4).toUpperCase();
/** No phase, requirement or task: nothing to measure against. */
const UNPLANNED = `HU${RUN}`;
/** One phase with no exit demo. */
const PLANNED = `HP${RUN}`;

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

test.describe('honest signals', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await signIn(page);
    for (const code of [UNPLANNED, PLANNED]) {
      const created = await page.request.post('/api/projects', { data: { code, name: `Honest ${code}` } });
      expect(created.status(), await created.text()).toBe(201);
    }
    const phase = await page.request.post(`/api/projects/${PLANNED}/phases`, {
      data: { number: 1, name: 'No demo yet' },
    });
    expect(phase.status(), await phase.text()).toBe(201);
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('Home reports CI as "N of M" and is never "Green" while a project has not reported', async ({ page }) => {
    await page.goto('/');
    const main = page.getByRole('main');
    const ci = main.getByRole('link', { name: /CI · reporting/ });
    await expect(ci).toBeVisible();
    // The seeded projects never sent a CI result, so it cannot be clean.
    await expect(ci).toContainText(/\d+ of \d+/);
    await expect(ci).toContainText('not measurable yet');
    await expect(main.getByText('Green', { exact: true })).toHaveCount(0);
  });

  test('Home labels the figure "Critical + high", keeps the findings link, and gives each tile a way in', async ({
    page,
  }) => {
    await page.goto('/');
    const main = page.getByRole('main');
    await expect(main.getByText('Open criticals')).toHaveCount(0);
    const tile = main.getByRole('link', { name: /Critical \+ high/ });
    await expect(tile).toBeVisible();
    await expect(tile).toHaveAttribute('href', '/findings');
    // Every stat is a link to the list it counts.
    for (const label of ['Projects', 'Blocked tasks', 'Drift', 'CI · reporting']) {
      await expect(main.getByRole('link', { name: new RegExp(label) }).first()).toHaveAttribute('href', /^\/(projects|drift)/);
    }
  });

  test('Home keeps project codes out of the stat links, so each project is one link', async ({ page }) => {
    await page.goto('/');
    const main = page.getByRole('main');
    // Only the project's own tile is a link that names it; the tiles list codes in a plain line.
    await expect(main.getByRole('link', { name: new RegExp(UNPLANNED) })).toHaveCount(1);
    await expect(main.getByText(new RegExp(`No plan yet:.*${UNPLANNED}`))).toBeVisible();
  });

  test('Home draws Cancelled once in the work chart legend', async ({ page }) => {
    await page.goto('/');
    const legend = page.getByRole('main').locator('.fm-legend');
    await expect(legend.getByText('Cancelled')).toHaveCount(1);
    await expect(legend.getByText('Done')).toHaveCount(1);
  });

  test('a project with no plan shows coverage, drift and blocked as not measurable yet, never clean', async ({
    page,
  }) => {
    await page.goto(`/projects/${UNPLANNED}`);
    const main = page.getByRole('main');
    for (const label of ['Coverage holes', 'Drift', 'Blocked']) {
      await expect(main.locator('.fm-stat__label', { hasText: label })).toBeVisible();
    }
    // One "not measurable yet" badge per tile, and each figure an em dash rather than a clean zero.
    await expect(main.locator('.fm-stat__row').getByText('not measurable yet', { exact: true })).toHaveCount(3);
    await expect(main.locator('.fm-stat__value', { hasText: '—' })).toHaveCount(3);
    await expect(main.getByText('No drift')).toHaveCount(0);
    await expect(main.getByText(/Every Must has a task/)).toHaveCount(0);
    await expect(main.getByText(/has no plan in Foreman yet/)).toBeVisible();
  });

  test('its drift page says the six checks did not run instead of "No drift"', async ({ page }) => {
    await page.goto(`/projects/${UNPLANNED}/drift`);
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'Not measurable yet' })).toBeVisible();
    await expect(main.getByText('did not run')).toHaveCount(6);
    await expect(main.getByText('No drift')).toHaveCount(0);
  });

  test('a project with only a phase never reads its drift as clean: most checks could not run', async ({ page }) => {
    await page.goto(`/projects/${PLANNED}`);
    const main = page.getByRole('main');
    // The figure's row sits beside its label: the signal word there must not be "clean".
    const driftRow = main
      .locator('.fm-stat__label', { hasText: /^Drift$/ })
      .locator('xpath=following-sibling::span[contains(@class, "fm-stat__row")]');
    await expect(driftRow).toBeVisible();
    await expect(driftRow.getByText('clean', { exact: true })).toHaveCount(0);

    await page.goto(`/projects/${PLANNED}/drift`);
    await expect(main.getByRole('heading', { name: 'Not measurable yet' })).toBeVisible();
    await expect(main.getByText(/of 6 drift checks could run/)).toBeVisible();
    await expect(main.getByText('did not run').first()).toBeVisible();
    await expect(main.getByText('0 drift')).toHaveCount(0);
  });

  test('a phase shows the server status and a neutral "no exit demo" chip that links to drift', async ({ page }) => {
    await page.goto(`/projects/${PLANNED}/phases`);
    const main = page.getByRole('main');
    const chip = main.getByRole('link', { name: 'no exit demo' });
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('href', `/projects/${PLANNED}/drift`);
    // The project header has a "planned" lifecycle badge too; the phase's is the last on the page.
    await expect(main.getByText('planned', { exact: true }).last()).toBeVisible();

    await chip.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PLANNED}/drift$`));
  });

  test('the Scope of Work notes a missing exit demo as a neutral chip, not a warning', async ({ page }) => {
    await page.goto(`/projects/${PLANNED}/scope-of-work`);
    const main = page.getByRole('main');
    await expect(main.getByRole('link', { name: 'no exit demo' })).toBeVisible();
    await expect(main.getByText(/cannot be completed\s+until something does/)).toHaveCount(0);
  });

  test('the requirements glance explains the EARS card in its own terms', async ({ page }) => {
    await page.goto(`/projects/EXMP/requirements`);
    const main = page.getByRole('main');
    await expect(main.locator('.fm-stat__label', { hasText: 'EARS warnings' })).toBeVisible();
    await expect(main.getByText(/do not read as EARS/)).toBeVisible();
    await expect(main.getByText(/tasks cite nothing/)).toHaveCount(0);
  });
});
