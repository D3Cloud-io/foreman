import { parseAnyId } from '@foreman/shared';
import type { PortfolioRow, SearchHit } from './api';
import { scopedHref } from './scope';
import { SECTIONS } from './project';

/**
 * The console's keyboard layer (FRM-REQ-244, FRM-T-18.5): which key opens what, where a typed ID
 * goes, and what the palette offers under "Go to". Pure functions over strings and plain objects,
 * so the rules are tested once, in Node; `components/CommandPalette.tsx` is the part that draws.
 *
 * Phase 1 binds three keys and nothing else: ⌘K (Ctrl K elsewhere) and `/` open the palette, `?`
 * opens the cheat sheet. There are no g-sequences and no palette actions yet — the actions wait for
 * undo (FRM-T-18.4) — and `SHORTCUTS` below lists only what is bound.
 */

/** True on Apple platforms, whose modifier is ⌘; elsewhere it is Ctrl. */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** The platform's own modifier, as it is drawn on a key cap. */
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl';

// ─── Which key opens what ──────────────────────────────────────────────────

/** What a pressed key means to the console. */
export type ShortcutAction = 'palette' | 'sheet';

/** The part of an element the rules read: enough to test them without a DOM. */
export interface TargetLike {
  readonly tagName?: string;
  readonly type?: string;
  readonly isContentEditable?: boolean;
  readonly getAttribute?: (name: string) => string | null;
}

/** The part of a `KeyboardEvent` the rules read. */
export interface KeyLike {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly defaultPrevented?: boolean;
  readonly isComposing?: boolean;
  /** Held down: the browser's auto-repeat, which is never a second press. */
  readonly repeat?: boolean;
  /** 229 is what a browser sends for a key an input method is handling. */
  readonly keyCode?: number;
  readonly target: TargetLike | EventTarget | null;
}

/** Input types that take no text: a key typed on a checkbox is not typing. */
const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

function asTarget(target: KeyLike['target']): TargetLike | null {
  return target !== null && typeof target === 'object' && 'tagName' in target ? target : null;
}

/** A field a person types into — a single-line input, a textarea, a select, an editable region. */
export function isTextField(target: KeyLike['target']): boolean {
  const el = asTarget(target);
  if (el === null) return false;
  const tag = el.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((el.type ?? 'text').toLowerCase());
  if (el.isContentEditable === true) return true;
  const role = el.getAttribute?.('role');
  return role === 'textbox' || role === 'searchbox' || role === 'combobox';
}

/**
 * A multi-line field or editable region: where an unsaved draft lives, and the only place ⌘K is
 * refused. A single-line input is fine — ⌘K there is how you reach the palette from Search's box.
 */
function isDraftField(target: KeyLike['target']): boolean {
  const el = asTarget(target);
  if (el === null) return false;
  return el.tagName?.toUpperCase() === 'TEXTAREA' || el.isContentEditable === true;
}

/** Whether a dialog — an edit form, a confirmation, a drawer, the palette itself — is open. */
export function dialogIsOpen(doc: Pick<Document, 'querySelector'>): boolean {
  return doc.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]') !== null;
}

/**
 * ⌘K (Ctrl K elsewhere), by the platform's own modifier only: on a Mac, Control-K in a text field
 * deletes to the end of the line, and taking it would break that.
 */
