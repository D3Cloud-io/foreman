import { describe, expect, it } from 'vitest';
import { startedWhenMissing } from './TaskDetail';

/** A done task with no recorded start was never recorded; it is not "not yet" (FRM-DA-003). */
describe('the Started line of a task with no start', () => {
  it('says "not recorded" on a done task', () => {
    expect(startedWhenMissing('done')).toBe('not recorded');
  });

  it('says "not yet" on a task that has not been started', () => {
    for (const status of ['todo', 'in_progress', 'blocked', 'cancelled']) {
      expect(startedWhenMissing(status)).toBe('not yet');
    }
  });
});
