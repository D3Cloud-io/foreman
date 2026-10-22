import { describe, expect, it } from 'vitest';
import { splitWontFixReasons, WontFixReasonRefused, wontFixReasonAfter } from '../../src/domain/findings.js';
import { acceptedDriftIn } from '../../src/domain/record.js';

/** FRM-T-18.15: what the won't-fix and drift-acceptance moves read, and the reason's one rule. */

describe("splitting appended won't-fix paragraphs off a recommendation", () => {
  it('takes every appended paragraph, curly or straight, and keeps what the reviewer wrote', () => {
    expect(splitWontFixReasons('Scope the select.\n\n**Won’t fix** — one\n\n**Won\'t fix** — two\nlines')).toEqual({
      recommendation: 'Scope the select.',
      reasons: ['one', 'two\nlines'],
    });
    expect(splitWontFixReasons('**Won’t fix** — alone')).toEqual({ recommendation: null, reasons: ['alone'] });
  });

  it('leaves alone a recommendation with none, or one that only mentions it mid-paragraph', () => {
    expect(splitWontFixReasons(null)).toBeNull();
    expect(splitWontFixReasons('Scope the select.')).toBeNull();
    expect(splitWontFixReasons('Say **Won’t fix** — only in a sentence.')).toBeNull();
  });
});

describe('what a write leaves in wont_fix_reason', () => {
  const wontFix = { status: 'wont_fix' as const, wontFixReason: 'old' };
  const open = { status: 'open' as const, wontFixReason: null };

  it('keeps or replaces it while the finding stays wont_fix', () => {
    expect(wontFixReasonAfter('X-CR-001', wontFix, {})).toBe('old');
    expect(wontFixReasonAfter('X-CR-001', wontFix, { wontFixReason: 'new' })).toBe('new');
    expect(wontFixReasonAfter('X-CR-001', open, { status: 'wont_fix', wontFixReason: 'why' })).toBe('why');
  });

  it('clears it when the status moves away, and refuses one sent for any other status', () => {
    expect(wontFixReasonAfter('X-CR-001', wontFix, { status: 'open' })).toBeNull();
    expect(() => wontFixReasonAfter('X-CR-001', open, { wontFixReason: 'why' })).toThrow(WontFixReasonRefused);
    expect(() => wontFixReasonAfter('X-CR-001', wontFix, { status: 'fixed', wontFixReason: 'why' })).toThrow(/wontFixReason/);
  });
});

describe('reading an old acceptance statement', () => {
  it('names the record and the category, and nothing for anything else', () => {
    expect(acceptedDriftIn('Accepted drift on BND-REQ-041 (coverage-hole): A Must with no task.')).toEqual({
      subject: 'BND-REQ-041',
      category: 'coverage-hole',
    });
    expect(acceptedDriftIn('Accepted drift on BND-T-9.1 (stale-task)')).toEqual({ subject: 'BND-T-9.1', category: 'stale-task' });
    expect(acceptedDriftIn('Accepted drift on BND-T-9.1 (made-up)')).toBeNull();
    expect(acceptedDriftIn('We accepted drift on BND-T-9.1 (stale-task)')).toBeNull();
  });
});
