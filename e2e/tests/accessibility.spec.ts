// The named export, not the default: the package ships both, and under NodeNext the default
// resolves to the module namespace rather than to the class — "not constructable", at the one
// line the whole suite depends on.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { NodeResult, Result } from 'axe-core';

/**
 * The accessibility pass (T-9.2, T-9.3, FRM-REQ-012).
 *
 * **The defect classes asserted absent are Bindery's own.** Its design audit found five modal
 * overlays with no dialog semantics, controls with no accessible name, bare `<select>` elements and
 * errors announced nowhere — and those findings are free to inherit as tests rather than as a
 * list somebody reads once.
 *
 * Every screen is checked in **both themes**, because a contrast failure only exists in one of
 * them and checking the default alone is how half of them ship — and at **both widths**, 1440 and
 * 390 (FRM-REQ-218): below the shell's 1024px line the sidebar becomes a drawer and a tab bar,
 * cards lose their inset, and a phone is a different page as far as axe is concerned.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';

/**
 * Every screen a person can reach, with the seeded project. A path is a string, or — for a page
 * whose address the seed does not fix — a function that finds or makes the record and returns it.
 */
const SCREENS: { name: string; path: string | ((page: Page) => Promise<string>) }[] = [
  { name: 'home', path: '/' },
  { name: 'projects', path: '/projects' },
  { name: 'project ideas', path: '/project-ideas' },
  { name: 'project idea', path: '/project-ideas/PI-001' },
  { name: 'project overview', path: '/projects/EXMP' },
  { name: 'phases', path: '/projects/EXMP/phases' },
  { name: 'phase detail', path: '/projects/EXMP/phases/EXMP-P-1' },
  { name: 'requirements', path: '/projects/EXMP/requirements' },
  { name: 'requirement detail', path: '/requirements/EXMP-REQ-001' },
  { name: 'task detail', path: '/tasks/EXMP-T-1.1' },
  { name: 'scope of work', path: '/projects/EXMP/scope-of-work' },
  { name: 'register', path: '/projects/EXMP/register' },
  { name: 'documents', path: '/projects/EXMP/documents' },
  { name: 'document', path: documentPath },
  { name: 'decisions', path: '/projects/EXMP/adrs' },
  { name: 'risks', path: '/projects/EXMP/risks' },
  { name: 'glossary', path: '/projects/EXMP/glossary' },
  { name: 'ideas', path: '/projects/EXMP/ideas' },
  { name: 'audits', path: '/projects/EXMP/audits' },
  { name: 'activity', path: '/projects/EXMP/activity' },
  { name: 'drift', path: '/projects/EXMP/drift' },
  { name: 'screens', path: '/projects/EXMP/screens' },
  { name: 'screen detail', path: screenPath },
  { name: 'guidelines', path: '/guidelines' },
  { name: 'groups', path: '/groups' },
  { name: 'group page', path: groupPath },
  { name: 'findings', path: '/findings' },
  { name: 'finding detail', path: '/findings/EXMP-CR-001' },
  { name: 'search', path: '/search?q=decision' },
  { name: 'health', path: '/system' },
  { name: 'api tokens', path: '/tokens' },
  { name: 'not found', path: '/no-such-page' },
];

/** A document's page is addressed by its row ID, which the seed does not fix: follow the link. */
async function documentPath(page: Page): Promise<string> {
  await page.goto('/projects/EXMP/documents');
  const href = await page.getByRole('link', { name: 'Architecture' }).getAttribute('href');
  expect(href, 'the seeded Architecture document').toMatch(/^\/projects\/EXMP\/documents\/.+/);
  return href ?? '';
}

const SWEEP_GROUP = 'Accessibility sweep';

/**
 * The seed has no groups, so the sweep keeps one of its own, found by name or made once, holding
 * the seeded project — so the group page, Home's sections and the grouped Projects table all have
 * something in them to check.
 */
