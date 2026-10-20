import { afterEach, describe, expect, it, vi } from 'vitest';
import { undoAll, undoSummary } from './undo';

/** FRM-T-17.3: Undo reverses a write's events last-first, and never claims more than it did. */
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

    const report = await undoAll(['move', 'shift']);
    expect(calls).toEqual(['/api/undo/shift', '/api/undo/move']);
    expect(report).toEqual({ total: 1, undone: 1, refused: [] });
  });

  it('keeps going past a refusal, and reports what it could and could not put back', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      return url.endsWith('/u1')
        ? answer(409, { error: 'that change cannot be undone: groupId has changed since' })
        : answer(200, { undid: url });
    });

    const report = await undoAll(['u1', 'u2']);
    expect(calls).toEqual(['/api/undo/u2', '/api/undo/u1']);
    expect(report.total).toBe(2);
    expect(report.undone).toBe(1);
    expect(report.refused).toEqual([
      { id: 'u1', message: 'that change cannot be undone: groupId has changed since', conflict: true },
    ]);
  });

  it('still tries the earlier events after a later one is refused', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      return url.endsWith('/u2') ? answer(409, { error: 'moved on' }) : answer(200, {});
    });
    const report = await undoAll(['u1', 'u2']);
    expect(calls).toEqual(['/api/undo/u2', '/api/undo/u1']);
    expect(report.undone).toBe(1);
  });
});

describe('undoSummary', () => {
  const refusal = { id: 'u1', message: 'moved on', conflict: true };
  const partial = { total: 2, undone: 1, refused: [refusal] };

  it('says the success line when everything was undone', () => {
    expect(undoSummary({ total: 2, undone: 2, refused: [] }, 'Put U1 and U2 back')).toBe('Put U1 and U2 back');
  });

  it('names what was not put back, item by item, on a partial undo', () => {
    expect(undoSummary(partial, 'Put U1 and U2 back', { back: ['U2'], notBack: ['U1'] })).toBe(
      'Undid 1 of 2 — U1 has changed since',
    );
  });

  it('says "Not undone" only when nothing was', () => {
    expect(
      undoSummary({ total: 2, undone: 0, refused: [refusal, { id: 'u2', message: 'x', conflict: true }] }, 'ok', {
        back: [],
        notBack: ['U1', 'U2'],
      }),
    ).toBe('Not undone — U1 and U2 have changed since');
    expect(undoSummary({ total: 1, undone: 0, refused: [refusal] }, 'ok')).toBe(
      'Not undone — something has changed since',
    );
  });

  it('counts changes when it cannot name items', () => {
    expect(undoSummary(partial, 'ok')).toBe('Undid 1 of 2 changes — the rest had changed since');
  });
});
