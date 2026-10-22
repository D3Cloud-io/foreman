import { createHmac, randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Triage on /findings (FRM-T-18.7, FRM-REQ-246, design review FRM-DA-007), a test per tab.
 *
 * Tabs Findings | Drift | Review | Blocked, carried in `?tab=` beside `?group=`; a list and the
 * selected record; keyboard verdicts with Undo; drift actions as prefilled editors the operator
 * saves; Accept drift only with a reason; bulk verdicts that report per-item refusals; and on a
 * phone, a list, then the record, with 44px verdict buttons.
 *
 * Every test makes its own records rather than spending the seed's: a verdict changes what it
 * rules on, and a suite that consumes seeded state passes once.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';
const WEBHOOK_SECRET = process.env['GITHUB_WEBHOOK_SECRET'] ?? 'dev-webhook-secret';
const RUN = Date.now().toString(36);

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

async function created<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const res = await request.post(path, { data });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as T;
}

/** A finding of the run's own, with a lens no other finding has, so a filter finds only these. */
async function finding(request: APIRequestContext, lens: string, title: string): Promise<string> {
  const body = await created<{ humanId: string }>(request, '/api/projects/EXMP/findings', {
    title,
    severity: 'critical',
    lenses: [lens],
    recommendationMd: 'Scope the select.',
  });
  return body.humanId;
}

async function findingState(request: APIRequestContext, id: string) {
  const res = await request.get(`/api/findings/${id}`);
  return (await res.json()) as {
    status: string;
    verified: string;
    recommendationMd: string | null;
    wontFixReason: string | null;
  };
}

/** How many audit events a record has: a verdict that changed nothing must not have written one. */
async function eventCount(request: APIRequestContext, id: string): Promise<number> {
  const res = await request.get(`/api/audit-events?entity=${encodeURIComponent(id)}&limit=200`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { items: unknown[] }).items.length;
}

/** The toast that says `text`. */
const toast = (page: Page, text: string | RegExp) => page.locator('.d3-toast').filter({ hasText: text }).last();

/** Deliver a push citing `task`, signed as GitHub would, and wait for its proposal. */
async function propose(request: APIRequestContext, task: string): Promise<string> {
  const sha = randomBytes(20).toString('hex');
  const body = JSON.stringify({
    repository: { full_name: 'matdemers1/example-project' },
    ref: 'refs/heads/main',
    commits: [
      {
        id: sha,
        message: `Triage ${RUN} (${task})`,
        timestamp: new Date().toISOString(),
        author: { name: 'e2e', email: 'e2e@example.com' },
        added: [],
        modified: ['apps/web/src/screens/Findings.tsx'],
        removed: [],
      },
    ],
  });
  const res = await request.post('/webhooks/github', {
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-github-delivery': randomBytes(8).toString('hex'),
      'x-hub-signature-256': `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`,
    },
    data: body,
  });
  expect(res.status()).toBe(202);
  await expect
    .poll(
      async () => {
        const list = await request.get('/api/attributions?status=proposed&project=EXMP&limit=200');
        const page = (await list.json()) as { items: { commit: { sha: string } }[] };
        return page.items.some((item) => item.commit.sha === sha);
      },
      { timeout: 20_000, message: 'the commit was never proposed' },
    )
    .toBe(true);
  return sha;
}

