import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PropertyRail } from './PropertyRail';

// useMutate reads the design system's toast, which needs its provider; a static render has none.
vi.mock('../lib/mutate', () => ({
  useMutate: () => ({ mutate: () => Promise.resolve({ ok: true }), pending: false }),
}));

/** FRM-T-18.8: a record's properties are controls beside it, not fields behind a dialog. */
describe('the property rail', () => {
  it('draws a labelled select for each editable property and plain text for facts', () => {
    const html = renderToStaticMarkup(
      <PropertyRail
        subject="BND-REQ-001"
        onChanged={() => undefined}
        rows={[
          {
            kind: 'select',
            key: 'priority',
            label: 'Priority',
            ariaLabel: 'Priority of BND-REQ-001',
            value: 'M',
            options: [
              { value: 'M', label: 'Must' },
              { value: 'S', label: 'Should' },
            ],
            write: () => null,
          },
          { kind: 'text', key: 'project', label: 'Project', children: 'BND' },
        ]}
      />,
    );
    expect(html).toContain('aria-label="Properties"');
    expect(html).toContain('Priority');
    expect(html).toContain('Priority of BND-REQ-001');
    expect(html).toContain('Project');
    expect(html).toContain('BND');
  });
});
