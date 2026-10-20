import { createHash } from 'node:crypto';
// The named export, as accessibility.spec.ts explains: the default resolves to the namespace.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { NodeResult, Result } from 'axe-core';

/**
 * Screens in the console (FRM-T-12.3; FRM-REQ-195, FRM-REQ-196, FRM-REQ-197).
 *
 * The screen exists to put a design beside what was built, so that is what is asserted: both
 * images load (through the session cookie, as a plain `<img>`), a different variant shows a
 * different pair, a dropped PNG becomes the design on the spot, and a drift is recorded with what
 * drifted. The seed has no screens, so each test makes its own through the API it drives.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';
const CODE = 'EXMP';

/** Four 8×8 PNGs in four colours: distinct bytes, so distinct blobs, so distinct URLs. */
const PNG = {
  proposal: 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGPQiDqBFTEMLQkAFKhSgZfuVK8AAAAASUVORK5CYII=',
  capture: 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4EaWBFTEMLQkAZKhSgU2VHoYAAAAASUVORK5CYII=',
  mobile: 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGPQ2BKFFTEMLQkAPApNgUKgvRsAAAAASUVORK5CYII=',
  dropped: 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGOYZrMKK2IYWhIAGfNfAVeAoc4AAAAASUVORK5CYII=',
} as const;

const bytes = (name: keyof typeof PNG): Buffer => Buffer.from(PNG[name], 'base64');
const sha = (name: keyof typeof PNG): string =>
  createHash('sha256').update(bytes(name)).digest('hex');

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

/**
 * A screen with a desktop dark proposal and capture, and a mobile light proposal — through
 * `page.request`, which carries the console's own session, so the writes are the console's.
 */
