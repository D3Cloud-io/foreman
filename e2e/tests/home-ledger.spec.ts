import { expect, test, type Page } from '@playwright/test';

/**
 * Home as the grouped portfolio ledger (FRM-T-18.6, FRM-REQ-245, FRM-DA-006, board D-06).
 *
 * Two projects in a group of this run's own, with names unique to it: one mid-flight with a phase,
 * a next task and a critical finding, one with nothing planned. The spec asserts the Needs-you
 * strip, the ledger's columns, CI saying "never", the row disclosure, the served fields, and that
 * a phone row is two lines.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';

const RUN = Date.now().toString(36).slice(-4).toUpperCase();
const GROUP = `Ledger ${RUN}`;
const BUSY = `LB${RUN}`;
const EMPTY = `LE${RUN}`;
const NEXT_TITLE = `Verify the signature ${RUN}`;

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

interface Row {
  code: string;
  ciState: string;
  nextTask: { humanId: string; title: string } | null;
  deployed: { sha: string; at: string; ahead: number | null } | null;
}

test.describe('the portfolio ledger on Home', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await signIn(page);
    const group = await page.request.post('/api/groups', { data: { name: GROUP, accent: 'foreman' } });
    expect(group.status(), await group.text()).toBe(201);
    const { humanId } = (await group.json()) as { humanId: string };
    for (const code of [BUSY, EMPTY]) {
      const created = await page.request.post('/api/projects', {
        data: { code, name: `Ledger ${code}`, group: humanId },
      });
      expect(created.status(), await created.text()).toBe(201);
    }
    const phase = await page.request.post(`/api/projects/${BUSY}/phases`, {
      data: { number: 1, name: 'Ingest' },
    });
    expect(phase.status(), await phase.text()).toBe(201);
    const task = await page.request.post(`/api/projects/${BUSY}/tasks?phase=${BUSY}-P-1`, {
      data: { title: NEXT_TITLE },
    });
    expect(task.status(), await task.text()).toBe(201);
    const finding = await page.request.post(`/api/projects/${BUSY}/findings`, {
      data: { title: `Ledger finding ${RUN}`, severity: 'critical' },
    });
    expect(finding.status(), await finding.text()).toBe(201);
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('/api/portfolio rows carry nextTask, a CI word and the deploy state, additively', async ({ page }) => {
    const res = await page.request.get('/api/portfolio');
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { items: Row[]; groups: { projects: Row[] }[] };
    const busy = body.items.find((row) => row.code === BUSY);
    expect(busy?.nextTask).toMatchObject({ title: NEXT_TITLE });
    expect(busy?.ciState).toBe('never');
    expect(busy?.deployed).toBeNull();
    expect(body.items.find((row) => row.code === EMPTY)?.nextTask).toBeNull();
    // The sections carry the same rows: the console makes no call per project.
    const sectioned = body.groups.flatMap((g) => g.projects).find((row) => row.code === BUSY);
    expect(sectioned?.nextTask).toEqual(busy?.nextTask);
  });

  test('Home opens with a compact strip, ONE Needs-you strip, then the grouped ledger', async ({ page }) => {
    await page.goto('/');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();

    // One strip, not one per group, and above every group's section.
    const strip = main.getByRole('group', { name: 'Needs you' });
    await expect(strip).toHaveCount(1);
    await expect(strip.getByRole('link', { name: new RegExp(BUSY) }).first()).toBeVisible();
    await expect(strip.getByRole('link', { name: /1 critical \+ high/ })).toBeVisible();
    // Nothing is planned for the empty one, and CI that never reported is not "failing".
    await expect(strip.getByRole('link', { name: new RegExp(EMPTY) })).toHaveCount(0);

    const order = await main.evaluate((el) => {
      const first = (sel: string) => Array.from(el.querySelectorAll(sel))[0];
      const ny = el.querySelector('.fm-needsyou');
      const sec = first('section[aria-labelledby]');
      const stat = el.querySelector('.fm-sstrip');
      const pos = (n: Element | null | undefined) => (n === null || n === undefined ? -1 : n.getBoundingClientRect().top);
      return { stat: pos(stat), ny: pos(ny), sec: pos(sec) };
    });
    expect(order.stat).toBeLessThan(order.ny);
    expect(order.ny).toBeLessThan(order.sec);

    // Nothing is draggable.
    await expect(page.locator('[draggable="true"]')).toHaveCount(0);
  });

  test('a ledger row names its phase with progress, next task, drift, needs-you and CI "never"', async ({ page }) => {
    await page.goto('/');
    const section = page.getByRole('main').getByRole('region', { name: GROUP });
    const busy = section.getByRole('listitem').filter({ has: page.getByRole('link', { name: new RegExp(BUSY) }) });
    await expect(busy.getByRole('link', { name: /P-1 · Ingest/ })).toBeVisible();
    await expect(busy.getByText('0 of 1 tasks')).toBeVisible();
    await expect(busy.getByRole('link', { name: new RegExp(NEXT_TITLE) })).toHaveAttribute(
      'href',
      new RegExp(`/tasks/${BUSY}-T-`),
    );
    await expect(busy.getByRole('link', { name: /1 critical \+ high/ })).toBeVisible();
    // CI that never reported is its own word, and a link to where it would show.
    await expect(busy.getByRole('link', { name: /CI\s+never/ })).toBeVisible();

    const empty = section.getByRole('listitem').filter({ has: page.getByRole('link', { name: new RegExp(EMPTY) }) });
    await expect(empty.getByText('No plan yet')).toBeVisible();
    await expect(empty.getByText('not measurable yet').first()).toBeVisible();
    await expect(empty.getByRole('link', { name: /CI\s+never/ })).toBeVisible();
  });

  test('the row opens a disclosure with deployed-vs-main and last activity, and closes it again', async ({ page }) => {
    await page.goto('/');
    const section = page.getByRole('main').getByRole('region', { name: GROUP });
    const toggle = section.getByRole('button', { name: `Show details for Ledger ${BUSY}` });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(section.getByText('Deployed vs main').first()).toBeHidden();

    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(section.getByText('Deployed vs main').first()).toBeVisible();
    await expect(section.getByText('Never recorded as deployed.').first()).toBeVisible();
    await expect(section.getByText('Last activity').first()).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('a group section still collapses, and the ledger goes with it', async ({ page }) => {
    await page.goto('/');
    const main = page.getByRole('main');
    const toggle = main.getByRole('button', { name: `${GROUP} projects` });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(
      main.getByRole('region', { name: GROUP }).getByRole('link', { name: new RegExp(`^${BUSY}`) }),
    ).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('a project is a two-line item, and the page does not scroll sideways', async ({ page }) => {
      await page.goto('/');
      const section = page.getByRole('main').getByRole('region', { name: GROUP });
      const row = section.getByRole('listitem').filter({ has: page.getByRole('link', { name: new RegExp(BUSY) }) });
      await expect(row).toBeVisible();

      const box = await row.boundingBox();
      // Two lines of text and their padding — never a tall card and never three lines.
      expect(box?.height ?? 0).toBeLessThan(110);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);

      // The disclosure is there and is a real target.
      const toggle = row.getByRole('button', { name: /Show details/ });
      const size = await toggle.boundingBox();
      expect(size?.height ?? 0).toBeGreaterThanOrEqual(24);
    });
  });
});
