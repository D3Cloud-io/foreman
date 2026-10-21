import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ToastRegion } from '@d3cloud/ui';
import type { ProposedAttribution } from '@foreman/shared';
import {
  FindingVerdicts,
  verdictApplies,
  verdictBody,
  verdictPressed,
  withWontFixReason,
} from './FindingDetail';
import { filtersOf, rowState } from './Findings';
import {
  SplitView,
  bulkLine,
  bulkUndoLine,
  effectiveSelection,
  moveSelection,
  runBulk,
  selectionOf,
  spanOf,
  tabHref,
  tabOf,
  undoBulk,
} from './triage';
import { acceptanceStatement, actionFor, driftKey, splitAccepted, titleFrom, type DriftRow } from './TriageDrift';
import { checksWords, nextWaiting, reviewKey, type ReviewItem } from './TriageReview';

vi.mock('../lib/undo', () => ({
  // MUR-AP-003 has changed since; everything else goes back.
  undoAll: vi.fn((ids: readonly string[]) =>
    Promise.resolve(
      ids.includes('ev-mur')
        ? { total: 1, undone: 0, refused: [{ id: 'ev-mur', message: 'status has changed since', conflict: true }] }
        : { total: ids.length, undone: ids.length, refused: [] },
    ),
  ),
}));

/** FRM-T-18.7: the triage surface on /findings — its URL, its verdicts and its bulk undo. */

describe('where the triage surface is, in the URL', () => {
  it('reads the tab from ?tab=, Findings being its absence', () => {
    expect(tabOf('')).toBe('findings');
    expect(tabOf('?tab=review&group=dormice')).toBe('review');
    expect(tabOf('?tab=changes')).toBe('findings');
  });

  it('keeps the scope when the tab changes, and drops the selection and the Findings filters', () => {
    expect(tabHref('?group=dormice&severity=high&sel=BND-CR-001', 'drift')).toBe('/findings?group=dormice&tab=drift');
    expect(tabHref('?group=dormice&tab=drift&sel=coverage-hole%3AX-REQ-001', 'findings')).toBe('/findings?group=dormice');
  });

  it('reads the selection, and moves it with j and k, held at either end', () => {
    expect(selectionOf('?sel=BND-CR-001')).toBe('BND-CR-001');
    expect(selectionOf('?sel=')).toBeNull();
    const ids = ['A', 'B', 'C'];
    expect(moveSelection(ids, 'A', 1)).toBe('B');
    expect(moveSelection(ids, 'C', 1)).toBe('C');
    expect(moveSelection(ids, 'A', -1)).toBe('A');
    expect(moveSelection(ids, null, 1)).toBe('A');
    expect(moveSelection(ids, null, -1)).toBe('C');
    expect(moveSelection([], 'A', 1)).toBeNull();
  });

  it('shows the first row when the URL names none, or one no longer in the list', () => {
    expect(effectiveSelection(['A', 'B'], 'B')).toBe('B');
    expect(effectiveSelection(['A', 'B'], 'Z')).toBe('A');
    expect(effectiveSelection([], null)).toBeNull();
  });

  it('reads the Findings filters, `open` being the default status', () => {
    expect(filtersOf('?project=BND&severity=high')).toEqual({ severity: 'high', lens: '', status: 'open', project: 'BND' });
  });
});

describe('the split view collapses on a phone', () => {
  it('marks whether a row is picked, which is what shows the record below lg', () => {
    const html = (picked: boolean) =>
      renderToStaticMarkup(
        <SplitView label="Findings" picked={picked} list={<p>list</p>} detail={<p>detail</p>} onBack={() => undefined} />,
      );
    expect(html(false)).toContain('data-picked="false"');
    expect(html(true)).toContain('data-picked="true"');
    expect(html(true)).toContain('Back to the list');
  });
});

