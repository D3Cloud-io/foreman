import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SHORTCUTS } from '../lib/shortcuts';
import { ShortcutList } from './ShortcutSheet';

/** FRM-T-18.5: the `?` sheet is the shortcut list, drawn with the design system's key caps. */
describe('the shortcut sheet', () => {
  const html = renderToStaticMarkup(<ShortcutList />);

  it('draws every key as a d3-kbd cap, readable by a screen reader', () => {
    const caps = html.match(/<kbd class="d3-kbd">/g) ?? [];
    expect(caps.length).toBe(SHORTCUTS.flatMap((g) => g.rows.flatMap((r) => r.keys)).length);
    expect(html).not.toContain('aria-hidden');
  });

  it('names what each key does, in labelled groups', () => {
    expect(html).toContain('Open the command palette');
    expect(html).toContain('Show this sheet');
    expect(html).toContain('aria-label="Anywhere"');
    expect(html).toContain('<kbd class="d3-kbd">?</kbd>');
  });
});
