import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Undo, console side (FRM-REQ-243, FRM-T-18.4, design review FRM-DA-004).
 *
 * The clauses of the task's doneWhen that only a browser can show:
 *
 * - **A status change lands in place and Undo reverses it** — the row, its table and the focus on
 *   the select survive the write (no skeleton), the toast names the change, the phase and the
 *   project it rolled up, and Undo puts all three back through `POST /api/undo`.
 * - **A refused undo says why in the server's words**, and History says so before anyone presses
 *   anything; an event beyond the checked ten is checked on request.
 * - **A document save's Undo shows the restored text**, and still does after a reload — the read
 *   is never a cached copy of the undone body.
 * - **A double ⌘↵ stores one thing**, for a thought and for a canvas section.
 * - **Revoking a token asks first**, naming what stops working, because it cannot be undone —
 *   focus lands on Keep token, and Keep token keeps it.
 * - **An editor guards its draft**: Escape on a form with typed changes asks before discarding.
 *
 * Everything is made for the run through the API on the console's own session: a project of its
 * own (a project cannot be deleted, so it stays, as the groups spec's do), phases with numbers
 * nothing else uses in EXMP, removed afterwards, and a project idea, deleted afterwards.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';
const CODE = 'EXMP';
/** Four characters, letters and digits: unique enough per run, short enough for a project code. */
const RUN = Date.now().toString(36).slice(-4).toUpperCase();

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
async function seedPhase(api: APIRequestContext, code = CODE): Promise<{ phase: PhaseRow; task: TaskRow }> {
  let created = null;
  for (let attempt = 0; attempt < 5 && created?.status() !== 201; attempt += 1) {
    const number = 1000 + Math.floor(Math.random() * 9000);
    created = await api.post(`/api/projects/${code}/phases`, {
      data: { number, name: `Undo e2e ${String(number)}`, exitDemo: 'Nothing, yet.' },
    });
  }
  expect(created?.status(), await created?.text()).toBe(201);
  const phase = (await created?.json()) as PhaseRow;

  const made = await api.post(`/api/projects/${code}/tasks`, {
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

async function phaseStatus(api: APIRequestContext, humanId: string, code = CODE): Promise<string | undefined> {
  const res = await api.get(`/api/projects/${code}/phases`);
  return ((await res.json()) as { items: PhaseRow[] }).items.find((p) => p.humanId === humanId)?.status;
}

async function lifecycle(api: APIRequestContext, code: string): Promise<string> {
  const res = await api.get(`/api/projects/${code}`);
  return ((await res.json()) as { lifecycle: string }).lifecycle;
}

/** A project of the run's own, still `planned`, so its first started task rolls it up too. */
async function seedProject(api: APIRequestContext, suffix: string): Promise<string> {
  const code = `U${suffix}${RUN}`.slice(0, 8);
  const res = await api.post('/api/projects', { data: { code, name: `Undo e2e ${suffix} ${RUN}` } });
  expect(res.status(), await res.text()).toBe(201);
  return code;
}

interface HistoryItem {
  id: string;
  action: string;
  summary: string;
  undoable: boolean | null;
  reason?: string;
}

async function history(api: APIRequestContext, entity: string): Promise<HistoryItem[]> {
  const res = await api.get(`/api/audit-events?entity=${encodeURIComponent(entity)}&limit=50`);
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { items: HistoryItem[] }).items;
}

test.describe('undo, from the console (FRM-REQ-243)', () => {
  test('a status change lands in place, names the phase and project roll-ups, and Undo puts all three back', async ({ page }) => {
    await signIn(page);
    const api = page.request;
    const code = await seedProject(api, 'S');
    const { phase, task } = await seedPhase(api, code);

    try {
      await page.goto(`/projects/${code}/phases/${phase.humanId}`);
      const row = page.getByRole('row').filter({ hasText: task.humanId });
      await expect(row).toBeVisible();
      expect(await phaseStatus(api, phase.humanId, code)).toBe('planned');
      expect(await lifecycle(api, code)).toBe('planned');

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

      // The toast names the change and what it rolled up, from the server's `rolledUp`.
      const toast = page.getByText(
        `${task.humanId} marked in progress · ${phase.humanId} rolled up to active · ${code} rolled up to building`,
      );
      await expect(toast).toBeVisible();
      await expect(select).toContainText('In progress');
      // The same row, and the select still has the keyboard.
      await expect(row).toBeVisible();
      await expect(select).toBeFocused();
      expect(await page.evaluate(() => (window as unknown as { __undoSeen: { skeleton: boolean } }).__undoSeen.skeleton)).toBe(false);

      expect(await taskStatus(api, task.humanId)).toBe('in_progress');
      expect(await phaseStatus(api, phase.humanId, code)).toBe('active');
      expect(await lifecycle(api, code)).toBe('building');

      // Undo reverses the task's event, the phase's and the project's, last-first.
      await page.getByRole('button', { name: /^Undo/ }).click();
      await expect(page.getByText(`Undone — ${task.humanId} is to do again`)).toBeVisible();
      await expect(select).toContainText('To do');
      expect(await taskStatus(api, task.humanId)).toBe('todo');
      expect(await phaseStatus(api, phase.humanId, code)).toBe('planned');
      expect(await lifecycle(api, code)).toBe('planned');
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
      await api.delete(`/api/projects/${code}/tasks/${task.humanId}`);
      await api.delete(`/api/projects/${code}/phases/${phase.humanId}`);
    }
  });

  test('a refused undo shows the server’s words, and History says why before anything is pressed', async ({ page }) => {
    await signIn(page);
    const api = page.request;
    const { phase, task } = await seedPhase(api);

    try {
      await page.goto(`/projects/${CODE}/phases/${phase.humanId}`);
      const select = page.getByRole('combobox', { name: `Status of ${task.humanId}` });
      await select.click();
      await page.getByRole('option', { name: 'In progress' }).click();
      await expect(page.getByText(`${task.humanId} marked in progress`)).toBeVisible();

      // Something else changes the task before the Undo is pressed: the status may no longer be
      // put back without discarding that edit, so the server refuses — and the toast says why.
      const retitled = await api.patch(`/api/projects/${CODE}/tasks/${task.humanId}`, {
        data: { title: `Retitled ${String(Date.now())}` },
      });
      expect(retitled.ok(), await retitled.text()).toBe(true);
      const refused = (await history(api, task.humanId)).find(
        (event) => event.action === 'update' && event.undoable === false,
      );
      expect(refused?.reason, 'the status change should now be refused').toBeDefined();

      await page.getByRole('button', { name: /^Undo/ }).click();
      // Verbatim: the server's own sentence, not a paraphrase of it.
      await expect(page.getByText(/refused: /)).toContainText(refused?.reason ?? '');
      expect(await taskStatus(api, task.humanId)).toBe('in_progress');

      // History carries the same reason on the event, before anyone presses anything.
      await page.goto(`/tasks/${task.humanId}`);
      await page.getByRole('button', { name: 'History' }).click();
      const drawer = page.getByRole('dialog', { name: `History of ${task.humanId}` });
      await expect(drawer.getByText(`Cannot be undone here: ${refused?.reason ?? ''}`)).toBeVisible();
    } finally {
      await api.delete(`/api/projects/${CODE}/tasks/${task.humanId}`);
      await api.delete(`/api/projects/${CODE}/phases/${phase.humanId}`);
    }
  });

  test('History checks an event beyond the newest ten when asked', async ({ page }) => {
    await signIn(page);
    const api = page.request;
    const { phase, task } = await seedPhase(api);

    try {
      // Twelve events: the creation and eleven edits. The server dry-runs the newest ten only.
      for (let i = 1; i <= 11; i += 1) {
        const res = await api.patch(`/api/projects/${CODE}/tasks/${task.humanId}`, {
          data: { title: `Edit ${String(i)} of ${task.humanId}` },
        });
        expect(res.ok(), await res.text()).toBe(true);
      }

      await page.goto(`/tasks/${task.humanId}`);
      await page.getByRole('button', { name: 'History' }).click();
      const drawer = page.getByRole('dialog', { name: `History of ${task.humanId}` });
      const oldest = drawer.getByRole('list', { name: `Changes to ${task.humanId}` }).getByRole('listitem').last();
      await expect(oldest).toContainText('not checked');

      await oldest.getByRole('button', { name: /^Check whether/ }).click();
      // Checked: the guess is replaced by the verdict — a button to press, or the reason it cannot.
      await expect(oldest).not.toContainText('not checked');
      await expect(oldest.getByRole('button', { name: /^Check whether/ })).toHaveCount(0);
    } finally {
      await api.delete(`/api/projects/${CODE}/tasks/${task.humanId}`);
      await api.delete(`/api/projects/${CODE}/phases/${phase.humanId}`);
    }
  });

  test('a document save’s Undo shows the restored text, and still does after a reload', async ({ page }) => {
    await signIn(page);
    const api = page.request;
    const code = await seedProject(api, 'D');
    const original = `The text before ${RUN}.`;
    const made = await api.post(`/api/projects/${code}/documents`, {
      data: { kind: 'architecture', title: `Undo e2e ${RUN}`, sections: [{ heading: 'Summary', bodyMd: original }] },
    });
    expect(made.status(), await made.text()).toBe(201);
    const document = (await made.json()) as { id: string };

    await page.goto(`/projects/${code}/documents/${document.id}`);
    await expect(page.getByText(original)).toBeVisible();
    await page.getByRole('button', { name: 'Edit Summary' }).click();
    const edited = `The text to be undone ${RUN}.`;
    await page.getByRole('textbox', { name: 'Summary — markdown' }).fill(edited);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(edited)).toBeVisible();

    await page.getByRole('button', { name: /^Undo/ }).click();
    await expect(page.getByText('Undone — “Summary” is as it was')).toBeVisible();
    await expect(page.getByText(original)).toBeVisible();
    await expect(page.getByText(edited)).toBeHidden();

    // A full reload reads the document again — and is not answered from a cached copy of the
    // undone body, because the undo moved the document's version.
    await page.reload();
    await expect(page.getByText(original)).toBeVisible();
    await expect(page.getByText(edited)).toBeHidden();
  });

  test('a double ⌘↵ stores one thought and sends one section save', async ({ page }) => {
    await signIn(page);
    const api = page.request;
    const made = await api.post('/api/project-ideas', { data: { title: `Double submit ${RUN}` } });
    expect(made.status(), await made.text()).toBe(201);
    const idea = (await made.json()) as { humanId: string };

    try {
      await page.goto(`/project-ideas/${idea.humanId}`);
      const thought = `One thought, pressed twice ${RUN}`;
      const box = page.getByRole('textbox', { name: 'Add a thought' });
      await box.fill(thought);
      // To whatever has focus, without waiting: the second press must not wait for anything.
      await page.keyboard.press('Control+Enter');
      await page.keyboard.press('Control+Enter');
      await expect(page.getByText('Thought added')).toBeVisible();
      await expect(box).toHaveValue('');
      const comments = await api.get(`/api/project-ideas/${idea.humanId}/comments`);
      const items = ((await comments.json()) as { items: { body: string }[] }).items;
      expect(items.filter((c) => c.body === thought)).toHaveLength(1);

      const patches: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'PATCH' && request.url().includes(`/api/project-ideas/${idea.humanId}`)) {
          patches.push(request.url());
        }
      });
      const pitch = page.getByRole('region', { name: 'The pitch' });
      await pitch.getByRole('button', { name: 'Write' }).click();
      const area = page.getByRole('textbox', { name: 'The pitch' });
      await area.fill(`A pitch, saved once ${RUN}`);
      // The first save may close the editor before the second press: sent to the page, not to the
      // textarea, so the test never waits for a box that is gone.
      await page.keyboard.press('Control+Enter');
      await page.keyboard.press('Control+Enter');
      await expect(pitch.getByText(`A pitch, saved once ${RUN}`)).toBeVisible();
      expect(patches).toHaveLength(1);
    } finally {
      await api.delete(`/api/project-ideas/${idea.humanId}`);
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
    // Focus on the safe choice, so Enter keeps the token rather than revoking it.
    await expect(dialog.getByRole('button', { name: 'Keep token' })).toBeFocused();
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
