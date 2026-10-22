import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Reality } from '../lib/api';
import { RealityBody } from './RealitySection';

/** FRM-T-18.8: the Reality section says what the repo shows, and what it cannot. */

const base: Reality = { humanId: 'BND-T-9.3', commits: [], checks: [], deployments: [], drift: [] };
const commit = (over: Partial<Reality['commits'][number]>): Reality['commits'][number] => ({
  sha: 'a1c4e09'.padEnd(40, '0'),
  message: 'feat(unify): apply reviewed merge round (BND-T-9.3)',
  committedAt: '2026-08-30T10:00:00.000Z',
  repo: 'matdemers1/bindery',
  task: 'BND-T-9.3',
  source: 'message',
  confidence: 1,
  confirmed: true,
  evidence: null,
  shippedIn: null,
  ...over,
});
const render = (reality: Reality, doneClaimed = false) =>
  renderToStaticMarkup(<RealityBody reality={reality} kind="task" projectCode="BND" doneClaimed={doneClaimed} />);

describe('the Reality section', () => {
  it('says "done on say-so" when a done task has no commit, without alarm', () => {
    const html = render(base, true);
    expect(html).toContain('done on say-so');
    expect(html).toContain('Nothing to report on');
    expect(html).toContain('Not deployed');
  });

  it('lists a confirmed commit as confirmed, and a suggestion as not counted yet', () => {
    const html = render({
      ...base,
      commits: [
        commit({}),
        commit({ sha: '5b21e8f'.padEnd(40, '0'), confirmed: false, source: 'file_overlap', message: 'test(unify): guard' }),
      ],
    });
    expect(html).toContain('Commits · 1 confirmed, 1 waiting');
    expect(html).toContain('confirmed');
    expect(html).toContain('suggested · not counted yet');
    expect(html).toContain('path match');
    expect(html).toContain('/projects/BND/activity');
  });

  it('says CI is unknown, not passing, when no run posted for the confirmed commits', () => {
    const html = render({ ...base, commits: [commit({})] });
    expect(html).toContain('Never reported');
    expect(html).toContain('unknown — not');
  });

  it('shows a CI result against the confirmed commit only', () => {
    const html = render({
      ...base,
      commits: [commit({}), commit({ sha: '5b21e8f'.padEnd(40, '0'), confirmed: false })],
      checks: [
        { commitSha: 'a1c4e09'.padEnd(40, '0'), name: 'ci', conclusion: 'success', completedAt: '2026-08-30T11:00:00Z', detailsUrl: null },
        { commitSha: '5b21e8f'.padEnd(40, '0'), name: 'lint', conclusion: 'failure', completedAt: null, detailsUrl: null },
      ],
    });
    expect(html).toContain('>ci<');
    expect(html).not.toContain('>lint<');
  });

  it('lists the deployment a commit is in, and what is on main but not yet shipped', () => {
    const html = render({
      ...base,
      commits: [commit({ shippedIn: 'd1' }), commit({ sha: 'b'.repeat(40), shippedIn: null })],
      deployments: [
        { id: 'd1', environment: 'production', image: 'ghcr.io/x', imageSha: 'sha-3f8e21c', deployedAt: '2026-08-30T00:00:00Z', via: 'image' },
      ],
    });
    expect(html).toContain('3f8e21c');
    expect(html).toContain('1 confirmed commit is');
    expect(html).toContain('not yet deployed');
  });

  it('puts the drift engine’s own line at the top', () => {
    const html = render({ ...base, drift: [{ category: 'stale-task', detail: 'in progress, untouched for 51 days' }] });
    expect(html).toContain('Stale task');
    expect(html).toContain('untouched for 51 days');
  });
});
