import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast, type ToastApi } from '@d3cloud/ui';
import { ApiError, type RolledUp } from './api';
import { refreshSignals } from '../components/shellSignals';
import { undoAll, undoSummary, type UndoCheck, type Undoable, type UndoReport } from './undo';

/**
 * Every console write, one way (FRM-REQ-243, FRM-T-18.4, design review FRM-DA-004).
 *
 * **Pessimistic, in place.** The screen waits for the server — the control shows it is waiting,
 * nothing on screen claims the change yet — then applies the server's answer, roll-ups included,
 * and re-reads quietly (`useAsync().refresh`). It never drops back to a skeleton, so a table keeps
 * its rows, its sort and the focus on the control that was used.
 *
 * **A toast names what happened**, and what moved because of it: "BND-T-9.4 marked done ·
 * BND-P-9 rolled up to complete". Its Undo reverses every audit event the write answered with,
 * last-first (`undoAll`), so a status change and the phase and project it rolled up go back
 * together. When the server refuses, the toast says so in the server's own words.
 *
 * **The ladder.** What can be undone acts at once and offers Undo. What cannot — a token revoke —
 * asks first, at the call site, and its toast offers nothing (`undoable: false`).
 */

export interface MutationSpec<R> {
  /** The write. */
  run: () => Promise<R>;
  /** What the record is called, in a refusal: "BND-T-9.4". */
  subject: string;
  /** One line saying what happened, from the answer: "BND-T-9.4 marked done". Null: no toast. */
  message: (result: R) => string | null;
  /** Apply the server's answer to what is on screen, before any re-read lands. */
  apply?: (result: R) => void;
  /** Re-read in place, after the write and again after an undo. */
  refresh?: () => void;
  /** False for what the server cannot reverse — a revoked token, a commit's attribution. */
  undoable?: boolean;
  /** What the toast says once it is undone. Defaults to "Undone — <subject> is as it was". */
  undone?: string;
  /** The write changed a "needs you" count in the shell (attributions, findings). */
  signals?: boolean;
  /**
   * How a failed write is told: `toast` (the default) shows the server's message; `inline` leaves
   * it to the caller, whose form has a place for it beside the field it is about.
   */
  failure?: 'toast' | 'inline';
  /** After an undo, whether it worked or not — for a screen that must do more than refresh. */
  onUndone?: (report: UndoReport) => void;
  /**
   * The sentence an undo ends with, when the screen can say more than the default can — the Groups
   * screens name which projects are back and which have changed since ("Undid 1 of 2 — X has changed
   * since", `undoWords`). Given the whole report; the default is `undoOutcome`.
   */
  undoWords?: (report: UndoReport) => string | Promise<string>;
}

/** What announcing and undoing a write need: everything but the write itself. */
export type Announcement<R> = Omit<MutationSpec<R>, 'run'>;

export type MutationOutcome<R> =
  | { readonly ok: true; readonly value: R }
  | {
      readonly ok: false;
      readonly error: unknown;
      readonly message: string;
      /**
       * Refused before it was sent, because this hook's last write has not landed. Said in a toast
       * already, so a form shows nothing more for it.
       */
      readonly inFlight?: true;
    };

/** What a second write is told while the first is still with the server. */
export const STILL_SAVING = 'Still saving the last change — this one was not sent twice.';

/** The events a write's answer carries — the record's own first, its roll-ups after. */
export function eventIdsOf(result: unknown): readonly string[] {
  if (typeof result !== 'object' || result === null || !('auditEventIds' in result)) return [];
  const ids = result.auditEventIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/** The statuses that moved because of a write (ADR-018), read from its answer. */
export function rolledUpOf(result: unknown): readonly RolledUp[] {
  if (typeof result !== 'object' || result === null || !('rolledUp' in result)) return [];
  const moves = result.rolledUp;
  return Array.isArray(moves) ? (moves as RolledUp[]) : [];
}

/** The status words the console shows, for the toast: `in_progress` is "in progress". */
export function statusWords(status: string): string {
  return status.replace(/_/g, ' ');
}

/**
 * The toast's line: the change, then each roll-up it caused — "BND-T-9.4 marked done · BND-P-9
 * rolled up to complete". A held move was worked out and not made, so it is not named as one.
 */
export function withRollups(message: string, rolledUp: readonly RolledUp[]): string {
  const moves = rolledUp
    .filter((move) => move.held !== true)
    .map((move) => `${move.humanId} rolled up to ${statusWords(move.to)}`);
  return [message, ...moves].join(' · ');
}

/**
 * What an undo ends with. All of it: the success line. Any refusal: the server's words, verbatim —
 * "Undo of BND-T-9.4 refused: that change cannot be undone: title has changed since" — and, when
 * only part of it went, how much did.
 */
export function undoOutcome(report: UndoReport, subject: string, undone: string): string {
  if (report.refused.length === 0) return undone;
  const words = [...new Set(report.refused.map((r) => r.message))].join('; ');
  if (report.undone === 0) return `Undo of ${subject} refused: ${words}`;
  return `Undid ${String(report.undone)} of ${String(report.total)} changes to ${subject}; refused: ${words}`;
}

/** The message a failed write is shown with: the server's own, or a plain sentence. */
export function failureMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error && caught.message !== '') return caught.message;
  return 'That change did not go through.';
}

