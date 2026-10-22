import { useSyncExternalStore } from 'react';

/**
 * A small router.
 *
 * `react-router` would be six components and a dependency for a console with five screens and no
 * nested layouts. This is the whole of what those screens need: the current path, a way to change
 * it without a reload, and the back button working.
 */

/** Paths the API serves. A click on one must leave the SPA rather than route inside it. */
const SERVER_PATHS = ['/auth', '/api', '/webhooks', '/healthz', '/readyz', '/health'];

/** Where we are: the path that chooses the screen, and the query that configures it. */
export interface Location {
  readonly path: string;
  /** The raw query string, `?uncovered=true` or empty. A filtered link is a shareable link. */
  readonly search: string;
  /** The raw fragment, `#BND-ADR-002` or empty: the row a list screen scrolls to (FRM-T-18.13). */
  readonly hash: string;
}

/**
 * The one record of where the console is (FRM-T-17.4).
 *
 * Every `useLocation` reads this store, so every instance — a screen, the scope switcher, the
 * shell — hears every change at once. It used to be one `useState` per hook with one document
 * click listener each: the first listener to run called `preventDefault`, every later one saw
 * `defaultPrevented` and bailed, so a second instance went stale on the first link click, and a
 * `history.replaceState` (Search writing `?q=`) was heard by none of them.
 *
 * It is told by: `navigate` and `replaceLocation` (the app's two ways to change the URL from
 * code), the browser's `popstate` (Back and Forward), and a click on an in-app link.
 *
 * `createLocationStore` takes the window so it can be tested without a browser.
 */
export interface LocationStore {
  /** The current `pathname + search + hash`. A string, so a snapshot compares by value. */
  readonly snapshot: () => string;
  readonly subscribe: (listener: () => void) => () => void;
  readonly navigate: (to: string) => void;
  readonly replace: (to: string) => void;
}

/** The slice of `window` the store touches. */
export interface LocationHost {
  readonly location: {
    readonly pathname: string;
    readonly search: string;
    readonly hash: string;
  };
  readonly history: {
    pushState(data: unknown, unused: string, url?: string | URL | null): void;
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  };
  addEventListener(type: 'popstate' | 'hashchange', listener: () => void): void;
  removeEventListener(type: 'popstate' | 'hashchange', listener: () => void): void;
  readonly document: {
    addEventListener(type: 'click', listener: (event: MouseEvent) => void): void;
    removeEventListener(type: 'click', listener: (event: MouseEvent) => void): void;
  };
  scrollTo(x: number, y: number): void;
}

export function createLocationStore(host: LocationHost): LocationStore {
  const listeners = new Set<() => void>();
  const snapshot = () => host.location.pathname + host.location.search + host.location.hash;
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  // Anchors are intercepted here rather than replaced with a Link component, so `@d3cloud/ui`'s
  // own Link keeps working and nothing has to know it is inside a router. One listener for the
  // whole console, however many components are reading the location.
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const anchor = (event.target as HTMLElement | null)?.closest('a');
    if (anchor === null || anchor === undefined) return;

    const to = anchor.getAttribute('href');
    if (to === null || !to.startsWith('/')) return;
    if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;
    // The server owns these, and they are real navigations — `/auth/oidc/start` redirects to the
    // identity provider. Intercepting one turns the D3 Auth button into a link that does nothing.
    if (SERVER_PATHS.some((prefix) => to === prefix || to.startsWith(`${prefix}/`))) return;

    event.preventDefault();
    navigate(to);
  };

  const navigate = (to: string) => {
    host.history.pushState({}, '', to);
    host.scrollTo(0, 0);
    emit();
  };

  return {
    snapshot,
    subscribe: (listener) => {
      if (listeners.size === 0) {
        host.addEventListener('popstate', emit);
        // A fragment link (`<a href="#x">`) moves the hash without a click this store handles.
        host.addEventListener('hashchange', emit);
        host.document.addEventListener('click', onClick);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          host.removeEventListener('popstate', emit);
          host.removeEventListener('hashchange', emit);
          host.document.removeEventListener('click', onClick);
        }
      };
    },
    navigate,
    // No scroll: a replace rewrites where you already are — a search's `?q=`, a filter.
    replace: (to) => {
      host.history.replaceState({}, '', to);
      emit();
    },
  };
}

let store: LocationStore | null = null;

function shared(): LocationStore {
  store ??= createLocationStore(window);
  return store;
}

export function useLocation(): Location {
  const href = useSyncExternalStore(
    (listener) => shared().subscribe(listener),
    () => shared().snapshot(),
    () => '/',
  );

  return splitHref(href);
}

/** `/path?query#fragment` as its three parts. The query never contains a `#`, so it comes first. */
export function splitHref(href: string): Location {
  const at = href.indexOf('#');
  const hash = at === -1 ? '' : href.slice(at);
  const rest = at === -1 ? href : href.slice(0, at);
  const index = rest.indexOf('?');
  return index === -1
    ? { path: rest, search: '', hash }
    : { path: rest.slice(0, index), search: rest.slice(index), hash };
}

/**
 * Go somewhere from code, the way a link click does: no reload, the back button works, and every
 * `useLocation` hears it.
 */
export function navigate(to: string): void {
  shared().navigate(to);
}

/**
 * Rewrite the URL where you are — a search's query, a filter — without a history entry, and tell
 * every `useLocation`. The console's only way to call `history.replaceState`.
 */
export function replaceLocation(to: string): void {
  shared().replace(to);
}

/** The path alone, for the screens that do not care about the query. */
export function usePath(): string {
  return useLocation().path;
}

