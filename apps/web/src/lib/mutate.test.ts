import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToastOptions } from '@d3cloud/ui';
import { ApiError, auditIdsFromHeaders } from './api';
import {
  announceMutation,
  changedCharacters,
  discardQuestion,
  draftSize,
  eventIdsOf,
  failureMessage,
  oneAtATime,
  rolledUpOf,
  runMutation,
  STILL_SAVING,
  undoOutcome,
  undoReportWords,
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

describe('oneAtATime', () => {
  it('refuses a second write while the first is with the server, and says so', async () => {
    const { shown, toast } = recorder();
    const busy: boolean[] = [];
    const mutate = oneAtATime(toast, (b) => busy.push(b));
    let sent = 0;
    let land: () => void = () => undefined;
    const slow = () => {
      sent += 1;
      return new Promise<{ auditEventIds: string[] }>((resolve) => {
        land = () => { resolve({ auditEventIds: [] }); };
      });
    };

    // Two presses in the same tick, before anything renders.
    const first = mutate({ subject: 'PI-007', run: slow, message: () => 'Thought added' });
    const second = await mutate({ subject: 'PI-007', run: slow, message: () => 'Thought added' });
    expect(second).toEqual({ ok: false, error: null, message: STILL_SAVING, inFlight: true });
    expect(sent).toBe(1);
    expect(shown[0]?.message).toBe(STILL_SAVING);

    land();
    expect((await first).ok).toBe(true);
    expect(busy).toEqual([true, false]);

    // Once it has landed, the next one goes.
    const third = mutate({ subject: 'PI-007', run: slow, message: () => 'Thought added' });
    land();
    expect((await third).ok).toBe(true);
    expect(sent).toBe(2);
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

/** FRM-T-18.14: the Groups screens' partial-undo report, and a write announced after the fact. */
describe('undoWords — telling a partial undo item by item', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says "Undid 1 of 2 — X has changed since", read back from the state', async () => {
    // P1 moved on: its undo is refused, P2's goes through.
    vi.stubGlobal('fetch', (url: string) =>
      url.endsWith('/p1')
        ? answer(409, { error: 'that change cannot be undone: groupId has changed since' })
        : answer(200, {}),
    );
    const { shown, toast } = recorder();
    const settled = new Promise<void>((resolve) => {
      announceMutation(
        {
          subject: 'Moved KURO and BURR',
          message: () => 'Moved KURO and BURR to Dormice',
          undone: 'Put KURO and BURR back',
          undoWords: undoReportWords('Put KURO and BURR back', () =>
            Promise.resolve({ back: ['BURR'], notBack: ['KURO'] }),
          ),
          onUndone: () => { resolve(); },
        },
        { auditEventIds: ['p1', 'p2'] },
        toast,
      );
      shown[0]?.action?.onAction();
    });
    await settled;

    expect(shown[0]?.message).toBe('Moved KURO and BURR to Dormice');
    expect(shown[1]?.message).toBe('Undid 1 of 2 — KURO has changed since');
    // A partial undo stays until it is read.
    expect(shown[1]?.duration).toBe(0);
  });

  it('is the success line when everything went back, and falls back to the server’s words if it cannot say', async () => {
    vi.stubGlobal('fetch', () => answer(200, {}));
    const { shown, toast } = recorder();
    const done = new Promise<void>((resolve) => {
      announceMutation(
        {
          subject: 'Dormice',
          message: () => 'Moved Dormice up',
          undone: 'Put the order back',
          undoWords: () => Promise.reject(new Error('read-back failed')),
          onUndone: () => { resolve(); },
        },
        { auditEventIds: ['one'] },
        toast,
      );
      shown[0]?.action?.onAction();
    });
    await done;
    expect(shown[1]?.message).toBe('Put the order back');
  });

  it('offers no Undo when the write answered with no events', () => {
    const { shown, toast } = recorder();
    announceMutation({ subject: 'x', message: () => 'Did it' }, { auditEventIds: [] }, toast);
    expect(shown[0]?.action).toBeUndefined();
  });
});

describe('an attribution decision is undoable from the console (FRM-T-18.14)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers Undo on a confirm, and puts the proposal back through POST /api/undo', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      return answer(200, {});
    });
    const { shown, toast } = recorder();
    const undone = new Promise<void>((resolve) => {
      void runMutation(
        {
          subject: 'abc1234 → BND-T-1.1',
          run: () => Promise.resolve({ commitSha: 'abc1234', confirmed: true, auditEventIds: ['decision'] }),
          message: () => 'abc1234 confirmed as BND-T-1.1',
          undone: 'abc1234 is waiting to be reviewed again',
          onUndone: () => { resolve(); },
        },
        toast,
      ).then(() => {
        expect(shown[0]?.action?.label).toBe('Undo');
        shown[0]?.action?.onAction();
      });
    });
    await undone;
    expect(calls).toEqual(['/api/undo/decision']);
    expect(shown[1]?.message).toBe('abc1234 is waiting to be reviewed again');
  });
});
