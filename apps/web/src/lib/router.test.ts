import { describe, expect, it } from 'vitest';
import { createLocationStore, type LocationHost } from './router';

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
  const clicks = new Set<Listener>();
  const split = () => {
    const at = href.indexOf('?');
    return at === -1 ? { pathname: href, search: '' } : { pathname: href.slice(0, at), search: href.slice(at) };
  };
  const host: LocationHost = {
    location: {
      get pathname() { return split().pathname; },
      get search() { return split().search; },
    },
    history: {
      pushState: (_d, _u, url) => { href = String(url); },
      replaceState: (_d, _u, url) => { href = String(url); },
    },
    addEventListener: (_type, listener) => { popstate.add(listener); },
    removeEventListener: (_type, listener) => { popstate.delete(listener); },
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
  return { host, back, click, listenerCount: () => ({ clicks: clicks.size, popstate: popstate.size }) };
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
    expect(fake.listenerCount()).toEqual({ clicks: 1, popstate: 1 });
    stop();
    expect(fake.listenerCount()).toEqual({ clicks: 0, popstate: 0 });
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
