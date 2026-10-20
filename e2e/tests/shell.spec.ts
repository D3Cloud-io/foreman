import { expect, test, type Page } from '@playwright/test';

/**
 * The family shell (FRM-T-16.4, FRM-ADR-025, FRM-DA-001).
 *
 * Foreman's frame used to disagree with Shipyard's on sight: a recessed sheet, 22 uncounted rows in
 * a project with Drift 21st and below the fold at 900px, Health and API tokens as permanent rows,
 * and a record page that dropped its project the moment you opened it. Each of those is asserted
 * gone here, at the size the audit measured it.
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

test.describe('the sidebar at 1440×900', () => {
  test.use({ viewport: LAPTOP });

  for (const path of ['/projects/EXMP', '/requirements/EXMP-REQ-001']) {
    test(`shows every row on ${path}, Drift included, without scrolling`, async ({ page }) => {
      await signIn(page);
      await page.goto(path);
      const nav = page.getByRole('navigation', { name: 'Main' });
      const drift = nav.getByRole('link', { name: 'Drift' });
      await expect(drift).toBeVisible();

      // The footer's top is where the list must end: a row behind the account menu is not visible.
      const footer = await page.getByRole('link', { name: /Foreman healthy|Health ·/ }).boundingBox();
      expect(footer).not.toBeNull();
      const rows = nav.locator('a, button');
      const count = await rows.count();
      expect(count).toBeGreaterThan(8);
      for (let i = 0; i < count; i++) {
        const row = rows.nth(i);
        if (!(await row.isVisible())) continue;
        const box = await row.boundingBox();
        const name = (await row.textContent()) ?? '';
        expect(box, name).not.toBeNull();
        if (box !== null && footer !== null) {
          expect(box.y + box.height, `${name} is below the fold`).toBeLessThanOrEqual(footer.y);
        }
      }

      // And nothing is scrolled to get there.
      const scrolled = await nav.evaluate((el) => {
        // The nearest ancestor that scrolls its own content, short of the document itself.
        for (let node: Element | null = el; node !== null; node = node.parentElement) {
          if (node.tagName === 'HTML' || node.tagName === 'BODY') return false;
          if (node.scrollHeight > node.clientHeight + 1 && getComputedStyle(node).overflowY !== 'visible') return true;
        }
        return false;
      });
      expect(scrolled, 'the sidebar has to scroll').toBe(false);
    });
  }

  test('puts Drift second in the project, under Overview', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP');
    const block = page.getByRole('navigation', { name: 'Main' }).getByRole('group', { name: 'Example Project' });
    await block.getByRole('link', { name: 'Drift' }).waitFor();
    // A row's text ends with its count when it has one ("Activity2"); the order is the label's.
    const labels = (await block.getByRole('link').allTextContents()).map((text) => text.replace(/\d+$/, ''));
    expect(labels.slice(0, 6)).toEqual(['Overview', 'Drift', 'Phases', 'Requirements', 'Activity', 'Audits']);
  });

  test('has no Health or API tokens row, and a health line in the footer', async ({ page }) => {
    await signIn(page);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Health', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'API tokens' })).toHaveCount(0);

    await page.getByRole('link', { name: /Foreman healthy|Health ·/ }).click();
    await expect(page).toHaveURL(/\/system$/);
  });

  test('reaches API tokens as Connect an agent, from the Library and the account menu', async ({ page }) => {
    await signIn(page);
    const nav = page.getByRole('navigation', { name: 'Main' });
    const library = nav.getByRole('button', { name: 'Library' });
    if ((await library.getAttribute('aria-expanded')) === 'false') await library.click();
    await nav.getByRole('link', { name: 'Connect an agent' }).click();
    await expect(page).toHaveURL(/\/tokens$/);

    await page.goto('/');
    await page.getByRole('button', { name: new RegExp(EMAIL) }).click();
    await page.getByRole('menuitem', { name: 'Connect an agent' }).click();
    await expect(page).toHaveURL(/\/tokens$/);
  });
});

test.describe('a fold in the sidebar', () => {
  test.use({ viewport: LAPTOP });

  test('is a button saying whether it is open, remembered across a reload', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP');
    const nav = page.getByRole('navigation', { name: 'Main' });
    const knowledge = nav.getByRole('button', { name: 'Knowledge' });
    await expect(knowledge).toHaveAttribute('aria-expanded', 'false');
    await expect(nav.getByRole('link', { name: 'Documents' })).toHaveCount(0);

    await knowledge.click();
    await expect(knowledge).toHaveAttribute('aria-expanded', 'true');
    await expect(nav.getByRole('link', { name: 'Documents' })).toBeVisible();

    await page.reload();
    await expect(nav.getByRole('button', { name: 'Knowledge' })).toHaveAttribute('aria-expanded', 'true');

    // Put it back, so the rest of the suite starts from the default.
    await nav.getByRole('button', { name: 'Knowledge' }).click();
    await expect(nav.getByRole('button', { name: 'Knowledge' })).toHaveAttribute('aria-expanded', 'false');
  });

  test('opens itself when it holds the page you are on', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/glossary');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('button', { name: 'Knowledge' })).toHaveAttribute('aria-expanded', 'true');
    await expect(nav.getByRole('link', { name: 'Glossary' })).toHaveAttribute('aria-current', 'page');
  });
});

test.describe('counts', () => {
  test.use({ viewport: LAPTOP });

  test('are not shown at zero', async ({ page }) => {
    await page.route('**/api/findings?*', (route) =>
      route.fulfill({ json: { items: [], nextCursor: null, total: 0 } }),
    );
    await page.route('**/api/brief/EXMP', async (route) => {
      const response = await route.fetch();
      const brief = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...brief, unconfirmedAttributions: 0 } });
    });
    await signIn(page);
    await page.goto('/projects/EXMP');
    await page.waitForLoadState('networkidle');

    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Findings', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Activity', exact: true })).toBeVisible();
  });

  test('say what needs you, and keep the destination in the name', async ({ page }) => {
    const critical = { humanId: 'EXMP-CR-901', severity: 'critical', status: 'open', title: 'stub' };
    await page.route('**/api/findings?*', (route) =>
      route.fulfill({ json: { items: [critical, { ...critical, humanId: 'EXMP-CR-902' }], nextCursor: null, total: 2 } }),
    );
    await page.route('**/api/brief/EXMP', async (route) => {
      const response = await route.fetch();
      const brief = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...brief, unconfirmedAttributions: 3 } });
    });
    await signIn(page);
    await page.goto('/projects/EXMP');

    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Findings, 2 open critical' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Activity, 3 waiting for review' })).toBeVisible();

    await page.setViewportSize(PHONE);
    await expect(
      page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Findings, 2 open critical' }),
    ).toBeVisible();
  });
});

