import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Undo, console side (FRM-REQ-243, FRM-T-18.4, design review FRM-DA-004).
 *
 * The three clauses of the task's doneWhen that only a browser can show:
 *
 * - **A status change lands in place and Undo reverses it** — the row, its table and the focus on
 *   the select survive the write (no skeleton), the toast names the change and the phase it rolled
 *   up, and Undo puts both back through `POST /api/undo`.
 * - **Revoking a token asks first**, naming what stops working, because it cannot be undone — and
 *   Keep token keeps it.
 * - **An editor guards its draft**: Escape on a form with typed changes asks before discarding.
 *
 * Everything is made for the run through the API on the console's own session, in a phase with a
 * number nothing else uses, and removed afterwards, so the seed other specs read is left as found.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';
const CODE = 'EXMP';

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

interface PhaseRow {
  id: string;
  humanId: string;
  status: string;
}

interface TaskRow {
  humanId: string;
  status: string;
}

/** A planned phase of its own with one task to do in it — so a status change rolls the phase up. */
async function seedPhase(api: APIRequestContext): Promise<{ phase: PhaseRow; task: TaskRow }> {
  let created = null;
  for (let attempt = 0; attempt < 5 && created?.status() !== 201; attempt += 1) {
    const number = 1000 + Math.floor(Math.random() * 9000);
    created = await api.post(`/api/projects/${CODE}/phases`, {
      data: { number, name: `Undo e2e ${String(number)}`, exitDemo: 'Nothing, yet.' },
    });
  }
  expect(created?.status(), await created?.text()).toBe(201);
  const phase = (await created?.json()) as PhaseRow;

  const made = await api.post(`/api/projects/${CODE}/tasks`, {
    data: { title: `Undo me ${String(Date.now())}`, phaseId: phase.id },
  });
  expect(made.status(), await made.text()).toBe(201);
  const task = (await made.json()) as TaskRow;
  return { phase, task };
}

async function taskStatus(api: APIRequestContext, humanId: string): Promise<string> {
  const res = await api.get(`/api/entities/${humanId}`);
  return ((await res.json()) as { entity: { status: string } }).entity.status;
}

async function phaseStatus(api: APIRequestContext, humanId: string): Promise<string | undefined> {
  const res = await api.get(`/api/projects/${CODE}/phases`);
  return ((await res.json()) as { items: PhaseRow[] }).items.find((p) => p.humanId === humanId)?.status;
}

