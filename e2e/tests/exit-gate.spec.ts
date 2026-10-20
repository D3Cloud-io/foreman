import { expect, test, type Page } from '@playwright/test';

/**
 * FRM-REQ-056, from the console: **completing a phase whose exit gate fails is refused, the refusal
 * names what is in the way, and the phase stays as it was** (FRM-T-025).
 *
 * Phase status is mostly derived since ADR-018, but the console's Edit still offers Complete by
 * hand, and that path runs the same gate the rollup does. The phase here is made for the run, with
 * one Must assigned to it that no task satisfies — the gate's `uncovered-must` refusal — and is
 * removed afterwards so the seeded project the other specs read is left as it was found.
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

test.describe('the exit gate, from the console (FRM-REQ-056)', () => {
  test('refuses to complete a phase with an uncovered Must, naming it, and leaves the phase as it was', async ({
    page,
  }) => {
    await signIn(page);
    const api = page.request;

    // A phase number nothing else uses, so reruns never collide with the seed or with each other.
    const number = 9000 + (Date.now() % 900_000);
    const created = await api.post(`/api/projects/${CODE}/phases`, {
      data: { number, name: `Exit gate e2e ${String(number)}`, exitDemo: 'Nothing, yet.' },
    });
    expect(created.status(), await created.text()).toBe(201);
    const phase = (await created.json()) as PhaseRow;

    const must = await api.post(`/api/projects/${CODE}/requirements`, {
      data: {
        statement: 'When a phase is completed, the system shall have a task that satisfies this.',
        priority: 'M',
        phaseId: phase.id,
      },
    });
    expect(must.status(), await must.text()).toBe(201);
    const requirement = (await must.json()) as { humanId: string };

    try {
      await page.goto(`/projects/${CODE}/phases/${phase.humanId}`);
      const before = phase.status;
      await expect(page.getByRole('heading', { level: 1 })).toContainText(`Exit gate e2e ${String(number)}`);

      await page.getByRole('button', { name: 'Edit' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('combobox', { name: 'Status' }).click();
      await page.getByRole('option', { name: 'Complete' }).click();
      await dialog.getByRole('button', { name: 'Save' }).click();

      // The refusal, in the dialog, naming the requirement that blocks it — not "the gate failed".
      const refusal = dialog.getByRole('alert');
      await expect(refusal).toBeVisible();
      await expect(refusal).toContainText(`${phase.humanId} cannot be completed`);
      await expect(refusal.getByRole('list', { name: 'What is in the way' })).toContainText(requirement.humanId);
      await expect(refusal).toContainText('no task satisfies it');

      // The dialog stays open on a refusal, so the person can read it; nothing was saved.
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();

      await page.reload();
      await expect(page.getByRole('heading', { level: 1 })).toContainText(`Exit gate e2e ${String(number)}`);
      // The status badge still says what it said before the attempt.
      await expect(page.getByText(before, { exact: true }).first()).toBeVisible();

      const phases = await api.get(`/api/projects/${CODE}/phases`);
      const stored = ((await phases.json()) as { items: (PhaseRow & { completedAt: string | null })[] }).items.find(
        (p) => p.humanId === phase.humanId,
      );
      expect(stored?.status).toBe(before);
      expect(stored?.status).not.toBe('complete');
      expect(stored?.completedAt ?? null).toBeNull();
    } finally {
      await api.delete(`/api/projects/${CODE}/requirements/${requirement.humanId}`);
      await api.delete(`/api/projects/${CODE}/phases/${phase.humanId}`);
    }
  });
});
