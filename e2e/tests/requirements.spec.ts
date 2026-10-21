import { expect, test } from '@playwright/test';

/**
 * The Phase 3 screens (T-3.8, T-3.9): the register at volume, one requirement, and the two views
 * that replace documents.
 *
 * The seeded EXMP project has one requirement of every EARS pattern, one of every priority, and
 * deliberately leaves the last one in the backlog with nothing covering it — which is exactly the
 * state these screens exist to make visible.
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

test.describe('the requirements table (S-13)', () => {
  test('lists the register and reaches one requirement', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/requirements');

    await expect(page.getByRole('heading', { name: 'Requirements' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'EXMP-REQ-001' })).toBeVisible();

    await page.getByRole('link', { name: 'EXMP-REQ-001' }).click();
    await expect(page).toHaveURL(/\/requirements\/EXMP-REQ-001$/);
  });

  test('filters to the backlog, which is a filter and not a separate screen (T-3.1)', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/requirements');

    await page.getByRole('combobox', { name: 'Phase' }).click();
    await page.getByRole('option', { name: 'Backlog — no phase' }).click();

    // The seed leaves exactly the last requirement unassigned.
    await expect(page.getByRole('link', { name: 'EXMP-REQ-007' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'EXMP-REQ-001' })).toBeHidden();
  });

  test('filters to what nothing covers, and arrives filtered from a link', async ({ page }) => {
    await signIn(page);
    // The drift count on the project overview links straight here: a filtered link is the whole
    // difference between a number and something somebody acts on.
    await page.goto('/projects/EXMP/requirements?uncovered=true');

    await expect(page.getByRole('combobox', { name: 'Coverage' })).toContainText(
      'Nothing covers it',
    );
    await expect(page.getByRole('link', { name: 'EXMP-REQ-007' })).toBeVisible();
  });

  test('filters to the statements the lint warned about', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/requirements?earsLint=warned');

    // The seed writes exactly one statement that is not EARS at all.
    await expect(page.getByRole('link', { name: 'EXMP-REQ-007' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'EXMP-REQ-002' })).toBeHidden();
  });
});

test.describe('requirement detail (S-14)', () => {
  test('flags an uncovered requirement rather than showing an empty section', async ({ page }) => {
    await signIn(page);
    await page.goto('/requirements/EXMP-REQ-007');

    // "Nothing here" and "nothing satisfies this" look the same in an empty section and mean
    // opposite things. This screen says which.
    await expect(page.getByText('No task satisfies this')).toBeVisible();
  });

  test('shows the lint warning, and says the requirement was stored anyway', async ({ page }) => {
    await signIn(page);
    await page.goto('/requirements/EXMP-REQ-007');

    await expect(page.getByText('Read as unparsed')).toBeVisible();
    await expect(page.getByText('the lint warns, it never refuses')).toBeVisible();
  });

  test('names the backlog as the backlog, not as a missing value', async ({ page }) => {
    await signIn(page);
    await page.goto('/requirements/EXMP-REQ-007');

    // The rail's phase select reads the backlog by name, not as an empty value.
    await expect(page.getByRole('combobox', { name: 'Phase of EXMP-REQ-007' })).toContainText('Backlog — no phase');
  });
});

test.describe('the generated views (T-3.9)', () => {
  test('the scope of work is generated from the phases and tasks', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/scope-of-work');

    await expect(page.getByRole('heading', { name: 'Scope of work' })).toBeVisible();
    await expect(page.getByText('not a document anybody maintains')).toBeVisible();
    // Build order, which is the order the phases were authored in — not numeric order.
    await expect(page.getByRole('link', { name: /EXMP-T-/ }).first()).toBeVisible();
  });

  test('the register carries the coverage arithmetic above the rows', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/register');

    await expect(page.getByRole('heading', { name: 'Requirements register' })).toBeVisible();
    await expect(page.getByText('Musts covered')).toBeVisible();
    await expect(page.getByRole('link', { name: 'EXMP-REQ-001' })).toBeVisible();
  });

  test('both are reachable from the project, because a view nobody can find is a document', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/projects/EXMP');

    // Both are reachable from the sidebar, under Knowledge. The overview's map of section tiles is
    // gone (FRM-T-18.8): the sidebar already carries every section, from every screen.
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Requirements' }).first()).toBeVisible();
    const knowledge = nav.getByRole('button', { name: 'Knowledge' });
    if ((await knowledge.getAttribute('aria-expanded')) !== 'true') await knowledge.click();
    for (const name of ['Scope of work', 'Register']) {
      await expect(nav.getByRole('link', { name })).toBeVisible();
    }
  });
});