export interface Route {
  readonly screen:
    | 'dashboard'
    | 'projects'
    | 'project-ideas'
    | 'project-idea'
    | 'guidelines'
    | 'groups'
    | 'group'
    | 'members'
    | 'project'
    | 'phases'
    | 'phase'
    | 'requirements'
    | 'requirement'
    | 'scope-of-work'
    | 'register'
    | 'documents'
    | 'document'
    | 'adrs'
    | 'risks'
    | 'glossary'
    | 'ideas'
    | 'audits'
    | 'activity'
    | 'findings'
    | 'finding'
    | 'drift'
    | 'drift-across'
    | 'screens'
    | 'screen'
    | 'health'
    | 'tokens'
    | 'search'
    | 'task'
    | 'not-found';
  readonly code?: string;
  readonly humanId?: string;
}

export function routeFor(path: string): Route {
  const parts = path.split('/').filter((p) => p.length > 0);

  if (parts.length === 0) return { screen: 'dashboard' };

  // `/projects` is a screen now, not a path nothing matched. It was the one destination the
  // sidebar offered and the router had never handled, so it rendered the not-found page.
  if (parts[0] === 'projects' && parts[1] === undefined) return { screen: 'projects' };
  // Before the `/projects/:code` branch would ever see it, and a separate path entirely: a
  // project idea is not a project, which is the whole distinction.
  if (parts[0] === 'project-ideas') {
    // An idea's own page, addressed by its codeless ID — `PI-007` belongs to no project, so its
    // page sits under the list rather than under `/projects/…` (ADR-015).
    return parts[1] === undefined
      ? { screen: 'project-ideas' }
      : { screen: 'project-idea', humanId: parts[1] };
  }
  // Cross-project, like project ideas: a guideline applies to every project and belongs to none.
  if (parts[0] === 'guidelines' && parts[1] === undefined) return { screen: 'guidelines' };
  if (parts[0] === 'members' && parts[1] === undefined) return { screen: 'members' };
  // Groups belong to no project either (FRM-ADR-024): the list, and one group by its slug.
  if (parts[0] === 'groups') {
    if (parts[1] === undefined) return { screen: 'groups' };
    if (parts[2] === undefined) return { screen: 'group', humanId: decodeURIComponent(parts[1]) };
  }

  if (parts[0] === 'projects' && parts[1] !== undefined) {
    const code = parts[1];
    if (parts[2] === undefined) return { screen: 'project', code };
    if (parts[2] === 'phases' && parts[3] === undefined) return { screen: 'phases', code };
    if (parts[2] === 'phases' && parts[3] !== undefined) {
      return { screen: 'phase', code, humanId: parts[3] };
    }
    if (parts[2] === 'requirements' && parts[3] === undefined) {
      return { screen: 'requirements', code };
    }
    // The two generated registers (ADR-006). Paths, not document IDs: there is no document.
    if (parts[2] === 'scope-of-work' && parts[3] === undefined) {
      return { screen: 'scope-of-work', code };
    }
    if (parts[2] === 'register' && parts[3] === undefined) return { screen: 'register', code };
    if (parts[2] === 'risks' && parts[3] === undefined) return { screen: 'risks', code };
    if (parts[2] === 'glossary' && parts[3] === undefined) return { screen: 'glossary', code };
    if (parts[2] === 'ideas' && parts[3] === undefined) return { screen: 'ideas', code };
    if (parts[2] === 'adrs' && parts[3] === undefined) return { screen: 'adrs', code };
    if (parts[2] === 'audits' && parts[3] === undefined) return { screen: 'audits', code };
    if (parts[2] === 'activity' && parts[3] === undefined) return { screen: 'activity', code };
    if (parts[2] === 'drift' && parts[3] === undefined) return { screen: 'drift', code };
    // A screen's ID carries its project, but the API reads it under the project's path, so the
    // page sits there too (FRM-REQ-196).
    if (parts[2] === 'screens') {
      return parts[3] === undefined
        ? { screen: 'screens', code }
        : { screen: 'screen', code, humanId: parts[3] };
    }
    if (parts[2] === 'documents') {
      return parts[3] === undefined
        ? { screen: 'documents', code }
        : { screen: 'document', code, humanId: parts[3] };
    }
  }

  if (parts[0] === 'search' && parts[1] === undefined) return { screen: 'search' };
  // Drift across projects, narrowed by `?group=` (FRM-T-17.4); a project's own is under it.
  if (parts[0] === 'drift' && parts[1] === undefined) return { screen: 'drift-across' };
  // `/system`, not `/health`: the server owns `/health` as its deploy probe and answers it with
  // JSON before the SPA ever sees the request. Two meanings of one path is a screen that renders
  // as a blob of JSON, which is how this was found.
  if (parts[0] === 'system' && parts[1] === undefined) return { screen: 'health' };
  if (parts[0] === 'tokens' && parts[1] === undefined) return { screen: 'tokens' };

  // Findings are reached without a project: the inbox is cross-project by design, and a finding's
  // human ID already carries its project (ADR-008).
  if (parts[0] === 'findings') {
    return parts[1] === undefined
      ? { screen: 'findings' }
      : { screen: 'finding', humanId: parts[1] };
  }

  if (parts[0] === 'tasks' && parts[1] !== undefined) {
    return { screen: 'task', humanId: parts[1] };
  }

  // A requirement is reached by ID alone: the ID already carries its project (ADR-008).
  if (parts[0] === 'requirements' && parts[1] !== undefined) {
    return { screen: 'requirement', humanId: parts[1] };
  }

  return { screen: 'not-found' };
}
