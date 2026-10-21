import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime } from './text';
import { plural } from '../ui/status';

describe('formatDate / formatDateTime', () => {
  const shape = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  it('prints one shape: the operator’s locale, an explicit year-month-day', () => {
    const at = '2026-08-30T12:00:00.000Z';
    expect(formatDate(at)).toBe(shape.format(new Date(at)));
    expect(formatDate(at)).toMatch(/2026/);
  });

  it('reads a bare calendar day as that day, in any time zone', () => {
    expect(formatDate('2026-08-30')).toBe(
      new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date('2026-08-30T00:00:00Z')),
    );
  });

  it('adds the time of day for an event, and a dash for what it cannot read', () => {
    expect(formatDateTime('2026-08-30T12:00:00.000Z')).toContain(formatDate('2026-08-30T12:00:00.000Z'));
    expect(formatDate('')).toBe('—');
    expect(formatDateTime('not a date')).toBe('—');
  });
});

describe('tripwire pluralisation', () => {
  it('agrees the verb with the count', () => {
    expect(`${plural(1, 'tripwire has', 'tripwires have')} fired`).toBe('1 tripwire has fired');
    expect(`${plural(2, 'tripwire has', 'tripwires have')} fired`).toBe('2 tripwires have fired');
  });
});
