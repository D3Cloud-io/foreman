import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CLEAN, NOT_MEASURABLE, needsYou } from './status';
import { SERIES } from './tone';
import { Legend, Pill, SegmentBar, StatCard } from './viz';

describe('a stat card', () => {
  it('shows the word beside the figure, and a not-measurable figure muted', () => {
    const html = renderToStaticMarkup(<StatCard label="Drift" value="—" signal={NOT_MEASURABLE} />);
    expect(html).toContain('not measurable yet');
    expect(html).toContain('fm-stat__value--muted');
  });

  it('inks a figure only when it needs you', () => {
    expect(renderToStaticMarkup(<StatCard label="x" value={3} signal={needsYou('danger')} />)).toContain('fm-stat__value--danger');
    const clean = renderToStaticMarkup(<StatCard label="x" value={0} signal={CLEAN} />);
    expect(clean).toContain('clean');
    expect(clean).not.toMatch(/fm-stat__value--(danger|warning|success|accent|muted)/);
  });

  it('names where it goes when it is a link', () => {
    const html = renderToStaticMarkup(<StatCard label="x" value={3} href="/findings" action="Open 3 findings" />);
    expect(html).toContain('href="/findings"');
    expect(html).toContain('Open 3 findings');
  });

  it('never paints success or accent', () => {
    expect(renderToStaticMarkup(<StatCard label="x" value={0} tone="success" />)).not.toContain('success');
    expect(renderToStaticMarkup(<StatCard label="x" value={0} tone="accent" />)).not.toContain('accent');
  });
});

describe('the legacy pill', () => {
  it('is a Badge now, and success renders neutral', () => {
    const html = renderToStaticMarkup(<Pill tone="success">confirmed</Pill>);
    expect(html).toContain('d3-bdg--neutral');
    expect(html).not.toContain('success');
  });
});

describe('chart legends', () => {
  it('names each series once, so a repeated Cancelled is one entry with the counts added', () => {
    const html = renderToStaticMarkup(
      <Legend
        segments={[
          { label: 'Done', value: 3, color: SERIES.done },
          { label: 'Cancelled', value: 1, color: SERIES.quiet },
          { label: 'Cancelled', value: 1, color: SERIES.quiet },
        ]}
      />,
    );
    expect(html.match(/Cancelled/g)).toHaveLength(1);
    expect(html).toContain('>2<');
  });

  it('puts every segment of a bar into text', () => {
    const html = renderToStaticMarkup(
      <SegmentBar segments={[{ label: 'Done', value: 2, color: SERIES.done }, { label: 'Open', value: 1, color: SERIES.active }]} />,
    );
    expect(html).toContain('Done');
    expect(html).toContain('Open');
    expect(html).toContain('aria-label="Done: 2, Open: 1"');
  });

  it('gives Cancelled a colour that is not the track and no series the success token', () => {
    expect(SERIES.quiet).not.toBe('var(--color-border)');
    for (const colour of Object.values(SERIES)) expect(colour).not.toContain('success');
  });
});
