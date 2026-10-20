import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { undoAll, undoFailure } from './undo';

/** FRM-T-17.3: Undo reverses a write's events last-first, and passes over only a renumbering. */
describe('undoAll', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const answer = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

  it('undoes the events last-first, and passes over a renumbering the change caused', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      return url.endsWith('/shift')
        ? answer(409, { error: 'that renumbering followed a change (KURO moved to GRP-002); undo that change instead' })
        : answer(200, { undid: url });
    });

    await undoAll(['move', 'shift']);
    expect(calls).toEqual(['/api/undo/shift', '/api/undo/move']);
  });

  it('fails on any other refusal, and says the state has moved on', async () => {
    vi.stubGlobal('fetch', () => answer(409, { error: 'the project has changed since' }));

    const caught = await undoAll(['move']).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ApiError);
    expect(undoFailure(caught)).toBe('Not undone — something has changed since');
    expect(undoFailure(new Error('network'))).toBe('That was not undone');
  });
});
