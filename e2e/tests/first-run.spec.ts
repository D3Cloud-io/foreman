import { expect, test, type Page } from '@playwright/test';

/**
 * First run from the console (FRM-T-18.9, FRM-REQ-248, FRM-DA-009, board D-09).
 *
 * - With no real project, Home is a setup checklist ticked from real state, the samples labelled
 *   and removable (with Undo). The shared e2e database already holds other specs' projects, so the
 *   zero state is the portfolio answer narrowed to its samples, in the browser.
 * - `/tokens` is Connect an agent: three tabs with accurate snippets and a waiting-for-first-call
 *   line that turns into "Connected" when the token is used.
 * - Projects has New project (typed code, the uppercase rule, the immutable warning, the group
 *   defaulting to the scope) and Import… as the CLI lines, dry run first.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
const GROUP = `First run ${RUN}`;
const CODE = `FR${RUN}`;

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

interface Row {
  code: string;
  sample?: boolean;
}
interface PortfolioBody {
  items: Row[];
  total: number;
  groups: { projects: Row[] }[];
  ungrouped: { projects: Row[] } | null;
}

/** The portfolio as a Foreman with nothing but its samples would answer it. */
async function onlySamples(page: Page): Promise<void> {
  await page.route(/\/api\/portfolio(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as PortfolioBody;
    const keep = (rows: Row[]) => rows.filter((row) => row.sample === true);
    const items = keep(body.items);
    await route.fulfill({
      response,
      json: {
        ...body,
        items,
        total: items.length,
        groups: body.groups.map((group) => ({ ...group, projects: keep(group.projects) })),
        ungrouped: body.ungrouped === null ? null : { ...body.ungrouped, projects: keep(body.ungrouped.projects) },
      },
    });
  });
}

