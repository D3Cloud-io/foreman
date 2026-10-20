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

/**
 * Opens the palette with `/` once the shell's key listener is bound. A page that has just loaded
 * has its navigation on screen a moment before React's effects have run, so the key is pressed
 * again until the palette answers: while it is open `/` does nothing, so this cannot toggle it.
 */
async function openWithSlash(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: /Main|Primary/ })
    .first()
    .waitFor();
  await expect(async () => {
    await page.keyboard.press('/');
    await expect(paletteOf(page)).toBeVisible({ timeout: 500 });
  }).toPass();
}

/** Axe reads a dialog mid-fade as washed-out text: wait for its entrance animation to finish. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
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
      // Each jump lands on a new page: wait for its shell to listen before pressing '/'.
      await openWithSlash(page);
      const input = paletteOf(page).getByRole('combobox');
      await input.fill(id);
      await input.press('Enter');
      await expect(page).toHaveURL(url);
    }
  });

  test('a word lists Go to first, and Enter on a screen goes there', async ({ page }) => {
    await signIn(page);
    await openWithSlash(page);
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
    await openWithSlash(page);
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
    await page.keyboard.press('?');
    const sheet = sheetOf(page);
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Open the command palette', { exact: true })).toBeVisible();
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

  test('the key that opened the palette does not land in its input, however long it is held', async ({
    page,
  }) => {
    await signIn(page);
    await openWithSlash(page);
    await page.keyboard.press('Escape');
    await expect(paletteOf(page)).toBeHidden();
    // `/` held: one keydown, then auto-repeats. The first opens it and takes focus; the repeats then
    // arrive in the input, where a real keyboard would type them, unless the shell cancels them.
    // A synthetic event inserts nothing, so what is asserted is that the repeat was cancelled
    // (`dispatchEvent` returns false) and that the palette is still open and empty.
    const repeatNotCancelled = await page.evaluate(async () => {
      const key = (repeat: boolean) =>
        new KeyboardEvent('keydown', { key: '/', code: 'Slash', repeat, bubbles: true, cancelable: true });
      document.body.dispatchEvent(key(false));
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      const target = document.querySelector<HTMLInputElement>('[role="dialog"] input') ?? document.body;
      return target.dispatchEvent(key(true));
    });
    expect(repeatNotCancelled).toBe(false);
    const input = paletteOf(page).getByRole('combobox');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('');
    // A held ⌘K does not toggle it shut.
    await page.keyboard.press('Escape');
    await expect(paletteOf(page)).toBeHidden();
    const mod = await chord(page);
    await page.evaluate((modifier) => {
      const init = {
        key: 'k',
        code: 'KeyK',
        bubbles: true,
        cancelable: true,
        metaKey: modifier === 'Meta',
        ctrlKey: modifier === 'Control',
      };
      document.body.dispatchEvent(new KeyboardEvent('keydown', init));
      window.setTimeout(() => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { ...init, repeat: true }));
      }, 100);
    }, mod);
    await expect(paletteOf(page)).toBeVisible();
    await page.waitForTimeout(300);
    await expect(paletteOf(page)).toBeVisible();
  });

  test('a key an input method is handling opens nothing', async ({ page }) => {
    await signIn(page);
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
    await page.evaluate(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '/',
          isComposing: true,
          keyCode: 229,
          bubbles: true,
          cancelable: true,
        }),
      );
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '?',
          isComposing: true,
          keyCode: 229,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await page.waitForTimeout(300);
    await expect(paletteOf(page)).toHaveCount(0);
    await expect(sheetOf(page)).toHaveCount(0);
  });

  test('closing the palette returns focus to where it was opened from', async ({ page }) => {
    await signIn(page);
    const opener = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Findings' });
    await opener.focus();
    await expect(opener).toBeFocused();
    await page.keyboard.press('/');
    await expect(paletteOf(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(paletteOf(page)).toBeHidden();
    await expect(opener).toBeFocused();

    // And the sheet.
    await page.keyboard.press('?');
    await expect(sheetOf(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheetOf(page)).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('Records follow the scope in the URL, and name it', async ({ page }) => {
    await signIn(page);
    const run = Date.now().toString(36);
    const make = async (name: string) => {
      const res = await page.request.post('/api/groups', { data: { name, accent: 'neutral' } });
      expect(res.status(), await res.text()).toBe(201);
      return (await res.json()) as { humanId: string; slug: string; name: string };
    };
    const filled = await make(`Palette filled ${run}`);
    const empty = await make(`Palette empty ${run}`);
    const code = `PL${run
      .slice(-5)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, 'X')}`;
    const project = await page.request.post('/api/projects', {
      data: { code, name: `Palette ${code}`, group: filled.humanId },
    });
    expect(project.status(), await project.text()).toBe(201);
    const title = `Palettefinding${run}`;
    const finding = await page.request.post(`/api/projects/${code}/findings`, {
      data: { title, severity: 'high' },
    });
    expect(finding.status(), await finding.text()).toBe(201);

    const records = (group: string) => paletteOf(page).getByRole('group', { name: `Records in ${group}` });

    await page.goto(`/findings?group=${filled.slug}`);
    await openWithSlash(page);
    const asked = page.waitForRequest(
      (req) => req.url().includes('/api/search') && req.url().includes(`group=${filled.slug}`),
    );
    await paletteOf(page).getByRole('combobox').fill(title);
    await asked;
    await expect(records(filled.name).getByRole('option')).toHaveCount(1);
    await expect(records(filled.name).getByRole('option').first()).toContainText(title);
    await page.keyboard.press('Escape');

    // The same word in a group with nothing in it finds no records.
    await page.goto(`/findings?group=${empty.slug}`);
    await openWithSlash(page);
    await paletteOf(page).getByRole('combobox').fill(title);
    await expect(paletteOf(page).getByText(`No results for “${title}”`)).toBeVisible();
    await expect(paletteOf(page).getByRole('option')).toHaveCount(0);
  });

  test('none of it opens while a dialog is open', async ({ page }) => {
    await signIn(page);
    await page.goto('/tasks/EXMP-T-1.1');
    await page.getByRole('button', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible();
    await page.keyboard.press(`${await chord(page)}+k`);
    await page.keyboard.press('/');
    await page.keyboard.press('?');
    await expect(paletteOf(page)).toHaveCount(0);
    await expect(sheetOf(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/tasks\/EXMP-T-1\.1$/);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`the palette and the sheet have no axe violations — ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await signIn(page);
      const axe = async () => {
        await settled(page);
        await settled(page);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        return {
          violations: results.violations.map(
            (v) =>
              `${v.id}: ${v.nodes.map((n) => `${n.target.join(' ')} ${n.any[0]?.message ?? ''}`).join(' | ')}`,
          ),
        };
      };

      await page.keyboard.press('/');
      const input = paletteOf(page).getByRole('combobox');
      await input.fill('exmp');
      await expect(paletteOf(page).getByRole('option').first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect((await axe()).violations).toEqual([]);
      await page.keyboard.press('Escape');
      // Still in the DOM while it leaves, and a dialog in the DOM keeps `?` from opening another.
      await expect(paletteOf(page)).toBeHidden();

      await page.keyboard.press('?');
      await expect(sheetOf(page)).toBeVisible();
      expect((await axe()).violations).toEqual([]);
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
    // It scales in over 200ms; the size is read once that has settled.
    await expect
      .poll(async () => {
        const size = await palette.boundingBox();
        return [size?.width, size?.height];
      })
      .toEqual([PHONE.width, PHONE.height]);

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
      await settled(page);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations.map((v) => v.id)).toEqual([]);
    });
  }
});
