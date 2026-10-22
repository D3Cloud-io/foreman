import { createElement, useEffect, type ReactNode } from 'react';
import { useLocation } from './router';

/**
 * Row anchors on the list screens (FRM-T-18.13, FRM-REQ-244).
 *
 * ⌘K on `BND-ADR-002` goes to `/projects/BND/adrs#BND-ADR-002`. A list that renders every row
 * with `id=<humanId>` and calls `useRowAnchor` once it has loaded does the rest: the row named by
 * the fragment scrolls into view, takes focus and is outlined, on load and again when only the
 * fragment changes (a second ⌘K while still on the list).
 *
 * The URL is never written here — the fragment arrives through `useLocation`, which the router's
 * `navigate` and `hashchange` both feed.
 */

/** The class the anchored row wears: an outline in the focus tokens (styles.css). */
export const ANCHORED_CLASS = 'fm-row--anchored';

/** The class of the id-carrying wrapper inside a table cell, for rows `Table` cannot give an id. */
export const ROW_ID_CLASS = 'fm-row-id';

/** The id a fragment names: `#BND-ADR-002` is `BND-ADR-002`; an empty or malformed one is null. */
export function idFromHash(hash: string): string | null {
  if (!hash.startsWith('#') || hash.length < 2) return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
}

/** The id the current location names, for a screen deciding what its list must show. */
export function useAnchorId(): string | null {
  return idFromHash(useLocation().hash);
}

/** Just enough of an element to scroll to, focus and outline it. */
export interface AnchorTarget {
  scrollIntoView(options: ScrollIntoViewOptions): void;
  focus(options?: FocusOptions): void;
  closest(selector: string): AnchorTarget | null;
  readonly classList: { add(name: string): void; remove(name: string): void };
}

export interface AnchorHost {
  getElementById(id: string): AnchorTarget | null;
}

/**
 * Anchor the row named by `id`; returns a function that takes the outline off again, or null when
 * the document has no such row.
 *
 * A `Table` row cannot carry an id, so its first-cell wrapper (`rowAnchor`) does, and the outline
 * goes on the `<tr>` around it while the wrapper keeps focus. Smooth scrolling is for people who
 * have not asked for less motion.
 */
export function anchorRow(
  host: AnchorHost,
  id: string,
  options: { reducedMotion: boolean },
): (() => void) | null {
  const target = host.getElementById(id);
  if (target === null) return null;
  const row = target.closest('tr, [role="row"]') ?? target;
  row.classList.add(ANCHORED_CLASS);
  target.scrollIntoView({ block: 'center', behavior: options.reducedMotion ? 'auto' : 'smooth' });
  // The scroll above is the position; focus must not start a second, jumping one.
  target.focus({ preventScroll: true });
  return () => {
    row.classList.remove(ANCHORED_CLASS);
  };
}

/**
 * Call on a list screen with `ready` true once its rows are in the document. Re-runs when the
 * fragment changes, so a jump while already on the list lands too.
 */
export function useRowAnchor(ready: boolean): void {
  const id = useAnchorId();
  useEffect(() => {
    if (!ready || id === null) return undefined;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return anchorRow(document, id, { reducedMotion }) ?? undefined;
  }, [ready, id]);
}

/**
 * The first cell's content, wearing the row's id. `Table` has no row props, so the id sits on a
 * block inside the cell and `anchorRow` outlines the row around it. Focusable by script, not by Tab.
 */
export function rowAnchor(id: string, content: ReactNode): ReactNode {
  return createElement('div', { id, tabIndex: -1, className: ROW_ID_CLASS }, content);
}
