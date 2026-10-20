import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PhaseCard } from './Phases';

/** FRM-DA-003: Bindery's Phase 9 is 8 of 12 on Phases, as on the overview. */
describe('a phase card', () => {
  const phase = {
    id: 'p9',
    humanId: 'BND-P-9',
    number: '9',
    sortOrder: 9,
    name: 'Ingest',
    objective: null,
    status: 'active',
    exitDemo: 'Demo',
    size: null,
  };

  it('draws the counts it is given, from the server, and never "No tasks" for a populated phase', () => {
    const html = renderToStaticMarkup(
      <PhaseCard counted={{ phase, done: 8, cancelled: 0, total: 12 }} code="BND" />,
    );
    expect(html).toContain('8 of 12 done');
    expect(html).not.toContain('No tasks');
  });

  it('says "No tasks" only for a phase the server counted as empty', () => {
    const html = renderToStaticMarkup(
      <PhaseCard counted={{ phase, done: 0, cancelled: 0, total: 0 }} code="BND" />,
    );
    expect(html).toContain('No tasks');
  });
});
