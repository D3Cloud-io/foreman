import { ApiError, foreman } from './api';
import { listJoin } from './groups';

/**
 * Undo, from the console (FRM-T-17.3): every audited write answers with the events it recorded,
 * and `POST /api/undo/:auditEventId` reverses one. This is the one place the console does that,
 * small on purpose so every screen can adopt it.
 *
 * An undo is not atomic — each event is its own request — so it never claims more than happened:
 * it tries every event, counts what was reversed, and says plainly when only part of it was.
 */

/**
 * The server's refusal for a renumbering a change caused: positions are dense, so it is reversed by
 * undoing the change itself, never on its own (`undoReorder` in the server's domain/groups.ts).
 */
const FOLLOWED_A_CHANGE = /renumbering followed a change/;

/** What an undo did: how many of the write's own events it reversed, and why the rest refused. */
export interface UndoReport {
  /** Events that counted — every one but the renumberings a change caused. */
  readonly total: number;
  readonly undone: number;
  /** The server's reason for each event it refused, or the error for one that never arrived. */
  readonly refused: readonly { readonly id: string; readonly message: string; readonly conflict: boolean }[];
}

/**
 * Reverse a write: its audit events undone last-first, as the server recorded them, each tried
 * even when one before it was refused — the rest are still worth putting back.
 *
 * A move or a create records the row's own event, then the renumberings it caused. Those answer
 * 409 "undo that change instead" — undoing the change settles the order around it — so they are
 * passed over and not counted.
 */
export async function undoAll(auditEventIds: readonly string[]): Promise<UndoReport> {
  let total = 0;
  let undone = 0;
  const refused: { id: string; message: string; conflict: boolean }[] = [];
  for (const id of [...auditEventIds].reverse()) {
    try {
      await foreman.undo(id);
      total += 1;
      undone += 1;
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409 && FOLLOWED_A_CHANGE.test(caught.message)) continue;
      total += 1;
      refused.push({
        id,
        message: caught instanceof Error ? caught.message : String(caught),
        conflict: caught instanceof ApiError && caught.status === 409,
      });
    }
  }
  return { total, undone, refused };
}

/**
 * Which of the things a write touched are back as they were, checked against the state after the
 * undo — so a partial undo can be told item by item ("U1 has changed since").
 */
export interface UndoCheck {
  readonly back: readonly string[];
  readonly notBack: readonly string[];
}

/** The sentence an undo ends with. `undone` is the success line; nothing here overstates. */
export function undoSummary(report: UndoReport, undone: string, check?: UndoCheck): string {
  if (report.refused.length === 0) return undone;
  const movedOn = report.refused.every((r) => r.conflict);
  const why = movedOn ? 'changed since' : 'not been undone';
  if (check !== undefined && check.notBack.length > 0) {
    const all = check.back.length + check.notBack.length;
    const verb = check.notBack.length === 1 ? 'has' : 'have';
    return check.back.length === 0
      ? `Not undone — ${listJoin(check.notBack)} ${verb} ${why}`
      : `Undid ${String(check.back.length)} of ${String(all)} — ${listJoin(check.notBack)} ${verb} ${why}`;
  }
  if (report.undone === 0) {
    return movedOn ? 'Not undone — something has changed since' : 'That was not undone';
  }
  return `Undid ${String(report.undone)} of ${String(report.total)} changes — the rest ${movedOn ? 'had changed since' : 'failed'}`;
}

/**
 * What a write that already happened hands to its toast (`useUndoToast` in `mutate.ts`, which turns
 * it into the one announcement every write uses).
 */
export interface Undoable {
  /** One line saying what just happened: "Moved KURO and BURR to Dormice". */
  readonly message: string;
  /** The events the write answered with. None means nothing to offer, and no Undo is shown. */
  readonly auditEventIds: readonly string[];
  /** What the toast says once it is undone: "Put KURO and BURR back". */
  readonly undone?: string;
  /** After a refused event, says which items are back — read from the state, not assumed. */
  readonly check?: () => Promise<UndoCheck>;
  /** Re-read in place after the undo, whether it worked or not. */
  readonly reload: () => void;
}
