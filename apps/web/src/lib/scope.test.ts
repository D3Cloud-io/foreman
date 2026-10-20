import { describe, expect, it } from 'vitest';
import type { GroupListing } from '@foreman/shared';
import { routeFor } from './router';
import {
  carryScope,
  isScopedPath,
  matchScope,
  scopedHref,
  scopeName,
  scopeOf,
  scopeOptions,
  scopePhrase,
  scopeTarget,
  withScope,
} from './scope';

/** FRM-T-17.4: the scope lives in the URL, and these are the rules that keep it there. */

const listing = {
  items: [
    { humanId: 'GRP-001', name: 'D3 Cloud', slug: 'd3-cloud', accent: 'foreman', counts: { projects: 11, guidelines: 6 } },
    { humanId: 'GRP-002', name: 'Dormice', slug: 'dormice', accent: 'bindery', counts: { projects: 2, guidelines: 4 } },
  ],
  ungrouped: { humanId: null, name: 'Ungrouped', slug: 'ungrouped', projects: [], counts: { projects: 3 } },
  total: 2,
} as unknown as GroupListing;

describe('reading and writing ?group=', () => {
  it('reads the scope, and treats an empty one as none', () => {
    expect(scopeOf('?group=dormice')).toBe('dormice');
    expect(scopeOf('?severity=high&group=GRP-002')).toBe('GRP-002');
    expect(scopeOf('?group=')).toBeNull();
    expect(scopeOf('?group=%20')).toBeNull();
    expect(scopeOf('')).toBeNull();
  });

  it('sets and clears the scope, keeping every other parameter and the hash', () => {
    expect(withScope('/findings', 'dormice')).toBe('/findings?group=dormice');
    expect(withScope('/search?q=tunnel&type=adr', 'dormice')).toBe('/search?q=tunnel&type=adr&group=dormice');
    expect(withScope('/search?q=tunnel&group=dormice', null)).toBe('/search?q=tunnel');
    expect(withScope('/?group=dormice#top', 'd3-cloud')).toBe('/?group=d3-cloud#top');
    expect(withScope('/', null)).toBe('/');
  });

  it('knows which pages a scope narrows — exact paths, not what is beneath them', () => {
    for (const path of ['/', '/projects', '/findings', '/search', '/drift']) expect(isScopedPath(path)).toBe(true);
    for (const path of ['/findings/CR-001', '/projects/FRM', '/projects/FRM/drift', '/groups', '/guidelines']) {
      expect(isScopedPath(path), path).toBe(false);
    }
  });

  it('routes /drift to drift across projects, and a project’s drift to its own view', () => {
    expect(routeFor('/drift')).toEqual({ screen: 'drift-across' });
    expect(routeFor('/projects/FRM/drift')).toEqual({ screen: 'drift', code: 'FRM' });
  });
});

describe('the scope persists between scoped pages and drops elsewhere', () => {
  it('builds a link that carries the scope to a scoped page and drops it from any other', () => {
    expect(scopedHref('/findings', 'dormice')).toBe('/findings?group=dormice');
    expect(scopedHref('/drift', null)).toBe('/drift');
    expect(scopedHref('/projects/KURO', 'dormice')).toBe('/projects/KURO');
    expect(scopedHref('/projects/KURO?group=dormice', 'dormice')).toBe('/projects/KURO');
  });

  it('carries the scope onto a shell link that names none', () => {
    expect(carryScope('/findings', '/', '?group=dormice')).toBe('/findings?group=dormice');
    expect(carryScope('/', '/search', '?q=x&group=dormice')).toBe('/?group=dormice');
    expect(carryScope('/search', '/findings', '?group=GRP-002&severity=high')).toBe('/search?group=GRP-002');
  });

  it('leaves alone a link that names its own scope, goes somewhere unscoped, or starts unscoped', () => {
    expect(carryScope('/findings?group=d3-cloud', '/', '?group=dormice')).toBe('/findings?group=d3-cloud');
    expect(carryScope('/projects/KURO', '/', '?group=dormice')).toBe('/projects/KURO');
    expect(carryScope('/findings', '/', '')).toBe('/findings');
    // A stray ?group= on a page that is not scoped is not a scope.
    expect(carryScope('/findings', '/projects/KURO', '?group=dormice')).toBe('/findings');
  });

  it('chooses a scope in place on a scoped page, and on Home from anywhere else', () => {
    expect(scopeTarget('/findings', '?severity=high', 'dormice')).toBe('/findings?severity=high&group=dormice');
    expect(scopeTarget('/findings', '?group=dormice', null)).toBe('/findings');
    expect(scopeTarget('/projects/FRM', '', 'dormice')).toBe('/?group=dormice');
    expect(scopeTarget('/groups', '', null)).toBe('/');
  });
});

describe('what a scope is called', () => {
  const options = scopeOptions(listing);

  it('lists All projects, each group in order with its count, then Ungrouped', () => {
    expect(options.map((o) => [o.value, o.name, o.count])).toEqual([
      [null, 'All projects', 16],
      ['d3-cloud', 'D3 Cloud', 11],
      ['dormice', 'Dormice', 2],
      ['ungrouped', 'Ungrouped', 3],
    ]);
    expect(options[2]?.accent).toBe('bindery');
    expect(options[0]?.accent).toBeNull();
  });

  it('matches a scope the way the server resolves it: slug in any case, GRP-n, or ungrouped', () => {
    expect(matchScope(null, options)?.key).toBe('all');
    expect(matchScope('dormice', options)?.key).toBe('GRP-002');
    expect(matchScope('DORMICE', options)?.key).toBe('GRP-002');
    expect(matchScope('GRP-001', options)?.key).toBe('GRP-001');
    expect(matchScope('Ungrouped', options)?.key).toBe('ungrouped');
    expect(matchScope('no-such', options)).toBeUndefined();
    expect(matchScope('all', options)).toBeUndefined();
  });

  it('names the scope in copy: “Open findings across D3 Cloud”', () => {
    expect(scopePhrase(null, matchScope(null, options))).toBe('every project');
    expect(scopePhrase('d3-cloud', matchScope('d3-cloud', options))).toBe('D3 Cloud');
    expect(scopePhrase('ungrouped', matchScope('ungrouped', options))).toBe('the ungrouped projects');
    // Before the groups load, the URL's own word rather than nothing.
    expect(scopePhrase('dormice', undefined)).toBe('dormice');
    expect(scopeName(null, undefined)).toBe('All projects');
    expect(scopeName('GRP-002', matchScope('GRP-002', options))).toBe('Dormice');
  });
});
