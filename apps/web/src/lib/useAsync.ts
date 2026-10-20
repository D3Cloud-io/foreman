import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

/**
 * Load something, and hold the three states a screen actually has to render: loading, failed, and
 * loaded (S-04 onward).
 *
 * A screen that only renders the third is the one that shows an empty table while the data is still
 * in flight, and nothing at all when the request failed.
 *
 * Two ways to read again, for two different moments (FRM-T-18.4, INT-03):
 *
 * - `reload()` starts over — back to `loading`, so the screen shows its skeleton. For a screen whose
 *   question changed, or one that failed and is being retried.
 * - `refresh()` reads again **in place**: the current value stays on screen while the request is in
 *   flight and is replaced by the answer, so a table keeps its rows, its sort and its focus. This is
 *   what a screen calls after its own write, and after an undo. A refresh that fails keeps what is
 *   shown — the write already said how it went — rather than swapping a page for an error.
 *
 * `update(fn)` changes the loaded value from a write's own answer, before any refresh lands.
 */

export type Async<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string; notFound: boolean }
  | { status: 'ready'; value: T };

export interface AsyncHandle<T> {
  state: Async<T>;
  /** Back to `loading`, then read again. */
  reload: () => void;
  /** Read again, keeping what is shown until the answer arrives. */
  refresh: () => void;
  /** True while an in-place refresh is in flight. */
  refreshing: boolean;
  /** Change the loaded value from a write's answer. Does nothing until something has loaded. */
  update: (change: (value: T) => T) => void;
}

export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncHandle<T> {
  const [state, setState] = useState<Async<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // Whether the next read is a refresh, and which load it was asked of: a refresh requested in
  // the same moment the screen's question changed is a new question, and gets a skeleton.
  const quiet = useRef(false);
  const lastRun = useRef<(() => Promise<T>) | null>(null);

  // The caller states its own dependencies, which is the whole point of the hook taking them.
  const run = useCallback(load, deps);

  useEffect(() => {
    let live = true;
    const inPlace = quiet.current && lastRun.current === run;
    quiet.current = false;
    lastRun.current = run;
    if (inPlace) {
      setRefreshing(true);
    } else {
      setState({ status: 'loading' });
      setRefreshing(false);
    }

    run()
      .then((value) => {
        // A response that arrives after the screen moved on must not render over what replaced it.
        if (live) setState({ status: 'ready', value });
      })
      .catch((error: unknown) => {
        if (!live) return;
        if (inPlace) {
          // Keep what is on screen: a quiet re-read that failed is not a page that failed.
          setState((current) =>
            current.status === 'ready' ? current : errorState(error),
          );
          return;
        }
        setState(errorState(error));
      })
      .finally(() => {
        if (live && inPlace) setRefreshing(false);
      });

    return () => {
      live = false;
    };
  }, [run, nonce]);

  const reload = useCallback(() => {
    quiet.current = false;
    setNonce((n) => n + 1);
  }, []);

  const refresh = useCallback(() => {
    quiet.current = true;
    setNonce((n) => n + 1);
  }, []);

  const update = useCallback((change: (value: T) => T) => {
    setState((current) =>
      current.status === 'ready' ? { status: 'ready', value: change(current.value) } : current,
    );
  }, []);

  return { state, reload, refresh, refreshing, update };
}

function errorState(error: unknown): Async<never> {
  return {
    status: 'error',
    message: error instanceof Error ? error.message : String(error),
    notFound: error instanceof ApiError && error.status === 404,
  };
}
