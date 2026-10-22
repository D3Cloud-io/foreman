import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PortfolioRow } from '../lib/api';
import { Ledger } from '../components/Ledger';
import { PortfolioStats } from './Home';

const COUNTS = {
  'coverage-hole': 0,
  'stale-task': 0,
  'fired-tripwire': 0,
  'failed-exit-gate': 0,
  'orphan-adr': 0,
  'screen-drift': 0,
} as const;

function row(code: string, over: Partial<PortfolioRow> = {}): PortfolioRow {
  return {
    code,
    name: code,
    lifecycle: 'building',
    phase: { humanId: `${code}-P-1`, number: '1', name: 'One' },
    tasks: { open: 1, blocked: 0, done: 1, cancelled: 0 },
    openCriticals: 0,
    ci: { conclusion: null, unknown: true },
    unconfirmedAttributions: 0,
    drift: { counts: { ...COUNTS }, total: 0 },
    lastActivityAt: null,
    group: null,
    ...over,
  };
}

const empty = { open: 0, blocked: 0, done: 0, cancelled: 0 };

describe('the portfolio figures (FRM-REQ-241)', () => {
  it('reads "1 of 8 reporting", never Green, while seven projects have never reported', () => {
    const rows = [
      row('FRM', { ci: { conclusion: 'success', unknown: false } }),
      ...['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((c) => row(c)),
    ];
    const html = renderToStaticMarkup(<PortfolioStats rows={rows} projectsDetail="" />);
    expect(html).toContain('CI · reporting');
    expect(html).toContain('1 of 8');
    expect(html).toContain('not measurable yet');
    expect(html).not.toContain('Green');
    expect(html).toContain('7 projects have never sent a CI result');
  });

  it('labels the figure "Critical + high" with its breakdown, and links it with the scope', () => {
    const html = renderToStaticMarkup(
      <PortfolioStats
        rows={[row('A', { openCriticals: 3 })]}
        projectsDetail=""
        scope="dormice"
        severities={{ critical: 1, high: 2, medium: 0, low: 0 }}
      />,
    );
    expect(html).toContain('Critical + high');
    expect(html).not.toContain('Open criticals');
    expect(html).toContain('1 critical · 2 high');
    expect(html).toContain('href="/findings?group=dormice"');
    expect(html).toContain('needs you');
  });

  it('is clean and neutral — "0 drift" is not green — when every project has a plan and nothing drifts', () => {
    const html = renderToStaticMarkup(<PortfolioStats rows={[row('A'), row('B')]} projectsDetail="" />);
    expect(html).toContain('Plan and reality agree');
    expect(html).not.toMatch(/--success|fm-stat__value--(success|accent)/);
  });

  it('does not call drift clean while a project has no plan', () => {
    const html = renderToStaticMarkup(
      <PortfolioStats rows={[row('A'), row('PW', { phase: null, tasks: empty })]} projectsDetail="" />,
    );
    expect(html).toContain('1 project has no plan yet, so drift is not measured there');
    expect(html).not.toContain('Plan and reality agree');
    // The figure is a dash, not a 0 beside "not measurable yet"; the code is said outside the card.
    expect(html).toMatch(/fm-stat__value fm-stat__value--muted">—<\/span>/);
    expect(html).toContain('No plan yet: PW');
    expect(html).not.toMatch(/<a[^>]*>(?:(?!<\/a>).)*PW(?:(?!<\/a>).)*<\/a>/);
  });

  it('shows Blocked tasks as a dash, not 0, while a project has no tasks, and does not say nothing is waiting', () => {
    const html = renderToStaticMarkup(
      <PortfolioStats rows={[row('A'), row('PW', { phase: null, tasks: empty })]} projectsDetail="" />,
    );
    expect(html).not.toContain('No task is waiting on another');
    expect(html).toContain('no tasks yet, so this is not measured there');
  });

  it('gives drift a breakdown by check and links it filtered', () => {
    const drifting = row('A', { drift: { counts: { ...COUNTS, 'coverage-hole': 2, 'stale-task': 1 }, total: 3 } });
    const html = renderToStaticMarkup(<PortfolioStats rows={[drifting]} projectsDetail="" />);
    expect(html).toContain('2 coverage holes');
    expect(html).toContain('1 stale tasks');
    expect(html).toContain('href="/drift"');
  });

  it('lists each chart series once: Cancelled appears once in the legend', () => {
    const rows = [row('A', { tasks: { open: 2, blocked: 1, done: 3, cancelled: 1 } })];
    const html = renderToStaticMarkup(<PortfolioStats rows={rows} projectsDetail="" />);
    const legend = html.slice(html.indexOf('fm-legend'));
    expect(legend.match(/Cancelled/g)).toHaveLength(1);
    expect(html).toContain('4 of 7');
  });
});

describe('a ledger row', () => {
  it('says what CI said in words, and says drift is not measurable for a project with no plan', () => {
    const html = renderToStaticMarkup(<Ledger rows={[row('PW', { phase: null, tasks: empty })]} />);
    expect(html).toContain('never');
    expect(html).toContain('drift not measurable yet');
    expect(html).toContain('No plan yet');
  });
});