describe('finding verdicts', () => {
  const open = { status: 'open', verified: 'unverified' };

  it('offers only the verdicts that would change something', () => {
    expect(verdictApplies('acknowledge', open)).toBe(true);
    expect(verdictApplies('acknowledge', { ...open, verified: 'confirmed' })).toBe(false);
    expect(verdictApplies('reopen', open)).toBe(false);
    expect(verdictApplies('reopen', { ...open, status: 'fixed' })).toBe(true);
    expect(verdictApplies('fixed', { ...open, status: 'fixed' })).toBe(false);
    expect(verdictApplies('wont-fix', { ...open, status: 'wont_fix' })).toBe(false);
  });

  it('draws the current state as the pressed verdict', () => {
    expect(verdictPressed('fixed', { ...open, status: 'fixed' })).toBe(true);
    expect(verdictPressed('acknowledge', { ...open, verified: 'confirmed' })).toBe(true);
    expect(verdictPressed('reopen', open)).toBe(false);
  });

  it('sends one PATCH each, and keeps a Won’t fix reason with the recommendation', () => {
    expect(verdictBody('acknowledge')).toEqual({ verified: 'confirmed' });
    expect(verdictBody('fixed')).toEqual({ status: 'fixed' });
    expect(verdictBody('reopen')).toEqual({ status: 'open' });
    expect(verdictBody('wont-fix', 'Scope the select.', ' the code is going ')).toEqual({
      status: 'wont_fix',
      recommendationMd: 'Scope the select.\n\n**Won’t fix** — the code is going',
    });
    expect(withWontFixReason(null, 'no')).toBe('**Won’t fix** — no');
  });

  it('draws the verdicts as buttons with their keys, and as a phone ActionBar', () => {
    const html = renderToStaticMarkup(
      <ToastRegion>
        <FindingVerdicts
          finding={{ humanId: 'BND-CR-001', project: 'BND', status: 'open', verified: 'unverified' }}
          pending={false}
          onVerdict={() => undefined}
        />
      </ToastRegion>,
    );
    for (const label of ['Acknowledge', 'Mark fixed', 'Reopen', 'Won’t fix…']) expect(html).toContain(label);
    // The key caps are decoration: the label is the name.
    expect(html).toMatch(/<kbd class="d3-kbd fm-triage__kbd" aria-hidden="true">a<\/kbd>/);
    expect(html).toContain('aria-label="Verdicts on BND-CR-001"');
    expect(html).toContain('fm-triage__actionbar');
  });

  it('says what a row is: acknowledged for an open finding somebody accepted', () => {
    expect(rowState({ status: 'open', verified: 'confirmed' })).toBe('acknowledged');
    expect(rowState({ status: 'wont_fix', verified: 'confirmed' })).toBe('wont fix');
    expect(rowState({ status: 'open', verified: 'unverified' })).toBe('open');
  });
});

describe('bulk verdicts are N writes and N undos', () => {
  it('tries every item, and names each refusal in the server’s words', async () => {
    const results = await runBulk(['SHP-CR-007', 'MUR-AP-003', 'DS-DA-009'], (id) =>
      id === 'DS-DA-009'
        ? Promise.reject(new Error('no finding called DS-DA-009'))
        : Promise.resolve({ auditEventIds: [id === 'MUR-AP-003' ? 'ev-mur' : `ev-${id}`] }),
    );
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(bulkLine('Acknowledged', { one: 'finding', other: 'findings' }, results)).toBe(
      'Acknowledged 2 of 3 — DS-DA-009 refused: no finding called DS-DA-009',
    );
    expect(bulkLine('Acknowledged', { one: 'finding', other: 'findings' }, results.slice(0, 2))).toBe(
      'Acknowledged 2 findings',
    );
  });

  it('undoes each item on its own, and a partial undo never reads as success', async () => {
    const results = await runBulk(['SHP-CR-007', 'MUR-AP-003', 'DS-DA-009'], (id) =>
      Promise.resolve({ auditEventIds: [id === 'MUR-AP-003' ? 'ev-mur' : `ev-${id}`] }),
    );
    const reports = await undoBulk(results);
    expect(reports).toEqual([
      { id: 'SHP-CR-007', undone: true },
      { id: 'MUR-AP-003', undone: false, message: 'status has changed since' },
      { id: 'DS-DA-009', undone: true },
    ]);
    expect(bulkUndoLine(reports, 'Undone')).toBe(
      'Undid 2 of 3 — SHP-CR-007 and DS-DA-009 are back; MUR-AP-003 was not undone: status has changed since',
    );
    expect(bulkUndoLine(reports.filter((r) => r.undone), 'Undone — 2 findings are as they were')).toBe(
      'Undone — 2 findings are as they were',
    );
    expect(bulkUndoLine(reports.filter((r) => !r.undone), 'Undone')).toBe(
      'Not undone — MUR-AP-003 was not undone: status has changed since',
    );
  });

  it('says what a selection spans', () => {
    expect(spanOf(['SHP', 'MUR', 'DS', 'MUR'])).toBe('3 projects · SHP, MUR, DS');
  });
});

