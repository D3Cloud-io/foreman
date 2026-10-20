import { expect, test, type Page } from '@playwright/test';

/**
 * The console on a phone (FRM-T-16.1).
 *
 * Below the shell's 1024px line the sidebar becomes a drawer behind the top bar's menu button and
 * a tab bar of five rides the foot of the screen (FRM-REQ-217). Two things can quietly go wrong
 * there, and both are asserted here: a destination that exists on a laptop and nowhere on a phone,
 * and a control sized for a cursor rather than a thumb (FRM-REQ-219).
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';

const PHONE = { width: 390, height: 844 };

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

async function hrefsIn(page: Page, name: string): Promise<string[]> {
  return page
    .getByRole('navigation', { name })
    .getByRole('link')
    .evaluateAll((links) => links.map((l) => l.getAttribute('href') ?? ''));
}

test.describe('the tab bar', () => {
  test.use({ viewport: PHONE });

  test('carries at most five destinations, and the fifth follows the project you are in', async ({ page }) => {
    await signIn(page);

    const bar = page.getByRole('navigation', { name: 'Primary' });
    await expect(bar).toBeVisible();
    expect(await hrefsIn(page, 'Primary')).toEqual(['/', '/projects', '/findings', '/search', '/project-ideas']);
    await expect(bar.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');

    // Inside a project the fifth tab is that project, so its overview is a tap from any section.
    await page.goto('/projects/EXMP/adrs');
    expect(await hrefsIn(page, 'Primary')).toEqual(['/', '/projects', '/findings', '/search', '/projects/EXMP']);
    await expect(bar.getByRole('link', { name: 'EXMP' })).toHaveAttribute('aria-current', 'page');

    // A tab routes inside the console rather than reloading it.
    await bar.getByRole('link', { name: 'Findings' }).click();
    await expect(page).toHaveURL(/\/findings$/);
    await expect(bar.getByRole('link', { name: 'Findings' })).toHaveAttribute('aria-current', 'page');
  });

  test('is a laptop’s sidebar from 1024px, and not a second copy of it', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await signIn(page);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  });

  test('never covers the end of the page', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); });

    const bar = await page.getByRole('navigation', { name: 'Primary' }).boundingBox();
    // The last thing in <main> before the bar's clearing block, which is aria-hidden.
    const last = await page.locator('main > :not([aria-hidden="true"]):not(nav)').last().boundingBox();
    expect(bar).not.toBeNull();
    expect(last).not.toBeNull();
    if (bar !== null && last !== null) expect(last.y + last.height).toBeLessThanOrEqual(bar.y);
  });
});

test.describe('every destination is reachable on a phone', () => {
  for (const path of ['/', '/projects/EXMP/requirements']) {
    test(`from ${path}, through the drawer`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await signIn(page);
      await page.goto(path);
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link').first().waitFor();
      // Inside a project the sidebar's last group arrives with the brief.
      if (path.startsWith('/projects/')) {
        await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Screens' }).waitFor();
      }
      const wide = await hrefsIn(page, 'Main');
      expect(wide.length).toBeGreaterThan(5);

      await page.setViewportSize(PHONE);
      await page.getByRole('button', { name: 'Open navigation' }).click();
      const drawer = page.getByRole('dialog', { name: 'Navigation' });
      await expect(drawer).toBeVisible();
      if (path.startsWith('/projects/')) await drawer.getByRole('link', { name: 'Screens' }).waitFor();
      const narrow = await hrefsIn(page, 'Main');
      expect(narrow).toEqual(wide);

      // And choosing one closes the drawer and goes there.
      await drawer.getByRole('link', { name: 'Guidelines' }).click();
      await expect(page).toHaveURL(/\/guidelines$/);
      await expect(drawer).toBeHidden();
    });
  }
});

/**
 * FRM-REQ-219: under a coarse pointer, every control the console draws itself is at least 44 by
 * 44. The library's own are the library's: 1.7 sizes Button, IconButton, SegmentedControl rows and
 * SideNav rows for a thumb (D-089), and the ones it does not yet — Select, Input, Checkbox, a
 * Table's sort header, PageHeader's back link, Link, AppShellBrand — are reported to the design
 * system rather than overridden here by selecting its class names. A link inside a sentence is
 * exempt, as WCAG 2.5.8 exempts it: it cannot grow without breaking the line it sits in.
 */
test.describe('a thumb, not a cursor', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  const SCREENS = [
    '/',
    '/project-ideas',
    '/project-ideas/PI-001',
    '/projects/EXMP',
    '/projects/EXMP/screens',
    '/findings',
  ];

  test('every control the console draws is at least 44 by 44', async ({ page }) => {
    await signIn(page);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

    const small: string[] = [];
    for (const path of SCREENS) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const found = await page.evaluate(() => {
        const out: string[] = [];
        const controls = document.querySelectorAll<HTMLElement>(
          'a[href][class*="fm-"], button[class*="fm-"], [role="button"][class*="fm-"], label.fm-radio, summary, nav[aria-label="Primary"] a',
        );
        for (const el of controls) {
          const box = el.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) continue;
          if (box.width < 44 || box.height < 44) {
            const name = (el.getAttribute('aria-label') ?? el.textContent).trim().slice(0, 40);
            out.push(`${String(Math.round(box.width))}x${String(Math.round(box.height))} ${el.className} "${name}"`);
          }
        }
        return out;
      });
      small.push(...found.map((line) => `${path}: ${line}`));
    }
    expect(small, small.join('\n')).toEqual([]);
  });
});

test.describe('no sideways scroll at 390', () => {
  test.use({ viewport: PHONE });

  for (const path of ['/', '/projects', '/projects/EXMP', '/projects/EXMP/requirements', '/findings', '/tokens']) {
    test(path, async ({ page }) => {
      await signIn(page);
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} scrolls sideways by ${String(overflow)}px`).toBeLessThanOrEqual(0);
    });
  }
});