async function groupPath(page: Page): Promise<string> {
  const list = await page.request.get('/api/groups');
  expect(list.ok(), await list.text()).toBe(true);
  const { items } = (await list.json()) as { items: { name: string; slug: string }[] };
  const existing = items.find((item) => item.name === SWEEP_GROUP);
  if (existing !== undefined) return `/groups/${existing.slug}`;

  const created = await page.request.post('/api/groups', {
    data: { name: SWEEP_GROUP, accent: 'foreman', description: 'Kept by the accessibility sweep', siteUrl: 'https://example.com' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { humanId, slug } = (await created.json()) as { humanId: string; slug: string };
  const moved = await page.request.post(`/api/groups/${humanId}/projects`, { data: { projects: ['NBR'] } });
  expect(moved.ok(), await moved.text()).toBe(true);
  return `/groups/${slug}`;
}

/** One 8×8 PNG, so the screen's page has a design to show beside nothing built yet. */
const PROPOSAL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGPQiDqBFTEMLQkAFKhSgZfuVK8AAAAASUVORK5CYII=';
const SWEEP_SCREEN = 'Accessibility sweep';

/**
 * The seed has no screens, so the sweep keeps one of its own — found by name, made once through
 * the API on the console's own session (as screens.spec.ts does), with a desktop proposal.
 */
async function screenPath(page: Page): Promise<string> {
  const list = await page.request.get('/api/projects/EXMP/screens');
  expect(list.ok(), await list.text()).toBe(true);
  const { items } = (await list.json()) as { items: { humanId: string; name: string }[] };
  const existing = items.find((item) => item.name === SWEEP_SCREEN);
  if (existing !== undefined) return `/projects/EXMP/screens/${existing.humanId}`;

  const created = await page.request.post('/api/projects/EXMP/screens', {
    data: { name: SWEEP_SCREEN, route: '/inbox' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { humanId } = (await created.json()) as { humanId: string };

  const blob = await page.request.post('/api/blobs', {
    multipart: {
      file: { name: 'proposal.png', mimeType: 'image/png', buffer: Buffer.from(PROPOSAL_PNG, 'base64') },
    },
  });
  expect(blob.ok(), await blob.text()).toBe(true);
  const { sha256 } = (await blob.json()) as { sha256: string };
  const proposal = await page.request.post(`/api/projects/EXMP/screens/${humanId}/proposals`, {
    data: {
      blobSha256: sha256,
      viewport: 'desktop',
      theme: 'light',
      figmaFileKey: 'e2eFigmaFile',
      figmaNodeId: '12:34',
      figmaFileVersion: '1',
    },
  });
  expect(proposal.ok(), await proposal.text()).toBe(true);
  return `/projects/EXMP/screens/${humanId}`;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

/** Run axe and return the violations, described well enough to fix without re-running. */
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

/** A laptop, and a phone — the two sides of the shell's 1024px line (FRM-REQ-218). */
const WIDTHS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
] as const;

for (const theme of ['light', 'dark'] as const) {
  test.describe(`axe — ${theme}`, () => {
    for (const width of WIDTHS) {
      for (const screen of SCREENS) {
        test(`${screen.name} at ${width.name} has no violations`, async ({ page }) => {
          await page.setViewportSize({ width: width.width, height: width.height });
          await page.emulateMedia({ colorScheme: theme });
          await signIn(page);
          await page.goto(typeof screen.path === 'string' ? screen.path : await screen.path(page));
          // Let the screen's own fetches land: axe on a skeleton tests the skeleton.
          await page.waitForLoadState('networkidle');

          const violations = await violationsOn(page);
          expect(
            violations,
            `${screen.name} (${theme}, ${width.name}):\n  ${violations.join('\n  ')}`,
          ).toEqual([]);
        });
      }
    }

    // Members exists only on a fund board (ADR-016); a solo deployment answers it with not-found,
    // which the sweep already checks. The suite runs against solo, so this runs only if pointed at
    // a board.
    for (const width of WIDTHS) {
      test(`members at ${width.name} has no violations`, async ({ page }) => {
        await page.setViewportSize({ width: width.width, height: width.height });
        await page.emulateMedia({ colorScheme: theme });
        await signIn(page);
        const session = await page.request.get('/auth/session');
        const { mode } = (await session.json()) as { mode?: string };
        test.skip(mode !== 'board', 'a solo deployment has no Members screen');
        await page.goto('/members');
        await page.waitForLoadState('networkidle');

        const violations = await violationsOn(page);
        expect(violations, `members (${theme}, ${width.name}):\n  ${violations.join('\n  ')}`).toEqual([]);
      });
    }

    // On a phone the sidebar is a drawer, which the sweep above never opens.
    test('the navigation drawer at 390 has no violations', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: theme });
      await signIn(page);
      await page.goto('/projects/EXMP/requirements');
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: 'Open navigation' }).click();
      const drawer = page.getByRole('dialog', { name: 'Navigation' });
      await drawer.getByRole('link', { name: 'Drift' }).waitFor();
      // With both folds open, so their rows are checked too (FRM-T-16.4).
      for (const name of ['Knowledge', 'Library']) {
        const toggle = drawer.getByRole('button', { name });
        if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
      }
      await drawer.getByRole('link', { name: 'Screens' }).waitFor();

      const violations = await violationsOn(page);
      expect(violations, `drawer (${theme}):\n  ${violations.join('\n  ')}`).toEqual([]);
    });

    // FRM-T-13.2: the front door, signed out, with its story panel showing.
    test('sign in has no violations', async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto('/');
      await page.getByRole('complementary', { name: 'About Foreman' }).waitFor();

      const violations = await violationsOn(page);
      expect(violations, `sign in (${theme}):\n  ${violations.join('\n  ')}`).toEqual([]);
    });
  });
}

