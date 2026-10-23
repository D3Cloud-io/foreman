import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PortfolioRow } from '../lib/api';
import { formatDate } from '../lib/text';
import { ciWordOf, Ledger, needsYouOf, NeedsYouStrip, reasonsOf, StatStrip } from './Ledger';

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
    name: `${code} project`,
    lifecycle: 'building',
    phase: { humanId: `${code}-P-2`, number: '2', name: 'Ingest' },
    tasks: { open: 2, blocked: 0, done: 3, cancelled: 1 },
    openCriticals: 0,
    ci: { conclusion: 'success', unknown: false },
    ciState: 'passing',
    nextTask: { humanId: `${code}-T-2.4`, title: 'Verify the signature' },
    deployed: null,
    unconfirmedAttributions: 0,
    drift: { counts: { ...COUNTS }, total: 0 },
    lastActivityAt: null,
    group: null,
    ...over,
  };
}

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('a ledger row (FRM-REQ-245)', () => {
  it('shows project, phase with progress, next task, drift, needs-you and CI', () => {
    const out = html(<Ledger rows={[row('AAA', { drift: { counts: { ...COUNTS, 'stale-task': 2 }, total: 2 } })]} />);
    expect(out).toContain('AAA');
    expect(out).toContain('building');
    expect(out).toContain('P-2 · Ingest');
    expect(out).toContain('4 of 6 tasks');
    expect(out).toContain('AAA-T-2.4');
    expect(out).toContain('href="/tasks/AAA-T-2.4"');
    expect(out).toContain('href="/projects/AAA/drift"');
    expect(out).toContain('passing');
  });

  it('says "never" for a project nothing was ingested for — not passing, not blank', () => {
    const out = html(
      <Ledger rows={[row('AAA', { ci: { conclusion: null, unknown: true }, ciState: 'never' })]} />,
    );
    expect(out).toContain('never');
    expect(out).not.toContain('passing');
  });

  it('keeps deployed-vs-main and last activity in a disclosure, not in columns', () => {
    const out = html(
      <Ledger
        rows={[
          row('AAA', {
            deployed: { sha: 'abcdef1234', at: new Date().toISOString(), ahead: 3 },
            lastActivityAt: '2026-10-01T10:00:00.000Z',
          }),
        ]}
      />,
    );
    // A disclosure button that says whether it is open, controlling a hidden region.
    expect(out).toMatch(/aria-expanded="false"[^>]*aria-controls="([^"]+)"|aria-controls="([^"]+)"[^>]*aria-expanded="false"/);
    expect(out).toMatch(/class="fm-lrow__more"[^>]*hidden/);
    expect(out).toContain('Deployed vs main');
    expect(out).toContain('abcdef1 deployed today; main is 3 commits ahead.');
    expect(out).toContain('Last activity');
    expect(out).toContain(formatDate('2026-10-01T10:00:00.000Z'));
  });

  it('says so when the deployed SHA is not a known commit, and when nothing was ever deployed', () => {
    const unknown = html(
      <Ledger rows={[row('AAA', { deployed: { sha: 'abcdef1234', at: new Date().toISOString(), ahead: null } })]} />,
    );
    expect(unknown).toContain('is unknown, because that SHA is not a commit Foreman has seen');
    expect(html(<Ledger rows={[row('AAA')]} />)).toContain('Never recorded as deployed.');
  });

  it('states a project with no plan as not measurable, with a dash for drift rather than a clean 0', () => {
    const out = html(<Ledger rows={[row('PW', { phase: null, tasks: { open: 0, blocked: 0, done: 0, cancelled: 0 }, nextTask: null })]} />);
    expect(out).toContain('No plan yet');
    expect(out).toContain('drift not measurable yet');
    // The drift cell is a dash, not a link to a zero.
    expect(out).not.toMatch(/fm-lrow__drift"><a/);
  });

  it('reads a run that neither passed nor failed as what it was, not as a pass', () => {
    const out = html(
      <Ledger rows={[row('AAA', { ci: { conclusion: 'cancelled', unknown: false }, ciState: 'other' })]} />,
    );
    expect(out).toContain('cancelled');
    expect(out).not.toContain('passing');
    expect(ciWordOf(row('A', { ciState: 'other' }))).toBe('other');
    // And a row that predates ciState reads the same way from `ci`.
    const old = { ...row('A'), ci: { conclusion: 'action_required', unknown: false } } as PortfolioRow;
    delete (old as { ciState?: unknown }).ciState;
    expect(ciWordOf(old)).toBe('other');
  });

  it('gives a phone row ONE chip, the most urgent, and names the rest as text', () => {
    const out = html(
      <Ledger
        rows={[
          row('AAA', {
            openCriticals: 1,
            tasks: { open: 1, blocked: 2, done: 0, cancelled: 0 },
            unconfirmedAttributions: 3,
          }),
        ]}
      />,
    );
    expect(out).toContain('fm-reasons--compact');
    expect(out).toContain('+2 more');
    // The most urgent is first; CSS shows only it on a phone.
    expect(out.indexOf('1 critical + high')).toBeLessThan(out.indexOf('2 blocked'));
    expect(out.indexOf('2 blocked')).toBeLessThan(out.indexOf('3 to review'));
  });

  it('draws progress in its own bar, never in green', () => {
    const out = html(<Ledger rows={[row('AAA')]} />);
    // Its own class: a shared .fm-bar shrank every SegmentBar in the console (FRM-T-18.16).
    expect(out).toContain('fm-lbar__fill');
    expect(out).not.toContain('class="fm-bar"');
    expect(out).not.toMatch(/success|green/i);
  });
});

describe('what needs you', () => {
  it('collects critical + high, blocked, failing CI and review waiting, across groups', () => {
    const rows = [
      row('CLEAN'),
      row('CRIT', { openCriticals: 2 }),
      row('BLK', { tasks: { open: 1, blocked: 2, done: 0, cancelled: 0 } }),
      row('FAIL', { ciState: 'failing', ci: { conclusion: 'failure', unknown: false } }),
      row('REV', { unconfirmedAttributions: 4 }),
    ];
    const items = needsYouOf(rows);
    expect(items.map((i) => i.row.code).sort()).toEqual(['BLK', 'CRIT', 'FAIL', 'REV']);
    // The loud ones (danger) first; review waiting is a warning.
    expect(items.at(-1)?.row.code).toBe('REV');
    expect(reasonsOf(rows[1] as PortfolioRow, false).map((r) => r.label)).toEqual(['2 critical + high']);
    // A never-reported CI is not "failing": it is not asked yet.
    expect(needsYouOf([row('N', { ciState: 'never', ci: { conclusion: null, unknown: true } })])).toEqual([]);
  });

  it('is one strip, not one per group, and never names Critical + high with a capital in a link', () => {
    const out = html(<NeedsYouStrip rows={[row('CRIT', { openCriticals: 1, group: { humanId: 'GRP-1', name: 'Dormice', slug: 'dormice', accent: 'bindery' } })]} />);
    expect(out.match(/<h2/g)).toHaveLength(1);
    expect(out).toContain('Needs you');
    expect(out).toContain('Dormice');
    expect(out).toContain('1 critical + high');
    expect(out).not.toContain('Critical + high');
    expect(out).toContain('href="/findings?group=dormice"');
  });

  it('says nothing needs you only over what is measured, and names what is not', () => {
    const out = html(
      <NeedsYouStrip rows={[row('A', { ciState: 'never', ci: { conclusion: null, unknown: true } })]} />,
    );
    expect(out).toContain('Nothing in what is measured');
    expect(out).toContain('CI is not reported for 1');
  });

  it('serves the CI word from the row, and falls back to ci for a row that predates it', () => {
    expect(ciWordOf(row('A', { ciState: 'failing' }))).toBe('failing');
    const old = { ...row('A'), ci: { conclusion: 'failure', unknown: false } } as PortfolioRow;
    delete (old as { ciState?: unknown }).ciState;
    expect(ciWordOf(old)).toBe('failing');
  });
});

describe('the stat strip', () => {
  it('is compact, carries the scope in its links, and is never clean over unmeasured projects', () => {
    const out = html(
      <StatStrip
        rows={[row('A'), row('B', { ci: { conclusion: null, unknown: true }, ciState: 'never' })]}
        projectsDetail="In Dormice"
        scope="dormice"
      />,
    );
    expect(out).toContain('CI · reporting');
    expect(out).toContain('1 of 2');
    expect(out).toContain('not measurable yet');
    expect(out).toContain('href="/findings?group=dormice"');
    expect(out).toContain('href="/drift?group=dormice"');
    // The figures that are not lists link where they can: the strip, the ledger's CI, blocked work.
    expect(out).toContain('href="#needs-you"');
    expect(out).toContain('href="#ci"');
    expect(out).toContain('href="/findings?tab=blocked&amp;group=dormice"');
    expect(out).not.toContain('Green');
  });
});
