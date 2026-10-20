import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToastOptions } from '@d3cloud/ui';
import { ApiError, auditIdsFromHeaders } from './api';
import {
  changedCharacters,
  discardQuestion,
  draftSize,
  eventIdsOf,
  failureMessage,
  rolledUpOf,
  runMutation,
  undoOutcome,
  withRollups,
} from './mutate';

/** FRM-T-18.4: every console write, one way — in place, a toast naming the roll-up, Undo. */

const answer = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

function recorder() {
  const shown: ToastOptions[] = [];
  return { shown, toast: { show: (options: ToastOptions) => { shown.push(options); return String(shown.length); } } };
}

describe('the toast line', () => {
  it('names the change and every roll-up it caused, and skips a held one', () => {
    expect(
      withRollups('BND-T-9.4 marked done', [
        { humanId: 'BND-P-9', kind: 'phase', from: 'active', to: 'complete' },
        { humanId: 'BND', kind: 'project', from: 'building', to: 'deployed' },
        { humanId: 'BND-P-8', kind: 'phase', from: 'complete', to: 'active', held: true },
      ]),
    ).toBe('BND-T-9.4 marked done · BND-P-9 rolled up to complete · BND rolled up to deployed');
    expect(withRollups('Saved GL-004', [])).toBe('Saved GL-004');
  });

  it('reads the events and the roll-ups from a write’s answer, and nothing from anything else', () => {
    expect(eventIdsOf({ auditEventIds: ['own', 'phase'] })).toEqual(['own', 'phase']);
    expect(eventIdsOf(undefined)).toEqual([]);
    expect(eventIdsOf({ auditEventIds: 'no' })).toEqual([]);
    expect(rolledUpOf({ rolledUp: [{ humanId: 'X-P-1', kind: 'phase', from: 'a', to: 'b' }] })).toHaveLength(1);
    expect(rolledUpOf({})).toEqual([]);
  });

  it('reads a DELETE’s events from its headers, own first', () => {
    expect(auditIdsFromHeaders(new Headers({ 'Audit-Event-Ids': 'own, roll', 'Audit-Event-Id': 'own' }))).toEqual([
      'own',
      'roll',
    ]);
    expect(auditIdsFromHeaders(new Headers({ 'Audit-Event-Id': 'own' }))).toEqual(['own']);
    expect(auditIdsFromHeaders(new Headers())).toEqual([]);
  });
});

describe('an undo’s outcome', () => {
  it('says the success line when everything went back', () => {
    expect(undoOutcome({ total: 2, undone: 2, refused: [] }, 'BND-T-9.4', 'Undone')).toBe('Undone');
  });

  it('shows the server’s refusal word for word', () => {
    const message = 'that change cannot be undone: title has changed since, and restoring would discard the later edit';
    expect(
      undoOutcome({ total: 1, undone: 0, refused: [{ id: 'e1', message, conflict: true }] }, 'BND-T-9.4', 'Undone'),
    ).toBe(`Undo of BND-T-9.4 refused: ${message}`);
  });

  it('says how much went back when only part of it did', () => {
    expect(
      undoOutcome(
        { total: 2, undone: 1, refused: [{ id: 'e1', message: 'moved on', conflict: true }] },
        'BND-T-9.4',
        'Undone',
      ),
    ).toBe('Undid 1 of 2 changes to BND-T-9.4; refused: moved on');
  });

  it('keeps the server’s message for a failed write', () => {
    expect(failureMessage(new ApiError(409, 'a blocked task must say what is blocking it'))).toBe(
      'a blocked task must say what is blocking it',
    );
    expect(failureMessage('weird')).toBe('That change did not go through.');
  });
});

