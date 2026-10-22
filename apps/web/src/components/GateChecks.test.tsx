import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GateResult } from '../lib/api';
import { checksMet, failureHref, GATE_CHECKS, GateList } from './GateChecks';

/** FRM-T-18.8: the gate is the server's, printed as it came (FRM-DA-008). */

const FAILING: GateResult = {
  phase: 'BND-P-9',
  passed: false,
  failures: [
    { kind: 'no-acceptance-test', humanId: 'BND-REQ-083', detail: 'no acceptance test recorded — Backlog documents <can> be triaged' },
    { kind: 'unfinished-task', humanId: 'BND-T-9.3', detail: 'in_progress — Merge the existing fragmentation' },
    { kind: 'unfinished-task', humanId: 'BND-T-9.7', detail: 'blocked — waiting on the SMB spike' },
    { kind: 'screen-unreviewed', humanId: 'BND-SCR-007', detail: 'Organise: its latest capture has not been reviewed' },
  ],
};

describe('the exit gate as required checks', () => {
  it('lists the gate’s seven kinds, in the order the gate runs them', () => {
    expect(GATE_CHECKS.map((c) => c.kind)).toEqual([
      'no-exit-demo',
      'uncovered-must',
      'no-acceptance-test',
      'unfinished-task',
      'open-critical',
      'screen-unreviewed',
      'screen-drifted',
    ]);
  });

  it('counts a check as met when the server named no failure of its kind', () => {
    expect(checksMet(FAILING)).toBe(4);
    expect(checksMet({ failures: [] })).toBe(7);
  });

  it('prints every failure’s detail unedited, under its check, and says "met" for the rest', () => {
    const html = renderToStaticMarkup(<GateList code="BND" result={FAILING} exitDemo={null} />);
    // Verbatim — apart from the HTML escaping React applies to text, which is not an edit.
    expect(html).toContain('in_progress — Merge the existing fragmentation');
    expect(html).toContain('blocked — waiting on the SMB spike');
    expect(html).toContain('no acceptance test recorded — Backlog documents &lt;can&gt; be triaged');
    expect(html).toContain('Organise: its latest capture has not been reviewed');
    expect(html).toContain('4 of 7 checks pass');
    expect(html).toContain('4 things stand in the way');
    expect((html.match(/>met</g) ?? []).length).toBe(4);
    expect((html.match(/>not met</g) ?? []).length).toBe(3);
  });

  it('is all met, with nothing in the way, when the gate returns no failures', () => {
    const html = renderToStaticMarkup(
      <GateList code="BND" result={{ phase: 'BND-P-9', passed: true, failures: [] }} exitDemo="Ask, and get an answer." />,
    );
    expect(html).toContain('7 of 7 checks pass');
    expect(html).toContain('nothing stands in the way');
    expect(html).toContain('Ask, and get an answer.');
    expect(html).not.toContain('not met');
  });

  it('links each failure to the record at fault', () => {
    const href = (kind: GateResult['failures'][number]['kind'], humanId: string) =>
      failureHref('BND', { kind, humanId, detail: '' });
    expect(href('uncovered-must', 'BND-REQ-1')).toBe('/requirements/BND-REQ-1');
    expect(href('unfinished-task', 'BND-T-9.3')).toBe('/tasks/BND-T-9.3');
    expect(href('open-critical', 'BND-CR-1')).toBe('/findings/BND-CR-1');
    expect(href('screen-drifted', 'BND-SCR-7')).toBe('/projects/BND/screens/BND-SCR-7');
    expect(href('no-exit-demo', 'BND-P-9')).toBe('/projects/BND/phases/BND-P-9');
  });
});
