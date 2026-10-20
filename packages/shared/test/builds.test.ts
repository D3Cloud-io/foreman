import { describe, expect, it } from 'vitest';
import {
  BUILD_CHECK_PREFIX,
  BUILD_CONCLUSION,
  BuildResultInput,
  BuildState,
  buildCheckName,
  CheckConclusion,
} from '../src/index.js';

/** A build result from Shipyard, as the API accepts it (FRM-T-008, FRM-REQ-182). */

const row = {
  kind: 'foreman_build',
  buildId: 'b-1',
  app: 'foreman',
  sha: 'ABCDEF0123'.repeat(4),
  project: 'FRM',
  environment: 'production',
  state: 'failed',
  failedStage: 'test',
};

describe('a build result', () => {
  it("parses Shipyard's foreman_build outbox row as it stands, lowercasing the SHA", () => {
    const parsed = BuildResultInput.parse(row);
    expect(parsed.sha).toBe('abcdef0123'.repeat(4));
    expect(parsed.state).toBe('failed');
  });

  it('needs only the build, the app, the commit and the state', () => {
    expect(BuildResultInput.safeParse({ buildId: 'b', app: 'a', sha: '0'.repeat(40), state: 'succeeded' }).success).toBe(
      true,
    );
  });

  it('refuses a short SHA, another kind, or a state Shipyard does not send', () => {
    expect(BuildResultInput.safeParse({ ...row, sha: 'abcdef0' }).success).toBe(false);
    expect(BuildResultInput.safeParse({ ...row, kind: 'deployment' }).success).toBe(false);
    expect(BuildResultInput.safeParse({ ...row, state: 'passed' }).success).toBe(false);
  });

  it('maps every state to a check conclusion, and only success to success', () => {
    for (const state of BuildState.options) {
      expect(CheckConclusion.options).toContain(BUILD_CONCLUSION[state]);
      expect(BUILD_CONCLUSION[state] === 'success').toBe(state === 'succeeded');
    }
  });

  it('names one check per app, under a prefix GitHub never uses', () => {
    expect(buildCheckName('foreman')).toBe('shipyard/build/foreman');
    expect(buildCheckName('foreman').startsWith(BUILD_CHECK_PREFIX)).toBe(true);
  });
});