async function seedScreen(page: Page): Promise<{ humanId: string; name: string }> {
  const name = `Inbox from an e2e run ${String(Date.now())}`;
  const created = await page.request.post(`/api/projects/${CODE}/screens`, {
    data: { name, route: '/inbox' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { humanId } = (await created.json()) as { humanId: string };

  const upload = async (file: keyof typeof PNG): Promise<string> => {
    const res = await page.request.post('/api/blobs', {
      multipart: { file: { name: `${file}.png`, mimeType: 'image/png', buffer: bytes(file) } },
    });
    expect(res.ok(), await res.text()).toBe(true);
    return ((await res.json()) as { sha256: string }).sha256;
  };

  const proposal = async (file: keyof typeof PNG, viewport: string, theme: string) => {
    const res = await page.request.post(`/api/projects/${CODE}/screens/${humanId}/proposals`, {
      data: {
        blobSha256: await upload(file),
        viewport,
        theme,
        figmaFileKey: 'e2eFigmaFile',
        figmaNodeId: '12:34',
        figmaFileVersion: '1',
      },
    });
    expect(res.ok(), await res.text()).toBe(true);
  };

  await proposal('proposal', 'desktop', 'dark');
  await proposal('mobile', 'mobile', 'light');

  const capture = await page.request.post(`/api/projects/${CODE}/screens/${humanId}/captures`, {
    data: {
      blobSha256: await upload('capture'),
      viewport: 'desktop',
      theme: 'dark',
      commitSha: '0123456789abcdef0123456789abcdef01234567',
    },
  });
  expect(capture.ok(), await capture.text()).toBe(true);

  return { humanId, name };
}

/** The image is there and actually decoded — a broken `<img>` is visible too. */
async function loaded(image: Locator, blob: string): Promise<void> {
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('src', `/api/blobs/${blob}`);
  await expect
    .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
}

async function violationsOn(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map(
    (v: Result) =>
      `${v.id} (${v.impact ?? 'unknown'}): ${v.help}\n      ${v.nodes
        .slice(0, 3)
        .map((n: NodeResult) => n.target.join(' '))
        .join('\n      ')}`,
  );
}

test.describe('screens (FRM-T-12.3)', () => {
  test('compares, takes a dropped PNG as the design, and records a drift', async ({ page }) => {
    await signIn(page);
    const { humanId, name } = await seedScreen(page);

    // Reached from inside the project, not only by URL.
    await page.goto(`/projects/${CODE}`);
    // Behind the project's Knowledge row since FRM-T-16.4, which keeps the sidebar to 900px.
    await page.getByRole('button', { name: 'Knowledge' }).click();
    await page.getByRole('link', { name: 'Screens', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Screens', level: 1 })).toBeVisible();
    await page.getByRole('link', { name: humanId, exact: true }).click();
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();

    const proposed = page.getByRole('region', { name: 'Proposed' });
    const built = page.getByRole('region', { name: 'Built' });

    // FRM-REQ-196: the design beside the build, for the variant shown.
    await loaded(proposed.getByRole('img', { name: `Proposed design for ${name}, desktop dark` }), sha('proposal'));
    await loaded(built.getByRole('img', { name: `Built screen for ${name}, desktop dark` }), sha('capture'));
    await expect(proposed.getByRole('link', { name: /Figma frame 12:34/ })).toHaveAttribute(
      'href',
      'https://www.figma.com/design/e2eFigmaFile?node-id=12-34',
    );
    await expect(built.getByText('0123456')).toBeVisible();

    // Another variant is another pair — here a design with nothing built for it yet.
    await page.getByRole('radiogroup', { name: 'Viewport' }).getByRole('radio', { name: 'Mobile' }).click();
    await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Light' }).click();
    await loaded(proposed.getByRole('img', { name: `Proposed design for ${name}, mobile light` }), sha('mobile'));
    await expect(built.getByText('Nothing captured at mobile light yet')).toBeVisible();

    await page.getByRole('radiogroup', { name: 'Viewport' }).getByRole('radio', { name: 'Desktop' }).click();
    await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }).click();
    await loaded(proposed.getByRole('img', { name: `Proposed design for ${name}, desktop dark` }), sha('proposal'));

    // FRM-REQ-197: a PNG put on the screen becomes its current design, with no reload.
    await expect(proposed.getByRole('button', { name: /Drop a PNG here/ })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'dropped.png',
      mimeType: 'image/png',
      buffer: bytes('dropped'),
    });
    await expect(proposed.getByRole('status')).toHaveText('dropped.png is now the current desktop dark proposal.');
    await loaded(proposed.getByRole('img', { name: `Proposed design for ${name}, desktop dark` }), sha('dropped'));
    await expect(proposed.getByText('Dropped in the console')).toBeVisible();

    // The design it replaced is kept, marked superseded.
    const history = page.getByRole('region', { name: 'Version history' });
    await history.getByText('3 proposals and 1 capture').click();
    await expect(history.getByText('superseded', { exact: true })).toBeVisible();

    // FRM-REQ-195: a drift has to say what drifted, and the error is tied to the field.
    const submit = built.getByRole('button', { name: 'Record verdict' });
    await submit.click();
    await expect(built.getByText('Choose a verdict.')).toBeVisible();

    await built.getByRole('radio', { name: 'Drifted — fix' }).check();
    await submit.click();
    const note = built.getByRole('textbox', { name: /Note/ });
    await expect(note).toHaveAttribute('aria-invalid', 'true');
    await expect(note).toHaveAccessibleDescription(/Say what drifted/);

    const what = `The header spacing is 8 not 16 (${String(Date.now())})`;
    await note.fill(what);
    await submit.click();
    await expect(built.getByText('Recorded: Drifted — fix.')).toBeVisible();
    await expect(built.locator('.fm-badge', { hasText: 'Drifted — fix' })).toBeVisible();
    await expect(built.getByText(what)).toBeVisible();

    // And it is the record, not only the page: kind, reviewer and note stored.
    const res = await page.request.get(`/api/projects/${CODE}/screens/${humanId}`);
    const detail = (await res.json()) as {
      captures: { verdicts: { verdict: string; note: string | null; reviewer: string }[] }[];
    };
    const recorded = detail.captures[0]?.verdicts[0];
    expect(recorded?.verdict).toBe('drifted_fix');
    expect(recorded?.note).toBe(what);
    expect(recorded?.reviewer).not.toBe('');
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`the list and a screen have no axe violations — ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await signIn(page);
      const { humanId } = await seedScreen(page);

      await page.goto(`/projects/${CODE}/screens`);
      await page.waitForLoadState('networkidle');
      let violations = await violationsOn(page);
      expect(violations, `screens (${theme}):\n  ${violations.join('\n  ')}`).toEqual([]);

      await page.goto(`/projects/${CODE}/screens/${humanId}`);
      await page.waitForLoadState('networkidle');
      // Open the history and raise the form's errors, so what they render is checked too.
      await page.getByRole('region', { name: 'Version history' }).locator('summary').click();
      await page.getByRole('button', { name: 'Record verdict' }).click();
      await page.getByText('Choose a verdict.').waitFor();
      violations = await violationsOn(page);
      expect(violations, `screen detail (${theme}):\n  ${violations.join('\n  ')}`).toEqual([]);
    });
  }
});
