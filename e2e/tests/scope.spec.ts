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
/** A group with no projects in it. */
let empty: Group;
/** Each project's finding, by code. */
const findingId = new Map<string, string>();
const findingTitle = (code: string) => `Scoped finding ${code}`;

async function seed(page: Page): Promise<void> {
  const make = async (name: string, accent: string): Promise<Group> => {
    const res = await page.request.post('/api/groups', { data: { name, accent } });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()) as Group;
  };
  cloud = await make(CLOUD, 'foreman');
  dormice = await make(DORMICE, 'bindery');
  empty = await make(`Empty ${RUN}`, 'neutral');

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
    findingId.set(code, ((await finding.json()) as { humanId: string }).humanId);
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

    // All projects takes the scope out of the URL, and everybody's findings come back. The menu
    // has finished closing first: Radix drops a click on its trigger that lands mid-exit.
    await expect(page.getByRole('menu')).toHaveCount(0);
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
    // The project is in its group's ledger, and — it has a critical finding — in the Needs-you strip
    // above, so the link is looked for in the group's own section (FRM-T-18.6).
    const ledger = page.getByRole('region', { name: DORMICE });
    await expect(ledger.getByRole('link', { name: new RegExp(IN_DORMICE[0]) })).toBeVisible();
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

  test('links to scoped pages carry the scope in their href, and links to other pages do not', async ({ page }) => {
    await page.goto(`/?group=${dormice.slug}`);
    const main = page.getByRole('main');
    // In the href itself, so a middle-click, a new tab and a copied link open in Dormice too.
    await expect(main.getByRole('link', { name: /Critical \+ high/ })).toHaveAttribute('href', `/findings?group=${dormice.slug}`);
    await expect(main.getByRole('link', { name: /Drift/ }).first()).toHaveAttribute('href', `/drift?group=${dormice.slug}`);
    await expect(
      main.getByRole('region', { name: DORMICE }).getByRole('link', { name: new RegExp(IN_DORMICE[0]) }),
    ).toHaveAttribute('href', `/projects/${IN_DORMICE[0]}`);

    const opened = page.context().waitForEvent('page');
    await main.getByRole('link', { name: /Critical \+ high/ }).click({ modifiers: ['ControlOrMeta'] });
    const tab = await opened;
    await expect(tab).toHaveURL(new RegExp(`/findings\\?group=${dormice.slug}$`));
    await tab.close();

    await main.getByRole('link', { name: /Critical \+ high/ }).click();
    await expect(page).toHaveURL(new RegExp(`/findings\\?group=${dormice.slug}$`));
    await expect(page.getByText(findingTitle(IN_DORMICE[0]))).toBeVisible();
    await expect(page.getByText(findingTitle(IN_CLOUD))).toHaveCount(0);
    // A finding's page is not scoped: its link drops the scope.
    await expect(page.getByRole('link', { name: findingId.get(IN_DORMICE[0]) ?? '' })).toHaveAttribute(
      'href',
      `/findings/${findingId.get(IN_DORMICE[0]) ?? ''}`,
    );
  });

  test('changing the scope keeps a search and its results', async ({ page }) => {
    await page.goto(`/search?group=${dormice.slug}`);
    // The run's own tag: every project of this run has it, and no earlier run's does.
    await page.getByRole('textbox', { name: 'Find' }).fill(RUN);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/search\\?group=${dormice.slug}&q=${RUN}$`));
    const results = page.getByRole('list', { name: `Results for ${RUN}` });
    await expect(results).toContainText(findingTitle(IN_DORMICE[0]));
    await expect(results).not.toContainText(findingTitle(IN_CLOUD));

    // The switcher heard the search: All projects keeps it.
    await page.getByRole('button', { name: `Scope: ${DORMICE}. Change scope` }).click();
    await expect(page.getByRole('menu').getByRole('menuitemradio', { name: /All projects/ })).toHaveAttribute(
      'href',
      `/search?q=${RUN}`,
    );
    await page.getByRole('menu').getByRole('menuitemradio', { name: /All projects/ }).click();
    await expect(page).toHaveURL(new RegExp(`/search\\?q=${RUN}$`));
    await expect(page.getByRole('textbox', { name: 'Find' })).toHaveValue(RUN);
    await expect(results).toContainText(findingTitle(IN_CLOUD));
    await expect(results).toContainText(findingTitle(IN_DORMICE[0]));
  });

  test('changing the scope keeps the Findings filters, which live in the URL', async ({ page }) => {
    await page.goto(`/findings?group=${dormice.slug}`);
    await page.getByRole('combobox', { name: 'Severity' }).click();
    await page.getByRole('option', { name: 'High' }).click();
    await expect(page).toHaveURL(new RegExp(`/findings\\?group=${dormice.slug}&severity=high$`));

    await page.getByRole('button', { name: `Scope: ${DORMICE}. Change scope` }).click();
    await page.getByRole('menu').getByRole('menuitemradio', { name: new RegExp(`^${CLOUD}`) }).click();
    await expect(page).toHaveURL(new RegExp(`/findings\\?group=${cloud.slug}&severity=high$`));
    await expect(page.getByRole('combobox', { name: 'Severity' })).toContainText('High');
    await expect(page.getByText(findingTitle(IN_CLOUD))).toBeVisible();

    // And a filtered, scoped inbox is a link.
    await page.goto(`/findings?group=${cloud.slug}&severity=low`);
    await expect(page.getByRole('combobox', { name: 'Severity' })).toContainText('Low');
    await expect(page.getByText(findingTitle(IN_CLOUD))).toHaveCount(0);
  });

  test('a scoped search for an ID outside the scope says where it is, never "Nothing matches"', async ({ page }) => {
    const id = findingId.get(IN_CLOUD) ?? '';
    await page.goto(`/search?group=${dormice.slug}&q=${id}`);
    const notice = page.getByRole('alert').or(page.getByRole('status')).filter({ hasText: `${id} is in ${CLOUD}, outside ${DORMICE}` });
    await expect(notice).toBeVisible();
    await expect(page.getByText(/Nothing matches/)).toHaveCount(0);
    await expect(notice.getByRole('link', { name: 'Show it' })).toHaveAttribute('href', `/findings/${id}`);
    await expect(notice.getByRole('link', { name: 'Search every project' })).toHaveAttribute('href', `/search?q=${id}`);
    await notice.getByRole('link', { name: 'Search every project' }).click();
    await expect(page.getByRole('list', { name: `Results for ${id}` })).toContainText(id);

    // Nothing anywhere: "Nothing matches", and the way out is a link.
    await page.goto(`/search?group=${dormice.slug}&q=zzznothing${RUN}`);
    await expect(page.getByRole('heading', { name: new RegExp(`Nothing matches .* in ${DORMICE}`) })).toBeVisible();
    await expect(page.getByRole('link', { name: 'search every project' })).toHaveAttribute('href', `/search?q=zzznothing${RUN}`);
  });

  test('a group with no projects says so rather than calling it a success', async ({ page }) => {
    await page.goto(`/findings?group=${empty.slug}`);
    await expect(page.getByRole('heading', { name: `Empty ${RUN} has no projects` })).toBeVisible();
    await expect(page.getByText(/success state/)).toHaveCount(0);
  });

  test('a deleted group’s link never says "across" it', async ({ page }) => {
    const gone = await page.request.post('/api/groups', { data: { name: `Gone ${RUN}` } });
    const { humanId, slug } = (await gone.json()) as Group;
    expect((await page.request.delete(`/api/groups/${humanId}`)).ok()).toBe(true);

    for (const path of [`/findings?group=${slug}`, `/drift?group=${slug}`, `/?group=${slug}`, `/search?group=${slug}&q=x`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: `No group is called “${slug}”` })).toBeVisible();
      await expect(page.getByText(new RegExp(`across ${slug}`, 'i')), path).toHaveCount(0);
      await expect(page.getByText(new RegExp(` in ${slug}`, 'i')), path).toHaveCount(0);
    }
  });

  test('the Menu opens on the checked scope and gives focus back to its button', async ({ page }) => {
    await page.goto(`/findings?group=${dormice.slug}`);
    const trigger = page.getByRole('button', { name: `Scope: ${DORMICE}. Change scope` });
    await trigger.click();
    await expect(page.getByRole('menu').getByRole('menuitemradio', { name: new RegExp(`^${DORMICE}`) })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(page.getByRole('menu')).toHaveCount(0);

    await trigger.press('Enter');
    await expect(page.getByRole('menu').getByRole('menuitemradio', { name: new RegExp(`^${DORMICE}`) })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('menu').getByRole('menuitemradio', { name: new RegExp(`^${CLOUD}`) })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/findings\\?group=${cloud.slug}$`));
    await expect(page.getByRole('button', { name: `Scope: ${CLOUD}. Change scope` })).toBeFocused();
  });

  test('the shell keeps the scope: its rows, the brand and the switcher, across scoped pages', async ({ page }) => {
    await page.goto(`/findings?group=${dormice.slug}`);
    const nav = page.getByRole('navigation', { name: 'Main' });
    for (const [name, to] of [
      ['Home', '/'],
      ['Projects', '/projects'],
      ['Search', '/search'],
    ] as const) {
      await expect(nav.getByRole('link', { name, exact: true })).toHaveAttribute('href', `${to}?group=${dormice.slug}`);
    }
    // Findings carries a count when something needs you, which renames the link; match its start.
    await expect(nav.getByRole('link', { name: /^Findings/ })).toHaveAttribute('href', `/findings?group=${dormice.slug}`);
    await expect(page.getByRole('link', { name: 'Foreman' }).first()).toHaveAttribute('href', `/?group=${dormice.slug}`);

    await nav.getByRole('link', { name: 'Search', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/search\\?group=${dormice.slug}$`));
    await nav.getByRole('link', { name: 'Projects', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects\\?group=${dormice.slug}$`));
    await expect(page.getByRole('button', { name: `Scope: ${DORMICE}. Change scope` })).toBeVisible();

    // Into a project: not a scoped page, so the scope goes, the switcher says All projects, and
    // the rows go back to plain links.
    await page.getByRole('main').getByRole('link', { name: `Scoped ${IN_DORMICE[0]}` }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${IN_DORMICE[0]}$`));
    await expect(page.getByRole('button', { name: 'Scope: All projects. Change scope' })).toBeVisible();
    await expect(nav.getByRole('link', { name: /^Findings/ })).toHaveAttribute('href', '/findings');

    // Choosing a scope from a page a scope does not narrow goes to Home in it.
    await page.getByRole('button', { name: 'Scope: All projects. Change scope' }).click();
    await page.getByRole('menu').getByRole('menuitemradio', { name: new RegExp(`^${CLOUD}`) }).click();
    await expect(page).toHaveURL(new RegExp(`/\\?group=${cloud.slug}$`));
  });

  test('on the collapsed rail the scope button says its scope in a tooltip, on hover and on focus', async ({ page }) => {
    await page.goto(`/findings?group=${dormice.slug}`);
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    const button = page.getByRole('button', { name: `Scope: ${DORMICE}. Change scope` });
    try {
      await button.hover();
      await expect(page.getByRole('tooltip', { name: `Scope: ${DORMICE}` })).toBeVisible();

      // Keyboard focus alone, on a fresh page (the rail is remembered): no hover to lean on.
      await page.reload();
      await expect(page.getByRole('tooltip', { name: `Scope: ${DORMICE}` })).toHaveCount(0);
      await button.focus();
      await expect(page.getByRole('tooltip', { name: `Scope: ${DORMICE}` })).toBeVisible();
      // Still the Menu's trigger: it opens on the checked scope.
      await button.press('Enter');
      await expect(page.getByRole('menu').getByRole('menuitemradio', { name: new RegExp(`^${DORMICE}`) })).toBeFocused();
      await page.keyboard.press('Escape');
    } finally {
      // The choice is remembered per browser; leave the sidebar as the other tests expect it.
      await page.getByRole('button', { name: 'Expand sidebar' }).click();
    }
  });

  test('on a phone the tab bar keeps the scope, and the drawer has the switcher too', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?group=${dormice.slug}`);
    const bar = page.getByRole('navigation', { name: 'Primary' });
    await expect(bar.getByRole('link', { name: 'Search', exact: true })).toHaveAttribute('href', `/search?group=${dormice.slug}`);
    await expect(bar.getByRole('link', { name: 'Projects', exact: true })).toHaveAttribute('href', `/projects?group=${dormice.slug}`);
    await bar.getByRole('link', { name: 'Search', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/search\\?group=${dormice.slug}$`));

    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await drawer.getByRole('button', { name: `Scope: ${DORMICE}. Change scope` }).click();
    await page.getByRole('menu').getByRole('menuitemradio', { name: new RegExp(`^${CLOUD}`) }).click();
    await expect(page).toHaveURL(new RegExp(`/search\\?group=${cloud.slug}$`));
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
    // It opens on where you are, and Escape gives focus back to the chip.
    await expect(sheet.getByRole('link', { name: new RegExp(`^${DORMICE}`) })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: `Scope: ${DORMICE}. Change scope` })).toBeFocused();
    await page.getByRole('button', { name: `Scope: ${DORMICE}. Change scope` }).click();
    await expect(sheet.getByRole('link', { name: 'Manage groups…' })).toBeVisible();

    await sheet.getByRole('link', { name: new RegExp(`^${CLOUD}`) }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/\\?group=${cloud.slug}$`));
    await expect(page.getByRole('button', { name: `Scope: ${CLOUD}. Change scope` })).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: `Viewing ${CLOUD}` })).toBeVisible();
    await expect(
      page.getByRole('region', { name: CLOUD }).getByRole('link', { name: new RegExp(IN_CLOUD) }),
    ).toBeVisible();
  });
});
