import { parseAnyId } from '@foreman/shared';
import { foreman, type Brief } from './api';

/**
 * The sections a project has, in one list.
 *
 * Read by the sidebar (to offer them all from inside any one of them) and by the breadcrumb (to
 * name the section you are in). It was previously a row of links hard-coded in the project
 * overview, which is why every other section screen was a dead end: the moment you followed one,
 * the only way to another was the browser's back button or a 3-character link in the corner.
 */
export interface Section {
  readonly slug: string;
  /** What the sidebar calls it. Short: it sits in a narrow column beside ten others. */
  readonly label: string;
  /**
   * What the page calls itself, when that differs. "Register" is a fine nav item and a poor
   * heading — the screen is the requirements register, and a heading has room to say so.
   */
  readonly title?: string;
  /** Which half of the tool this belongs to — the plan, or what is actually there. */
  readonly group: 'Plan' | 'Knowledge' | 'Reality';
}

export const SECTIONS: readonly Section[] = [
  { slug: 'phases', label: 'Phases', group: 'Plan' },
  { slug: 'requirements', label: 'Requirements', group: 'Plan' },
  { slug: 'scope-of-work', label: 'Scope of work', group: 'Plan' },
  { slug: 'register', label: 'Register', title: 'Requirements register', group: 'Plan' },
  { slug: 'documents', label: 'Documents', group: 'Knowledge' },
  { slug: 'adrs', label: 'Decisions', group: 'Knowledge' },
  { slug: 'risks', label: 'Risks', group: 'Knowledge' },
  { slug: 'glossary', label: 'Glossary', group: 'Knowledge' },
  { slug: 'ideas', label: 'Ideas', title: 'Ideas', group: 'Plan' },
  { slug: 'activity', label: 'Activity', group: 'Reality' },
  { slug: 'audits', label: 'Audits', group: 'Reality' },
  { slug: 'drift', label: 'Drift', group: 'Reality' },
  // What it should look like beside what it does (FRM-REQ-196): the design half of drift.
  { slug: 'screens', label: 'Screens', group: 'Reality' },
];

export function sectionFor(path: string): Section | null {
  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts[0] !== 'projects' || parts[2] === undefined) return null;
  return SECTIONS.find((section) => section.slug === parts[2]) ?? null;
}

/**
 * The rows a project shows in the sidebar, in order (FRM-ADR-025, FRM-DA-001).
 *
 * The reality half comes first — Drift second, under Overview — because it is the reason to open a
 * project at all; it used to be row 21 of 22 and below the fold of a 900px laptop. Six rows always
 * shown, then everything you look things up in behind one **Knowledge** row that opens itself when
 * you are on one of them. Scope of work and Register sit there too: each is a second view of
 * Phases or Requirements, not a destination of its own.
 *
 * The project overview's map of sections still reads `SECTIONS` in its own order; this is only the
 * sidebar's arrangement.
 */
export const PROJECT_ROWS: readonly string[] = ['drift', 'phases', 'requirements', 'activity', 'audits'];
export const KNOWLEDGE_ROWS: readonly string[] = [
  'documents',
  'adrs',
  'risks',
  'glossary',
  'ideas',
  'screens',
  'scope-of-work',
  'register',
];

export function section(slug: string): Section {
  const found = SECTIONS.find((candidate) => candidate.slug === slug);
  if (found === undefined) throw new Error(`no section ${slug}`);
  return found;
}

/**
 * Record pages that live at a flat route and belong to a project by their ID's prefix (ADR-008):
 * `/requirements/BND-REQ-001`, `/tasks/BND-T-1.2`, `/findings/BND-CR-001`. Each names the project
 * section it is a page of, for the trail and the sidebar's current row — a task is a page of its
 * phase, so of Phases; a finding is the cross-project inbox's, so of no project section.
 */
const RECORD_ROUTES: Readonly<Record<string, string | null>> = {
  requirements: 'requirements',
  tasks: 'phases',
  findings: null,
};

/**
 * The project the current page belongs to, or null when it belongs to none.
 *
 * Inside `/projects/CODE/…` it is the path's code. On a record page it is the ID's prefix, read with
 * `parseAnyId` — the routes stay flat, with no migration and no redirects (FRM-ADR-025), and the
 * project block, the trail and the phone's project tab follow the record's owner rather than the
 * URL's first segment. A codeless ID (PI-, GL-, GRP-) belongs to no project.
 *
 * This says what the page *claims*. Whether such a project exists is the shell's question: it asks
 * for the brief, and an unknown code renders the not-found page with no project block.
 */
export function projectCodeFor(path: string): string | null {
  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts[0] === 'projects') return parts[1] ?? null;
  if (parts[0] !== undefined && Object.hasOwn(RECORD_ROUTES, parts[0]) && parts[1] !== undefined && parts[2] === undefined) {
    return parseAnyId(decodeURIComponent(parts[1]))?.code ?? null;
  }
  return null;
}

/**
 * The project section a page is in: its own on `/projects/CODE/<slug>/…`, and on a record page
 * the section it is a record of. Null on the overview, and on a page belonging to no section.
 */
export function currentSectionSlug(path: string): string | null {
  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts[0] === 'projects') return parts[2] ?? null;
  if (parts[0] !== undefined && Object.hasOwn(RECORD_ROUTES, parts[0]) && projectCodeFor(path) !== null) {
    return RECORD_ROUTES[parts[0]] ?? null;
  }
  return null;
}

/** True on a flat record page that belongs to a project — the pages whose trail the shell draws. */
export function isRecordPage(path: string): boolean {
  const first = path.split('/').filter((p) => p.length > 0)[0];
  return first !== undefined && Object.hasOwn(RECORD_ROUTES, first) && projectCodeFor(path) !== null;
}

/**
 * The brief, fetched once per project and shared.
 *
 * The sidebar wants a project's name while a section screen wants its whole brief, and without a
 * cache that is two requests for the same row on every navigation — and a name that flickers in
 * on each one. Keyed by code, holding the promise rather than the value so concurrent callers
 * join the request already in flight.
 *
 * Deliberately not invalidated on a timer. It is invalidated on a write, by `forgetBrief`, which
 * is the only moment it can actually be wrong.
 */
const briefs = new Map<string, Promise<Brief>>();

export function briefFor(code: string): Promise<Brief> {
  const cached = briefs.get(code);
  if (cached !== undefined) return cached;

  const pending = foreman.brief(code).catch((error: unknown) => {
    // A failed request must not be cached, or one flaky moment sticks for the session.
    briefs.delete(code);
    throw error;
  });
  briefs.set(code, pending);
  return pending;
}

export function forgetBrief(code: string): void {
  briefs.delete(code);
}
