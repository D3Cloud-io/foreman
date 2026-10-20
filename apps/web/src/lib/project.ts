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

/** The project code in the current path, or null when we are not inside a project. */
export function projectCodeFor(path: string): string | null {
  const parts = path.split('/').filter((p) => p.length > 0);
  return parts[0] === 'projects' && parts[1] !== undefined ? parts[1] : null;
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
