import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { openCriticalTotal } from './shellSignals';

/** FRM-REQ-242: the badge reads the route's `total`, from a page of one row. */
describe('the open-critical count', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks for one row and reads the total of the whole matching set', async () => {
    const get = vi
      .spyOn(api, 'get')
      .mockResolvedValue({ items: [{ humanId: 'X-1' }], nextCursor: null, total: 137 });

    expect(await openCriticalTotal()).toBe(137);
    expect(get).toHaveBeenCalledTimes(1);
    const path = String(get.mock.calls[0]?.[0]);
    expect(path).toContain('limit=1');
    expect(path).not.toContain('limit=200');
    expect(path).toContain('severity=critical');
    expect(path).toContain('status=open');
  });

  it('falls back to the rows returned only when no total is sent', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ items: [{}], nextCursor: null, total: null });
    expect(await openCriticalTotal()).toBe(1);
  });
});