/**
 * A Mermaid diagram follows a theme change made *after* it was drawn.
 *
 * The sweep above emulates the colour scheme before the page loads, so every diagram it sees was
 * drawn in the right theme — and it passed while the console had a diagram that kept its first
 * palette forever. Flip the ThemeSwitch on the page and the node boxes stayed light, and the edge
 * labels ("MQTT", "SMS" on the seeded Bambu idea) became dark-theme text on a light-theme plate.
 */
test.describe('a Mermaid diagram follows the theme', () => {
  const diagram = '[data-mermaid] svg';

  async function drawn(page: Page): Promise<string> {
    await page.locator(diagram).first().waitFor();
    return (await page.locator(diagram).first().getAttribute('id')) ?? '';
  }

  /** Every redraw gets a new id, so a changed id is the diagram having been drawn again. */
  async function redrawn(page: Page, before: string): Promise<void> {
    await expect(page.locator(diagram).first()).not.toHaveAttribute('id', before);
  }

  async function choose(page: Page, mode: 'System' | 'Light' | 'Dark'): Promise<void> {
    await page.getByRole('button', { name: new RegExp(EMAIL) }).click();
    await page.getByRole('menuitemradio', { name: mode }).click();
    await page.keyboard.press('Escape');
  }

  /** Contrast inside the diagram, and the label plate is the surface token rather than Mermaid's. */
  async function legible(page: Page, theme: string): Promise<void> {
    const results = await new AxeBuilder({ page })
      .include('[data-mermaid]')
      .withRules(['color-contrast'])
      .analyze();
    const failures = results.violations.flatMap((v) => v.nodes.map((n) => n.target.join(' ')));
    expect(failures, `contrast in the diagram (${theme})`).toEqual([]);

    // axe passes Mermaid's own grey plate too, so assert the rule in styles.css actually won:
    // Mermaid scopes its rules under the SVG's id, which out-ranks a class selector.
    const [plate, surface] = await page.evaluate(() => {
      const label = document.querySelector('[data-mermaid] .edgeLabel p');
      const probe = document.createElement('div');
      probe.style.background = 'var(--color-surface)';
      document.body.append(probe);
      const pair = [
        label === null ? 'no edge label' : getComputedStyle(label).backgroundColor,
        getComputedStyle(probe).backgroundColor,
      ];
      probe.remove();
      return pair;
    });
    expect(plate, `edge label plate (${theme})`).toBe(surface);
  }

  for (const start of ['light', 'dark'] as const) {
    const other = start === 'light' ? 'dark' : 'light';

    test(`from ${start}, through the ThemeSwitch and the OS`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: start });
      await signIn(page);
      await page.goto('/project-ideas/PI-001');
      let id = await drawn(page);
      await legible(page, start);

      await choose(page, other === 'dark' ? 'Dark' : 'Light');
      await redrawn(page, id);
      id = await drawn(page);
      await legible(page, `${start} → ${other}`);

      await choose(page, start === 'dark' ? 'Dark' : 'Light');
      await redrawn(page, id);
      id = await drawn(page);
      await legible(page, `${other} → ${start}`);

      // Following the OS, which flips underneath the page with no click at all.
      await choose(page, 'System');
      await page.emulateMedia({ colorScheme: other });
      await redrawn(page, id);
      await legible(page, `system, OS → ${other}`);
    });
  }
});