/** The part of `useToast()` a write needs. */
export interface Toaster {
  show: ToastApi['show'];
}

/**
 * One write, start to finish: run it; on success apply the answer, re-read in place, and toast the
 * change and its roll-ups with Undo; on Undo reverse every event last-first and toast the outcome
 * in the server's words. The hook below is this with the app's toast and an in-flight count.
 */
export async function runMutation<R>(spec: MutationSpec<R>, toast: Toaster): Promise<MutationOutcome<R>> {
  let result: R;
  try {
    result = await spec.run();
  } catch (caught) {
    const message = failureMessage(caught);
    if (spec.failure !== 'inline') {
      // A refusal stays until it is read: it is the one toast that needs acting on.
      toast.show({ message: `${spec.subject}: ${message}`, duration: 0 });
    }
    return { ok: false, error: caught, message };
  }

  spec.apply?.(result);
  spec.refresh?.();
  if (spec.signals === true) refreshSignals();

  announceMutation(spec, result, toast);
  return { ok: true, value: result };
}

/**
 * The toast for a write that has landed: what happened and what rolled up, with Undo when the server
 * answered with events to reverse. `runMutation` ends here; a screen whose write was made by a
 * shared dialog (the Move dialog) calls it with that write's answer.
 */
export function announceMutation<R>(spec: Announcement<R>, result: R, toast: Toaster): void {
  const line = spec.message(result);
  if (line === null) return;
  const ids = eventIdsOf(result);
  const offer = spec.undoable !== false && ids.length > 0;
  toast.show({
    message: withRollups(line, rolledUpOf(result)),
    ...(offer
      ? {
          action: {
            label: 'Undo',
            onAction: () => {
              void undoMutation(spec, ids, toast);
            },
          },
        }
      : {}),
  });
}

/** Undo a write: every event, last-first, then say what happened and re-read in place. */
export async function undoMutation<R>(
  spec: Announcement<R>,
  ids: readonly string[],
  toast: Toaster,
): Promise<UndoReport> {
  const report = await undoAll(ids);
  const undone = spec.undone ?? `Undone — ${spec.subject} is as it was`;
  let words = undoOutcome(report, spec.subject, undone);
  if (spec.undoWords !== undefined) {
    // Said by the screen; if it cannot (a read-back failed), the server's own words stand.
    words = await Promise.resolve(spec.undoWords(report)).catch(() => words);
  }
  toast.show({
    message: words,
    ...(report.refused.length > 0 ? { duration: 0 } : {}),
  });
  spec.refresh?.();
  if (spec.signals === true) refreshSignals();
  spec.onUndone?.(report);
  return report;
}

/**
 * One write at a time (FRM-T-18.4). A second call while the first is with the server is refused
 * before it is sent, and says so: a double ⌘↵ or a double click must not store a thing twice. The
 * flag is plain state outside React, so two calls in the same tick — before any render — are
 * still one.
 */
export function oneAtATime(toast: Toaster, onBusy: (busy: boolean) => void = () => undefined) {
  let sending = false;
  return async <R>(spec: MutationSpec<R>): Promise<MutationOutcome<R>> => {
    if (sending) {
      toast.show({ message: STILL_SAVING });
      return { ok: false, error: null, message: STILL_SAVING, inFlight: true };
    }
    sending = true;
    onBusy(true);
    try {
      return await runMutation(spec, toast);
    } finally {
      sending = false;
      onBusy(false);
    }
  };
}

