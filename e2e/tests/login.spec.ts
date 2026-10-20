import { expect, test } from '@playwright/test';

/**
 * The Phase 0 exit demo, as a suite.
 *
 * The account and password come from the seed, which CI runs immediately before this.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('the console', () => {
  test('serves the built console from the API, at one origin', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-type']).toContain('text/html');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in', exact: true })).toBeVisible();
  });

  test('the front door says what Foreman is beside the form, and drops it below 1024px (FRM-T-13.2)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const story = page.getByRole('complementary', { name: 'About Foreman' });
    await expect(story).toBeVisible();
    await expect(story.getByRole('heading', { level: 2 })).toContainText('checked against the code.');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

    await page.setViewportSize({ width: 800, height: 900 });
    await expect(story).toBeHidden();
    await expect(page.getByRole('main').getByText('Foreman', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Email' })).toBeVisible();
  });

  test('serves the favicon, rather than the console in its place (FRM-T-13.1)', async ({ request }) => {
    const res = await request.get('/favicon.svg');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/svg+xml');
  });

  test('signs in with a password and lands on the shell', async ({ page }) => {
    await signIn(page);

    await expect(page.getByRole('navigation')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Home' })).toBeVisible();
    // The account menu names who is signed in, which is how you know the session is real.
    await expect(page.getByText(EMAIL)).toBeVisible();
  });

  test('refuses a wrong password without saying which half was wrong', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
    await page.getByRole('textbox', { name: 'Password' }).fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByText('Those details did not match.')).toBeVisible();
    await expect(page.getByRole('navigation')).toBeHidden();
  });

  test('offers the D3 Auth link only when the server says it is reachable', async ({ page, request }) => {
    // Whichever way the dev stack is configured, the screen must agree with the server — and the
    // server's answer reaches an anonymous caller in the body of the 401, which is the only place
    // the login screen can learn it.
    const anonymous = await request.get('/auth/session');
    expect(anonymous.status()).toBe(401);
    const { oidcAvailable } = (await anonymous.json()) as { oidcAvailable: boolean };

    await page.goto('/');
    const link = page.getByRole('link', { name: /D3 Auth/ });
    if (oidcAvailable) await expect(link).toBeVisible();
    else await expect(link).toBeHidden();
  });

  test('the D3 Auth link leaves the app rather than being swallowed by the router', async ({
    page,
    request,
  }) => {
    const anonymous = await request.get('/auth/session');
    const { oidcAvailable } = (await anonymous.json()) as { oidcAvailable: boolean };
    test.skip(!oidcAvailable, 'no provider configured in this environment');

    await page.goto('/');
    // `/auth/oidc/start` is a server route: the console's click interceptor once treated it as an
    // internal path and pushState'd, which made the button a link that did nothing at all.
    await page.getByRole('link', { name: /D3 Auth/ }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/auth/oidc/start'), { timeout: 15_000 });
    expect(page.url()).not.toContain('127.0.0.1');
  });

  test('sets a session cookie that JavaScript cannot read', async ({ page, context }) => {
    await signIn(page);
    await expect(page.getByRole('navigation')).toBeVisible();

    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name.endsWith('foreman_session'));
    expect(session, 'a session cookie should have been set').toBeDefined();
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Lax');

    // The whole point of HttpOnly: a script on the page cannot see it.
    const visible = await page.evaluate<string>('document.cookie');
    expect(visible).not.toContain('foreman_session');
  });

  test('signs out, and the session does not come back on reload', async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole('navigation')).toBeVisible();

    await page.getByRole('button', { name: new RegExp(EMAIL.split('@')[0] ?? 'Developer') }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'Sign in', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in', exact: true })).toBeVisible();
  });

  test('renders the shell on a phone, with the navigation reachable', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);

    // Below the shell breakpoint the sidebar is a drawer behind a control, not a missing feature.
    const opener = page.getByRole('button', { name: /menu|navigation/i }).first();
    await expect(opener).toBeVisible();
    await opener.click();
    await expect(page.getByRole('link', { name: 'Home' })).toBeVisible();
  });
});

test.describe('the API', () => {
  test('404s an unknown API path in JSON, never as HTML', async ({ request }) => {
    const res = await request.get('/auth/nope');
    expect(res.status()).toBe(404);
    expect(res.headers()['content-type']).toContain('application/json');
  });

  test('reports its schema revision, which is the standing deploy rule', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { schemaRevision: string | null };
    expect(body.schemaRevision).toMatch(/^\d{14}_/);
  });

  test('is ready, and says so separately from being alive', async ({ request }) => {
    expect((await request.get('/healthz')).ok()).toBe(true);
    expect((await request.get('/readyz')).ok()).toBe(true);
  });
});

test.describe('editing (T-2.10)', () => {
  const signIn = async (page: import('@playwright/test').Page): Promise<void> => {
    await page.goto('/');
    await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
    await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('navigation').waitFor();
  };

  test('every control in an edit form has an accessible name (FRM-REQ-048)', async ({ page }) => {
    await signIn(page);
    await page.goto('/tasks/EXMP-T-1.1');
    await page.getByRole('button', { name: 'Edit' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Every focusable control inside the dialog, checked by name rather than by inspection: a
    // label that is merely *near* a control is not a name, and only the tree can tell them apart.
    const unnamed = await dialog
      .locator('input, textarea, select, button, [role="combobox"]')
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => {
            const el = node as HTMLElement;
            if (el.getAttribute('aria-hidden') === 'true') return false;
            if (el.hasAttribute('disabled')) return false;
            // Every way a control can get a name, in the order the accessibility tree prefers.
            const candidates = [
              el.getAttribute('aria-label'),
              el.getAttribute('aria-labelledby'),
              el.id === '' ? '' : document.querySelector(`label[for="${el.id}"]`)?.textContent,
              el.closest('label')?.textContent,
              el.textContent,
            ];
            return !candidates.some((name) => typeof name === 'string' && name.trim() !== '');
          })
          .map((node) => (node as HTMLElement).outerHTML.slice(0, 80)),
      );

    expect(unnamed, 'a control with no accessible name is a control a screen reader cannot announce').toEqual([]);
  });

  test('saves a change, and the page shows it', async ({ page }) => {
    await signIn(page);
    await page.goto('/tasks/EXMP-T-1.1');
    await page.getByRole('button', { name: 'Edit' }).click();

    const title = page.getByRole('textbox', { name: 'Title' });
    const original = await title.inputValue();
    const edited = `${original} (edited)`;

    await title.fill(edited);
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('heading', { name: edited })).toBeVisible();

    // Put it back, so the suite is re-runnable.
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(original);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { name: original })).toBeVisible();
  });

  test('a cancelled edit changes nothing', async ({ page }) => {
    await signIn(page);
    await page.goto('/tasks/EXMP-T-1.1');
    const heading = await page.getByRole('heading', { level: 1 }).textContent();

    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill('Discarded');
    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.getByRole('heading', { name: heading ?? '' })).toBeVisible();
  });

  test('offers no field for a project code, because it cannot change', async ({ page }) => {
    await signIn(page);
    await page.goto('/projects/EXMP');
    await page.getByRole('button', { name: 'Edit' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // ADR-008: the code is embedded in every human ID in the project. Not offering the field is
    // how "immutable" is expressed to a person.
    await expect(dialog.getByRole('textbox', { name: /code/i })).toHaveCount(0);
    await expect(dialog.getByRole('textbox', { name: 'Name' })).toBeVisible();
  });
});
