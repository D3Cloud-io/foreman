import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * The command palette and the `?` sheet (FRM-REQ-244, FRM-T-18.5).
 *
 * ⌘K and `/` open @d3cloud/ui's CommandPalette: an exact human ID is one Jump row, anything else is
 * Go to (screens, projects, groups) and then Records from /api/search; `?` opens a sheet of the keys.
 * Neither opens while a dialog is open or focus is in a text field (⌘K excepted, in a one-line one).
 * Run against the seeded example project, EXMP.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';

const LAPTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

/** ⌘K on a Mac, Ctrl K elsewhere: the platform the page believes it is on, not the one running the suite. */
async function chord(page: Page): Promise<string> {
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  return mac ? 'Meta' : 'Control';
}

const paletteOf = (page: Page) => page.getByRole('dialog', { name: 'Search and jump' });
const sheetOf = (page: Page) => page.getByRole('dialog', { name: 'Keyboard shortcuts' });

test.describe('on a laptop', () => {
  test.use({ viewport: LAPTOP });

  test('an exact ID is one Jump row, and Enter goes straight to the record', async ({ page }) => {
    await signIn(page);
    await page.keyboard.press(`${await chord(page)}+k`);
    const palette = paletteOf(page);
    await expect(palette).toBeVisible();
    const input = palette.getByRole('combobox', { name: 'Search and jump' });
    await input.fill('exmp-req-001');

    const rows = palette.getByRole('option');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('EXMP-REQ-001');
    await expect(palette.getByRole('group', { name: 'Jump to' })).toBeVisible();
    // Resolved locally: no Go to, no Records.
    await expect(palette.getByText('Records')).toHaveCount(0);

    await input.press('Enter');
    await expect(page).toHaveURL(/\/requirements\/EXMP-REQ-001$/);
    await expect(palette).toBeHidden();
  });

  test('other kinds of ID jump too: a task, a finding, a project idea', async ({ page }) => {
    await signIn(page);
    for (const [id, url] of [
      ['EXMP-T-1.1', /\/tasks\/EXMP-T-1\.1$/],
      ['EXMP-CR-001', /\/findings\/EXMP-CR-001$/],
      ['PI-001', /\/project-ideas\/PI-001$/],
    ] as const) {
      await page.keyboard.press('/');
      const input = paletteOf(page).getByRole('combobox');
      await input.fill(id);
      await input.press('Enter');
      await expect(page).toHaveURL(url);
    }
  });

  test('a word lists Go to first, and Enter on a screen goes there', async ({ page }) => {
    await signIn(page);
    await page.keyboard.press('/');
    const palette = paletteOf(page);
    await expect(palette).toBeVisible();
    // With no query, the screens alone.
    await expect(palette.getByRole('group', { name: 'Go to' })).toBeVisible();
    await expect(palette.getByRole('option', { name: /Findings/ })).toBeVisible();

    const input = palette.getByRole('combobox');
    await input.fill('exmp');
    const goTo = palette.getByRole('group', { name: 'Go to' });
    await expect(goTo.getByRole('option').first()).toContainText('EXMP');

    await input.fill('findings');
    await input.press('Enter');
    await expect(page).toHaveURL(/\/findings$/);
  });

  test('a project opens from Go to', async ({ page }) => {
    await signIn(page);
    await page.keyboard.press(`${await chord(page)}+k`);
    const input = paletteOf(page).getByRole('combobox');
    await input.fill('exmp');
    await paletteOf(page).getByRole('option', { name: /EXMP/ }).first().click();
    await expect(page).toHaveURL(/\/projects\/EXMP$/);
  });

  test('⌘↵ hands the query to Search, in the scope', async ({ page }) => {
    await signIn(page);
    await page.goto('/findings');
    await page.keyboard.press('/');
    const input = paletteOf(page).getByRole('combobox');
    await input.fill('decision');
    await input.press(`${await chord(page)}+Enter`);
    await expect(page).toHaveURL(/\/search\?q=decision/);
  });

  test('⌘K again, or Escape, closes it and returns focus', async ({ page }) => {
    await signIn(page);
    const key = `${await chord(page)}+k`;
    await page.keyboard.press(key);
    await expect(paletteOf(page)).toBeVisible();
    await page.keyboard.press(key);
    await expect(paletteOf(page)).toBeHidden();
    await page.keyboard.press('/');
    await expect(paletteOf(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(paletteOf(page)).toBeHidden();
  });

  test('? opens the shortcut sheet, built from key caps', async ({ page }) => {
    await signIn(page);
    await page.keyboard.press('Shift+/');
    const sheet = sheetOf(page);
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Open the command palette')).toBeVisible();
    await expect(sheet.locator('kbd.d3-kbd').first()).toBeVisible();
    expect(await sheet.locator('kbd.d3-kbd').count()).toBeGreaterThanOrEqual(6);
    // A dialog is open, so the palette key does nothing.
    await page.keyboard.press('/');
    await expect(paletteOf(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  test('/ and ? are characters in a text field, not shortcuts; ⌘K still works in a one-line one', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/search');
    const find = page.getByRole('textbox', { name: 'Find' });
    await find.click();
    await page.keyboard.type('a/b?');
    await expect(find).toHaveValue('a/b?');
    await expect(paletteOf(page)).toHaveCount(0);
    await expect(sheetOf(page)).toHaveCount(0);

    await page.keyboard.press(`${await chord(page)}+k`);
    await expect(paletteOf(page)).toBeVisible();
  });

  test('none of it opens while a dialog is open', async ({ page }) => {
    await signIn(page);
    await page.goto('/tasks/EXMP-T-1.1');
    await page.getByRole('button', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible();
    await page.keyboard.press(`${await chord(page)}+k`);
    await page.keyboard.press('/');
    await page.keyboard.press('Shift+/');
    await expect(paletteOf(page)).toHaveCount(0);
    await expect(sheetOf(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/tasks\/EXMP-T-1\.1$/);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`the palette and the sheet have no axe violations — ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await signIn(page);
      const axe = () =>
        new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();

      await page.keyboard.press('/');
      const input = paletteOf(page).getByRole('combobox');
      await input.fill('exmp');
      await expect(paletteOf(page).getByRole('option').first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect((await axe()).violations.map((v) => v.id)).toEqual([]);
      await page.keyboard.press('Escape');

      await page.keyboard.press('Shift+/');
      await expect(sheetOf(page)).toBeVisible();
      expect((await axe()).violations.map((v) => v.id)).toEqual([]);
    });
  }
});

test.describe('on a phone', () => {
  test.use({ viewport: PHONE });

  test('the top bar’s search button opens the palette full-screen', async ({ page }) => {
    await signIn(page);
    const button = page.getByRole('button', { name: 'Search', exact: true });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    await button.click();
    const palette = paletteOf(page);
    await expect(palette).toBeVisible();
    const size = await palette.boundingBox();
    expect(size?.width).toBe(PHONE.width);
    expect(size?.height).toBe(PHONE.height);

    await palette.getByRole('combobox').fill('EXMP-REQ-001');
    await palette.getByRole('option').first().click();
    await expect(page).toHaveURL(/\/requirements\/EXMP-REQ-001$/);
  });

  test('a phone has no Escape: the palette has a Close button', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await paletteOf(page).getByRole('button', { name: 'Close' }).click();
    await expect(paletteOf(page)).toBeHidden();
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`the full-screen palette has no axe violations — ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await signIn(page);
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await paletteOf(page).getByRole('combobox').fill('exmp');
      await expect(paletteOf(page).getByRole('option').first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations.map((v) => v.id)).toEqual([]);
    });
  }
});
