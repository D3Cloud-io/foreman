import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Groups in the console (FRM-T-17.3, the Foreman board's P17 · Groups frames).
 *
 * Every clause of the task's doneWhen is one test here: Home's sections and their collapse, the
 * grouped Projects table and its Move dialog with Undo, the Groups screen's create / rename /
 * reorder / refused delete, a project's overview, the guideline editor's Applies to, and the
 * convert dialog's Joins group. Everything is seeded through the API on the console's own session,
 * with names unique to the run, so the spec runs on a database other specs (and earlier runs) have
 * already written to.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';

/** Four characters, letters and digits: unique enough per run, short enough for a project code. */
const RUN = Date.now().toString(36).slice(-4).toUpperCase();

const ALPHA = `Alpha ${RUN}`;
const BETA = `Beta ${RUN}`;
const GAMMA = `Gamma ${RUN}`;
const DELTA = `Delta ${RUN}`;
const P1 = `GA${RUN}`;
const P2 = `GB${RUN}`;

interface GroupRow {
  humanId: string;
  name: string;
  slug: string;
  position: number;
  projects: { code: string }[];
}
interface Listing {
  items: GroupRow[];
  ungrouped: { projects: { code: string }[] };
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

async function listing(request: APIRequestContext): Promise<Listing> {
  const res = await request.get('/api/groups');
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as Listing;
}

async function groupOf(request: APIRequestContext, code: string): Promise<string | null> {
  const { items } = await listing(request);
  return items.find((group) => group.projects.some((p) => p.code === code))?.name ?? null;
}

/** The world the rest of the spec moves around in: two projects in Gamma, Delta empty, a GL for Gamma. */
async function seed(page: Page): Promise<{ gamma: GroupRow; delta: GroupRow; guideline: string }> {
  const make = async (name: string, accent: string): Promise<GroupRow> => {
    const res = await page.request.post('/api/groups', { data: { name, accent, description: `${name}, for the e2e suite` } });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()) as GroupRow;
  };
  const gamma = await make(GAMMA, 'bindery');
  const delta = await make(DELTA, 'shipyard');

  for (const [code, name] of [
    [P1, `Grouped one ${RUN}`],
    [P2, `Grouped two ${RUN}`],
  ] as const) {
    const res = await page.request.post('/api/projects', { data: { code, name, group: gamma.humanId } });
    expect(res.status(), await res.text()).toBe(201);
  }

  const gl = await page.request.post('/api/guidelines', {
    data: {
      title: `Only for Gamma ${RUN}`,
      area: 'Process',
      decision: 'Applies to one family.',
      rationale: '',
      guidance: '',
      appliesTo: 'groups',
      groups: [gamma.humanId],
    },
  });
  expect(gl.status(), await gl.text()).toBe(201);
  const { humanId } = (await gl.json()) as { humanId: string };
  return { gamma, delta, guideline: humanId };
}

test.describe.configure({ mode: 'serial' });

test.describe('groups', () => {
  let seeded: Awaited<ReturnType<typeof seed>>;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await signIn(page);
    seeded = await seed(page);
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('the Groups screen creates, renames, and reorders with Move up / Move down buttons', async ({ page }) => {
    await page.goto('/groups');
    await expect(page.getByRole('heading', { name: /^Groups/, level: 1 })).toBeVisible();

    for (const name of [`${ALPHA} draft`, BETA]) {
      await page.getByRole('button', { name: 'New group' }).click();
      const dialog = page.getByRole('dialog', { name: 'New group' });
      await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
      await dialog.getByRole('radio', { name: 'Clearwhen' }).check();
      await dialog.getByRole('button', { name: 'Create group' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
      // Every write says what it did, with Undo beside it.
      await expect(page.getByText(`Created ${name}`)).toBeVisible();
      await expect(page.getByRole('button', { name: /^Undo/ })).toBeVisible();
    }

    // A name is unique ignoring case, and the editor says so before the server has to.
    await page.getByRole('button', { name: 'New group' }).click();
    const again = page.getByRole('dialog', { name: 'New group' });
    await again.getByRole('textbox', { name: 'Name' }).fill(BETA.toLowerCase());
    await expect(again.getByText(/already exists \(GRP-\d+\)/)).toBeVisible();
    await expect(again.getByRole('button', { name: 'Create group' })).toBeDisabled();
    await again.getByRole('button', { name: 'Cancel' }).click();

    // Renamed: the name changes, the slug in every link to it does not.
    await page.getByRole('button', { name: `Edit ${ALPHA} draft` }).click();
    const edit = page.getByRole('dialog', { name: `Edit ${ALPHA} draft` });
    await edit.getByRole('textbox', { name: 'Name' }).fill(ALPHA);
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(edit).toBeHidden();
    await expect(page.getByRole('link', { name: ALPHA, exact: true })).toHaveAttribute(
      'href',
      new RegExp(`/groups/alpha-${RUN.toLowerCase()}-draft$`),
    );

    // Beta was made last, so it is last, and its Move down is disabled at the end.
    await expect(page.getByRole('button', { name: `Move ${BETA} down` })).toBeDisabled();
    const before = (await listing(page.request)).items.sort((a, b) => a.position - b.position).map((g) => g.name);
    expect(before.indexOf(BETA)).toBe(before.indexOf(ALPHA) + 1);

    // By keyboard: focus the button, press it, and focus stays on it for the next press.
    const up = page.getByRole('button', { name: `Move ${BETA} up` });
    await up.focus();
    await page.keyboard.press('Enter');
    await expect(up).toBeFocused();
    await expect
      .poll(async () => {
        const order = (await listing(page.request)).items.sort((a, b) => a.position - b.position).map((g) => g.name);
        return order.indexOf(BETA) < order.indexOf(ALPHA);
      })
      .toBe(true);

    // And the list on screen is in the new order too.
    const names = await page.getByRole('list', { name: 'Groups, in order' }).getByRole('link').allTextContents();
    expect(names.indexOf(BETA)).toBeLessThan(names.indexOf(ALPHA));
    // The toast's Undo puts the order back, through POST /api/undo.
    await expect(page.getByText(`Moved ${BETA} up`)).toBeVisible();
    await page.getByRole('button', { name: /^Undo/ }).click();
    await expect(page.getByText('Put the order back')).toBeVisible();
    await expect
      .poll(async () => {
        const order = (await listing(page.request)).items.sort((a, b) => a.position - b.position).map((g) => g.name);
        return order.indexOf(BETA) === order.indexOf(ALPHA) + 1;
      })
      .toBe(true);
    const restored = await page.getByRole('list', { name: 'Groups, in order' }).getByRole('link').allTextContents();
    expect(restored.indexOf(BETA)).toBe(restored.indexOf(ALPHA) + 1);

    // No drag anywhere: nothing on the screen is draggable.
    await expect(page.locator('[draggable="true"]')).toHaveCount(0);
  });

  test('Home shows a section per group in order, Ungrouped last, and collapses by keyboard', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();

    const sections = page.getByRole('main').getByRole('region');
    await expect(sections.filter({ hasText: GAMMA })).toHaveCount(1);
    const headings = await page.getByRole('main').getByRole('heading', { level: 2 }).allTextContents();
    const order = (await listing(page.request)).items.sort((a, b) => a.position - b.position).map((g) => g.name);
    // Every group, in the order the Groups screen set, then Ungrouped — last.
    expect(headings.filter((h) => order.includes(h))).toEqual(order);
    expect(headings.at(-1)).toBe('Ungrouped');

    // Gamma's section holds its projects, with the figures in its heading.
    const gamma = sections.filter({ has: page.getByRole('heading', { name: GAMMA, level: 2 }) });
    await expect(gamma.getByText('2 projects · 0 building', { exact: false })).toBeVisible();
    await expect(gamma.getByRole('link', { name: new RegExp(P1) })).toBeVisible();

    // Collapsed from the keyboard alone; aria-expanded says so.
    const toggle = page.getByRole('button', { name: `${GAMMA} projects` });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(gamma.getByRole('link', { name: new RegExp(P1) })).toBeHidden();

    // Remembered per group in this browser.
    await page.reload();
    await expect(page.getByRole('button', { name: `${GAMMA} projects` })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('button', { name: `${DELTA} projects` })).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: `${GAMMA} projects` }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: `${GAMMA} projects` })).toHaveAttribute('aria-expanded', 'true');
  });

  test('Projects groups its rows, moves two through the Move dialog naming the guidelines that change, and Undo puts them back', async ({ page }) => {
    await page.goto('/projects');
    await page.getByRole('searchbox', { name: 'Filter by code or name' }).fill(RUN);

    const gammaRows = page.locator('tbody').filter({ has: page.getByRole('rowheader', { name: new RegExp(GAMMA) }) });
    await expect(gammaRows.getByRole('link', { name: `Grouped one ${RUN}` })).toBeVisible();
    await expect(gammaRows.getByRole('link', { name: `Grouped two ${RUN}` })).toBeVisible();

    await page.getByRole('checkbox', { name: `Select ${P1} Grouped one ${RUN}` }).click();
    await page.getByRole('checkbox', { name: `Select ${P2} Grouped two ${RUN}` }).click();
    const bar = page.getByRole('region', { name: 'Selected projects' });
    await expect(bar).toContainText('2 selected');
    await bar.getByRole('button', { name: 'Move to group…' }).click();

    const dialog = page.getByRole('dialog', { name: 'Move 2 projects to…' });
    await expect(dialog.getByRole('radio', { name: 'No group (Ungrouped)' })).toBeVisible();
    await dialog.getByRole('radio', { name: DELTA }).check();
    // The consequence, before anything happens: Gamma's own guideline stops applying.
    await expect(dialog.getByText('Guidelines that apply will change')).toBeVisible();
    await expect(dialog.getByText(`${seeded.guideline} stops applying to ${P1} and ${P2}.`, { exact: false })).toBeVisible();
    await dialog.getByRole('button', { name: 'Move 2 projects' }).click();
    await expect(dialog).toBeHidden();

    const toast = page.getByText(`Moved ${P1} and ${P2} to ${DELTA}`);
    await expect(toast).toBeVisible();
    expect(await groupOf(page.request, P1)).toBe(DELTA);
    const deltaRows = page.locator('tbody').filter({ has: page.getByRole('rowheader', { name: new RegExp(DELTA) }) });
    await expect(deltaRows.getByRole('link', { name: `Grouped one ${RUN}` })).toBeVisible();

    await page.getByRole('button', { name: /^Undo/ }).click();
    await expect(page.getByText(`Put ${P1} and ${P2} back`)).toBeVisible();
    await expect.poll(() => groupOf(page.request, P1)).toBe(GAMMA);
    expect(await groupOf(page.request, P2)).toBe(GAMMA);
    await expect(gammaRows.getByRole('link', { name: `Grouped one ${RUN}` })).toBeVisible();
  });

  test('a partial undo says what it put back and what it could not', async ({ page }) => {
    await page.goto('/projects');
    await page.getByRole('searchbox', { name: 'Filter by code or name' }).fill(RUN);
    await page.getByRole('checkbox', { name: `Select ${P1} Grouped one ${RUN}` }).click();
    await page.getByRole('checkbox', { name: `Select ${P2} Grouped two ${RUN}` }).click();
    await page.getByRole('region', { name: 'Selected projects' }).getByRole('button', { name: 'Move to group…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Move 2 projects to…' });
    await dialog.getByRole('radio', { name: DELTA }).check();
    await dialog.getByRole('button', { name: 'Move 2 projects' }).click();
    await expect(page.getByText(`Moved ${P1} and ${P2} to ${DELTA}`)).toBeVisible();

    // Somebody moves P1 on before Undo is pressed: its move can no longer be reversed, P2's can.
    const beta = (await listing(page.request)).items.find((g) => g.name === BETA);
    expect(beta).toBeDefined();
    const moved = await page.request.post(`/api/groups/${beta?.humanId ?? ''}/projects`, { data: { projects: [P1] } });
    expect(moved.ok(), await moved.text()).toBe(true);

    await page.getByRole('button', { name: /^Undo/ }).click();
    await expect(page.getByText(`Undid 1 of 2 — ${P1} has changed since`)).toBeVisible();
    await expect.poll(() => groupOf(page.request, P2)).toBe(GAMMA);
    expect(await groupOf(page.request, P1)).toBe(BETA);

    // Put the world back as the rest of the spec expects it: both in Gamma, P1 first.
    const back = await page.request.post(`/api/groups/${seeded.gamma.humanId}/projects`, { data: { projects: [P1] } });
    expect(back.ok(), await back.text()).toBe(true);
    const order = await page.request.post(`/api/groups/${seeded.gamma.humanId}/projects/order`, { data: { order: [P1, P2] } });
    expect(order.ok(), await order.text()).toBe(true);
  });

  test('the Move dialog waits for the guidelines, and says so when it cannot read them', async ({ page }) => {
    // Slow reads first: Move stays disabled until the consequence is known.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/groups/GRP-*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await held;
      return route.continue();
    });
    await page.goto(`/projects/${P1}`);
    await page.getByRole('button', { name: `More for Grouped one ${RUN}` }).click();
    await page.getByRole('menuitem', { name: 'Move to group…' }).click();
    const dialog = page.getByRole('dialog', { name: `Move ${P1} to…` });
    await dialog.getByRole('radio', { name: DELTA }).check();
    await expect(dialog.getByRole('button', { name: 'Checking guidelines…' })).toBeDisabled();
    release();
    await expect(dialog.getByRole('button', { name: 'Move', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.unrouteAll({ behavior: 'wait' });

    // A read that fails is said, not skipped.
    await page.route('**/api/groups/GRP-*', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) })
        : route.continue(),
    );
    await page.getByRole('button', { name: `More for Grouped one ${RUN}` }).click();
    await page.getByRole('menuitem', { name: 'Move to group…' }).click();
    await dialog.getByRole('radio', { name: DELTA }).check();
    await expect(dialog.getByText('Could not check which guidelines change — the move will still apply them.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('the group editor shows the server’s reason beside the field it is about', async ({ page }) => {
    await page.goto('/groups');
    await page.getByRole('button', { name: 'New group' }).click();
    const dialog = page.getByRole('dialog', { name: 'New group' });
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Ungrouped');
    await dialog.getByRole('button', { name: 'Create group' }).click();
    await expect(dialog.getByText(/reserved/)).toBeVisible();
    await expect(dialog.getByText('the request body is not valid')).toHaveCount(0);
    await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveAttribute('aria-invalid', 'true');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('Projects says so when no project is ungrouped', async ({ page }) => {
    // The shared database always holds an ungrouped project, so the answer is narrowed here. The
    // group filter is the scope since FRM-T-17.4, read by the server as `?group=ungrouped`, so the
    // narrowed read is matched with its query too.
    await page.route(/\/api\/portfolio(\?.*)?$/, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { ungrouped: { projects: unknown[] } | null };
      if (body.ungrouped !== null) body.ungrouped.projects = [];
      await route.fulfill({ response, json: body });
    });
    await page.goto('/projects');
    await page.getByRole('combobox', { name: 'Group' }).click();
    await page.getByRole('option', { name: 'Ungrouped' }).click();
    await expect(page).toHaveURL(/\/projects\?group=ungrouped$/);
    await expect(page.getByRole('heading', { name: 'No project is ungrouped' })).toBeVisible();
    await expect(page.getByText(/No project has\s+in its code or name/)).toHaveCount(0);
  });

  test('the Groups screen refuses deleting a non-empty group, naming its projects', async ({ page }) => {
    await page.goto('/groups');
    await page.getByRole('button', { name: `More for ${GAMMA}` }).click();
    await page.getByRole('menuitem', { name: `Delete ${GAMMA}…` }).click();

    const refusal = page.getByRole('alert').filter({ hasText: `${GAMMA} can’t be deleted yet` });
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText(`still holds 2 projects (${P1}, ${P2})`);
    // A guideline scoped to it holds it too, and is named.
    await expect(refusal).toContainText(seeded.guideline);
    expect((await listing(page.request)).items.some((g) => g.name === GAMMA)).toBe(true);

    // The way out is beside the reason.
    await refusal.getByRole('button', { name: 'Move projects…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Move 2 projects to…' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // An empty group is deleted, after a confirmation.
    await page.getByRole('button', { name: `More for ${ALPHA}` }).click();
    await page.getByRole('menuitem', { name: `Delete ${ALPHA}…` }).click();
    await page.getByRole('dialog', { name: `Delete ${ALPHA}` }).getByRole('button', { name: 'Delete group' }).click();
    await expect(page.getByRole('link', { name: ALPHA, exact: true })).toBeHidden();
  });

  test('deleting an empty group acts with an Undo toast that brings it back (FRM-T-18.14)', async ({ page }) => {
    const name = `Scratch ${RUN}`;
    const made = await page.request.post('/api/groups', { data: { name, accent: 'neutral', description: 'deleted, then undone' } });
    expect(made.status(), await made.text()).toBe(201);

    await page.goto('/groups');
    await page.getByRole('button', { name: `More for ${name}` }).click();
    await page.getByRole('menuitem', { name: `Delete ${name}…` }).click();
    await page.getByRole('dialog', { name: `Delete ${name}` }).getByRole('button', { name: 'Delete group' }).click();
    await expect(page.getByRole('link', { name, exact: true })).toBeHidden();

    // Said, with Undo beside it — the list updates in place, with no skeleton in between.
    await expect(page.getByText(`Deleted ${name}`)).toBeVisible();
    await page.getByRole('button', { name: /^Undo/ }).click();
    await expect(page.getByText(`Put ${name} back`)).toBeVisible();
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
    expect((await listing(page.request)).items.some((g) => g.name === name)).toBe(true);

    // Left as it was found for the specs that count groups.
    const row = (await listing(page.request)).items.find((g) => g.name === name);
    const gone = await page.request.delete(`/api/groups/${row?.humanId ?? ''}`);
    expect(gone.status()).toBe(204);
  });

  test("a project's overview shows its group and moves it", async ({ page }) => {
    await page.goto(`/projects/${P1}`);
    const chip = page.getByRole('main').getByRole('link', { name: GAMMA }).first();
    await expect(chip).toHaveAttribute('href', `/groups/${seeded.gamma.slug}`);

    await page.getByRole('button', { name: `More for Grouped one ${RUN}` }).click();
    await page.getByRole('menuitem', { name: 'Move to group…' }).click();
    const dialog = page.getByRole('dialog', { name: `Move ${P1} to…` });
    await dialog.getByRole('radio', { name: DELTA }).check();
    await dialog.getByRole('button', { name: 'Move', exact: true }).click();

    await expect(page.getByText(`Moved ${P1} to ${DELTA}`)).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: DELTA }).first()).toBeVisible();
    expect(await groupOf(page.request, P1)).toBe(DELTA);

    await page.getByRole('button', { name: /^Undo/ }).click();
    await expect.poll(() => groupOf(page.request, P1)).toBe(GAMMA);
  });

  test('the guideline editor sets Applies to', async ({ page }) => {
    const created = await page.request.post('/api/guidelines', {
      data: { title: `Scope me ${RUN}`, area: 'Process', decision: 'Starts everywhere.', rationale: '', guidance: '' },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { humanId } = (await created.json()) as { humanId: string };

    await page.goto('/guidelines');
    await page.getByRole('button', { name: new RegExp(`Scope me ${RUN}`) }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Edit' }).click();

    const form = page.getByRole('dialog', { name: `Edit ${humanId}` });
    await expect(form.getByRole('radio', { name: 'All projects' })).toBeChecked();
    await form.getByRole('radio', { name: 'Chosen groups' }).click();
    await form.getByRole('checkbox', { name: DELTA }).click();
    await expect(form.getByText(`${humanId} will apply to the 0 projects in ${DELTA}.`, { exact: false })).toBeVisible();
    await form.getByRole('button', { name: 'Save guideline' }).click();
    await expect(form).toBeHidden();

    const res = await page.request.get(`/api/guidelines/${humanId}`);
    const saved = (await res.json()) as { appliesTo: string; groups: string[] };
    expect(saved).toMatchObject({ appliesTo: 'groups', groups: [seeded.delta.humanId] });
  });

  test('converting a project idea asks which group it joins', async ({ page }) => {
    const idea = await page.request.post('/api/project-ideas', { data: { title: `Joins a group ${RUN}` } });
    expect(idea.status(), await idea.text()).toBe(201);
    const { humanId } = (await idea.json()) as { humanId: string };
    const code = `GC${RUN}`;

    await page.goto(`/project-ideas/${humanId}`);
    await page.getByRole('button', { name: 'Convert' }).click();
    const dialog = page.getByRole('dialog', { name: `Make ${humanId} a project` });
    await dialog.getByRole('textbox', { name: 'Code' }).fill(code);
    const joins = dialog.getByRole('combobox', { name: 'Joins group' });
    // No scope in the address, so no group is guessed.
    await expect(joins).toContainText('No group (Ungrouped)');
    await joins.click();
    await page.getByRole('option', { name: DELTA }).click();
    await dialog.getByRole('button', { name: 'Convert to project' }).click();

    await expect(page).toHaveURL(new RegExp(`/projects/${code}$`));
    await expect(page.getByRole('main').getByRole('link', { name: DELTA }).first()).toBeVisible();
    expect(await groupOf(page.request, code)).toBe(DELTA);
  });

  test('a Joins group that does not stick is said, with the way to finish it', async ({ page }) => {
    const idea = await page.request.post('/api/project-ideas', { data: { title: `Join fails ${RUN}` } });
    expect(idea.status(), await idea.text()).toBe(201);
    const { humanId } = (await idea.json()) as { humanId: string };
    const code = `GF${RUN}`;
    await page.route('**/api/projects/*', (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'the database went away' }) })
        : route.continue(),
    );

    await page.goto(`/project-ideas/${humanId}`);
    await page.getByRole('button', { name: 'Convert' }).click();
    const dialog = page.getByRole('dialog', { name: `Make ${humanId} a project` });
    await dialog.getByRole('textbox', { name: 'Code' }).fill(code);
    await dialog.getByRole('combobox', { name: 'Joins group' }).click();
    await page.getByRole('option', { name: DELTA }).click();
    await dialog.getByRole('button', { name: 'Convert to project' }).click();

    // On the project, which exists, with the failure in words and the way to finish it.
    await expect(page).toHaveURL(new RegExp(`/projects/${code}$`));
    await expect(page.getByText(`${code} was created, but it did not join ${DELTA}: the database went away`)).toBeVisible();
    expect(await groupOf(page.request, code)).toBeNull();
    await page.unrouteAll({ behavior: 'wait' });
    await page.getByRole('region', { name: 'Notifications' }).getByRole('button', { name: 'Move to group…' }).click();
    await expect(page.getByRole('dialog', { name: `Move ${code} to…` })).toBeVisible();
  });

  test("a group's page lists its projects in order, with Move up / Move down", async ({ page }) => {
    await page.goto(`/groups/${seeded.gamma.slug}`);
    await expect(page.getByRole('heading', { name: GAMMA, level: 1 })).toBeVisible();
    const list = page.getByRole('list', { name: `Projects in ${GAMMA}, in order` });
    await expect(list.getByRole('link')).toHaveText([`Grouped one ${RUN}`, `Grouped two ${RUN}`]);

    await page.getByRole('button', { name: `Move Grouped two ${RUN} up` }).click();
    await expect(list.getByRole('link')).toHaveText([`Grouped two ${RUN}`, `Grouped one ${RUN}`]);
    await expect(page.getByRole('button', { name: `Move Grouped two ${RUN} down` })).toBeFocused();
    await expect(page.getByText(seeded.guideline).first()).toBeVisible();
  });
});