/**
 * Run writes the one way. Each hook instance knows whether its own write is in flight, so a
 * control can show that it is waiting without the screen around it doing anything — and refuses a
 * second write until the first has landed (`oneAtATime`).
 */
export function useMutate(): {
  mutate: <R>(spec: MutationSpec<R>) => Promise<MutationOutcome<R>>;
  pending: boolean;
} {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Made once per hook instance: the in-flight flag must survive every render, including the one
  // its own `setPending` causes. The toast is read through a ref so a new `useToast()` object
  // never makes a second mutator with a fresh flag.
  const latestToast = useRef(toast);
  latestToast.current = toast;
  const [mutate] = useState(() =>
    oneAtATime(
      { show: (options) => latestToast.current.show(options) },
      (busy) => {
        if (mounted.current) setPending(busy);
      },
    ),
  );

  return { mutate, pending };
}

// ─── Writes made elsewhere, and the partial-undo report ──────────────────────

/**
 * An `undoWords` that tells a partial undo item by item (FRM-T-17.3): all of it, the success line;
 * part of it, "Undid 1 of 2 — KURO has changed since", read back from the state after the undo.
 * `check` is only asked when something was refused.
 */
export function undoReportWords(
  undone: string,
  check?: () => Promise<UndoCheck>,
): (report: UndoReport) => Promise<string> {
  return async (report) => {
    let checked: UndoCheck | undefined;
    if (report.refused.length > 0 && check !== undefined) {
      checked = await check().catch(() => undefined);
    }
    return undoSummary(report, undone, checked);
  };
}

/**
 * Announce a write that was already made — the shared Move dialog does the move and hands the screen
 * its answer. The same toast and the same Undo as `useMutate`.
 */
export function useAnnounce(): <R>(spec: Announcement<R>, result: R) => void {
  const toast = useToast();
  return (spec, result) => { announceMutation(spec, result, toast); };
}

/**
 * The Groups screens' older form of `useAnnounce` (FRM-T-17.3), kept as a thin alias: a line, the
 * events to reverse, what the undo says, how to tell a partial undo, and what to re-read.
 */
export function useUndoToast(): (undoable: Undoable) => void {
  const announce = useAnnounce();
  return ({ message, auditEventIds, undone = 'Undone', check, reload }) => {
    announce(
      {
        subject: message,
        message: () => message,
        undone,
        refresh: reload,
        undoWords: undoReportWords(undone, check),
      },
      { auditEventIds },
    );
  };
}

// ─── Drafts ──────────────────────────────────────────────────────────────────

/**
 * How much of a draft would be lost: the length of the stretch that differs between what is
 * stored and what was typed, once their shared start and end are set aside. A select changed from
 * one value to another counts its characters too; what matters is that it is not zero.
 */
export function changedCharacters(before: string, after: string): number {
  if (before === after) return 0;
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before[start] === after[start]) start += 1;
  let end = 0;
  while (
    end < shortest - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end += 1;
  }
  return Math.max(before.length, after.length) - start - end;
}

/** The unsaved characters across a form's fields. Zero means there is nothing to lose. */
export function draftSize(
  stored: Readonly<Record<string, string | null | undefined>>,
  draft: Readonly<Record<string, string | null | undefined>>,
): number {
  let total = 0;
  for (const key of new Set([...Object.keys(stored), ...Object.keys(draft)])) {
    total += changedCharacters(stored[key] ?? '', draft[key] ?? '');
  }
  return total;
}

/** The question asked before a draft is thrown away. */
export function discardQuestion(characters: number, subject?: string): string {
  const what = `${String(characters)} unsaved ${characters === 1 ? 'character' : 'characters'}`;
  return `Discard ${what}${subject === undefined ? '' : ` in ${subject}`}?`;
}

/**
 * An editor's guard on its own unsaved changes (INT-10). While there is a draft, closing the tab
 * asks; `allowClose()` is what the editor calls before it closes itself by Escape, by the scrim, or
 * by switching to another thing — true when there is nothing to lose or the person said discard.
 *
 * An explicit Cancel is the person saying discard, so it is not asked again.
 */
export function useDraftGuard(characters: number, subject?: string): () => boolean {
  useEffect(() => {
    if (characters === 0) return undefined;
    // `preventDefault` is the standard way to ask; no browser shows a page's own text any more.
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [characters]);

  return useCallback(
    () => characters === 0 || window.confirm(discardQuestion(characters, subject)),
    [characters, subject],
  );
}
