import { useEffect, useRef, useState } from 'react';
import { foreman, type HealthReport } from '../lib/api';

/**
 * What the frame says needs you (FRM-ADR-025): the counts on the sidebar and the tab bar, and the
 * health line in the sidebar's foot.
 *
 * **Counts are only for work waiting on you, never totals, and none at zero.** A total that never
 * reaches zero (hundreds of open findings) trains the eye to skip the badge, and a badge that says
 * "0" is a badge for nothing.
 *
 * - **Findings**: open critical findings, across every project — the inbox's alarm. The triage
 *   surface stays `/findings`; the count is why to go there.
 * - **Activity**: commits the attribution pass proposed and nobody has confirmed or rejected, for
 *   the project you are in. An unconfirmed attribution is never truth (the ledger's first
 *   non-negotiable), so until someone answers it the work it may describe is not counted anywhere.
 * - **Health**: the health report's problems, which is what `/system` shows in full.
 *
 * Read again as you move around, at most every `FRESH_MS`, so a count you just cleared on another
 * screen does not linger for the session — and not on a timer, which would poll a tab nobody is
 * looking at. A failed read leaves the last answer in place rather than a badge that flickers out.
 */

const FRESH_MS = 15_000;

/**
 * Screens that change a count call this after the write lands — confirming or rejecting an
 * attribution on Activity — so the badge answers the action rather than waiting for the next
 * navigation. It re-reads everything, ignoring `FRESH_MS`: the write is the moment it went stale.
 */
const refreshers = new Set<() => void>();

export function refreshSignals(): void {
  for (const refresh of refreshers) refresh();
}

export interface ShellSignals {
  /** Open critical findings, or null until the first answer. */
  readonly criticals: number | null;
  /** The health report, `error` when it could not be read, or null until the first answer. */
  readonly health: HealthReport | 'error' | null;
  /** Attributions awaiting review in `code`, or null until the first answer. */
  readonly unconfirmed: number | null;
}

export function useShellSignals(path: string, code: string | null): ShellSignals {
  const [criticals, setCriticals] = useState<number | null>(null);
  const [health, setHealth] = useState<HealthReport | 'error' | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<{ code: string; count: number } | null>(null);
  const lastGlobal = useRef(0);
  const lastProject = useRef<{ code: string; at: number } | null>(null);
  // Not reset per navigation: a read skipped as fresh on the next page relies on this one landing.
  // The shell is mounted for the whole session, so this only guards signing out mid-request.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Bumped by `refreshSignals`, which also forgets when each read last ran.
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const refresh = () => {
      lastGlobal.current = 0;
      lastProject.current = null;
      setNonce((n) => n + 1);
    };
    refreshers.add(refresh);
    return () => {
      refreshers.delete(refresh);
    };
  }, []);

  useEffect(() => {
    const live = () => mounted.current;
    const now = Date.now();

    if (now - lastGlobal.current >= FRESH_MS) {
      lastGlobal.current = now;
      foreman
        .openCriticalCount()
        .then((count) => {
          if (live()) setCriticals(count);
        })
        .catch(() => {
          // Keep the last count: a badge that vanishes on one failed read reads as "all clear".
        });
      foreman
        .healthReport()
        .then((report) => {
          if (live()) setHealth(report);
        })
        .catch(() => {
          if (live()) setHealth('error');
        });
    }

    const last = lastProject.current;
    if (code !== null && (last === null || last.code !== code || now - last.at >= FRESH_MS)) {
      lastProject.current = { code, at: now };
      // The brief, read fresh rather than from the shared cache: the cache is only forgotten on a
      // write to the project itself, and confirming an attribution is not one.
      foreman
        .brief(code)
        .then((brief) => {
          if (live()) setUnconfirmed({ code, count: brief.unconfirmedAttributions });
        })
        .catch(() => {
          // An unknown project has no Activity row to count, and the shell says not-found instead.
        });
    }
  }, [path, code, nonce]);

  return {
    criticals,
    health,
    unconfirmed: unconfirmed !== null && unconfirmed.code === code ? unconfirmed.count : null,
  };
}

/** A count to show, or nothing: never a badge at zero, and never one before the answer arrives. */
export function needsYou(count: number | null | undefined, countLabel: (count: number) => string) {
  return count !== null && count !== undefined && count > 0 ? { count, countLabel: countLabel(count) } : {};
}
