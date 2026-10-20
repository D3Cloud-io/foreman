import { useToast } from '@d3cloud/ui';
import { ApiError, foreman } from './api';

/**
 * Undo, from the console (FRM-T-17.3): every audited write answers with the events it recorded,
 * and `POST /api/undo/:auditEventId` reverses one. This is the one place the console does that,
 * small on purpose so every screen can adopt it.
 */

/**
 * The server's refusal for a renumbering a change caused: positions are dense, so it is reversed by
 * undoing the change itself, never on its own (`undoReorder` in the server's domain/groups.ts).
 */
const FOLLOWED_A_CHANGE = /renumbering followed a change/;

/**
 * Reverse a write: its audit events undone last-first, as the server recorded them.
 *
 * A move or a create records the row's own event, then the renumberings it caused. Those answer
 * 409 "undo that change instead" — undoing the change settles the order around it — so that one
 * refusal is passed over; any other refusal still fails the undo.
 */
export async function undoAll(auditEventIds: readonly string[]): Promise<void> {
  for (const id of [...auditEventIds].reverse()) {
    try {
      await foreman.undo(id);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409 && FOLLOWED_A_CHANGE.test(caught.message)) continue;
      throw caught;
    }
  }
}

/** Why an undo did not happen, in words: a 409 means the ledger has moved on since the write. */
export function undoFailure(caught: unknown): string {
  return caught instanceof ApiError && caught.status === 409
    ? 'Not undone — something has changed since'
    : 'That was not undone';
}

export interface Undoable {
  /** One line saying what just happened: "Moved KURO and BURR to Dormice". */
  readonly message: string;
  /** The events the write answered with. None means nothing to offer, and no Undo is shown. */
  readonly auditEventIds: readonly string[];
  /** What the toast says once it is undone: "Put KURO and BURR back". */
  readonly undone?: string;
  /** Re-read in place after the undo, whether it worked or not. */
  readonly reload: () => void;
}

/**
 * A toast saying what just happened, with Undo (`@d3cloud/ui` Toast through `ToastRegion`). Undo
 * reverses the write's events last-first, then says that it did — or, on a 409, that the state has
 * moved on — and reloads the screen in place.
 */
export function useUndoToast(): (undoable: Undoable) => void {
  const toast = useToast();
  return ({ message, auditEventIds, undone = 'Undone', reload }) => {
    toast.show({
      message,
      ...(auditEventIds.length === 0
        ? {}
        : {
            action: {
              label: 'Undo',
              onAction: () => {
                void undoAll(auditEventIds)
                  .then(() => {
                    toast.show({ message: undone });
                  })
                  .catch((caught: unknown) => {
                    toast.show({ message: undoFailure(caught) });
                  })
                  .finally(reload);
              },
            },
          }),
    });
  };
}
