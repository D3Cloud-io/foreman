import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InlineMarkdown } from './InlineMarkdown';

const html = (text: string | null | undefined) => renderToStaticMarkup(<InlineMarkdown>{text}</InlineMarkdown>);

/** FRM-T-18.11 / FRM-REQ-250: titles and cells render the markup that remains, never its marks. */
describe('InlineMarkdown', () => {
  it('renders emphasis and code as elements, with no literal markers left', () => {
    const out = html('**Asset** and `field_provenance`, _kept_ ~~old~~');
    expect(out).toContain('<strong>Asset</strong>');
    expect(out).toContain('<code>field_provenance</code>');
    expect(out).toContain('<em>kept</em>');
    expect(out).toContain('<del>old</del>');
    expect(out).not.toContain('**');
    expect(out).not.toContain('`');
  });

  it('renders nothing for empty input, so a cell stays a cell', () => {
    expect(html('')).toBe('');
    expect(html(null)).toBe('');
    expect(html(undefined)).toBe('');
  });

  it('shows raw HTML as text rather than parsing it', () => {
    const out = html('<script>alert(1)</script> and <img src=x onerror=alert(1)>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;');
  });

  it('keeps safe links and drops the href of an unsafe one, keeping its text', () => {
    const safe = html('[docs](https://example.com/a "Docs")');
    expect(safe).toContain('href="https://example.com/a"');
    expect(safe).toContain('rel="noreferrer noopener"');
    expect(html('[local](/projects/FRM)')).toContain('href="/projects/FRM"');

    const unsafe = html('[click](javascript:alert(1))');
    expect(unsafe).not.toContain('href');
    expect(unsafe).toContain('click');
  });

  it('refuses a link the browser would read as protocol-relative', () => {
    for (const href of ['//evil.com', '/\\evil.com', '\\\\evil.com', '/%09/evil.com', 'javascript:alert(1)']) {
      const out = html(`[x](<${href}>)`);
      expect(out, href).not.toMatch(/href="(\/\/|\/\\|\\|javascript)/);
    }
    // A literal tab or backslash inside the target never survives as a link.
    expect(html('[x](</a\\b>)')).not.toContain('href');
    expect(html('[x](</\t/evil.com>)')).not.toContain('href');
  });

  it('does not render block syntax in a cell', () => {
    const out = html('# not a heading\n- not a list');
    expect(out).not.toContain('<h1');
    expect(out).not.toContain('<ul');
    expect(out).toContain('# not a heading');
  });

  it('shows an image as its alt text', () => {
    expect(html('![the diagram](https://example.com/x.png)')).not.toContain('<img');
    expect(html('![the diagram](https://example.com/x.png)')).toContain('the diagram');
  });

  it('wraps in a span, so it can sit inside a heading or a table cell', () => {
    expect(html('x')).toBe('<span class="fm-inline-md">x</span>');
  });
});
