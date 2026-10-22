import { describe, expect, it } from 'vitest';
import { createLocationStore, splitHref, type LocationHost } from './router';

/**
 * FRM-T-17.4: one location store for the whole console. Two readers of the location — a screen and
 * the scope switcher, or the shell — must both hear every change: a link click, `navigate`,
 * `replaceLocation` (Search writing `?q=`), and Back. Before the store, each `useLocation` kept
 * its own state and its own click listener, the first listener's `preventDefault` made every
 * later one bail, and `history.replaceState` was heard by none of them.
 */

type Listener = (event: MouseEvent) => void;

function fakeHost(start = '/') {
  let href = start;
  const popstate = new Set<() => void>();
  const hashchange = new Set<() => void>();
  const clicks = new Set<Listener>();
  const split = () => {
    const { path, search, hash } = splitHref(href);
    return { pathname: path, search, hash };
  };
  const host: LocationHost = {
    location: {
      get pathname() { return split().pathname; },
      get search() { return split().search; },
      get hash() { return split().hash; },
    },
    history: {
      pushState: (_d, _u, url) => { href = String(url); },
      replaceState: (_d, _u, url) => { href = String(url); },
    },
    addEventListener: (type, listener) => { (type === 'hashchange' ? hashchange : popstate).add(listener); },
    removeEventListener: (type, listener) => { (type === 'hashchange' ? hashchange : popstate).delete(listener); },
    document: {
      addEventListener: (_type, listener) => { clicks.add(listener); },
      removeEventListener: (_type, listener) => { clicks.delete(listener); },
    },
    scrollTo: () => undefined,
  };
  /** The browser moving the URL itself — Back — then telling the page. */
  const back = (to: string) => {
    href = to;
    for (const listener of popstate) listener();
  };
  /** A plain left click on `<a href={to}>`, through every document listener in turn. */
  const click = (to: string) => {
    let prevented = false;
    const anchor = {
      getAttribute: (name: string) => (name === 'href' ? to : null),
      hasAttribute: () => false,
      target: '',
    };
    const event = {
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      get defaultPrevented() { return prevented; },
      preventDefault: () => { prevented = true; },
      target: { closest: () => anchor },
    } as unknown as MouseEvent;
    for (const listener of clicks) listener(event);
    return prevented;
  };
  /** The browser moving only the fragment (`<a href="#x">`), then firing `hashchange`. */
  const fragment = (to: string) => {
    href = to;
    for (const listener of hashchange) listener();
  };
  return {
    host,
    back,
    click,
    fragment,
    listenerCount: () => ({ clicks: clicks.size, popstate: popstate.size, hashchange: hashchange.size }),
  };
}

/** Two readers, as two `useLocation`s are: each re-reads the snapshot when told. */
function twoReaders(store: ReturnType<typeof createLocationStore>) {
  const seen: [string[], string[]] = [[], []];
  const stops = seen.map((log) => store.subscribe(() => { log.push(store.snapshot()); }));
  return { seen, stop: () => { for (const stop of stops) stop(); } };
}

describe('the location store', () => {
  it('tells every reader about a replace — Search writing ?q= beside the scope', () => {
    const { host } = fakeHost('/search?group=dormice');
    const store = createLocationStore(host);
    const { seen, stop } = twoReaders(store);

    store.replace('/search?group=dormice&q=Scoped');
    expect(store.snapshot()).toBe('/search?group=dormice&q=Scoped');
    expect(seen[0]).toEqual(['/search?group=dormice&q=Scoped']);
    expect(seen[1]).toEqual(['/search?group=dormice&q=Scoped']);
    stop();
  });

  it('tells every reader about navigate, a link click and Back', () => {
    const fake = fakeHost('/');
    const store = createLocationStore(fake.host);
    const { seen, stop } = twoReaders(store);

    store.navigate('/findings?group=dormice');
    expect(fake.click('/search?group=dormice')).toBe(true);
    fake.back('/findings?group=dormice');

    const expected = ['/findings?group=dormice', '/search?group=dormice', '/findings?group=dormice'];
    expect(seen[0]).toEqual(expected);
    expect(seen[1]).toEqual(expected);
    stop();
  });

  it('listens to the document once however many readers there are, and stops with the last', () => {
    const fake = fakeHost('/');
    const store = createLocationStore(fake.host);
    const { stop } = twoReaders(store);
    expect(fake.listenerCount()).toEqual({ clicks: 1, popstate: 1, hashchange: 1 });
    stop();
    expect(fake.listenerCount()).toEqual({ clicks: 0, popstate: 0, hashchange: 0 });
  });

  it('leaves server paths and other origins to the browser', () => {
    const fake = fakeHost('/');
    const store = createLocationStore(fake.host);
    const { seen, stop } = twoReaders(store);
    expect(fake.click('/auth/oidc/start')).toBe(false);
    expect(fake.click('https://dormice.ai/')).toBe(false);
    expect(seen[0]).toEqual([]);
    stop();
  });
});

describe('the fragment (FRM-T-18.13)', () => {
  it('keeps the hash through navigate and tells every reader, even when only the hash changed', () => {
    const fake = fakeHost('/projects/BND/adrs');
    const store = createLocationStore(fake.host);
    const { seen, stop } = twoReaders(store);

    store.navigate('/projects/BND/adrs#BND-ADR-002');
    expect(store.snapshot()).toBe('/projects/BND/adrs#BND-ADR-002');
    store.navigate('/projects/BND/adrs#BND-ADR-003');

    const expected = ['/projects/BND/adrs#BND-ADR-002', '/projects/BND/adrs#BND-ADR-003'];
    expect(seen[0]).toEqual(expected);
    expect(seen[1]).toEqual(expected);
    stop();
  });

  it('hears a fragment link the browser handled itself', () => {
    const fake = fakeHost('/guidelines');
    const store = createLocationStore(fake.host);
    const { seen, stop } = twoReaders(store);
    fake.fragment('/guidelines#GL-004');
    expect(seen[0]).toEqual(['/guidelines#GL-004']);
    stop();
  });

  it('splits a path, a query and a fragment', () => {
    expect(splitHref('/a/b')).toEqual({ path: '/a/b', search: '', hash: '' });
    expect(splitHref('/a?x=1')).toEqual({ path: '/a', search: '?x=1', hash: '' });
    expect(splitHref('/a#BND-ADR-002')).toEqual({ path: '/a', search: '', hash: '#BND-ADR-002' });
    expect(splitHref('/a?x=1#T-1')).toEqual({ path: '/a', search: '?x=1', hash: '#T-1' });
  });
});
