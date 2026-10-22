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

  it('shows the server status word for word, neutral for complete, never green', () => {
    const complete = renderToStaticMarkup(
      <PhaseCard counted={{ phase: { ...phase, status: 'complete' }, done: 8, cancelled: 0, total: 8 }} code="BND" />,
    );
    expect(complete).toContain('>complete<');
    expect(complete).toContain('d3-bdg--neutral');
    expect(complete).not.toContain('success');
  });

  it('shows a neutral "no exit demo" chip linking to drift, and none when there is one', () => {
    const without = renderToStaticMarkup(
      <PhaseCard counted={{ phase: { ...phase, exitDemo: null }, done: 1, cancelled: 0, total: 2 }} code="BND" />,
    );
    expect(without).toContain('no exit demo');
    expect(without).toContain('href="/projects/BND/drift"');
    expect(without).not.toContain('d3-bdg--warning');

    const withDemo = renderToStaticMarkup(
      <PhaseCard counted={{ phase, done: 1, cancelled: 0, total: 2 }} code="BND" />,
    );
    expect(withDemo).not.toContain('no exit demo');
  });
});