test.describe('undo, from the console (FRM-REQ-243)', () => {
  test('a status change lands in place, names the roll-up, and Undo puts both back', async ({ page }) => {
    await signIn(page);
    const api = page.request;
    const { phase, task } = await seedPhase(api);

    try {
      await page.goto(`/projects/${CODE}/phases/${phase.humanId}`);
      const row = page.getByRole('row').filter({ hasText: task.humanId });
      await expect(row).toBeVisible();
      expect(await phaseStatus(api, phase.humanId)).toBe('planned');

      // Watch for a skeleton from here on: an in-place write never shows one.
      await page.evaluate(() => {
        const seen = { skeleton: false };
        (window as unknown as { __undoSeen: typeof seen }).__undoSeen = seen;
        new MutationObserver(() => {
          if (document.querySelector('.d3-skl') !== null) seen.skeleton = true;
        }).observe(document.body, { childList: true, subtree: true });
      });

      const select = page.getByRole('combobox', { name: `Status of ${task.humanId}` });
      await select.click();
      await page.getByRole('option', { name: 'In progress' }).click();

      // The toast names the change and the phase it rolled up, from the server's `rolledUp`.
      const toast = page.getByText(`${task.humanId} marked in progress · ${phase.humanId} rolled up to active`);
      await expect(toast).toBeVisible();
      await expect(select).toContainText('In progress');
      // The same row, and the select still has the keyboard.
      await expect(row).toBeVisible();
      await expect(select).toBeFocused();
      expect(await page.evaluate(() => (window as unknown as { __undoSeen: { skeleton: boolean } }).__undoSeen.skeleton)).toBe(false);

      expect(await taskStatus(api, task.humanId)).toBe('in_progress');
      expect(await phaseStatus(api, phase.humanId)).toBe('active');

      // Undo reverses the task's event and the phase's, last-first.
      await page.getByRole('button', { name: /^Undo/ }).click();
      await expect(page.getByText(`Undone — ${task.humanId} is to do again`)).toBeVisible();
      await expect(select).toContainText('To do');
      expect(await taskStatus(api, task.humanId)).toBe('todo');
      expect(await phaseStatus(api, phase.humanId)).toBe('planned');
      expect(await page.evaluate(() => (window as unknown as { __undoSeen: { skeleton: boolean } }).__undoSeen.skeleton)).toBe(false);

      // And the task's History lists the change and its undo.
      await page.goto(`/tasks/${task.humanId}`);
      await page.getByRole('button', { name: 'History' }).click();
      const drawer = page.getByRole('dialog', { name: `History of ${task.humanId}` });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole('list', { name: `Changes to ${task.humanId}` }).getByRole('listitem').first()).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
      await expect(page.getByRole('button', { name: 'History' })).toBeFocused();
    } finally {
      await api.delete(`/api/projects/${CODE}/tasks/${task.humanId}`);
      await api.delete(`/api/projects/${CODE}/phases/${phase.humanId}`);
    }
  });

  test('revoking a token asks first, names what stops, and Keep token keeps it', async ({ page }) => {
    await signIn(page);
    const api = page.request;
    const name = `undo e2e ${String(Date.now())}`;
    const issued = await api.post('/api/tokens', { data: { name, scopes: ['read'] } });
    expect(issued.status(), await issued.text()).toBe(201);
    const token = (await issued.json()) as { id: string; prefix: string };
    const revokedAt = async () => {
      const res = await api.get('/api/tokens');
      return ((await res.json()) as { items: { id: string; revokedAt: string | null }[] }).items.find(
        (row) => row.id === token.id,
      )?.revokedAt;
    };

    await page.goto('/tokens');
    const revoke = page.getByRole('button', { name: `Revoke ${name}`, exact: true });
    await revoke.click();

    const dialog = page.getByRole('dialog', { name: `Revoke “${name}”?` });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`Agents using ${token.prefix}… stop working at once. This cannot be undone.`);

    // Keep token is the safe way out, and nothing happened.
    await dialog.getByRole('button', { name: 'Keep token' }).click();
    await expect(dialog).toBeHidden();
    expect(await revokedAt()).toBeNull();

    await revoke.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: `Revoke ${name}` }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`Revoked “${name}”`)).toBeVisible();
    // It cannot be undone, so the toast offers nothing to press.
    await expect(page.getByRole('button', { name: /^Undo/ })).toHaveCount(0);
    expect(await revokedAt()).not.toBeNull();
  });

  test('an editor asks before Escape throws a draft away', async ({ page }) => {
    await signIn(page);
    const api = page.request;
    const { phase, task } = await seedPhase(api);

    try {
      await page.goto(`/tasks/${task.humanId}`);
      await page.getByRole('button', { name: 'Edit' }).click();
      const dialog = page.getByRole('dialog', { name: `Edit ${task.humanId}` });
      await expect(dialog).toBeVisible();

      // Nothing typed: Escape closes without a question.
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();

      await page.getByRole('button', { name: 'Edit' }).click();
      await expect(dialog).toBeVisible();
      const title = dialog.getByRole('textbox', { name: 'Title' });
      await title.fill(`${await title.inputValue()} with a draft`);

      // Escape with a draft asks; saying no keeps the form open with the text in it.
      const asked: string[] = [];
      page.once('dialog', (question) => {
        asked.push(question.message());
        void question.dismiss();
      });
      await page.keyboard.press('Escape');
      await expect.poll(() => asked.length).toBe(1);
      expect(asked[0]).toMatch(new RegExp(`^Discard \\d+ unsaved characters? in ${task.humanId.replace(/\./g, '\\.')}\\?$`));
      await expect(dialog).toBeVisible();
      await expect(title).toHaveValue(/with a draft$/);

      // Saying yes discards it, and nothing was saved.
      page.once('dialog', (question) => {
        void question.accept();
      });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      const stored = await api.get(`/api/entities/${task.humanId}`);
      expect(((await stored.json()) as { entity: { title: string } }).entity.title).not.toMatch(/with a draft$/);
    } finally {
      await api.delete(`/api/projects/${CODE}/tasks/${task.humanId}`);
      await api.delete(`/api/projects/${CODE}/phases/${phase.humanId}`);
    }
  });
});
