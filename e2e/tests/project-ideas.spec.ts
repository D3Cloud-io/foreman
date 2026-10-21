import { expect, test } from '@playwright/test';

/**
 * Project ideas, from the console (FRM-REQ-159 … FRM-REQ-164, FRM-ADR-015).
 *
 * The screen exists so a project-sized thought has somewhere to live that is not a project. What
 * only this surface can show is the seam between the two: a code is never asked for until the
 * moment somebody converts, and converting keeps the idea rather than consuming it.
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

const title = () => `Project idea from an e2e run ${String(Date.now())}`;

/** A code this run invents, short enough to be legal and unlikely to collide with a real one. */
const code = () => `E${String(Date.now()).slice(-4)}`;

test.describe('project ideas (S-28)', () => {
  test('sits beside Projects in the sidebar, not inside one', async ({ page }) => {
    await signIn(page);

    // The distinction the whole entity exists for, made visible in the one place that teaches it.
    // In the Library since FRM-T-16.4: a row reached now and then, folded to keep the sidebar short.
    const library = page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library' });
    if ((await library.getAttribute('aria-expanded')) === 'false') await library.click();
    await page.getByRole('link', { name: 'Project ideas' }).click();
    await expect(page).toHaveURL(/\/project-ideas$/);
    await expect(page.getByRole('heading', { name: 'Project ideas', level: 1 })).toBeVisible();
  });

  /** Write one down; creating lands on its own page by design. Returns its title. */
  async function create(page: import('@playwright/test').Page, pitch?: string): Promise<string> {
    const text = title();
    await page.goto('/project-ideas');
    await page.getByRole('button', { name: 'New project idea' }).click();
    // A code is immutable and embedded in every ID the project will have (ADR-008). Asking for
    // one here would be asking a permanent question at the moment of least information.
    await expect(page.getByRole('textbox', { name: 'Code' })).toBeHidden();
    await page.getByRole('textbox', { name: 'Title' }).fill(text);
    if (pitch !== undefined) await page.getByRole('textbox', { name: 'Pitch' }).fill(pitch);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { name: text, level: 1 })).toBeVisible();
    return text;
  }

  test('takes one without asking for a code, and opens it', async ({ page }) => {
    await signIn(page);
    await create(page, 'What it is, and who it is for.');

    await expect(page).toHaveURL(/\/project-ideas\/PI-\d+$/);
    // It lands as `new`: nobody has judged it, and the create form offered no status at all.
    await expect(page.getByText('New', { exact: true }).first()).toBeVisible();
  });

  test('will not park one that does not say why', async ({ page }) => {
    await signIn(page);
    await create(page);

    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await page.getByRole('combobox', { name: 'Status' }).click();
    await page.getByRole('option', { name: 'Parked' }).click();
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText('A project idea that is parked has to say why.')).toBeVisible();
    await page.getByRole('textbox', { name: 'Why' }).fill('Not before Someday Vault ships.');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    // The reason leads the page — it changes how everything under it reads.
    await expect(page.getByText('Parked — deliberately not now')).toBeVisible();
    await expect(page.getByText('Not before Someday Vault ships.')).toBeVisible();
  });

  test('offers no way to mark one built by hand', async ({ page }) => {
    await signIn(page);
    await create(page);

    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await page.getByRole('combobox', { name: 'Status' }).click();

    // `Built` means a project exists. Offering it here would let somebody record that an idea
    // became something, with nothing to point at.
    await expect(page.getByRole('option', { name: 'Parked' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Built' })).toBeHidden();
  });

  test('converts into a project, and keeps the idea as the record of where it began', async ({
    page,
  }) => {
    await signIn(page);
    const text = await create(page, 'The pitch that should carry across.');
    const ideaUrl = page.url();
    const projectCode = code();

    await page.getByRole('button', { name: 'Convert' }).click();
    await page.getByRole('textbox', { name: 'Code' }).fill(projectCode);
    await page.getByRole('button', { name: 'Convert to project' }).click();

    // Straight to the thing that now exists, with the pitch it was given as an idea.
    await expect(page).toHaveURL(new RegExp(`/projects/${projectCode}$`));
    await expect(page.getByText('The pitch that should carry across.')).toBeVisible();

    // And the idea is still there, saying what it became — frozen, because a project now says
    // what it says.
    await page.goto(ideaUrl);
    await expect(page.getByRole('heading', { name: text, level: 1 })).toBeVisible();
    await expect(page.getByText(new RegExp(`Became ${projectCode}`))).toBeVisible();
    await expect(page.getByRole('button', { name: 'Convert' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeHidden();
  });

  const toast = (page: import('@playwright/test').Page, text: string | RegExp) =>
    page.locator('.d3-toast').filter({ hasText: text }).last();

  test('every write says what it did with an Undo: create, edit, delete (FRM-T-18.14)', async ({ page }) => {
    await signIn(page);
    const text = await create(page, 'Original pitch.');
    const humanId = /\/project-ideas\/(PI-\d+)$/.exec(page.url())?.[1] ?? '';
    expect(humanId).not.toBe('');

    // Creating is said, on the page it opened.
    await expect(toast(page, `${humanId} written down`).getByRole('button', { name: 'Undo' })).toBeVisible();

    // Editing: in place, a toast naming the fields, and Undo puts the pitch back.
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await page.getByRole('textbox', { name: 'Pitch' }).fill('A changed pitch.');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    const saved = toast(page, `Saved ${humanId} — pitch`);
    await expect(saved).toBeVisible();
    await saved.getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, `Undone — ${humanId} is as it was`)).toBeVisible();
    await expect.poll(async () => ((await (await page.request.get(`/api/project-ideas/${humanId}`)).json()) as { pitch: string }).pitch).toBe('Original pitch.');

    // Deleting acts at once; Undo brings it back and returns to it.
    await page.getByRole('button', { name: `Delete ${humanId}` }).click();
    await expect(page).toHaveURL(/\/project-ideas$/);
    await toast(page, `${humanId} deleted`).getByRole('button', { name: 'Undo' }).click();
    await expect(page).toHaveURL(new RegExp(`/project-ideas/${humanId}$`));
    await expect(page.getByRole('heading', { name: text, level: 1 })).toBeVisible();
  });

  test('closing the editor with unsaved words asks first, and Cancel does not (FRM-T-18.14)', async ({ page }) => {
    await signIn(page);
    await create(page, 'Kept as it is.');

    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await page.getByRole('textbox', { name: 'Pitch' }).fill('Kept as it is. Plus a draft nobody saved.');

    const asked: string[] = [];
    page.once('dialog', (dialog) => {
      asked.push(dialog.message());
      void dialog.dismiss();
    });
    await page.keyboard.press('Escape');
    expect(asked[0]).toMatch(/^Discard \d+ unsaved characters? in PI-\d+\?$/);
    // Dismissed: the draft is still there.
    await expect(page.getByRole('textbox', { name: 'Pitch' })).toHaveValue('Kept as it is. Plus a draft nobody saved.');

    // Cancel is the person saying discard, so it is not asked again.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('converting offers Undo, and Undo makes it an idea again (FRM-T-18.14)', async ({ page }) => {
    await signIn(page);
    const text = await create(page, 'Converted, then taken back.');
    const humanId = /\/project-ideas\/(PI-\d+)$/.exec(page.url())?.[1] ?? '';
    const projectCode = code();

    await page.getByRole('button', { name: 'Convert' }).click();
    await page.getByRole('textbox', { name: 'Code' }).fill(projectCode);
    await page.getByRole('button', { name: 'Convert to project' }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectCode}$`));

    await toast(page, `${humanId} converted — ${projectCode} created`).getByRole('button', { name: 'Undo' }).click();
    await expect(page).toHaveURL(new RegExp(`/project-ideas/${humanId}$`));
    await expect(page.getByRole('heading', { name: text, level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Convert' })).toBeVisible();
    expect((await page.request.get(`/api/projects/${projectCode}`)).status()).toBe(404);
  });
});
