import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PhaseCard, splitPhases } from './Phases';
import { Donut } from '../ui/viz';
import { SERIES } from '../ui/tone';

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

/** FRM-T-18.16: the open work leads; finished phases are one row each. */
describe('the phases split', () => {
  const row = (number: string, status: string) => ({ phase: { number, status } });

  it('puts active phases first, then parked and planned in build order, and closes the rest', () => {
    const { open, closed } = splitPhases([
      row('0', 'complete'),
      row('12', 'planned'),
      row('14', 'active'),
      row('13', 'parked'),
      row('15', 'cancelled'),
    ]);
    expect(open.map((r) => r.phase.number)).toEqual(['14', '12', '13']);
    expect(closed.map((r) => r.phase.number)).toEqual(['0', '15']);
  });

  it('leaves the build order alone inside a band', () => {
    const { open } = splitPhases([row('3', 'planned'), row('1', 'active'), row('2', 'planned'), row('4', 'active')]);
    expect(open.map((r) => r.phase.number)).toEqual(['1', '4', '3', '2']);
  });
});

describe('the ring', () => {
  it('draws done work in the accent, never the success token', () => {
    expect(SERIES.done).toBe('var(--color-accent)');
    expect(Object.values(SERIES).join(' ')).not.toContain('success');
  });

  it('uses the small figure on a small ring, so 100% fits inside it', () => {
    const small = renderToStaticMarkup(<Donut size={72} segments={[{ label: 'Done', value: 1, color: SERIES.done }]} label="100%" />);
    const large = renderToStaticMarkup(<Donut size={104} segments={[{ label: 'Done', value: 1, color: SERIES.done }]} label="100%" />);
    expect(small).toContain('fm-donut__label--sm');
    expect(large).not.toContain('fm-donut__label--sm');
  });
});