test.describe('triage on /findings', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('has four tabs, carried in ?tab= beside the scope, and keeps the tab and selection on reload', async ({ page }) => {
    await page.goto('/findings');
    const tabs = page.getByRole('tablist', { name: 'What to triage' });
    for (const name of ['Findings', 'Drift', 'Review', 'Blocked']) {
      await expect(tabs.getByRole('tab', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    // There is no "Changes" feed (FRM-DA-007).
    await expect(tabs.getByRole('tab', { name: /Changes/ })).toHaveCount(0);

    await tabs.getByRole('tab', { name: /^Blocked/ }).click();
    await expect(page).toHaveURL(/\/findings\?tab=blocked$/);
    await page.keyboard.press('3');
    await expect(page).toHaveURL(/\/findings\?tab=review$/);
    await page.keyboard.press('1');
    await expect(page).toHaveURL(/\/findings$/);

    // A selection is a place: reload lands on it.
    await page.keyboard.press('j');
    await expect(page).toHaveURL(/[?&]sel=/);
    const url = page.url();
    await page.reload();
    await expect(page).toHaveURL(url);
    await expect(page.locator('.fm-triage__row--selected')).toHaveCount(1);
  });

  test('Findings: honours ?project=, rules with a, w and r, and every verdict has Undo', async ({ page }) => {
    const request = page.request;
    const lens = `triage-${RUN}-one`;
    const id = await finding(request, lens, `A verdict to rule on ${RUN}`);

    await page.goto('/findings?project=NBR');
    await expect(page.getByRole('list', { name: 'Findings' })).toBeVisible();
    const projects = await page.locator('.fm-triage__rows .fm-triage__project').allTextContents();
    expect(projects.length).toBeGreaterThan(0);
    expect(new Set(projects)).toEqual(new Set(['NBR']));

    await page.goto(`/findings?project=EXMP&lens=${lens}`);
    await expect(page.getByRole('heading', { name: `A verdict to rule on ${RUN}`, level: 2 })).toBeVisible();

    // a — Acknowledge, one audit event, undone from its toast.
    await page.keyboard.press('a');
    await expect(toast(page, `${id} acknowledged`)).toBeVisible();
    await expect.poll(async () => (await findingState(request, id)).verified).toBe('confirmed');
    await toast(page, `${id} acknowledged`).getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, `Undone — ${id}`)).toBeVisible();
    await expect.poll(async () => (await findingState(request, id)).verified).toBe('unverified');

    // w — Won't fix asks for a reason first, and typing it (with an r in it) reopens nothing.
    await page.keyboard.press('w');
    const dialog = page.getByRole('dialog', { name: `Won’t fix ${id}` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Mark won’t fix' })).toBeDisabled();
    await dialog.getByRole('textbox', { name: 'Why it will not be fixed' }).fill('The router is being retired');
    await dialog.getByRole('button', { name: 'Mark won’t fix' }).click();
    await expect(toast(page, `${id} marked won’t fix`)).toBeVisible();
    // The reason is its own field; the recommendation the reviewer wrote is untouched (FRM-T-18.15).
    await expect
      .poll(async () => findingState(request, id))
      .toMatchObject({ status: 'wont_fix', recommendationMd: 'Scope the select.', wontFixReason: 'The router is being retired' });
    await toast(page, `${id} marked won’t fix`).getByRole('button', { name: 'Undo' }).click();
    await expect
      .poll(async () => findingState(request, id))
      .toMatchObject({ status: 'open', recommendationMd: 'Scope the select.', wontFixReason: null });

    // f, then r from the buttons beside the record.
    await page.getByRole('group', { name: `Verdicts on ${id}` }).getByRole('button', { name: /Mark fixed/ }).click();
    await expect(toast(page, `${id} marked fixed`)).toBeVisible();
    await expect.poll(async () => (await findingState(request, id)).status).toBe('fixed');
    await page.goto(`/findings?project=EXMP&lens=${lens}&status=fixed&sel=${id}`);
    await expect(page.getByRole('heading', { name: `A verdict to rule on ${RUN}`, level: 2 })).toBeVisible();
    await page.keyboard.press('r');
    await expect(toast(page, `${id} reopened`)).toBeVisible();
    await expect.poll(async () => (await findingState(request, id)).status).toBe('open');
  });

  test('Findings: a bulk verdict is N events, and a partial undo names what it could not put back', async ({ page }) => {
    const request = page.request;
    const lens = `triage-${RUN}-bulk`;
    const first = await finding(request, lens, `Bulk one ${RUN}`);
    const second = await finding(request, lens, `Bulk two ${RUN}`);

    await page.goto(`/findings?project=EXMP&lens=${lens}`);
    await page.getByRole('checkbox', { name: `Select ${first} for a bulk verdict` }).click();
    await page.getByRole('checkbox', { name: `Select ${second} for a bulk verdict` }).click();
    const bar = page.getByRole('region', { name: 'Bulk verdicts' });
    await expect(bar).toContainText('2 selected · 2 separate verdicts');

    await bar.getByRole('button', { name: 'Acknowledge 2' }).click();
    const done = toast(page, 'Acknowledged 2 findings');
    await expect(done).toBeVisible();

    // Something else changes the second one before the undo.
    const moved = await request.patch(`/api/projects/EXMP/findings/${second}`, { data: { status: 'fixed' } });
    expect(moved.status()).toBe(200);

    await done.getByRole('button', { name: 'Undo' }).click();
    const partial = toast(page, /Undid 1 of 2/);
    await expect(partial).toBeVisible();
    await expect(partial).toContainText(`${first} is back`);
    await expect(partial).toContainText(`${second} was not undone`);
    await expect.poll(async () => (await findingState(request, first)).verified).toBe('unverified');
    expect((await findingState(request, second)).verified).toBe('confirmed');
  });

  test('Findings: bulk Acknowledge and Reopen skip what they would not change, writing nothing for it', async ({ page }) => {
    const request = page.request;
    const lens = `triage-${RUN}-skip`;
    const already = await finding(request, lens, `Already acknowledged ${RUN}`);
    const fresh = await finding(request, lens, `Not yet acknowledged ${RUN}`);
    const ack = await request.patch(`/api/projects/EXMP/findings/${already}`, { data: { verified: 'confirmed' } });
    expect(ack.status()).toBe(200);
    const before = await eventCount(request, already);

    await page.goto(`/findings?project=EXMP&lens=${lens}`);
    await page.getByRole('checkbox', { name: `Select ${already} for a bulk verdict` }).click();
    await page.getByRole('checkbox', { name: `Select ${fresh} for a bulk verdict` }).click();
    const bar = page.getByRole('region', { name: 'Bulk verdicts' });
    await bar.getByRole('button', { name: 'Acknowledge 2' }).click();
    await expect(toast(page, 'Acknowledged 1 finding · 1 already acknowledged — skipped')).toBeVisible();
    await expect.poll(async () => (await findingState(request, fresh)).verified).toBe('confirmed');
    // No PATCH for the one already acknowledged, so no audit event.
    expect(await eventCount(request, already)).toBe(before);

    // Both open: Reopen has nothing to do, and says so rather than writing two no-ops.
    const counts = [await eventCount(request, already), await eventCount(request, fresh)];
    await page.getByRole('checkbox', { name: `Select ${already} for a bulk verdict` }).click();
    await page.getByRole('checkbox', { name: `Select ${fresh} for a bulk verdict` }).click();
    await bar.getByRole('button', { name: 'Reopen' }).click();
    await expect(toast(page, '2 already open — skipped')).toBeVisible();
    expect([await eventCount(request, already), await eventCount(request, fresh)]).toEqual(counts);
  });

  test('Review: confirms with y and rejects with n, moving on by itself, and Undo puts a ruling back', async ({ page }) => {
    const request = page.request;
    const one = await propose(request, 'T-0.1');
    const two = await propose(request, 'T-0.1');

    await page.goto(`/findings?tab=review&sel=${one.slice(0, 12)}~EXMP-T-0.1`);
    await expect(page.getByRole('heading', { name: `${one.slice(0, 7)} → EXMP-T-0.1`, level: 2 })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Move to the next after a verdict' })).toBeChecked();

    await page.keyboard.press('y');
    const confirmed = toast(page, `Confirmed ${one.slice(0, 7)} → EXMP-T-0.1`);
    await expect(confirmed).toBeVisible();
    // Reversible since FRM-T-18.14: the Undo is offered, and pressed below.
    await expect(confirmed.getByRole('button', { name: 'Undo' })).toBeVisible();
    await expect(page.locator('.fm-triage__row--dim').filter({ hasText: one.slice(0, 7) })).toContainText('confirmed just now');
    // Advanced: the selection left the ruled-on row.
    await expect(page).not.toHaveURL(new RegExp(`sel=${one.slice(0, 12)}`));

    await page.goto(`/findings?tab=review&sel=${two.slice(0, 12)}~EXMP-T-0.1`);
    await expect(page.getByRole('heading', { name: `${two.slice(0, 7)} → EXMP-T-0.1`, level: 2 })).toBeVisible();
    await page.keyboard.press('n');
    await expect(toast(page, `Rejected ${two.slice(0, 7)} → EXMP-T-0.1`)).toBeVisible();

    const queue = await request.get('/api/attributions?status=proposed&project=EXMP&limit=200');
    const shas = ((await queue.json()) as { items: { commit: { sha: string } }[] }).items.map((i) => i.commit.sha);
    expect(shas).not.toContain(one);
    expect(shas).not.toContain(two);

    // Undo on the rejection puts the proposal back in the queue.
    await toast(page, `Rejected ${two.slice(0, 7)} → EXMP-T-0.1`).getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, `${two.slice(0, 7)} → EXMP-T-0.1 is waiting for review again`)).toBeVisible();
    await expect
      .poll(async () => {
        const again = await request.get('/api/attributions?status=proposed&project=EXMP&limit=200');
        return ((await again.json()) as { items: { commit: { sha: string } }[] }).items.some((i) => i.commit.sha === two);
      })
      .toBe(true);
  });

  test('Drift: the resolving action is a prefilled editor you save, and Accept drift needs a reason', async ({ page }) => {
    const request = page.request;
    const hole = await created<{ humanId: string }>(request, '/api/projects/EXMP/requirements', {
      statement: `The system shall keep every page when a bundle is re-segmented ${RUN}. And more.`,
      priority: 'M',
    });
    const accepted = await created<{ humanId: string }>(request, '/api/projects/EXMP/requirements', {
      statement: `The system shall be accepted as drift ${RUN}.`,
      priority: 'M',
    });

    await page.goto(`/findings?tab=drift&sel=coverage-hole:${hole.humanId}`);
    const row = page.locator('.fm-triage__row--selected');
    await expect(row).toContainText('Create task…');
    const editor = page.getByRole('form', { name: `New task for ${hole.humanId}` });
    // Prefilled from the requirement — and nothing exists until Save.
    await expect(editor.getByRole('textbox', { name: 'Title' })).toHaveValue(
      `The system shall keep every page when a bundle is re-segmented ${RUN}.`,
    );
    await expect(editor.getByRole('button', { name: 'Save task' })).toBeDisabled();
    await editor.getByRole('textbox', { name: 'Done when' }).fill('A re-segmented bundle keeps every page.');
    await editor.getByRole('button', { name: 'Save task' }).click();
    await expect(toast(page, `created for ${hole.humanId}`)).toBeVisible();
    await expect(page.locator('.fm-triage__rows').getByText(hole.humanId, { exact: true })).toHaveCount(0);

    await page.goto(`/findings?tab=drift&sel=coverage-hole:${accepted.humanId}`);
    const accept = page.getByRole('form', { name: `Accept the drift on ${accepted.humanId}` });
    await expect(accept.getByRole('button', { name: 'Accept drift' })).toBeDisabled();
    await accept.getByRole('textbox', { name: /Why this can stay/ }).fill('Covered by the bundle work for now');
    await accept.getByRole('button', { name: 'Accept drift' }).click();
    const recorded = toast(page, `Accepted drift on ${accepted.humanId}`);
    await expect(recorded).toBeVisible();
    const group = page.getByRole('region', { name: /^Accepted, \d+/ });
    await expect(group).toContainText(accepted.humanId);
    // The decision is linked to the record and the category, and read back by that link.
    const acceptances = await request.get('/api/projects/EXMP/decisions?acceptsDrift=1&limit=200');
    const linked = ((await acceptances.json()) as { items: { acceptsDriftSubject: string; acceptsDriftCategory: string }[] }).items;
    expect(linked).toContainEqual(
      expect.objectContaining({ acceptsDriftSubject: accepted.humanId, acceptsDriftCategory: 'coverage-hole' }),
    );

    // Undo takes the decision back, and the drift is waiting again.
    await recorded.getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, `${accepted.humanId} is drift again`)).toBeVisible();
    await expect(page.getByRole('region', { name: /^Coverage holes/ })).toContainText(accepted.humanId);
  });

  test('Blocked: lists blocked work across the scope, unblocks through a saved editor, and undoes', async ({ page }) => {
    const request = page.request;
    const task = await created<{ humanId: string }>(request, '/api/projects/EXMP/tasks', {
      title: `Stuck ${RUN}`,
      status: 'blocked',
      blockedReason: `Waiting on the relay ${RUN}`,
    });

    await page.goto(`/findings?tab=blocked&sel=${task.humanId}`);
    await expect(page.getByRole('heading', { name: `Stuck ${RUN}`, level: 2 })).toBeVisible();
    await expect(page.getByText(`Waiting on the relay ${RUN}`).first()).toBeVisible();
    const editor = page.getByRole('form', { name: `Status of ${task.humanId}` });
    await expect(editor.getByRole('combobox', { name: 'Status' })).toContainText('In progress');
    await editor.getByRole('button', { name: 'Save status' }).click();
    const saved = toast(page, `${task.humanId} marked in progress`);
    await expect(saved).toBeVisible();
    await expect(page.locator('.fm-triage__rows').getByText(task.humanId, { exact: true })).toHaveCount(0);

    await saved.getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, `${task.humanId} is blocked again`)).toBeVisible();
    await expect(page.locator('.fm-triage__rows').getByText(task.humanId, { exact: true })).toBeVisible();
  });

  test('Drift, Review and Blocked honour ?project=, and a tab change keeps it', async ({ page }) => {
    const request = page.request;
    const task = await created<{ humanId: string }>(request, '/api/projects/EXMP/tasks', {
      title: `Stuck for the project filter ${RUN}`,
      status: 'blocked',
      blockedReason: `Waiting ${RUN}`,
    });

    // The tab carries the project with it.
    await page.goto('/findings?project=EXMP');
    await page.getByRole('tablist', { name: 'What to triage' }).getByRole('tab', { name: /^Blocked/ }).click();
    await expect(page).toHaveURL(/[?&]project=EXMP/);
    await expect(page).toHaveURL(/[?&]tab=blocked/);
    await expect(page.locator('.fm-triage__rows').getByText(task.humanId, { exact: true })).toBeVisible();
    for (const code of await page.locator('.fm-triage__rows .fm-triage__project').allTextContents()) {
      expect(code).toBe('EXMP');
    }

    // Another project's blocked list does not have it.
    await page.goto('/findings?tab=blocked&project=NBR');
    await expect(page.locator('.fm-triage__rows').getByText(task.humanId, { exact: true })).toHaveCount(0);

    // Review and Blocked pass the project to their reads; Drift keeps only its rows.
    for (const tab of ['drift', 'review']) {
      const attributions = page.waitForRequest((r) => r.url().includes('/api/attributions?') && r.url().includes('project=NBR'));
      const tasks = page.waitForRequest((r) => r.url().includes('/api/tasks?') && r.url().includes('project=NBR'));
      await page.goto(`/findings?tab=${tab}&project=NBR`);
      await attributions;
      await tasks;
      await page.waitForLoadState('networkidle');
      for (const code of await page.locator('.fm-triage__rows .fm-triage__project').allTextContents()) {
        expect(code, tab).toMatch(/^NBR\b/);
      }
    }
  });
});