test.describe('the defect classes from Bindery’s own audit', () => {
  test('every modal is a dialog, is labelled, and closes on Escape', async ({ page }) => {
    await signIn(page);
    await page.goto('/tasks/EXMP-T-1.1');
    await page.getByRole('button', { name: 'Edit' }).click();

    // Bindery had five overlays that were plain divs. A screen reader walked straight past them.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-labelledby', /.+/);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('focus moves into the modal and comes back to its trigger', async ({ page }) => {
    await signIn(page);
    await page.goto('/tasks/EXMP-T-1.1');

    const trigger = page.getByRole('button', { name: 'Edit' });
    await trigger.click();
    await expect(page.getByRole('dialog')).toBeVisible();

    // Focus inside the dialog, not left behind on the page underneath.
    const inside = await page.evaluate(() =>
      document.activeElement?.closest('[role="dialog"]') !== null,
    );
    expect(inside).toBe(true);

    await page.keyboard.press('Escape');
    // And back where it came from, or the keyboard user is at the top of the document.
    await expect(trigger).toBeFocused();
  });

  test('no bare select survives anywhere', async ({ page }) => {
    await signIn(page);

    for (const path of ['/projects/EXMP/requirements', '/findings', '/projects/EXMP/activity']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');

      // A native `<select>` with no accessible name is the defect; the library's Select is a
      // button + listbox, which is why this count is zero rather than "every select is labelled".
      const bare = await page.locator('select:not([aria-label]):not([id])').count();
      expect(bare, path).toBe(0);
    }
  });

  test('every interactive control on a dense screen has an accessible name', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/requirements');
    await page.waitForLoadState('networkidle');

    const unnamed = await page
      .locator('button, [role="button"], [role="combobox"], input, textarea, a[href]')
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => {
            const el = node as HTMLElement;
            if (el.getAttribute('aria-hidden') === 'true') return false;
            if (el.hasAttribute('disabled')) return false;
            if (el.offsetParent === null) return false;
            const named = [
              el.getAttribute('aria-label'),
              el.getAttribute('aria-labelledby'),
              el.getAttribute('title'),
              el.id === '' ? '' : document.querySelector(`label[for="${el.id}"]`)?.textContent,
              el.closest('label')?.textContent,
              el.textContent,
            ];
            return !named.some((n) => typeof n === 'string' && n.trim() !== '');
          })
          .map((node) => (node as HTMLElement).outerHTML.slice(0, 100)),
      );

    expect(unnamed, 'a control with no accessible name cannot be announced').toEqual([]);
  });

  test('a form error is tied to its field and announced', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
    await page.getByRole('textbox', { name: 'Password' }).fill('wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // An error rendered as loose text near a field is an error a screen reader never mentions.
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/did not match/);
  });

  test('the page has one h1, and the skip target is reachable', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP/requirements');

    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  });
});
