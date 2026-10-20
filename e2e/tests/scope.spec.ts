import { expect, test, type Page } from '@playwright/test';

/**
 * The group scope (FRM-T-17.4, the board's 17.02 and 17.03; FRM-ADR-024).
 *
 * `?group=` narrows Home, Projects, Findings, Search and Drift to one family and lives in the URL:
 * a shared link opens in that scope, the shell's links keep it between scoped pages, and a page
 * that is not scoped drops it. The switcher shows and changes it — a Menu at laptop width, a
 * bottom sheet on a phone. Seeded through the API with names unique to the run, so it runs on a
 * database other specs have already written to.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';

const RUN = Date.now().toString(36).slice(-4).toUpperCase();
const CLOUD = `Cloud ${RUN}`;
const DORMICE = `Dormice ${RUN}`;
/** One project in Cloud, two in Dormice. */
const IN_CLOUD = `SC${RUN}`;
const IN_DORMICE = [`SM${RUN}`, `SN${RUN}`] as const;

interface Group {
  humanId: string;
  name: string;
  slug: string;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

let cloud: Group;
let dormice: Group;
const findingTitle = (code: string) => `Scoped finding ${code}`;

async function seed(page: Page): Promise<void> {
  const make = async (name: string, accent: string): Promise<Group> => {
    const res = await page.request.post('/api/groups', { data: { name, accent } });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()) as Group;
  };
  cloud = await make(CLOUD, 'foreman');
  dormice = await make(DORMICE, 'bindery');

  for (const [code, group] of [
    [IN_CLOUD, cloud],
    [IN_DORMICE[0], dormice],
    [IN_DORMICE[1], dormice],
  ] as const) {
    const project = await page.request.post('/api/projects', {
      data: { code, name: `Scoped ${code}`, group: group.humanId },
    });
    expect(project.status(), await project.text()).toBe(201);
    const finding = await page.request.post(`/api/projects/${code}/findings`, {
      data: { title: findingTitle(code), severity: 'high' },
    });
    expect(finding.status(), await finding.text()).toBe(201);
  }
}

/** The Project column of every row in the findings table. */
async function findingProjects(page: Page): Promise<string[]> {
  const table = page.getByRole('table');
  await expect(table).toBeVisible();
  return (await table.locator('tbody tr td:nth-child(2)').allTextContents()).map((text) => text.trim());
}

