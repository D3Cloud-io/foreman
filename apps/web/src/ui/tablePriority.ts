import { createElement, Fragment, useSyncExternalStore, type ReactNode } from 'react';
import type { TableColumn, TableColumnWidth } from '@d3cloud/ui';

/**
 * Column priority for a table on a phone (FRM-REQ-249, FRM-DA-010).
 *
 * Below `md` (768px) a table of five or six columns has nowhere to put them: the library's `Table`
 * scrolls the surplus sideways, and the Status select or the Satisfies column ends up off-screen.
 * The library's own list mode is filed for `@d3cloud/ui` (DS-REQ-031); until it ships, each of
 * Foreman's tables says which of its columns matter on a phone and the rest fold into a sub-line
 * under the title:
 *
 * - `host` — the title column. It stays, grows a sub-line of everything folded, and may draw
 *   itself differently on a phone with `phoneCell` (the title as the row's link, say).
 * - `keep` — status and the primary control. Stays as its own column (the default).
 * - `fold` — moves into the host's sub-line as "Label value", skipped when it has nothing to show.
 * - `hide` — dropped on a phone because the host already says it.
 *
 * Wide screens get the columns exactly as written, minus the extra fields here.
 */

export type PhonePriority = 'host' | 'keep' | 'fold' | 'hide';

export interface PriorityColumn<Row> extends TableColumn<Row> {
  /** What the column does below 768px. Defaults to `keep`. */
  phone?: PhonePriority;
  /** The cell on a phone, for a `host` or `keep` column that reads differently there. */
  phoneCell?: (row: Row, index: number) => ReactNode;
  /** The word before a folded value. Defaults to the header when that is text; `''` for none. */
  foldLabel?: string;
  /** A folded column's value, when its cell holds a control that should not repeat in the sub-line. */
  foldCell?: (row: Row, index: number) => ReactNode;
  /** The column's width on a phone, where the desktop one is too wide for 390. */
  phoneWidth?: TableColumnWidth;
}

/** The line `md` draws in the design system, and the console's own breakpoint for tables. */
export const PHONE_QUERY = '(max-width: 767.98px)';

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

/** True below 768px, and re-read when the window crosses it. */
export function usePhone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}

/** Nothing to show: not a value worth a "Label" in front of it. */
function isEmpty(node: ReactNode): boolean {
  return node === null || node === undefined || node === false || node === '';
}

/** The folded values of one row, as a sub-line. */
function subline<Row>(folded: readonly PriorityColumn<Row>[], row: Row, index: number): ReactNode {
  const items = folded
    .map((column) => ({
      column,
      content: (column.foldCell ?? column.cell)?.(row, index) ?? null,
    }))
    .filter((item) => !isEmpty(item.content));
  if (items.length === 0) return null;
  return createElement(
    'div',
    { className: 'fm-subline' },
    items.map(({ column, content }) => {
      const label = column.foldLabel ?? (typeof column.header === 'string' ? column.header : '');
      return createElement(
        'span',
        { key: column.key, className: 'fm-subline__item' },
        label === '' ? null : createElement('span', { className: 'fm-subline__key' }, label),
        content,
      );
    }),
  );
}

/** The plain `TableColumn` a priority column is, without the phone-only fields. */
function plain<Row>(column: PriorityColumn<Row>): TableColumn<Row> {
  return {
    key: column.key,
    header: column.header,
    ...(column.cell === undefined ? {} : { cell: column.cell }),
    ...(column.sortable === undefined ? {} : { sortable: column.sortable }),
    ...(column.align === undefined ? {} : { align: column.align }),
    ...(column.width === undefined ? {} : { width: column.width }),
    ...(column.numeric === undefined ? {} : { numeric: column.numeric }),
  };
}

/**
 * The columns to give `Table`. On a wide screen they are the ones written; on a phone, the host
 * keeps its title and carries the sub-line, `keep` columns stay, `fold` columns move into the
 * sub-line and `hide` columns go. With no `host` the first kept column is the host.
 */
export function priorityColumns<Row>(
  columns: readonly PriorityColumn<Row>[],
  narrow: boolean,
): TableColumn<Row>[] {
  if (!narrow) return columns.map(plain);

  const kept = columns.filter((column) => column.phone !== 'fold' && column.phone !== 'hide');
  const folded = columns.filter((column) => column.phone === 'fold');
  const host = kept.find((column) => column.phone === 'host') ?? kept[0];

  return kept.map((column) => {
    const base = plain(column);
    const phoneCell = column.phoneCell ?? column.cell;
    const width = column.phoneWidth ?? (column === host ? 'auto' : column.width);
    const sized = width === undefined ? base : { ...base, width };
    if (column !== host) {
      return phoneCell === undefined ? sized : { ...sized, cell: phoneCell };
    }
    return {
      ...sized,
      cell: (row: Row, index: number) =>
        createElement(
          Fragment,
          null,
          phoneCell === undefined ? null : phoneCell(row, index),
          subline(folded, row, index),
        ),
    };
  });
}
