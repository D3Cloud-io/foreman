import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { priorityColumns, type PriorityColumn } from './tablePriority';

interface Row {
  id: string;
  title: string;
  status: string;
  size: string | null;
}

const COLUMNS: PriorityColumn<Row>[] = [
  { key: 'id', header: 'ID', width: '9rem', phone: 'fold', foldLabel: '', cell: (r) => r.id },
  { key: 'title', header: 'Task', phone: 'host', phoneCell: (r) => <a href={`/t/${r.id}`}>{r.title}</a>, cell: (r) => r.title },
  { key: 'status', header: 'Status', width: '11rem', phoneWidth: '8.5rem', cell: (r) => r.status },
  { key: 'size', header: 'Size', width: '5rem', phone: 'fold', cell: (r) => r.size },
  { key: 'gone', header: 'Gone', phone: 'hide', cell: () => 'x' },
];
const ROW: Row = { id: 'T-1', title: 'Do it', status: 'done', size: 'M' };

describe('column priority', () => {
  it('leaves a wide screen with every column, as written', () => {
    const columns = priorityColumns(COLUMNS, false);
    expect(columns.map((c) => c.key)).toEqual(['id', 'title', 'status', 'size', 'gone']);
    expect(columns[0]).not.toHaveProperty('phone');
  });

  it('keeps the title and status on a phone, and folds the rest under the title', () => {
    const columns = priorityColumns(COLUMNS, true);
    expect(columns.map((c) => c.key)).toEqual(['title', 'status']);
    expect(columns[1]?.width).toBe('8.5rem');
    const html = renderToStaticMarkup(<>{columns[0]?.cell?.(ROW, 0)}</>);
    expect(html).toContain('<a href="/t/T-1">Do it</a>');
    expect(html).toContain('class="fm-subline"');
    expect(html).toContain('T-1');
    expect(html).toContain('<span class="fm-subline__key">Size</span>M');
  });

  it('skips a folded value with nothing to show rather than printing a label over a blank', () => {
    const html = renderToStaticMarkup(<>{priorityColumns(COLUMNS, true)[0]?.cell?.({ ...ROW, size: null }, 0)}</>);
    expect(html).not.toContain('Size');
  });
});
