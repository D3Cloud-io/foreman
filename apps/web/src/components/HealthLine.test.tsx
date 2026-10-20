import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HealthLine, problemsIn } from './HealthLine';

/** FRM-T-16.4: the footer's health line, on every screen, so it may never be what breaks one. */
describe('the health line', () => {
  it('holds its place, saying nothing, until the report arrives', () => {
    const html = renderToStaticMarkup(<HealthLine health={null} />);
    expect(html).toContain('fm-health--pending');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('href');
  });

  it('reads a malformed report as something to look at, rather than throwing', () => {
    expect(problemsIn({})).toEqual(['The health report could not be read.']);
    expect(problemsIn({ problems: 'nope' })).toEqual(['The health report could not be read.']);
    expect(problemsIn(null)).toEqual(['The health report could not be read.']);
    expect(problemsIn('error')).toEqual(['The health report did not load.']);
    expect(problemsIn({ problems: ['One job failed.', 3] })).toEqual(['One job failed.']);
    expect(() => renderToStaticMarkup(<HealthLine health={{} as never} />)).not.toThrow();
  });

  it('is quiet when healthy, and says how many and the first when not', () => {
    expect(renderToStaticMarkup(<HealthLine health={{ problems: [] } as never} />)).toContain('Foreman healthy');
    const html = renderToStaticMarkup(<HealthLine health={{ problems: ['One job failed.'] } as never} />);
    expect(html).toContain('Health · 1 to look at');
    expect(html).toContain('One job failed.');
  });
});
