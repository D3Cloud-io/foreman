import { expect, test, type Page } from '@playwright/test';

/**
 * Every control, 44 by 44, under a coarse pointer (FRM-REQ-249, FRM-T-18.10).
 *
 * `phone.spec.ts` measures the controls Foreman's own classes name on eight routes. This is the
 * gate over the whole inventory: every screen the console has, at 390 by 844 with a touch screen,
 * and every interactive element on it that can be seen. A control added tomorrow on a screen nobody
 * thought to list is caught by being on the screen, not by being named here.
 *
 * What counts as a control: a, button, input, select, textarea, summary, and anything with the role
 * button, tab, menuitem, option, checkbox, radio or switch. What does not:
 *
 * - **Not on screen.** Not rendered (0 by 0), `aria-hidden`, `inert`, `visibility: hidden`, disabled
 *   (WCAG 2.5.8 exempts an inactive control), or under 2px **and clipped on purpose** (`clip`,
 *   `clip-path`: the skip link before it is focused, a visually-hidden label). A sliver that is not
 *   hidden on purpose is a tiny control, and is measured.
 * - **A link inside a sentence**, WCAG 2.5.8's inline exception, and only that: the library's
 *   `variant="inline"` link (or `data-inline-link`), `display: inline`, in a block whose text is mostly
 *   prose (twenty characters or more of it, and more than the links'), and — in a list item,
 *   description or cell — not the only control of that row. Any other link, and any link that is its
 *   row's or card's one action, is a control and is measured. `measure()` is proved on a page of
 *   known cases below, so a loosened rule fails there rather than quietly on a screen.
 * - **The field, not its inner input.** A text input is measured by the field that draws it
 *   (`.d3-inp`), and a checkbox, radio or switch by its label when it sits in one: what a thumb lands on.
 *
 * The library's own controls are the library's to size, and are listed in `LIBRARY_OWNED` with the
 * design-system requirement that fixes them, never silently skipped. Foreman sizes everything it can
 * from its own CSS (`styles.css`, "Every control, 44 by 44") — Select, Input, Checkbox, a Table's sort
 * header, PageHeader's back link, SegmentedControl's width (DS-REQ-016, DS-REQ-017) — so the list is
 * what remains once that is done. An entry that matches nothing fails the run: a fixed exception is
 * deleted, not left behind.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';
const CODE = 'EXMP';
const PHONE = { width: 390, height: 844 };
const MINIMUM = 44;

/** A control the library draws and Foreman cannot size, with the DS requirement that will. */
interface LibraryOwned {
  /** Matches the element itself (`el.matches`). */
  readonly selector: string;
  /** The design-system requirement that fixes it: `DS-REQ-nnn`. */
  readonly req: string;
  readonly why: string;
}

const LIBRARY_OWNED: readonly LibraryOwned[] = [];

/** Where the inventory's dynamic screens live, made or read through the API in `beforeAll`. */
interface Ids {
  phase: string;
  documentId: string;
  screen: string;
  group: string;
}

