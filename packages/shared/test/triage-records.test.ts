import { describe, expect, it } from 'vitest';
import { DecisionCreate, DecisionUpdate, FindingUpdate, UPDATE_FIELDS, UpdateInput } from '../src/index.js';

/** FRM-T-18.15: the fields triage now keeps, and where they are refused by name. */

const paths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  (result.error?.issues ?? []).map((issue) => issue.path.join('.'));

describe("a finding's won't-fix reason", () => {
  it('is taken with wont_fix, or with no status (the server checks the one it has)', () => {
    expect(FindingUpdate.parse({ status: 'wont_fix', wontFixReason: ' gone ' }).wontFixReason).toBe('gone');
    expect(FindingUpdate.safeParse({ wontFixReason: 'why' }).success).toBe(true);
    expect(FindingUpdate.safeParse({ wontFixReason: null, status: 'open' }).success).toBe(true);
  });

  it('is refused by name with any other status', () => {
    expect(paths(FindingUpdate.safeParse({ status: 'open', wontFixReason: 'why' }))).toEqual(['wontFixReason']);
    expect(paths(FindingUpdate.safeParse({ status: 'wont_fix', wontFixReason: '   ' }))).toEqual(['wontFixReason']);
  });

  it('is not a foreman_update field, so a session sending it is refused by name rather than dropped', () => {
    expect(UPDATE_FIELDS['CR']).not.toContain('wontFixReason');
    const result = UpdateInput.safeParse({ id: 'BND-CR-004', wontFixReason: 'why' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('wontFixReason');
  });
});

describe('a decision accepting drift', () => {
  it('names the record and the category together, or neither', () => {
    const base = { statement: 's', value: 'v' };
    expect(DecisionCreate.safeParse(base).success).toBe(true);
    expect(
      DecisionCreate.safeParse({ ...base, acceptsDriftSubject: 'BND-REQ-041', acceptsDriftCategory: 'coverage-hole' }).success,
    ).toBe(true);
    expect(paths(DecisionCreate.safeParse({ ...base, acceptsDriftSubject: 'BND-REQ-041' }))).toEqual(['acceptsDriftCategory']);
    expect(paths(DecisionCreate.safeParse({ ...base, acceptsDriftCategory: 'stale-task' }))).toEqual(['acceptsDriftSubject']);
  });

  it('is fixed when made: an update does not declare the link, so parseBody refuses it by name', () => {
    expect(Object.keys(DecisionUpdate.shape)).not.toContain('acceptsDriftSubject');
    expect(Object.keys(DecisionUpdate.shape)).not.toContain('acceptsDriftCategory');
  });
});