export function isPaletteChord(event: KeyLike, mac: boolean): boolean {
  if (event.key.toLowerCase() !== 'k' || event.altKey || event.shiftKey) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * What a key press opens, if anything.
 *
 * - **⌘K** opens the palette from anywhere but a dialog and a multi-line field.
 * - **`/`** opens it, and **`?`** opens the sheet, only when focus is not in a text field of any
 *   kind — they are characters a person types.
 * - Nothing opens while a dialog is open: navigating would throw away what is in it.
 */
export function shortcutFor(
  event: KeyLike,
  env: { mac: boolean; dialogOpen: boolean },
): ShortcutAction | null {
  if (event.defaultPrevented === true || event.isComposing === true || event.keyCode === 229) return null;
  // A held key opens nothing a second time, and closes nothing it just opened.
  if (event.repeat === true || env.dialogOpen) return null;
  if (isPaletteChord(event, env.mac)) return isDraftField(event.target) ? null : 'palette';
  if (event.metaKey || event.ctrlKey || event.altKey || isTextField(event.target)) return null;
  if (event.key === '/') return 'palette';
  if (event.key === '?') return 'sheet';
  return null;
}

// ─── The triage keys on /findings (FRM-T-18.7) ─────────────────────────────

/** What a key means on the triage surface. Each acts on the selected row, or the bulk selection. */
export type TriageKey =
  | 'acknowledge'
  | 'fixed'
  | 'reopen'
  | 'wont-fix'
  | 'confirm'
  | 'reject'
  | 'next'
  | 'previous'
  | 'toggle'
  | 'clear'
  | 'tab-1'
  | 'tab-2'
  | 'tab-3'
  | 'tab-4';

const TRIAGE_KEYS: Readonly<Record<string, TriageKey>> = {
  a: 'acknowledge',
  f: 'fixed',
  r: 'reopen',
  w: 'wont-fix',
  y: 'confirm',
  n: 'reject',
  j: 'next',
  k: 'previous',
  x: 'toggle',
  Escape: 'clear',
  '1': 'tab-1',
  '2': 'tab-2',
  '3': 'tab-3',
  '4': 'tab-4',
};

/**
 * What a key press means on `/findings`, if anything.
 *
 * A verdict is a single letter, so it is only ever read **outside a text field and while no dialog
 * is open**: a reason typed into "Won't fix" must not reopen the finding at its first `r`, and a key
 * pressed while a dialog asks something must not answer a different question behind it. No
 * modifier either — ⌘R is the browser's reload, not Reopen — and a held key acts once.
 */
export function triageKeyFor(event: KeyLike, env: { dialogOpen: boolean }): TriageKey | null {
  if (event.defaultPrevented === true || event.isComposing === true || event.keyCode === 229) return null;
  if (event.repeat === true || env.dialogOpen) return null;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (isTextField(event.target)) return null;
  return TRIAGE_KEYS[event.key] ?? null;
}

// ─── What the sheet lists ──────────────────────────────────────────────────

export interface ShortcutRow {
  readonly keys: readonly string[];
  readonly does: string;
}

export interface ShortcutGroup {
  readonly title: string;
  readonly rows: readonly ShortcutRow[];
}

/**
 * Everything that is bound, and nothing that is not (the mockup's greyed rows are not drawn). The
 * triage keys act only on `/findings` (FRM-T-18.7), and the group says so in its title.
 */
export const SHORTCUTS: readonly ShortcutGroup[] = [
  {
    title: 'Anywhere',
    rows: [
      { keys: [MOD_KEY, 'K'], does: 'Open the command palette' },
      { keys: ['/'], does: 'Open the command palette, outside a text field' },
      { keys: ['?'], does: 'Show this sheet, outside a text field' },
    ],
  },
  {
    title: 'On Findings',
    rows: [
      { keys: ['1', '2', '3', '4'], does: 'Show Findings, Drift, Review or Blocked' },
      { keys: ['j', 'k'], does: 'Select the next or the previous row' },
      { keys: ['x'], does: 'Add the finding to a bulk selection, or take it out' },
      { keys: ['a'], does: 'Acknowledge the finding' },
      { keys: ['f'], does: 'Mark the finding fixed' },
      { keys: ['r'], does: 'Reopen the finding' },
      { keys: ['w'], does: "Won't fix — asks for a reason first" },
      { keys: ['y'], does: 'Confirm the proposed attribution' },
      { keys: ['n'], does: 'Reject the proposed attribution' },
      { keys: ['esc'], does: 'Clear the bulk selection' },
    ],
  },
  {
    title: 'In the palette',
    rows: [
      { keys: ['↑', '↓'], does: 'Move through the results' },
      { keys: ['↵'], does: 'Go to the highlighted result' },
      { keys: [MOD_KEY, '↵'], does: 'See every result in Search' },
      { keys: ['esc'], does: 'Close it' },
    ],
  },
];

// ─── Where an ID goes ──────────────────────────────────────────────────────

/** A place to go, with the words that name it. */
export interface Destination {
  readonly href: string;
  readonly label: string;
  readonly description: string;
}

/** Just enough of a group to resolve `GRP-n` to its page. */
export interface GroupRef {
  readonly humanId: string;
  readonly name: string;
  readonly slug: string;
}

const FINDING_TYPES = new Set(['CR', 'DA', 'FR', 'API']);

/** The ID as it should be written: trimmed and upper-case, which is how every ID is issued. */
export function normaliseId(raw: string): string {
  return raw.trim().toUpperCase();
}

/** The human ID a query is, if it is exactly one (any kind). */
export function exactId(query: string): string | null {
  const id = normaliseId(query);
  return id.length > 0 && parseAnyId(id) !== null ? id : null;
}

/**
 * Where an exact human ID goes, resolved here and not by a search: a requirement, task, finding,
 * phase, screen or project idea has a page of its own; a decision record, risk, term, idea or audit
 * has its project's list and a guideline the guidelines, each with `#<ID>` so the list scrolls to
 * the row (FRM-T-18.13); a group has its page. Anything else —
 * a decision (`-D-`), a document — goes to Search with the ID in it, which finds it by ID.
 *
 * `groups` is the listing when it has loaded; until then `GRP-n` is addressed by its ID, which the
 * group page takes as well as a slug.
 */
export function jumpTarget(id: string, groups: readonly GroupRef[] | null): Destination | null {
  const parsed = parseAnyId(id);
  if (parsed === null) return null;
  const { code, type } = parsed;
  const here = (href: string, description: string): Destination => ({
    href,
    label: id,
    description,
  });
  switch (type) {
    case 'REQ':
      return here(`/requirements/${id}`, 'Requirement');
    case 'T':
      return here(`/tasks/${id}`, 'Task');
    case 'P':
      return here(`/projects/${code ?? ''}/phases/${id}`, 'Phase');
    case 'ADR':
      return here(`/projects/${code ?? ''}/adrs#${id}`, 'Decisions');
    case 'R':
      return here(`/projects/${code ?? ''}/risks#${id}`, 'Risks');
    case 'TERM':
      return here(`/projects/${code ?? ''}/glossary#${id}`, 'Glossary');
    case 'IDEA':
      return here(`/projects/${code ?? ''}/ideas#${id}`, 'Ideas');
    case 'AUD':
      return here(`/projects/${code ?? ''}/audits#${id}`, 'Audits');
    case 'SCR':
      return here(`/projects/${code ?? ''}/screens/${id}`, 'Screen');
    case 'PI':
      return here(`/project-ideas/${id}`, 'Project idea');
    case 'GL':
      return here(`/guidelines#${id}`, 'Guideline');
    case 'GRP': {
      const group = groups?.find((g) => g.humanId === id);
      return {
        href: `/groups/${group?.slug ?? id}`,
        label: id,
        description: group?.name ?? 'Group',
      };
    }
    default:
      if (FINDING_TYPES.has(type)) return here(`/findings/${id}`, 'Finding');
      return here(`/search?q=${encodeURIComponent(id)}`, 'Search');
  }
}

/** Where a search hit lives, by kind. A result you cannot open is one you have to go and find. */
export function hitHref(hit: SearchHit): string {
  const id = hit.humanId;
  const code = hit.projectCode;
  if (id !== null && code !== null) {
    switch (hit.type) {
      case 'requirement':
        return `/requirements/${id}`;
      case 'task':
        return `/tasks/${id}`;
      case 'phase':
        return `/projects/${code}/phases/${id}`;
      case 'adr':
        return `/projects/${code}/adrs`;
      case 'risk':
        return `/projects/${code}/risks`;
      case 'term':
        return `/projects/${code}/glossary`;
      case 'finding':
        return `/findings/${id}`;
      case 'screen':
        return `/projects/${code}/screens/${id}`;
      default:
        break;
    }
  }
  if (hit.type === 'document_section' && code !== null) return `/projects/${code}/documents`;
  return `/search?q=${encodeURIComponent(id ?? hit.title)}`;
}

/** The query as the full-results page takes it, in the scope you are in. */
export function searchHref(query: string, scope: string | null): string {
  return scopedHref(`/search?q=${encodeURIComponent(query.trim())}`, scope);
}

// ─── Go to ─────────────────────────────────────────────────────────────────

/** What a "Go to" entry is, for its icon and its ordering. */
export type GoToKind = 'screen' | 'project' | 'group' | 'section';

export interface GoToEntry extends Destination {
  readonly kind: GoToKind;
  /** Everything a query may match, lower-case. */
  readonly haystack: string;
}

/** The screens a person can go to: `lib/nav.ts`'s rows, plus the two that have no row of their own. */
export interface ScreenRef {
  readonly to: string;
  readonly label: string;
}

/** The most "Go to" entries shown at once: a palette is a short list, not a directory. */
export const GO_TO_LIMIT = 8;

export function screenEntries(screens: readonly ScreenRef[], scope: string | null): GoToEntry[] {
  return screens.map((screen) => ({
    kind: 'screen',
    href: scopedHref(screen.to, scope),
    label: screen.label,
    description: 'Screen',
    haystack: screen.label.toLowerCase(),
  }));
}

export function projectEntries(rows: readonly Pick<PortfolioRow, 'code' | 'name'>[]): GoToEntry[] {
  return rows.map((row) => ({
    kind: 'project',
    href: `/projects/${row.code}`,
    label: `${row.code} · ${row.name}`,
    description: 'Project',
    haystack: `${row.code} ${row.name}`.toLowerCase(),
  }));
}

export function groupEntries(groups: readonly GroupRef[]): GoToEntry[] {
  return groups.map((group) => ({
    kind: 'group',
    href: `/groups/${group.slug}`,
    label: group.name,
    description: `Group · ${group.humanId}`,
    haystack: `${group.name} ${group.humanId} ${group.slug}`.toLowerCase(),
  }));
}

/** "Drift · Bindery": a project's section, for a query like `bnd drift` or `drift`. */
export function sectionEntries(rows: readonly Pick<PortfolioRow, 'code' | 'name'>[]): GoToEntry[] {
  return rows.flatMap((row) =>
    SECTIONS.map((section) => ({
      kind: 'section' as const,
      href: `/projects/${row.code}/${section.slug}`,
      label: `${section.label} · ${row.name}`,
      description: row.code,
      haystack: `${row.code} ${row.name} ${section.label}`.toLowerCase(),
    })),
  );
}

/**
 * The "Go to" list for a query: every word of the query must appear in an entry. With no query,
 * the screens alone — the places you go every day. Screens come first, then projects, groups and
 * project sections, capped at `GO_TO_LIMIT`.
 */
export function goTo(
  query: string,
  entries: {
    readonly screens: readonly GoToEntry[];
    readonly projects: readonly GoToEntry[];
    readonly groups: readonly GoToEntry[];
    readonly sections: readonly GoToEntry[];
  },
): GoToEntry[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return entries.screens.slice(0, GO_TO_LIMIT);
  const matches = (entry: GoToEntry) => words.every((word) => entry.haystack.includes(word));
  return [...entries.screens, ...entries.projects, ...entries.groups, ...entries.sections]
    .filter(matches)
    .slice(0, GO_TO_LIMIT);
}
