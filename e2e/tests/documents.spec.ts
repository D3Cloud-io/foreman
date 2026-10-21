import { expect, test } from '@playwright/test';

/**
 * The Phase 4 exit demo, as a suite (T-4.10, FRM-REQ-063 … FRM-REQ-067).
 *
 * Edit one section, see a revision and a diff; open an ADR and see its supersedes graph. The
 * resource half of the demo — asking for `foreman://EXMP/architecture#deployment` and getting one
 * section — is asserted against the API here, and against the shim in its own contract tests.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

async function openArchitecture(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/projects/EXMP/documents');
  await page.getByRole('link', { name: 'Architecture' }).click();
  await expect(page.getByRole('heading', { name: 'Architecture', level: 1 })).toBeVisible();
}

test.describe('the document editor (S-22)', () => {
  test('shows each section with the URI it answers to', async ({ page }) => {
    await signIn(page);
    await openArchitecture(page);

    // The address is on the screen because it is what an MCP read uses and what a citation
    // points at — not an implementation detail of the editor.
    await expect(page.getByText('foreman://EXMP/architecture#deployment')).toBeVisible();
  });

  test('renders a Mermaid block as a diagram (FRM-REQ-066)', async ({ page }) => {
    await signIn(page);
    await openArchitecture(page);

    // `graph TB` becomes an SVG. A code fence still showing its source means mermaid never ran.
    const diagram = page.locator('[data-mermaid] svg').first();
    await expect(diagram).toBeVisible({ timeout: 15_000 });
    await expect(diagram.getByText('Cloudflare Tunnel')).toBeVisible();
  });

  test('saves one section, and leaves its neighbour alone', async ({ page }) => {
    await signIn(page);
    await openArchitecture(page);

    const neighbour = 'The section an MCP resource URI resolves to, on its own.';
    await expect(page.getByText(neighbour)).toBeVisible();

    await page.getByRole('button', { name: 'Edit Summary' }).click();
    const box = page.getByRole('textbox', { name: 'Summary — markdown' });
    const original = await box.inputValue();
    await box.fill('Edited by the e2e suite.');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText('Edited by the e2e suite.')).toBeVisible();
    // The whole claim of the single-section write.
    await expect(page.getByText(neighbour)).toBeVisible();

    // Put it back, so the suite is re-runnable.
    await page.getByRole('button', { name: 'Edit Summary' }).click();
    await page.getByRole('textbox', { name: 'Summary — markdown' }).fill(original);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Edited by the e2e suite.')).toBeHidden();
  });

  test('previews the markdown with the same renderer the page uses', async ({ page }) => {
    await signIn(page);
    await openArchitecture(page);

    await page.getByRole('button', { name: 'Edit Summary' }).click();
    await page.getByRole('textbox', { name: 'Summary — markdown' }).fill('# Heading\n\n- one\n- two');
    await page.getByRole('tab', { name: 'Preview' }).click();

    await expect(page.getByRole('listitem').filter({ hasText: 'one' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('a cancelled edit changes nothing', async ({ page }) => {
    await signIn(page);
    await openArchitecture(page);

    await page.getByRole('button', { name: 'Edit Summary' }).click();
    await page.getByRole('textbox', { name: 'Summary — markdown' }).fill('Discarded.');
    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.getByText('Discarded.')).toBeHidden();
  });

  test('lists revisions and diffs two of them', async ({ page }) => {
    await signIn(page);
    await openArchitecture(page);

    // One edit, so there is something to compare against the seeded revision.
    await page.getByRole('button', { name: 'Edit Summary' }).click();
    const box = page.getByRole('textbox', { name: 'Summary — markdown' });
    const original = await box.inputValue();
    await box.fill('A line that will show up in a diff.');
    await page.getByRole('textbox', { name: 'What changed, and why' }).fill('For the diff test.');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('A line that will show up in a diff.')).toBeVisible();

    await page.getByRole('button', { name: 'History' }).click();
    const dialog = page.getByRole('dialog');
    // `.first()`: the suite is re-runnable, so earlier runs have left revisions carrying the
    // same note. That they accumulate is the point of keeping them.
    await expect(dialog.getByText('For the diff test.').first()).toBeVisible();

    await dialog.getByRole('button', { name: /Compare revision/ }).first().click();
    await expect(dialog.getByText('A line that will show up in a diff.').first()).toBeVisible();
    await expect(dialog.getByText('changed').first()).toBeVisible();

    // Put it back — and **wait for it**. Without the assertion the test ends while the save is
    // still in flight, the page is torn down, and the next run starts from the edited text: which
    // is exactly how this test first failed, two runs later, comparing two identical revisions.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Edit Summary' }).click();
    await page.getByRole('textbox', { name: 'Summary — markdown' }).fill(original);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('A line that will show up in a diff.')).toBeHidden();
  });
});

test.describe('decisions, risks and the glossary', () => {
  test('draws the supersedes chain', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/adrs');

    // Headed "Decisions", the same word the sidebar uses. It read "Decision records" while the
    // link said "Decisions", which is a small thing that makes a reader doubt they arrived.
    await expect(page.getByRole('heading', { name: 'Decisions' })).toBeVisible();
    const chain = page.locator('[data-mermaid] svg').first();
    await expect(chain).toBeVisible({ timeout: 15_000 });
    await expect(chain.getByText('EXMP-ADR-001').first()).toBeVisible();
  });

  test('says what superseded a superseded decision', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/adrs');
    // A superseded ADR with nothing recorded as replacing it is the state the register prevents.
    await expect(page.getByText('Superseded').first()).toBeVisible();
  });

  test('names the tripwire on every risk', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/risks');

    await expect(page.getByRole('heading', { name: 'Risks' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Tripwire' })).toBeVisible();
    await expect(page.getByText(/tripwires? ha(s|ve) fired/)).toBeVisible();
  });

  test('shows ecosystem terms alongside the project’s own', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/glossary');

    await expect(page.getByRole('heading', { name: 'Glossary' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'ecosystem' }).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'project' }).first()).toBeVisible();
  });
});

test.describe('addressed by URI (FRM-REQ-087)', () => {
  // Every `/api` route needs a session — the request context keeps the cookie from this login,
  // which is also a small proof that the API is not readable anonymously.
  test.beforeEach(async ({ request }) => {
    const res = await request.post('/auth/login', { data: { email: EMAIL, password: PASSWORD } });
    expect(res.ok()).toBe(true);
  });

  test('refuses an anonymous read', async ({ playwright, baseURL }) => {
    // Spread rather than passed: `exactOptionalPropertyTypes` distinguishes an absent `baseURL`
    // from one that is `undefined`, and Playwright's options accept only the first.
    const anonymous = await playwright.request.newContext(
      baseURL === undefined ? {} : { baseURL },
    );
    expect((await anonymous.get('/api/resources')).status()).toBe(401);
    await anonymous.dispose();
  });

  test('returns one section, not the document', async ({ request }) => {
    const res = await request.get('/api/projects/EXMP/documents/at/architecture/sections/deployment');
    expect(res.status()).toBe(200);

    const body = (await res.json()) as { key: string; markdown: string };
    expect(body.key).toBe('deployment');
    expect(body.markdown).toContain('Cloudflare Tunnel');
    // The summary is not in the answer, which is the entire reason sections are addressable.
    expect(body.markdown).not.toContain('What this document is for');
  });

  test('lists every document and section as a URI', async ({ request }) => {
    const res = await request.get('/api/resources');
    const body = (await res.json()) as { items: { uri: string }[] };
    const uris = body.items.map((i) => i.uri);

    expect(uris).toContain('foreman://EXMP/architecture');
    expect(uris).toContain('foreman://EXMP/architecture#deployment');
  });
});

test.describe('the audit index (T-4.12)', () => {
  test('counts findings from the findings, not from a maintained number', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/audits');

    await expect(page.getByRole('heading', { name: 'Audits' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Findings' })).toBeVisible();
    // The seed writes four findings across its audits; the index counts them rather than
    // restating a number somebody typed.
    await expect(page.getByText(/open of/).first()).toBeVisible();
  });
});

test.describe('cross-project search (S-06, T-4.11, FRM-REQ-132)', () => {
  test('finds ADRs, and says which project each is from', async ({ page }) => {
    await signIn(page);
    await page.goto('/search?q=decision');

    const first = page.getByRole('list', { name: /Results for/ }).getByRole('listitem').first();
    await expect(first.getByRole('link', { name: /EXMP-ADR-/ })).toBeVisible();
    // A cross-project result set that does not say which project each hit is from is a list you
    // have to check one at a time.
    // Exact: 'EXMP' is also a substring of every ADR's ID on the same row.
    await expect(first.getByText('EXMP', { exact: true })).toBeVisible();
  });

  test('narrows to one kind', async ({ page }) => {
    await signIn(page);
    await page.goto('/search?q=decision&type=risk');

    // The same word, a different kind: no ADRs in the answer.
    await expect(page.getByRole('link', { name: /EXMP-ADR-/ })).toHaveCount(0);
  });

  test('keeps the search in the URL, so a result set is a link', async ({ page }) => {
    await signIn(page);
    await page.goto('/search');
    await page.getByRole('textbox', { name: 'Find' }).fill('tunnel');
    await page.getByRole('button', { name: 'Search' }).click();

    await expect(page).toHaveURL(/\/search\?q=tunnel/);
  });

  test('resolves an exact human ID first', async ({ page }) => {
    await signIn(page);
    await page.goto('/search?q=EXMP-ADR-001');

    await expect(
      page.getByRole('list', { name: /Results for/ }).getByRole('listitem').first(),
    ).toContainText('EXMP-ADR-001');
  });
});