test.describe('the group scope', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await signIn(page);
    await seed(page);
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('a shared Findings link scoped to Dormice opens in that scope and lists only Dormice projects’ findings', async ({
    page,
  }) => {
    await page.goto(`/findings?group=${dormice.slug}`);

    await expect(page.getByText(`Open findings across ${DORMICE}, worst first.`)).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: `Viewing ${DORMICE}` })).toBeVisible();
    await expect(page.getByRole('button', { name: `Scope: ${DORMICE}. Change scope` })).toBeVisible();

    await expect(page.getByText(findingTitle(IN_DORMICE[0]))).toBeVisible();
    await expect(page.getByText(findingTitle(IN_DORMICE[1]))).toBeVisible();
    await expect(page.getByText(findingTitle(IN_CLOUD))).toHaveCount(0);

    // Every row, not only the ones this spec made: nothing from outside Dormice gets in.
    const projects = await findingProjects(page);
    expect(projects.length).toBeGreaterThanOrEqual(2);
    expect(new Set(projects)).toEqual(new Set(IN_DORMICE));
  });

  test('the switcher shows the scope as a Menu, checked, and changes it in the URL', async ({ page }) => {
    await page.goto(`/findings?group=${dormice.slug}`);
    await page.getByRole('button', { name: `Scope: ${DORMICE}. Change scope` }).click();

    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitemradio', { name: /All projects/ })).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: new RegExp(`^${CLOUD}`) })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await expect(menu.getByRole('menuitemradio', { name: new RegExp(`^${DORMICE}, 2 projects`) })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(menu.getByRole('menuitemradio', { name: /Ungrouped/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Manage groups…' })).toHaveAttribute('href', '/groups');

    await menu.getByRole('menuitemradio', { name: new RegExp(`^${CLOUD}`) }).click();
    await expect(page).toHaveURL(new RegExp(`/findings\\?group=${cloud.slug}$`));
    await expect(page.getByText(findingTitle(IN_CLOUD))).toBeVisible();
    await expect(page.getByText(findingTitle(IN_DORMICE[0]))).toHaveCount(0);

    // All projects takes the scope out of the URL, and everybody's findings come back.
    await page.getByRole('button', { name: `Scope: ${CLOUD}. Change scope` }).click();
    await page.getByRole('menu').getByRole('menuitemradio', { name: /All projects/ }).click();
    await expect(page).toHaveURL(/\/findings$/);
    await expect(page.getByText(findingTitle(IN_CLOUD))).toBeVisible();
    await expect(page.getByText(findingTitle(IN_DORMICE[0]))).toBeVisible();
  });

  test('Home scoped to Dormice shows only Dormice, says so, and Show all goes back', async ({ page }) => {
    await page.goto(`/?group=${dormice.humanId}`);
    await expect(page.getByRole('status').filter({ hasText: `Viewing ${DORMICE}` })).toBeVisible();
    await expect(page.getByRole('heading', { name: DORMICE, level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: CLOUD, level: 2 })).toHaveCount(0);
    await expect(page.getByRole('link', { name: new RegExp(IN_DORMICE[0]) })).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(IN_CLOUD) })).toHaveCount(0);
    await expect(page.getByText(/Hidden by scope:/)).toContainText(`${CLOUD} 1`);

    // The figures keep the scope: Drift opens drift across Dormice.
    await page.getByRole('link', { name: /Drift/ }).first().click();
    await expect(page).toHaveURL(new RegExp(`/drift\\?group=${dormice.humanId}$`));
    await expect(page.getByRole('heading', { name: 'Drift', level: 1 })).toBeVisible();
    await expect(page.getByText(new RegExp(`across ${DORMICE}\\.`))).toBeVisible();

    await page.getByRole('status').getByRole('link', { name: 'Show all' }).click();
    await expect(page).toHaveURL(/\/drift$/);
    await expect(page.getByRole('status').filter({ hasText: 'Viewing' })).toHaveCount(0);
  });

  test('the scope persists between scoped pages through the sidebar, and a project page drops it', async ({ page }) => {
    await page.goto(`/findings?group=${dormice.slug}`);
    const nav = page.getByRole('navigation').first();

    await nav.getByRole('link', { name: 'Search', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/search\\?group=${dormice.slug}$`));
    await page.getByRole('textbox', { name: 'Find' }).fill('Scoped finding');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    // The search goes into the URL beside the scope rather than over it.
    await expect(page).toHaveURL(new RegExp(`group=${dormice.slug}`));
    const results = page.getByRole('list', { name: 'Results for Scoped finding' });
    await expect(results).toContainText(findingTitle(IN_DORMICE[0]));
    await expect(results).not.toContainText(findingTitle(IN_CLOUD));

    await nav.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/\\?group=${dormice.slug}$`));

    await nav.getByRole('link', { name: 'Projects', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects\\?group=${dormice.slug}$`));
    await expect(page.getByRole('link', { name: `Scoped ${IN_DORMICE[0]}` })).toBeVisible();
    await expect(page.getByRole('link', { name: `Scoped ${IN_CLOUD}` })).toHaveCount(0);

    // Into a project: not a scoped page, so the scope goes.
    await page.getByRole('link', { name: `Scoped ${IN_DORMICE[0]}` }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${IN_DORMICE[0]}$`));
    await nav.getByRole('link', { name: 'Findings', exact: true }).click();
    await expect(page).toHaveURL(/\/findings$/);
  });

  test('a link to a group that does not exist says so, with the way back', async ({ page }) => {
    await page.goto(`/findings?group=no-such-group-${RUN.toLowerCase()}`);
    await expect(page.getByRole('heading', { name: `No group is called “no-such-group-${RUN.toLowerCase()}”` })).toBeVisible();
    await page.getByRole('link', { name: 'Show every project' }).click();
    await expect(page).toHaveURL(/\/findings$/);
  });

  test('on a phone the scope chip opens a bottom sheet of scopes', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?group=${dormice.slug}`);

    await page.getByRole('button', { name: `Scope: ${DORMICE}. Change scope` }).click();
    const sheet = page.getByRole('dialog', { name: 'Show projects from' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('link', { name: new RegExp(`^${DORMICE}`) })).toHaveAttribute('aria-current', 'true');
    await expect(sheet.getByRole('link', { name: 'Manage groups…' })).toBeVisible();

    await sheet.getByRole('link', { name: new RegExp(`^${CLOUD}`) }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/\\?group=${cloud.slug}$`));
    await expect(page.getByRole('status').filter({ hasText: `Viewing ${CLOUD}` })).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(IN_CLOUD) })).toBeVisible();
  });
});
