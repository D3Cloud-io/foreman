import { describe, expect, it } from 'vitest';
import { attributionWords, mainVersusDeployed } from './ProjectOverview';

/** FRM-T-18.8: Recent reality says what each commit is attributed to, in words. */
describe('the overview’s recent reality', () => {
  it('reads main against what is deployed', () => {
    expect(mainVersusDeployed({ deployed: null })).toBe('nothing is recorded as deployed');
    expect(mainVersusDeployed({ deployed: { sha: 'sha-3f8e21c', at: '', ahead: 4 } })).toBe(
      'main is 4 commits ahead of what is deployed',
    );
    expect(mainVersusDeployed({ deployed: { sha: 'sha-3f8e21c', at: '', ahead: 1 } })).toBe(
      'main is 1 commit ahead of what is deployed',
    );
    expect(mainVersusDeployed({ deployed: { sha: 'sha-3f8e21c', at: '', ahead: 0 } })).toBe(
      'main is what is deployed',
    );
    expect(mainVersusDeployed({ deployed: { sha: 'sha-3f8e21c', at: '', ahead: null } })).toContain(
      'not a commit Foreman knows',
    );
  });

  const attribution = (task: string, confirmed: boolean, rejectedAt: string | null = null) => ({
    task: { humanId: task, title: '', status: 'todo' },
    source: 'file_overlap',
    confidence: 0.4,
    confirmed,
    rejectedAt,
    evidence: null,
  });

  it('names a confirmed task, calls a proposal waiting, and says "no task" otherwise', () => {
    expect(attributionWords({ attributions: [attribution('BND-T-9.3', true)] })).toBe('BND-T-9.3');
    expect(attributionWords({ attributions: [attribution('BND-T-9.3', false)] })).toBe('suggested BND-T-9.3 · waiting');
    expect(attributionWords({ attributions: [] })).toBe('no task');
  });

  it('never counts a rejected attribution', () => {
    expect(attributionWords({ attributions: [attribution('BND-T-9.3', false, '2026-10-01')] })).toBe('no task');
  });
});