describe('drift rows carry their resolving action', () => {
  const row = (over: Partial<DriftRow>): DriftRow => ({
    category: 'coverage-hole',
    humanId: 'BND-REQ-041',
    title: 'Re-segmenting a bundle keeps every vaulted document’s pages.',
    detail: 'A Must with no task satisfying it.',
    project: { code: 'BND', name: 'Bindery' },
    ...over,
  });

  it('names the action by what drifted', () => {
    expect(actionFor(row({}))).toBe('create-task');
    expect(actionFor(row({ humanId: 'BND-T-9.4' }))).toBe('cite-requirement');
    expect(actionFor(row({ category: 'stale-task', humanId: 'SHP-T-7.2' }))).toBe('set-status');
    expect(actionFor(row({ category: 'fired-tripwire', humanId: 'FLR-R-004' }))).toBe('record-adr');
    expect(actionFor(row({ category: 'failed-exit-gate', humanId: 'PST-P-4' }))).toBe('reopen-phase');
    expect(actionFor(row({ category: 'orphan-adr', humanId: 'BND-ADR-003' }))).toBe('adr-status');
    expect(actionFor(row({ category: 'screen-drift', humanId: 'BND-SCR-002' }))).toBe('open-screen');
  });

  it('prefills a task title from the requirement’s first sentence', () => {
    expect(titleFrom('Keep every page. And more.')).toBe('Keep every page.');
    expect(titleFrom('x'.repeat(400))).toHaveLength(300);
  });

  it('finds an acceptance by its decision, and moves the item to Accepted with the reason', () => {
    const hole = row({});
    const stale = row({ category: 'stale-task', humanId: 'BND-T-9.1', detail: 'In progress, untouched.' });
    expect(acceptanceStatement(hole)).toBe('Accepted drift on BND-REQ-041 (coverage-hole): A Must with no task satisfying it.');
    expect(driftKey(stale)).toBe('stale-task:BND-T-9.1');
    const split = splitAccepted(
      [hole, stale],
      new Map([
        [
          'BND',
          [{ humanId: 'BND-D-7', statement: acceptanceStatement(hole), rationale: 'Covered by BND-REQ-040 for now.' }],
        ],
      ]),
    );
    expect(split.items).toEqual([stale]);
    expect(split.accepted).toEqual([{ ...hole, decision: { humanId: 'BND-D-7', rationale: 'Covered by BND-REQ-040 for now.' } }]);
  });
});

describe('the review queue', () => {
  const item = (sha: string, task: string, decided?: 'confirmed'): ReviewItem => ({
    project: { code: 'BND', name: 'Bindery' },
    commit: { sha, message: 'm', author: 'a', committedAt: '', repo: 'r', files: [], orphaned: false, checks: [] },
    task: { humanId: task, title: 't', status: 'todo', doneWhen: null, phase: null },
    source: 'declared',
    confidence: 1,
    evidence: null,
    proposedAt: '',
    ...(decided === undefined ? {} : { decided }),
  });

  it('keys a proposal by commit and task, since one commit may be proposed for two', () => {
    expect(reviewKey(item('c0175a6aaaaaaaaa', 'BND-T-9.4'))).toBe('c0175a6aaaaa~BND-T-9.4');
  });

  it('advances to the next proposal still waiting, wrapping, and to none when all are ruled on', () => {
    const items = [item('a'.repeat(12), 'X-T-1'), item('b'.repeat(12), 'X-T-2', 'confirmed'), item('c'.repeat(12), 'X-T-3')];
    expect(nextWaiting(items, reviewKey(items[0] as ReviewItem))).toBe(reviewKey(items[2] as ReviewItem));
    expect(nextWaiting(items, reviewKey(items[2] as ReviewItem))).toBe(reviewKey(items[0] as ReviewItem));
    expect(nextWaiting([item('d'.repeat(12), 'X-T-4')], 'dddddddddddd~X-T-4')).toBeNull();
  });

  it('says CI in words, and nothing reported is never passing', () => {
    const checks = (list: ProposedAttribution['commit']['checks']) => checksWords(list);
    expect(checks([])).toBe('No CI reported');
    expect(checks([{ name: 'ci', conclusion: 'success' }])).toBe('CI passing');
    expect(checks([{ name: 'ci', conclusion: 'success' }, { name: 'e2e', conclusion: 'failure' }])).toBe('CI failing');
    expect(checks([{ name: 'ci', conclusion: null }])).toBe('CI running');
  });
});
