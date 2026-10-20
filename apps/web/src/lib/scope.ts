import type { GroupAccent, GroupListing } from '@foreman/shared';
import { navigate, useLocation } from './router';

/**
 * The scope — every project, one group, or the ungrouped — and where it lives: the URL
 * (FRM-ADR-024, FRM-T-17.4).
 *
 * `?group=dormice` narrows Home, Projects, Findings, Search and Drift to one family, and because it
 * is in the URL a link to "Dormice's findings" is a link: shared, it opens in that scope. Moving
 * between scoped pages keeps it (their links carry it); a page that is not scoped — a project, a
 * finding, Settings — drops it, because it would mean nothing there.
 *
 * Everything but `useScope` is a pure function over strings, so the rules are tested once.
 */

export const SCOPE_PARAM = 'group';

/** The value `?group=` takes for the projects in no group. */
export const UNGROUPED = 'ungrouped';

/** The pages a scope narrows. Exact paths: a page beneath one (a finding) is not scoped. */
export const SCOPED_PATHS: readonly string[] = ['/', '/projects', '/findings', '/search', '/drift'];

/**
 * Marks an anchor whose scope was chosen on purpose — the switcher's items, "Show all" — so the
 * router does not carry the current scope onto it.
 */
export const SCOPE_EXPLICIT_ATTR = 'data-fm-scope';

export function isScopedPath(path: string): boolean {
  return SCOPED_PATHS.includes(path);
}

/** The scope a query string names, or null for every project. An empty `?group=` is none. */
export function scopeOf(search: string): string | null {
  const value = new URLSearchParams(search).get(SCOPE_PARAM)?.trim() ?? '';
  return value.length === 0 ? null : value;
}

function split(href: string): { path: string; query: string; hash: string } {
  const hashAt = href.indexOf('#');
  const hash = hashAt === -1 ? '' : href.slice(hashAt);
  const rest = hashAt === -1 ? href : href.slice(0, hashAt);
  const queryAt = rest.indexOf('?');
  return queryAt === -1
    ? { path: rest, query: '', hash }
    : { path: rest.slice(0, queryAt), query: rest.slice(queryAt + 1), hash };
}

/** `href` with its scope set to `scope`, or removed for null. Every other parameter is kept. */
export function withScope(href: string, scope: string | null): string {
  const { path, query, hash } = split(href);
  const params = new URLSearchParams(query);
  if (scope === null) params.delete(SCOPE_PARAM);
  else params.set(SCOPE_PARAM, scope);
  const next = params.toString();
  return `${path}${next.length === 0 ? '' : `?${next}`}${hash}`;
}

/**
 * A link from a scoped page: it carries the scope when it goes to another scoped page, and drops
 * it when it does not.
 */
export function scopedHref(href: string, scope: string | null): string {
  return isScopedPath(split(href).path) ? withScope(href, scope) : withScope(href, null);
}

/**
 * What the router does with a link click (`lib/router.tsx`): a link to a scoped page that names no
 * scope of its own takes the one in view. This is how the shell's own destinations — Home,
 * Findings, Search — keep the scope without each knowing about it. A link that names a scope, or
 * one marked with `SCOPE_EXPLICIT_ATTR`, is left exactly as written.
 */
export function carryScope(to: string, fromPath: string, fromSearch: string): string {
  // Only a scoped page has a scope to carry; a stray `?group=` anywhere else means nothing.
  const scope = isScopedPath(fromPath) ? scopeOf(fromSearch) : null;
  if (scope === null) return to;
  const { path, query } = split(to);
  if (!isScopedPath(path)) return to;
  if (new URLSearchParams(query).has(SCOPE_PARAM)) return to;
  return withScope(to, scope);
}

/**
 * Where choosing a scope goes. On a scoped page, the same page in the new scope, its other
 * filters kept; anywhere else, Home in that scope — the page that shows a family first.
 */
export function scopeTarget(path: string, search: string, next: string | null): string {
  return isScopedPath(path) ? withScope(`${path}${search}`, next) : withScope('/', next);
}

// ─── What a scope is called ────────────────────────────────────────────────

/** One entry of the switcher: All projects, each group, Ungrouped. */
export interface ScopeOption {
  /** What `?group=` carries — a group's slug, `ungrouped` — or null for every project. */
  readonly value: string | null;
  readonly key: string;
  readonly name: string;
  /** Null for All projects and Ungrouped, which have no accent. */
  readonly accent: GroupAccent | null;
  readonly humanId: string | null;
  readonly count: number;
}

export function scopeOptions(listing: GroupListing): ScopeOption[] {
  const total =
    listing.items.reduce((sum, group) => sum + group.counts.projects, 0) + listing.ungrouped.counts.projects;
  return [
    { value: null, key: 'all', name: 'All projects', accent: null, humanId: null, count: total },
    ...listing.items.map((group) => ({
      value: group.slug,
      key: group.humanId,
      name: group.name,
      accent: group.accent,
      humanId: group.humanId,
      count: group.counts.projects,
    })),
    {
      value: UNGROUPED,
      key: UNGROUPED,
      name: 'Ungrouped',
      accent: null,
      humanId: null,
      count: listing.ungrouped.counts.projects,
    },
  ];
}

/**
 * The option a scope names, as the server resolves it: a `GRP-n`, a slug in any case, or
 * `ungrouped`. Undefined when nothing matches — the page will be answered with a 404.
 */
export function matchScope(scope: string | null, options: readonly ScopeOption[]): ScopeOption | undefined {
  if (scope === null) return options.find((option) => option.value === null);
  const lower = scope.toLowerCase();
  return options.find(
    (option) =>
      (option.value !== null && option.value.toLowerCase() === lower) || option.humanId === scope,
  );
}

/**
 * How copy names a scope: "Open findings across D3 Cloud". Every project when unscoped, the
 * ungrouped projects for `ungrouped`, otherwise the group's name — or, before the groups have
 * loaded, the value from the URL.
 */
export function scopePhrase(scope: string | null, option: ScopeOption | undefined): string {
  if (scope === null) return 'every project';
  if (scope.toLowerCase() === UNGROUPED) return 'the ungrouped projects';
  return option?.name ?? scope;
}

/** The name a scope shows in the switcher and in "Viewing …". */
export function scopeName(scope: string | null, option: ScopeOption | undefined): string {
  if (scope === null) return 'All projects';
  return option?.name ?? scope;
}

// ─── The hook ──────────────────────────────────────────────────────────────

export interface ScopeState {
  /** The scope in the URL, or null. On a page that is not scoped this is always null. */
  readonly scope: string | null;
  readonly path: string;
  readonly search: string;
  /** Whether this page is one a scope narrows. */
  readonly scoped: boolean;
  /** Go to `next` — see `scopeTarget`. */
  readonly setScope: (next: string | null) => void;
  /** Where choosing `next` would go, for a real link. */
  readonly hrefFor: (next: string | null) => string;
}

export function useScope(): ScopeState {
  const { path, search } = useLocation();
  const scoped = isScopedPath(path);
  return {
    scope: scoped ? scopeOf(search) : null,
    path,
    search,
    scoped,
    setScope: (next) => {
      navigate(scopeTarget(path, search, next));
    },
    hrefFor: (next) => scopeTarget(path, search, next),
  };
}
