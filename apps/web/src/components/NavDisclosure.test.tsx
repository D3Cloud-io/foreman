import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NavDisclosure } from './NavDisclosure';

/** FRM-T-16.4: the Library and Knowledge rows, until SideNavGroup can fold (DS-REQ-026). */
describe('a sidebar disclosure', () => {
  it('is a button that says whether its list is open, and controls it', () => {
    const html = renderToStaticMarkup(
      <NavDisclosure name="library" label="Library" icon={null} holdsCurrent={false}>
        <li>row</li>
      </NavDisclosure>,
    );
    expect(html).toMatch(/<button type="button"[^>]*aria-expanded="false"/);
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(controls).toBeDefined();
    expect(html).toContain(`id="${controls ?? ''}"`);
    // Closed means out of the tab order and the accessibility tree, not just out of sight.
    expect(html).toMatch(/<ul[^>]*hidden=""/);
  });

  it('opens itself when it holds the page on screen', () => {
    const html = renderToStaticMarkup(
      <NavDisclosure name="knowledge" label="Knowledge" icon={null} holdsCurrent>
        <li>row</li>
      </NavDisclosure>,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain('hidden=""');
  });
});