test.describe('a record page keeps its project', () => {
  const RECORDS = [
    { path: '/requirements/EXMP-REQ-001', current: 'Requirements' },
    { path: '/tasks/EXMP-T-1.1', current: 'Phases' },
    { path: '/findings/EXMP-CR-001', current: null },
  ];

  for (const record of RECORDS) {
    test(`on ${record.path}: the project block, the trail and the phone tab`, async ({ page }) => {
      await page.setViewportSize(LAPTOP);
      await signIn(page);
      await page.goto(record.path);

      const block = page.getByRole('navigation', { name: 'Main' }).getByRole('group', { name: 'Example Project' });
      await expect(block.getByRole('link', { name: 'Drift' })).toBeVisible();
      if (record.current !== null) {
        await expect(block.getByRole('link', { name: record.current })).toHaveAttribute('aria-current', 'page');
      }

      const trail = page.getByRole('navigation', { name: 'Breadcrumb' });
      await expect(trail.getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/projects');
      await trail.getByRole('link', { name: 'Example Project' }).click();
      await expect(page).toHaveURL(/\/projects\/EXMP$/);

      await page.setViewportSize(PHONE);
      await page.goto(record.path);
      const tab = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'EXMP' });
      await expect(tab).toHaveAttribute('href', '/projects/EXMP');
      await expect(tab).toHaveAttribute('aria-current', 'page');
    });
  }
});

test.describe('an unknown project code', () => {
  for (const path of ['/projects/ZZZ', '/projects/ZZZ/drift', '/requirements/ZZZ-REQ-001']) {
    test(`${path} is the plain not-found page, with no project anywhere`, async ({ page }) => {
      await page.setViewportSize(LAPTOP);
      await signIn(page);
      await page.goto(path);
      await expect(page.getByText('That page does not exist')).toBeVisible();
      const nav = page.getByRole('navigation', { name: 'Main' });
      await expect(nav.getByRole('link', { name: 'Overview' })).toHaveCount(0);
      await expect(nav.getByRole('group', { name: 'ZZZ' })).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toHaveCount(0);

      await page.setViewportSize(PHONE);
      const tabs = page.getByRole('navigation', { name: 'Primary' });
      await expect(tabs.getByRole('link', { name: 'ZZZ' })).toHaveCount(0);
    });
  }
});

test('⌘K goes to Search, with the cursor in it', async ({ page }) => {
  await page.setViewportSize(LAPTOP);
  await signIn(page);
  await page.goto('/projects/EXMP');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Drift' }).waitFor();
  // The platform the page believes it is on, not the machine running the suite: Desktop Chrome's
  // user agent says Windows wherever it runs.
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  await page.keyboard.press(mac ? 'Meta+k' : 'Control+k');
  await expect(page).toHaveURL(/\/search$/);
  await expect(page.getByRole('textbox', { name: 'Find' })).toBeFocused();
});