describe('runMutation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applies the answer, re-reads in place, and offers Undo naming the roll-up', async () => {
    const { shown, toast } = recorder();
    const order: string[] = [];
    const outcome = await runMutation(
      {
        subject: 'BND-T-9.4',
        run: () =>
          Promise.resolve({
            humanId: 'BND-T-9.4',
            status: 'done',
            rolledUp: [{ humanId: 'BND-P-9', kind: 'phase' as const, from: 'active', to: 'complete' }],
            auditEventIds: ['own', 'phase'],
          }),
        message: (r) => `${r.humanId} marked ${r.status}`,
        apply: () => order.push('apply'),
        refresh: () => order.push('refresh'),
      },
      toast,
    );

    expect(outcome.ok).toBe(true);
    expect(order).toEqual(['apply', 'refresh']);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.message).toBe('BND-T-9.4 marked done · BND-P-9 rolled up to complete');
    expect(shown[0]?.action?.label).toBe('Undo');
  });

  it('undoes every event last-first, then re-reads in place', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      return answer(200, {});
    });
    const { shown, toast } = recorder();
    const refreshed: string[] = [];
    const undone = new Promise<void>((resolve) => {
      void runMutation(
        {
          subject: 'BND-T-9.4',
          run: () => Promise.resolve({ auditEventIds: ['own', 'phase', 'project'] }),
          message: () => 'BND-T-9.4 marked done',
          refresh: () => refreshed.push('refresh'),
          undone: 'Undone — BND-T-9.4 is in progress again',
          onUndone: () => { resolve(); },
        },
        toast,
      ).then(() => {
        shown[0]?.action?.onAction();
      });
    });
    await undone;

    expect(calls).toEqual(['/api/undo/project', '/api/undo/phase', '/api/undo/own']);
    expect(shown[1]?.message).toBe('Undone — BND-T-9.4 is in progress again');
    expect(refreshed).toEqual(['refresh', 'refresh']);
  });

  it('shows a refused undo in the server’s words, and keeps it until read', async () => {
    vi.stubGlobal('fetch', () => answer(409, { error: 'that change cannot be undone: title has changed since' }));
    const { shown, toast } = recorder();
    const undone = new Promise<void>((resolve) => {
      void runMutation(
        {
          subject: 'BND-T-9.4',
          run: () => Promise.resolve({ auditEventIds: ['own'] }),
          message: () => 'BND-T-9.4 marked done',
          onUndone: () => { resolve(); },
        },
        toast,
      ).then(() => {
        shown[0]?.action?.onAction();
      });
    });
    await undone;

    expect(shown[1]?.message).toBe('Undo of BND-T-9.4 refused: that change cannot be undone: title has changed since');
    expect(shown[1]?.duration).toBe(0);
  });

  it('offers no Undo for what the server cannot reverse', async () => {
    const { shown, toast } = recorder();
    await runMutation(
      {
        subject: 'claude-code',
        run: () => Promise.resolve({ auditEventIds: ['revoke'] }),
        message: () => 'Revoked “claude-code”',
        undoable: false,
      },
      toast,
    );
    expect(shown[0]?.message).toBe('Revoked “claude-code”');
    expect(shown[0]?.action).toBeUndefined();
  });

  it('leaves a failure to the form when asked, and toasts it otherwise', async () => {
    const { shown, toast } = recorder();
    const refused = new ApiError(400, 'title is required');
    const inline = await runMutation(
      { subject: 'BND-T-9.4', run: () => Promise.reject(refused), message: () => 'never', failure: 'inline' },
      toast,
    );
    expect(inline).toEqual({ ok: false, error: refused, message: 'title is required' });
    expect(shown).toHaveLength(0);

    await runMutation({ subject: 'BND-T-9.4', run: () => Promise.reject(refused), message: () => 'never' }, toast);
    expect(shown[0]?.message).toBe('BND-T-9.4: title is required');
  });
});

describe('drafts', () => {
  it('counts only the stretch that differs', () => {
    expect(changedCharacters('same', 'same')).toBe(0);
    expect(changedCharacters('', 'hello')).toBe(5);
    expect(changedCharacters('hello world', 'hello brave world')).toBe(6);
    expect(changedCharacters('abc', 'abd')).toBe(1);
    expect(changedCharacters('aaaa', 'aa')).toBe(2);
  });

  it('adds every field up, absent as empty', () => {
    expect(draftSize({ title: 'A', body: null }, { title: 'A', body: 'xyz' })).toBe(3);
    expect(draftSize({ title: 'A' }, { title: 'A' })).toBe(0);
  });

  it('asks how many characters it would throw away', () => {
    expect(discardQuestion(12, 'BND-T-9.4')).toBe('Discard 12 unsaved characters in BND-T-9.4?');
    expect(discardQuestion(1)).toBe('Discard 1 unsaved character?');
  });
});