test.describe('first run from the console', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('the seeded samples say so on every read, and Home leaves them out of its figures', async ({ page }) => {
    const res = await page.request.get('/api/portfolio');
    const body = (await res.json()) as PortfolioBody;
    const flags = Object.fromEntries(body.items.map((row) => [row.code, row.sample]));
    expect(flags['EXMP']).toBe(true);
    expect(flags['NBR']).toBe(true);
    const real = body.items.filter((row) => row.sample !== true).length;

    await page.goto('/');
    const main = page.getByRole('main');
    if (real > 0) {
      // Labelled where it is listed; counted in no figure.
      await expect(main.getByRole('link', { name: /^EXMP Example Project · Sample/ }).first()).toBeVisible();
      await expect(main.getByRole('link', { name: /^Projects/ }).first()).toContainText(String(real));
    }
    await page.goto('/projects');
    const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: 'Example Project', exact: true }) });
    await expect(row.getByText('Sample', { exact: true })).toBeVisible();
  });

  test('with no real project, Home is a setup checklist ticked from real state', async ({ page }) => {
    await onlySamples(page);
    // An agent has called Foreman, as far as this page is told — whatever other specs did with
    // tokens — so step 1 is done and step 2 is the next one, with its actions shown.
    await page.route(/\/api\/tokens$/, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            json: {
              items: [
                {
                  id: '00000000-0000-7000-8000-000000000001',
                  name: 'first-run agent',
                  prefix: 'frm_e2e0',
                  scopes: ['read', 'write'],
                  createdAt: new Date(Date.now() - 86_400_000).toISOString(),
                  lastUsedAt: new Date().toISOString(),
                  expiresAt: null,
                  revokedAt: null,
                },
              ],
              nextCursor: null,
              total: 1,
            },
          })
        : route.continue(),
    );
    await page.goto('/');
    const main = page.getByRole('main');
    const checklist = main.getByRole('region', { name: 'Set Foreman up' });
    await expect(checklist).toBeVisible();
    await expect(checklist).toContainText(/\d of 4 done/);
    // The step titles — not the step's own "Connect an agent" button, which shares the words.
    await expect(checklist.locator('.fm-setup__title')).toHaveText([
      'Connect an agent',
      'Create or import a project',
      'Link its repository',
      'See the first commit',
    ]);
    // Step 1 is done, so its button offers another agent.
    await expect(checklist.getByRole('button', { name: 'Connect another' })).toBeVisible();
    // The samples do not count as a project, and no figure claims "clean".
    await expect(checklist).toContainText('The samples do not count');
    await expect(main.getByRole('link', { name: /CI · reporting/ })).toHaveCount(0);
    await expect(main.getByText('not measurable yet').first()).toBeVisible();

    // Labelled, and listed apart.
    await expect(main.getByText('Sample', { exact: true }).first()).toBeVisible();
    await expect(main.getByRole('region', { name: 'Samples' }).getByRole('link', { name: /^EXMP Example Project · Sample/ })).toBeVisible();

    // The next step's actions lead somewhere the console can go.
    await checklist.getByRole('button', { name: 'New project' }).click();
    await expect(page).toHaveURL(/\/projects\?new=1$/);
    await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
  });

  test('Remove sample projects is a soft delete with Undo', async ({ page }) => {
    await onlySamples(page);
    await page.goto('/');
    const deleted: string[] = [];
    page.on('response', (response) => {
      if (response.request().method() === 'DELETE' && /\/api\/projects\/(EXMP|NBR)$/.test(response.url())) {
        const ids = response.headers()['audit-event-ids'] ?? '';
        deleted.push(...ids.split(',').filter(Boolean).slice(0, 1));
      }
    });
    try {
      await page.getByRole('button', { name: 'Remove sample projects' }).click();
      await expect(page.getByText(/Removed the sample projects EXMP and NBR/)).toBeVisible();
      expect((await page.request.get('/api/projects/EXMP')).status()).toBe(404);

      await page.getByRole('button', { name: /^Undo/ }).click();
      await expect(page.getByText(/EXMP and NBR are back/)).toBeVisible();
      expect((await page.request.get('/api/projects/EXMP')).status()).toBe(200);
      expect((await page.request.get('/api/projects/NBR')).status()).toBe(200);
    } finally {
      // Every other spec runs against the samples: put them back whatever happened above.
      for (const code of ['EXMP', 'NBR']) {
        if ((await page.request.get(`/api/projects/${code}`)).status() === 404) {
          for (const id of deleted) await page.request.post(`/api/undo/${id}`);
        }
      }
    }
  });

  test('Connect an agent: three accurate snippets, and the first call is noticed', async ({ page, baseURL }) => {
    const origin = new URL(baseURL ?? 'http://127.0.0.1:3200').origin;
    await page.goto('/tokens');
    await expect(page.getByRole('heading', { name: 'Connect an agent', level: 1 })).toBeVisible();

    const ways = page.getByRole('region', { name: 'Ways in' });
    await expect(ways.getByRole('tab')).toHaveText(['Claude Code · remote MCP', 'Local shim', 'Audit & planning skills']);
    await expect(ways.getByRole('group', { name: 'the remote MCP command' }).locator('pre')).toHaveText(`claude mcp add --transport http foreman ${origin}/mcp`);
    await ways.getByRole('tab', { name: 'Local shim' }).click();
    await expect(ways.getByRole('group', { name: 'the local shim command' }).locator('pre')).toContainText(`FOREMAN_URL=${origin}`);
    await expect(ways.getByRole('group', { name: 'the local shim command' }).locator('pre')).toContainText('FOREMAN_TOKEN=');

    // Issue a read-only token from the console.
    const name = `first run ${RUN}`;
    await page.getByRole('button', { name: 'Issue a token' }).click();
    const issue = page.getByRole('dialog', { name: 'Issue an API token' });
    await issue.getByRole('textbox').fill(name);
    await issue.getByRole('button', { name: 'Issue', exact: true }).click();

    const shown = page.getByRole('dialog', { name: `“${name}” is ready` });
    await expect(shown).toBeVisible();
    const secret = (await shown.locator('pre.fm-secret').first().textContent()) ?? '';
    expect(secret).toMatch(/^frm_/);
    await expect(shown.getByRole('group', { name: 'the local shim command' }).locator('pre')).toContainText(`FOREMAN_TOKEN=${secret}`);
    await expect(shown.getByRole('button', { name: 'Copy the local shim command' })).toBeVisible();
    await expect(shown.getByText(`Waiting for the first call from “${name}”…`)).toBeVisible();

    // Read-only: the skills, which write findings, are not offered it.
    await shown.getByRole('tab', { name: 'Audit & planning skills' }).click();
    await expect(shown.getByText('Needs a token that can write')).toBeVisible();
    await expect(shown.getByText(`FOREMAN_WRITE_TOKEN=${secret}`)).toHaveCount(0);

    // The agent's first call moves the token's last-used time; the line follows it.
    const call = await page.request.get('/api/portfolio', { headers: { authorization: `Bearer ${secret}` } });
    expect(call.status()).toBe(200);
    await shown.getByRole('tab', { name: 'Local shim' }).click();
    await expect(shown.getByText(/Connected · first call at/)).toBeVisible({ timeout: 15_000 });

    await shown.getByRole('button', { name: 'I have copied it' }).click();
    const tokens = (await (await page.request.get('/api/tokens')).json()) as { items: { id: string; name: string }[] };
    const row = tokens.items.find((item) => item.name === name);
    if (row !== undefined) await page.request.delete(`/api/tokens/${row.id}`);
  });

  test('New project: a typed code, the uppercase rule, the immutable warning, the group from the scope', async ({ page }) => {
    const group = await page.request.post('/api/groups', { data: { name: GROUP, accent: 'neutral' } });
    expect(group.status(), await group.text()).toBe(201);
    const { humanId, slug } = (await group.json()) as { humanId: string; slug: string };

    await page.goto(`/projects?group=${slug}`);
    await page.getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    await expect(dialog).toContainText(`Into ${GROUP}, the scope you are in`);
    await expect(dialog.getByRole('combobox', { name: 'Group' })).toContainText(GROUP);
    await expect(dialog.getByText('Immutable once created')).toBeVisible();

    await dialog.getByRole('textbox', { name: 'Name' }).fill(`First run ${RUN}`);
    const code = dialog.getByRole('textbox', { name: 'Code' });
    await code.fill(CODE.toLowerCase());
    await expect(dialog.getByText(`Upper case only. Did you mean ${CODE}?`)).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Create/ })).toBeDisabled();
    await code.fill('EXMP');
    await expect(dialog.getByText('EXMP is Example Project’s code already.')).toBeVisible();

    await code.fill(CODE);
    await expect(dialog).toContainText(`${CODE}-REQ-001, ${CODE}-ADR-001, ${CODE}-T-1.1`);
    await dialog.getByRole('button', { name: `Create ${CODE}` }).click();
    await expect(page.getByText(`Created ${CODE} — First run ${RUN} in ${GROUP}`)).toBeVisible();

    const created = (await (await page.request.get(`/api/projects/${CODE}`)).json()) as {
      group: { humanId: string } | null;
      sample: boolean;
    };
    expect(created.group?.humanId).toBe(humanId);
    expect(created.sample).toBe(false);
  });

  test('with a real project and setup unfinished, Home is the dashboard with a Finish setting up card', async ({ page }) => {
    // No token has called Foreman, as far as this page is told: step 1 is pending whatever other
    // specs have done, so the card has something to finish.
    await page.route(/\/api\/tokens$/, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { items: [], nextCursor: null, total: 0 } })
        : route.continue(),
    );
    await page.goto('/');
    const main = page.getByRole('main');
    const card = main.getByRole('region', { name: 'Finish setting up' });
    await expect(card).toBeVisible();
    await expect(card).toContainText(/\d of 4 done · next: connect an agent/);
    // The dashboard is still Home: the figures are there, under the card.
    await expect(main.getByRole('link', { name: /CI · reporting/ })).toBeVisible();

    // Collapsed until asked; opened, it is the checklist.
    const toggle = card.getByRole('button', { name: 'Show the steps' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(card.getByRole('button', { name: 'Hide the steps' })).toHaveAttribute('aria-expanded', 'true');
    await expect(card.getByRole('region', { name: 'Set Foreman up' })).toBeVisible();
    await expect(card.locator('.fm-setup__title').first()).toHaveText('Connect an agent');

    // Not now is remembered in this browser.
    await card.getByRole('button', { name: 'Not now' }).click();
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(main.getByRole('link', { name: /CI · reporting/ })).toBeVisible();
    await expect(main.getByRole('region', { name: 'Finish setting up' })).toHaveCount(0);
  });

  test('Home counts no sample in a section’s summary or the ungrouped figure', async ({ page }) => {
    const body = (await (await page.request.get('/api/portfolio')).json()) as PortfolioBody;
    const ungrouped = (body.ungrouped?.projects ?? []).filter((row) => row.sample !== true).length;
    const samplesUngrouped = (body.ungrouped?.projects ?? []).some((row) => row.sample === true);
    await page.goto('/');
    const main = page.getByRole('main');
    if (body.groups.length > 0) {
      await expect(main.getByText(new RegExp(`· ${String(ungrouped)} ungrouped`)).first()).toBeVisible();
    }
    if (body.groups.length > 0 && samplesUngrouped) {
      const section = main.getByRole('region', { name: 'Ungrouped', exact: true });
      await expect(section).toContainText(`${String(ungrouped)} ${ungrouped === 1 ? 'project' : 'projects'} ·`);
      // Still listed, and labelled.
      await expect(section.getByText(/· Sample/).first()).toBeVisible();
    }
  });

  test('Import… shows the CLI, the dry run first, then --write, and calls no server', async ({ page }) => {
    await page.goto('/projects');
    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET') posts.push(request.url());
    });
    await page.getByRole('button', { name: 'Import…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import from the archived vault' });
    await dialog.getByRole('textbox', { name: 'Vault' }).fill('../d3cloud-archive/D3 Cloud Vault');
    await dialog.getByRole('textbox', { name: 'Project folder' }).fill('Kardashev');
    const dryRun = 'pnpm --filter foreman-server run import -- --path "../d3cloud-archive/D3 Cloud Vault" --only "Kardashev"';
    await expect(dialog.getByRole('group', { name: 'the import dry run' }).locator('pre')).toHaveText(dryRun);
    await expect(dialog.getByRole('group', { name: 'the import with --write' }).locator('pre')).toHaveText(`${dryRun} --write`);
    await expect(dialog.getByRole('button', { name: 'Copy the import dry run' })).toBeVisible();
    expect(posts).toEqual([]);
  });
});
