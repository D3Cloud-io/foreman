import { useEffect, useState, type ReactNode } from 'react';
import { Select, Spinner } from '@d3cloud/ui';
import { useMutate } from '../lib/mutate';
import './PropertyRail.css';
// The pending control's styles live with the rest of the undo flow's.
import './HistoryDrawer.css';

/**
 * A record's properties, edited where they are read (FRM-REQ-247, board D-08).
 *
 * A task's status, size and phase, a requirement's priority and phase: each is a select in the rail
 * beside the record, not a field behind an Edit dialog. Every change goes through `useMutate`, so it
 * is **pessimistic and in place** (FRM-T-18.4) — the select shows the value asked for, dimmed, beside
 * a spinner while the server has it, and only the server's answer changes the record — and a toast
 * names the change with Undo. One write at a time: a second choice made while the first is with the
 * server is refused in the toast, not sent twice.
 */

export interface RailOption {
  readonly value: string;
  readonly label: string;
}

/** What a write answers with: the events that undo it. */
export interface RailAnswer {
  readonly auditEventIds: readonly string[];
}

/** One write, as the rail runs it. */
export interface RailWrite {
  readonly run: () => Promise<RailAnswer>;
  /**
   * One line saying what happened: "BND-T-9.4 moved to P-9". What rolled up because of it is named
   * after it by `useMutate`, from the answer.
   */
  readonly message: () => string;
  /** What the toast says once it is undone. */
  readonly undone: string;
}

export type RailRow =
  | {
      readonly kind: 'select';
      readonly key: string;
      readonly label: string;
      readonly value: string;
      readonly options: readonly RailOption[];
      readonly ariaLabel: string;
      /** The write for a chosen value, or null to leave it as it was. */
      readonly write: (next: string) => RailWrite | null;
    }
  /** An editor of its own — the status control, which has its own queue and its own prompt. */
  | { readonly kind: 'node'; readonly key: string; readonly label: string; readonly children: ReactNode }
  /** A fact, not a control. */
  | { readonly kind: 'text'; readonly key: string; readonly label: string; readonly children: ReactNode };

export function PropertyRail({
  subject,
  rows,
  onChanged,
}: {
  /** What the record is called in a refusal: "BND-T-9.4". */
  subject: string;
  rows: readonly RailRow[];
  /** The write landed, or an undo of it did: read the record again, in place. */
  onChanged: () => void;
}) {
  const { mutate, pending } = useMutate();
  // The row being written, and the value asked for — shown until the server answers.
  const [asked, setAsked] = useState<{ key: string; value: string } | null>(null);
  // What the server answered, held until the screen's re-read brings it back as the row's value, so
  // a select never flicks back to the old option between the answer and the refresh.
  const [held, setHeld] = useState<{ key: string; value: string } | null>(null);

  const heldRow = held === null ? undefined : rows.find((row) => row.key === held.key);
  const heldFrom = heldRow?.kind === 'select' ? heldRow.value : null;
  useEffect(() => {
    setHeld(null);
  }, [heldFrom]);

  const choose = (row: Extract<RailRow, { kind: 'select' }>, next: string) => {
    if (next === row.value) return;
    const write = row.write(next);
    if (write === null) return;
    setAsked({ key: row.key, value: next });
    void mutate({
      subject,
      run: write.run,
      message: write.message,
      undone: write.undone,
      refresh: onChanged,
      onUndone: () => {
        setHeld(null);
        onChanged();
      },
    }).then((outcome) => {
      setAsked(null);
      if (outcome.ok) setHeld({ key: row.key, value: next });
    });
  };

  return (
    <aside className="fm-rail" aria-label="Properties">
      <dl className="fm-rail__list">
        {rows.map((row) => (
          <div key={row.key} className="fm-rail__row">
            <dt className="fm-rail__label">{row.label}</dt>
            <dd className="fm-rail__value">
              {row.kind === 'select' ? (
                <span
                  className={
                    pending && asked?.key === row.key
                      ? 'fm-status-control fm-status-control--pending'
                      : 'fm-status-control'
                  }
                  aria-busy={pending && asked?.key === row.key}
                >
                  <Select
                    options={[...row.options]}
                    value={
                      asked?.key === row.key ? asked.value : held?.key === row.key ? held.value : row.value
                    }
                    onValueChange={(next) => {
                      choose(row, next);
                    }}
                    size="sm"
                    aria-label={row.ariaLabel}
                  />
                  {pending && asked?.key === row.key ? (
                    <Spinner size="sm" label={`Saving ${row.label.toLowerCase()}`} />
                  ) : null}
                </span>
              ) : (
                row.children
              )}
            </dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
