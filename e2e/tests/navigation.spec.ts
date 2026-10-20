import { expect, test, type Page } from '@playwright/test';

/**
 * Every destination in the sidebar has a screen behind it.
 *
 * "Projects" was a static link to `/projects` — a path the router has never matched, because it
 * only ever handled `/projects/:code`. Clicking it rendered "That page does not exist", and no
 * test noticed: the suite navigated by URL, so it exercised the routes that exist rather than the
 * links the person can actually click.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

test.describe('the sidebar', () => {
  test('every link lands on a screen, and none on the not-found', async ({ page }) => {
    await signIn(page);

    const nav = page.getByRole('navigation').first();
    // The Library folds its rows away (FRM-T-16.4); a closed one's links are hidden, so open it.
    const library = nav.getByRole('button', { name: 'Library' });
    if ((await library.getAttribute('aria-expanded')) === 'false') await library.click();
    const hrefs = await nav.getByRole('link').evaluateAll((links) =>
      links.map((l) => l.getAttribute('href')).filter((h): h is string => h !== null && h.startsWith('/')),
    );

    // Guard the guard: an empty list would make every assertion below vacuously true.
    expect(hrefs.length).toBeGreaterThan(3);

    for (const href of hrefs) {
      await page.goto(href);
      await expect(page.getByText('That page does not exist'), `${href} has no screen`).toHaveCount(
        0,
      );
    }
  });

  test('reaches a project through Projects, not through a list of every project', async ({
    page,
  }) => {
    await signIn(page);

    // The sidebar used to list every project, which does not survive twenty of them. It offers
    // the screen that lists them instead, and that screen is a real route — it was previously a
    // link to `/projects`, which the router had never handled and which rendered not-found.
    const nav = page.getByRole('navigation').first();
    await nav.getByRole('link', { name: 'Projects' }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByText('That page does not exist')).toHaveCount(0);

    await page.getByRole('link', { name: /Example Project/ }).first().click();
    await expect(page).toHaveURL(/\/projects\/EXMP$/);
  });

  test("shows the current project's sections, from inside any one of them", async ({ page }) => {
    await signIn(page);

    // The navigation fix this replaced: two clicks into a project the sidebar offered ten other
    // projects and no way to this one's phases, so the only route onwards was the back button.
    await page.goto('/projects/EXMP/adrs');
    const nav = page.getByRole('navigation').first();

    await expect(nav.getByRole('link', { name: 'Phases' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Requirements' })).toBeVisible();

    await nav.getByRole('link', { name: 'Phases' }).click();
    await expect(page).toHaveURL(/\/projects\/EXMP\/phases$/);
  });

  test('the section chrome names the project, and climbs back to it', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/adrs');

    // A breadcrumb, rather than a three-character link in the corner.
    await page.getByRole('link', { name: 'Example Project' }).first().click();
    await expect(page).toHaveURL(/\/projects\/EXMP$/);
  });

  test('still says so plainly for a path that really is nothing', async ({ page }) => {
    await signIn(page);
    await page.goto('/no-such-screen');

    // The fix is a sidebar that does not link to nowhere, not a router that pretends everything
    // exists.
    await expect(page.getByText('That page does not exist')).toBeVisible();
  });
});