test.describe('triage on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('is a list, then the record, with 44px verdict buttons', async ({ page }) => {
    await signIn(page);
    const request = page.request;
    const lens = `triage-${RUN}-phone`;
    const id = await finding(request, lens, `On a phone ${RUN}`);

    await page.goto(`/findings?project=EXMP&lens=${lens}`);
    const list = page.getByRole('region', { name: 'Findings', exact: true });
    const record = page.getByRole('region', { name: 'Findings: the selected record' });
    await expect(list).toBeVisible();
    await expect(record).toBeHidden();

    await list.getByRole('button', { name: new RegExp(`On a phone ${RUN}`) }).tap();
    await expect(page).toHaveURL(new RegExp(`sel=${id}`));
    await expect(record).toBeVisible();
    await expect(list).toBeHidden();

    const bar = page.getByRole('group', { name: `Verdicts on ${id}` }).last();
    for (const label of ['Acknowledge', 'Mark fixed', 'Won’t fix…']) {
      const box = await bar.getByRole('button', { name: label }).boundingBox();
      expect(box, label).not.toBeNull();
      expect(box?.height ?? 0, label).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0, label).toBeGreaterThanOrEqual(44);
    }

    await record.getByRole('button', { name: 'Back to the list' }).tap();
    await expect(list).toBeVisible();
    await expect(page).not.toHaveURL(/sel=/);
  });
});
