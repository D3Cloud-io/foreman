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
/** Two reasons to need you (a critical finding, a blocked task) and a next task to show. */
const MULTI = `LM${RUN}`;
const NEXT_TITLE = `Verify the signature ${RUN}`;

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

/**
 * This spec's own group section. Every Home locator below starts here (or in the Needs-you strip,
 * narrowed to one project's item): other specs' groups and the seeded projects are on the same page,
 * and a locator that matches them is a single-match assumption that breaks the day one of them needs you.
 */
const section = (page: Page) => page.getByRole('main').getByRole('region', { name: GROUP, exact: true });
const rowOf = (page: Page, code: string) =>
  section(page)
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: new RegExp(`^${code}`) }) });

/** One project's card in the Needs-you strip, after opening it to every project (it shows six). */
async function needsYouItem(page: Page, code: string) {
  const strip = page.getByRole('main').getByRole('group', { name: 'Needs you' });
  const all = strip.getByRole('button', { name: /^Show all/ });
  if (await all.count()) await all.click();
  return strip.getByRole('listitem').filter({ has: page.getByRole('link', { name: new RegExp(`^${code}`) }) });
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
    for (const code of [BUSY, EMPTY, MULTI]) {
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
    const multiPhase = await page.request.post(`/api/projects/${MULTI}/phases`, {
      data: { number: 1, name: 'A phase with a rather long name' },
    });
    expect(multiPhase.status(), await multiPhase.text()).toBe(201);
    for (const data of [
      { title: `Blocked ${RUN}`, status: 'blocked', blockedReason: 'Waiting on the vendor' },
      { title: `A next task with a fairly long title ${RUN}` },
    ]) {
      const made = await page.request.post(`/api/projects/${MULTI}/tasks?phase=${MULTI}-P-1`, { data });
      expect(made.status(), await made.text()).toBe(201);
    }
    const multiFinding = await page.request.post(`/api/projects/${MULTI}/findings`, {
      data: { title: `Ledger multi finding ${RUN}`, severity: 'critical' },
    });
    expect(multiFinding.status(), await multiFinding.text()).toBe(201);
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
    const busy = await needsYouItem(page, BUSY);
    await expect(busy).toHaveCount(1);
    await expect(busy.getByRole('link', { name: '1 critical + high' })).toBeVisible();
    // Nothing is planned for the empty one, and CI that never reported is not "failing".
    await expect(await needsYouItem(page, EMPTY)).toHaveCount(0);

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
    const busy = rowOf(page, BUSY);
    await expect(busy).toHaveCount(1);
    await expect(busy.getByRole('link', { name: 'P-1 · Ingest' })).toBeVisible();
    await expect(busy.locator('.fm-lrow__bar').getByText('0 of 1 tasks', { exact: true })).toBeVisible();
    const next = busy.getByRole('link', { name: new RegExp(NEXT_TITLE) });
    await expect(next).toHaveAttribute('href', new RegExp(`/tasks/${BUSY}-T-`));
    await expect(busy.getByRole('link', { name: '1 critical + high' })).toBeVisible();
    // Drift is a figure for a planned project; CI that never reported is its own word.
    await expect(busy.getByRole('link', { name: /^\d+ drift$/ })).toBeVisible();
    await expect(busy.getByRole('link', { name: 'CI never' })).toBeVisible();

    const empty = rowOf(page, EMPTY);
    await expect(empty.getByText('No plan yet', { exact: true })).toBeVisible();
    await expect(empty.locator('.fm-lrow__phase').getByText('not measurable yet', { exact: true })).toBeVisible();
    await expect(empty.getByRole('link', { name: 'CI never' })).toBeVisible();
  });

  test('the row opens a disclosure with deployed-vs-main and last activity, and closes it again', async ({ page }) => {
    await page.goto('/');
    const busy = rowOf(page, BUSY);
    const toggle = busy.getByRole('button', { name: `Show details for Ledger ${BUSY}` });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(busy.getByText('Deployed vs main', { exact: true })).toBeHidden();

    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(busy.getByText('Deployed vs main', { exact: true })).toBeVisible();
    await expect(busy.getByText('Never recorded as deployed.', { exact: true })).toBeVisible();
    await expect(busy.getByText('Last activity', { exact: true })).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('a group section still collapses, and the ledger goes with it', async ({ page }) => {
    await page.goto('/');
    const main = page.getByRole('main');
    const toggle = main.getByRole('button', { name: `${GROUP} projects`, exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(section(page).getByRole('link', { name: new RegExp(`^${BUSY}`) })).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('a project is a two-line item, and the page does not scroll sideways', async ({ page }) => {
      await page.goto('/');
      const row = rowOf(page, BUSY);
      await expect(row).toBeVisible();

      const box = await row.boundingBox();
      // Two lines of text and their padding — never a tall card and never three lines.
      expect(box?.height ?? 0).toBeLessThan(110);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await expect(row.getByRole('button', { name: /Show details/ })).toBeVisible();
    });

    test('a row with several reasons stays two lines: ONE chip and "+1 more", and a next task you can read', async ({
      page,
    }) => {
      await page.goto('/');
      const row = rowOf(page, MULTI);
      await expect(row).toBeVisible();

      const top = async (selector: string) => (await row.locator(selector).first().boundingBox())?.y ?? -1;
      const line1 = await top('.fm-lrow__project a');
      const line2 = await top('.fm-lrow__phase a');
      expect(line2).toBeGreaterThan(line1);
      // The phase, the next task and CI share line two; the chip shares line one.
      expect(Math.abs((await top('.fm-lrow__next a')) - line2)).toBeLessThan(8);
      expect(Math.abs((await top('.fm-lrow__ci a')) - line2)).toBeLessThan(12);
      expect(Math.abs((await top('.fm-reasons--compact a')) - line1)).toBeLessThan(16);

      // Exactly one chip is drawn, the most urgent; the rest are said in words.
      const chips = await row.locator('.fm-reasons--compact a').evaluateAll((links) =>
        links.filter((l) => (l as HTMLElement).offsetParent !== null).map((l) => l.textContent.trim()),
      );
      expect(chips).toEqual(['1 critical + high']);
      await expect(row.getByText('+1 more', { exact: true })).toBeVisible();

      // The next task is readable: it has room, and it says which task on hover.
      const next = await row.locator('.fm-lrow__next a').boundingBox();
      expect(next?.width ?? 0).toBeGreaterThanOrEqual(64);
      await expect(row.locator('.fm-lrow__next a')).toHaveAttribute('title', new RegExp(`${MULTI}-T-.* A next task`));

      expect((await row.boundingBox())?.height ?? 0).toBeLessThan(110);
    });
  });
});
