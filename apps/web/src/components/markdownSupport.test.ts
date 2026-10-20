import { describe, expect, it } from 'vitest';
import { mermaidThemeVariables, wrapTables } from './markdownSupport';

describe('wrapTables', () => {
  const table = '<table><thead><tr><th>Risk</th><th>Tripwire</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>';

  it('puts a table in a focusable, named, horizontally scrolling region', () => {
    const out = wrapTables(`<p>before</p>${table}<p>after</p>`);
    expect(out).toContain('class="fm-table-scroll"');
    expect(out).toContain('tabindex="0"');
    expect(out).toContain('role="region"');
    expect(out).toContain('aria-label="Table: Risk, Tripwire"');
    expect(out).toContain('overflow-x:auto');
    expect(out).toContain(`${table}</div><p>after</p>`);
  });

  it('wraps each of several tables, and leaves text without one alone', () => {
    expect(wrapTables(table + table).match(/fm-table-scroll/g)).toHaveLength(2);
    expect(wrapTables('<p>no table</p>')).toBe('<p>no table</p>');
  });

  it('escapes quotes in a heading, and names a headingless table plainly', () => {
    expect(wrapTables('<table><tr><th>say "hi"</th></tr></table>')).toContain('aria-label="Table: say &quot;hi&quot;"');
    expect(wrapTables('<table><tr><td>x</td></tr></table>')).toContain('aria-label="Table"');
  });
});

describe('mermaidThemeVariables', () => {
  const light: Record<string, string> = {
    '--color-fg': ' #101117 ',
    '--color-fg-muted': '#2c303b',
    '--color-accent-muted': '#f0f0ff',
    '--color-surface': '#f9fafd',
  };

  it('reads every colour from the console tokens, trimmed', () => {
    const v = mermaidThemeVariables((token) => light[token] ?? '', false);
    expect(v.textColor).toBe('#101117');
    expect(v.lineColor).toBe('#2c303b');
    expect(v.primaryColor).toBe('#f0f0ff');
    expect(v.edgeLabelBackground).toBe('#f9fafd');
    expect(v.darkMode).toBe(false);
  });

  it('follows the theme: the same names, other values, darkMode on', () => {
    const dark: Record<string, string> = { '--color-fg': '#f0f2f7', '--color-fg-muted': '#b9bdcb' };
    const v = mermaidThemeVariables((token) => dark[token] ?? '', true);
    expect(v.textColor).toBe('#f0f2f7');
    expect(v.lineColor).toBe('#b9bdcb');
    expect(v.darkMode).toBe(true);
  });

  it('leaves out a token the page does not define rather than passing an empty colour', () => {
    const v = mermaidThemeVariables(() => '', false);
    expect(v).toEqual({ darkMode: false, fontFamily: 'inherit' });
  });
});