/** Every screen in the inventory (S-01 …), by name, so a failure says which one. */
function inventory(ids: Ids): { name: string; path: string }[] {
  return [
    { name: 'Home', path: '/' },
    { name: 'Projects', path: '/projects' },
    { name: 'A project overview', path: `/projects/${CODE}` },
    { name: 'Phases', path: `/projects/${CODE}/phases` },
    { name: 'A phase', path: `/projects/${CODE}/phases/${ids.phase}` },
    { name: 'Requirements', path: `/projects/${CODE}/requirements` },
    { name: 'Requirements Register', path: `/projects/${CODE}/register` },
    { name: 'Scope of Work', path: `/projects/${CODE}/scope-of-work` },
    { name: 'Risks', path: `/projects/${CODE}/risks` },
    { name: 'Glossary', path: `/projects/${CODE}/glossary` },
    { name: 'Decisions', path: `/projects/${CODE}/adrs` },
    { name: 'Documents', path: `/projects/${CODE}/documents` },
    { name: 'A document', path: `/projects/${CODE}/documents/${ids.documentId}` },
    { name: 'Ideas', path: `/projects/${CODE}/ideas` },
    { name: 'Activity', path: `/projects/${CODE}/activity` },
    { name: 'Audits', path: `/projects/${CODE}/audits` },
    { name: 'Drift', path: `/projects/${CODE}/drift` },
    { name: 'Screens', path: `/projects/${CODE}/screens` },
    { name: 'A screen', path: `/projects/${CODE}/screens/${ids.screen}` },
    { name: 'Findings', path: '/findings' },
    { name: 'Findings, drift', path: '/findings?tab=drift' },
    { name: 'Findings, review', path: '/findings?tab=review' },
    { name: 'Findings, blocked', path: '/findings?tab=blocked' },
    { name: 'A finding', path: '/findings/EXMP-CR-001' },
    { name: 'A task', path: '/tasks/EXMP-T-1.1' },
    { name: 'A requirement', path: '/requirements/EXMP-REQ-007' },
    { name: 'Search', path: '/search' },
    { name: 'Search results', path: '/search?q=decision' },
    { name: 'Guidelines', path: '/guidelines' },
    { name: 'Project ideas', path: '/project-ideas' },
    { name: 'A project idea', path: '/project-ideas/PI-001' },
    { name: 'Groups', path: '/groups' },
    { name: 'A group', path: `/groups/${ids.group}` },
    { name: 'Drift across projects', path: '/drift' },
    { name: 'Health', path: '/system' },
    { name: 'Tokens', path: '/tokens' },
  ];
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

interface Measured {
  /** Controls found and measured on the screen, so a screen that rendered nothing cannot pass. */
  readonly seen: number;
  readonly small: string[];
  /** `LIBRARY_OWNED` selectors that matched something on this screen. */
  readonly excused: string[];
}

/** Runs in the page: measures every control that can be seen, as the header comment defines. */
function measure(args: { minimum: number; owned: readonly string[] }): Measured {
  const CONTROLS =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"]';
  const seen: Element[] = [];
  const small: string[] = [];
  const excused = new Set<string>();

  /** Hidden from sight on purpose: clipped to nothing, as every visually-hidden pattern is. */
  const clippedOnPurpose = (el: Element): boolean => {
    for (let node: Element | null = el; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.clipPath !== 'none' || (style.position === 'absolute' && style.getPropertyValue('clip') !== 'auto')) return true;
    }
    return false;
  };

  const hiddenFromEveryone = (el: Element): boolean =>
    el.closest('[aria-hidden="true"], [inert]') !== null ||
    getComputedStyle(el).visibility === 'hidden' ||
    el.matches(':disabled') ||
    el.getAttribute('aria-disabled') === 'true';

  /** The nearest ancestor that is a block of text rather than a run inside one. */
  const blockOf = (el: Element): Element | null => {
    let node = el.parentElement;
    while (node !== null && getComputedStyle(node).display.startsWith('inline')) node = node.parentElement;
    return node;
  };

  /** WCAG 2.5.8's inline exception, and nothing broader. */
  const inSentence = (el: Element): boolean => {
    if (!el.matches('.d3-lnk--inline, [data-inline-link]')) return false;
    if (getComputedStyle(el).display !== 'inline') return false;
    const flow = blockOf(el);
    if (flow === null) return false;
    const controls = [...flow.querySelectorAll(CONTROLS)];
    const linked = controls.reduce((total, control) => total + control.textContent.trim().length, 0);
    const prose = flow.textContent.trim().length - linked;
    if (prose < 20 || prose < linked) return false;
    // In a row, the link is the row's control unless something else is.
    return !(flow.matches('li, dd, td, th') && controls.length < 2);
  };

  /** The element a thumb lands on, which is not always the one that carries the role. */
  const target = (el: Element): Element => {
    if (el.classList.contains('d3-inp__control')) return el.closest('.d3-inp') ?? el;
    const role = el.getAttribute('role');
    const isCheck =
      role === 'checkbox' || role === 'radio' || role === 'switch' ||
      (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio'));
    return isCheck ? (el.closest('label') ?? el) : el;
  };

  for (const el of document.querySelectorAll(CONTROLS)) {
    const own = el.getBoundingClientRect();
    if (own.width === 0 && own.height === 0) continue;
    if ((own.width < 2 || own.height < 2) && clippedOnPurpose(el)) continue;
    if (hiddenFromEveryone(el)) continue;
    if (inSentence(el)) continue;
    seen.push(el);

    const hit = target(el).getBoundingClientRect();
    if (hit.width >= args.minimum - 0.5 && hit.height >= args.minimum - 0.5) continue;

    const owner = args.owned.find((selector) => el.matches(selector));
    if (owner !== undefined) {
      excused.add(owner);
      continue;
    }
    const name = (el.getAttribute('aria-label') ?? el.textContent).trim().replace(/\s+/g, ' ').slice(0, 40);
    const classes = (el.getAttribute('class') ?? '').trim().replace(/\s+/g, '.');
    small.push(
      `${String(Math.round(hit.width))}x${String(Math.round(hit.height))} <${el.tagName.toLowerCase()}${classes === '' ? '' : `.${classes}`}> "${name}"`,
    );
  }
  return { seen: seen.length, small, excused: [...excused] };
}

/** A page of known cases: what `measure` must flag, and what it must let through. */
const FIXTURE = `
  <main>
    <button style="width:20px;height:20px">small button</button>
    <button style="min-width:44px;min-height:44px">big button</button>
    <p>This is a sentence of running prose that goes on for a while, <a class="d3-lnk--inline" href="#">an inline link</a> and then it carries on.</p>
    <ul><li><a class="d3-lnk--inline" href="#">sole control</a> of a row with some words that do not make the link a sentence</li></ul>
    <p>Another sentence of running prose, but <a href="#">a plain link</a> is a control wherever it sits.</p>
    <button role="checkbox" aria-label="a checkbox" style="width:17px;height:17px;padding:0"></button>
    <button aria-label="a sliver" style="width:1px;height:20px;padding:0"></button>
    <button aria-label="hidden on purpose" style="position:absolute;width:1px;height:1px;padding:0;border:0;clip-path:inset(50%);overflow:hidden"></button>
    <button aria-hidden="true" style="width:10px;height:10px"></button>
    <button disabled style="width:10px;height:10px">disabled</button>
  </main>`;

test.describe('a thumb, not a cursor, on every screen', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('the measure fails a known small control and lets the known exceptions through', async ({ page }) => {
    await page.setContent(FIXTURE);
    const found = await page.evaluate(measure, { minimum: MINIMUM, owned: [] });
    const names = found.small.map((line) => /"([^"]*)"$/.exec(line)?.[1]);
    expect(names).toEqual(['small button', 'sole control', 'a plain link', 'a checkbox', 'a sliver']);
    // The inline link in the paragraph, the clipped, hidden and disabled buttons are not controls to size.
    expect(found.small.join('\n')).not.toContain('an inline link');
    expect(found.excused).toEqual([]);
  });

  test('the library exceptions each name a design-system requirement', () => {
    for (const entry of LIBRARY_OWNED) {
      expect(entry.req, `${entry.selector} needs the DS requirement that fixes it`).toMatch(/^DS-REQ-\d{3}$/);
      expect(entry.why.length).toBeGreaterThan(10);
    }
  });

  test('every control that can be seen is at least 44 by 44', async ({ page }) => {
    test.setTimeout(10 * 60_000);
    await signIn(page);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

    // The screens that need something to open: read what the seed has, and make what it has not.
    const phases = await page.request.get(`/api/projects/${CODE}/phases`);
    expect(phases.ok(), await phases.text()).toBe(true);
    const phase = ((await phases.json()) as { items: { humanId: string }[] }).items[0];
    expect(phase, 'the example project has a phase').toBeDefined();

    const documents = await page.request.get(`/api/projects/${CODE}/documents`);
    expect(documents.ok(), await documents.text()).toBe(true);
    const document = ((await documents.json()) as { items: { id: string }[] }).items[0];
    expect(document, 'the example project has a document').toBeDefined();

    const stamp = Date.now().toString(36);
    const screen = await page.request.post(`/api/projects/${CODE}/screens`, {
      data: { name: `Touch targets ${stamp}`, route: '/touch-targets' },
    });
    expect(screen.status(), await screen.text()).toBe(201);
    const group = await page.request.post('/api/groups', { data: { name: `Touch targets ${stamp}` } });
    expect(group.status(), await group.text()).toBe(201);

    const ids: Ids = {
      phase: phase?.humanId ?? '',
      documentId: document?.id ?? '',
      screen: ((await screen.json()) as { humanId: string }).humanId,
      group: ((await group.json()) as { slug: string }).slug,
    };

    const owned = LIBRARY_OWNED.map((entry) => entry.selector);
    const failures: string[] = [];
    const matched = new Set<string>();

    for (const { name, path } of inventory(ids)) {
      await page.goto(path);
      await page.locator('main').waitFor();
      await page.waitForLoadState('networkidle');
      // A not-found page is a screen nobody asked for: the inventory names real routes.
      await expect(page.getByText('That page does not exist'), `${name} (${path}) is not a real screen`).toHaveCount(0);

      const found = await page.evaluate(measure, { minimum: MINIMUM, owned });
      expect(found.seen, `${name} (${path}) rendered no controls at all`).toBeGreaterThan(0);
      for (const selector of found.excused) matched.add(selector);
      failures.push(...found.small.map((line) => `${name} ${path}: ${line}`));
    }

    expect(failures, `controls under ${String(MINIMUM)} by ${String(MINIMUM)}:\n${failures.join('\n')}`).toEqual([]);
    for (const entry of LIBRARY_OWNED) {
      expect(matched.has(entry.selector), `${entry.selector} (${entry.req}) matched nothing: delete the exception`).toBe(true);
    }
  });
});
