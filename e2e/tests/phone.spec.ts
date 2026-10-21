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
    await expect(bar.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');

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
  /** Opens a sidebar disclosure (Library, Knowledge) if it is closed, so its rows are links again. */
  async function open(scope: ReturnType<Page['getByRole']>, name: string): Promise<void> {
    const toggle = scope.getByRole('button', { name });
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  }

  for (const path of ['/', '/projects/EXMP/requirements']) {
    test(`from ${path}, through the drawer and the tab bar`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await signIn(page);
      await page.goto(path);
      const main = page.getByRole('navigation', { name: 'Main' });
      await main.getByRole('link').first().waitFor();
      await open(main, 'Library');
      if (path.startsWith('/projects/')) await open(main, 'Knowledge');
      const wide = await hrefsIn(page, 'Main');
      expect(wide.length).toBeGreaterThan(5);

      // On a phone the tab bar carries the everyday destinations, so the drawer holds the rest
      // (FRM-T-16.4): between them, everything the laptop's sidebar offers.
      await page.setViewportSize(PHONE);
      await page.getByRole('navigation', { name: 'Primary' }).getByRole('link').first().waitFor();
      const tabs = await hrefsIn(page, 'Primary');
      await page.getByRole('button', { name: 'Open navigation' }).click();
      const drawer = page.getByRole('dialog', { name: 'Navigation' });
      await expect(drawer).toBeVisible();
      await open(drawer, 'Library');
      if (path.startsWith('/projects/')) await open(drawer, 'Knowledge');
      const narrow = await hrefsIn(page, 'Main');
      for (const href of wide) {
        expect([...narrow, ...tabs], `${href} is on a laptop and nowhere on a phone`).toContain(href);
      }
      // The drawer does not repeat the four everyday tabs. The fifth follows where you are (the
      // project, or Project ideas), and its row in the drawer is where it sits among its kind.
      const everyday = tabs.slice(0, 4);
      expect(narrow.filter((href) => everyday.includes(href))).toEqual([]);

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
 *
 * This is the quick check over the controls Foreman's own classes name. `touch-targets.spec.ts`
 * (FRM-REQ-249) is the gate over every screen and every interactive element, the library's included.
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
    '/projects',
    '/groups',
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

  // A family's site can be a long address with no break in it; it must not push the page wide.
  test('a group with a long site address', async ({ page }) => {
    await signIn(page);
    const name = `Long site ${Date.now().toString(36)}`;
    const created = await page.request.post('/api/groups', {
      data: { name, siteUrl: `https://example.com/${'a-very-long-unbroken-path-segment'.repeat(3)}` },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { slug } = (await created.json()) as { slug: string };
    for (const path of ['/', '/groups', `/groups/${slug}`]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} scrolls sideways by ${String(overflow)}px`).toBeLessThanOrEqual(0);
    }
  });

  for (const path of ['/', '/projects', '/projects/EXMP', '/projects/EXMP/requirements', '/findings', '/tokens', '/groups']) {
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

/**
 * FRM-REQ-249: below 768px a table keeps each row's title, status and primary control, folds the
 * rest into a sub-line, and does not scroll sideways; a stat is one line; and the lifecycle badge
 * is a pill on the phone's ground in both themes (MOB-01, MOB-03, MOB-05, MOB-07, MOB-11).
 */
test.describe('tables, stats and badges on a phone', () => {
  test.use({ viewport: PHONE });

  // Members is a board screen, absent on a solo Foreman (FRM-ADR-016), so it is not reachable here.
  const TABLES = [
    ...['requirements', 'register', 'risks', 'glossary', 'audits', 'documents', 'screens'].map((section) => `/projects/EXMP/${section}`),
    '/system',
  ];

  async function phaseWithTasks(page: Page): Promise<string> {
    const res = await page.request.get('/api/projects/EXMP/phases');
    expect(res.ok(), await res.text()).toBe(true);
    const items = ((await res.json()) as { items: { humanId: string; tasks: { total: number } }[] }).items;
    const phase = items.find((p) => p.tasks.total > 0) ?? items[0];
    expect(phase, 'the example project has a phase').toBeDefined();
    return phase?.humanId ?? '';
  }

  for (const path of TABLES) {
    test(`${path}: no table scrolls sideways`, async ({ page }) => {
      await signIn(page);
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const widths = await page.evaluate(() => [
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ...[...document.querySelectorAll('.d3-tbl-scroll')].map((el) => el.scrollWidth - el.clientWidth),
      ]);
      expect(widths.length, 'the screen draws a table').toBeGreaterThan(1);
      expect(widths, `${path} scrolls sideways`).toEqual(widths.map(() => 0));
    });
  }

  test('a phase keeps the task and its status select, and folds the rest under the title', async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/EXMP/phases/${await phaseWithTasks(page)}`);
    await page.waitForLoadState('networkidle');

    const table = page.getByRole('table', { name: /^Tasks in / });
    await expect(table.getByRole('columnheader')).toHaveText([/^Task/, /^Status/]);
    const select = table.getByRole('combobox', { name: /^Status of / }).first();
    await expect(select).toBeVisible();
    const box = await select.boundingBox();
    expect(box, 'the status select has a box').not.toBeNull();
    // On screen, not off the right edge of a box that scrolls.
    if (box !== null) expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    // What folded is still there, in the sub-line.
    await expect(table.locator('.fm-subline').first()).toContainText('Satisfies');
  });

  test('a stat is one line: its label and its figure share a row', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/requirements');
    await page.waitForLoadState('networkidle');
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('.fm-stat')].map((card) => {
        const label = card.querySelector('.fm-stat__label')?.getBoundingClientRect();
        const value = card.querySelector('.fm-stat__value')?.getBoundingClientRect();
        const box = card.getBoundingClientRect();
        return {
          height: box.height,
          apart: label === undefined || value === undefined ? 999 : Math.abs(label.top + label.height / 2 - (value.top + value.height / 2)),
        };
      }),
    );
    expect(rows.length, 'the screen draws stat cards').toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.apart).toBeLessThanOrEqual(12);
      expect(row.height).toBeLessThanOrEqual(72);
    }
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`the lifecycle badge is not the page ground (${theme})`, async ({ page }) => {
      await signIn(page);
      await page.goto('/projects/EXMP');
      await page.waitForLoadState('networkidle');
      await page.evaluate((mode) => { document.documentElement.setAttribute('data-theme', mode); }, theme);

      const badge = page.locator('.fm-badge').filter({ hasText: /^(planned|scaffolded|building|deployed|parked|scrapped)$/ }).first();
      await expect(badge).toBeVisible();
      const look = await badge.evaluate((el) => {
        const style = getComputedStyle(el);
        const ground = getComputedStyle(document.querySelector('main') ?? document.body).backgroundColor;
        return { background: style.backgroundColor, border: style.borderTopColor, borderWidth: style.borderTopWidth, ground };
      });
      expect(look.background, 'its fill is not the ground it sits on').not.toBe(look.ground);
      // And an outline, so a fill that is close is still a pill.
      expect(look.borderWidth).not.toBe('0px');
      expect(look.border).not.toBe(look.ground);
    });
  }
});
