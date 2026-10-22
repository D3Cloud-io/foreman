import { describe, expect, it } from 'vitest';
import {
  breakdown,
  checkMeasurable,
  ciTone,
  ciWord,
  CLEAN,
  CRITICAL_PLUS_HIGH,
  lifecycleTone,
  measurable,
  NOT_MEASURABLE,
  phaseStatusTone,
  readAcross,
  readCi,
  readCount,
  readValue,
  rowPlanned,
  severityTone,
  taskStatusTone,
} from './status';

/** FRM-REQ-241: every signal is needs you, clean, or not measurable yet — never clean unmeasured. */
describe('a count, read honestly', () => {
  it('needs you when anything is there, in the severity asked for', () => {
    expect(readCount(3, { measured: true, severity: 'danger' })).toMatchObject({ state: 'needs-you', tone: 'danger', label: 'needs you' });
    expect(readCount(1, { measured: true })).toMatchObject({ state: 'needs-you', tone: 'warning' });
  });

  it('is clean, and neutral, only when the check could run and found nothing', () => {
    expect(readCount(0, { measured: true })).toEqual(CLEAN);
    expect(CLEAN.tone).toBe('neutral');
  });

  it('is not measurable yet when it could not run, and a zero does not make it clean', () => {
    expect(readCount(0, { measured: false })).toEqual(NOT_MEASURABLE);
    expect(NOT_MEASURABLE.label).toBe('not measurable yet');
    expect(readValue(NOT_MEASURABLE, 0)).toBe('—');
    expect(readValue(CLEAN, 0)).toBe('0');
  });

  it('still needs you when something is found, even on a project with no plan', () => {
    expect(readCount(2, { measured: false }).state).toBe('needs-you');
  });
});

describe('a count across projects', () => {
  it('is clean only when every project was measured', () => {
    expect(readAcross(0, { unmeasured: [], total: 8 }).state).toBe('clean');
    expect(readAcross(0, { unmeasured: ['PW'], total: 8 }).state).toBe('not-measurable');
    expect(readAcross(0, { unmeasured: [], total: 0 }).state).toBe('not-measurable');
    expect(readAcross(4, { unmeasured: ['PW'], total: 8 }).state).toBe('needs-you');
  });
});

describe('what a plan lets the console measure', () => {
  it('measures nothing for a project with no phase, requirement or task', () => {
    expect(measurable({ phases: 0, requirements: 0, tasks: 0 })).toEqual({
      hasPlan: false,
      drift: false,
      coverage: false,
      blocked: false,
    });
  });

  it('measures what its parts allow', () => {
    expect(measurable({ phases: 1, requirements: 0, tasks: 0 })).toMatchObject({ drift: true, coverage: false, blocked: false });
    expect(measurable({ phases: 0, requirements: 5, tasks: 0 })).toMatchObject({ drift: true, coverage: true, blocked: false });
    expect(measurable({ phases: 1, requirements: 5, tasks: 3 })).toMatchObject({ drift: true, coverage: true, blocked: true });
  });

  it('reads a portfolio row the same way', () => {
    const tasks = { open: 0, blocked: 0, done: 0, cancelled: 0 };
    expect(rowPlanned({ phase: null, tasks })).toBe(false);
    expect(rowPlanned({ phase: { number: '1' }, tasks })).toBe(true);
    expect(rowPlanned({ phase: null, tasks: { ...tasks, done: 2 } })).toBe(true);
  });
});

describe('CI across projects', () => {
  const row = (code: string, conclusion: string | null, unknown = false) => ({ code, ci: { conclusion, unknown } });

  it('says "N of M" and is never clean while any project is unreported', () => {
    const reading = readCi([row('FRM', 'success'), ...['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((c) => row(c, null, true))]);
    expect(reading.value).toBe('1 of 8');
    expect(reading.signal).toEqual(NOT_MEASURABLE);
    expect(reading.silent).toHaveLength(7);
    expect(reading.detail).toContain('7 projects have never sent a CI result');
  });

  it('is clean, neutral, only when every project reports and none fails', () => {
    const reading = readCi([row('A', 'success'), row('B', 'success')]);
    expect(reading.value).toBe('2 of 2');
    expect(reading.signal).toEqual(CLEAN);
  });

  it('needs you for a failure, even beside unreported projects', () => {
    const reading = readCi([row('A', 'failure'), row('B', null, true)]);
    expect(reading.signal).toMatchObject({ state: 'needs-you', tone: 'danger' });
    expect(reading.failing).toEqual(['A']);
  });

  it('is not measurable with no projects at all', () => {
    expect(readCi([]).signal.state).toBe('not-measurable');
  });

  it('tones one project: unknown and success are neutral, a failure is danger, pending is warning', () => {
    expect(ciTone(null, true)).toBe('neutral');
    expect(ciTone('success', false)).toBe('neutral');
    expect(ciTone('failure', false)).toBe('danger');
    expect(ciTone('timed_out', false)).toBe('danger');
    expect(ciTone(null, false)).toBe('warning');
    expect(ciWord({ conclusion: 'success', unknown: false })).toBe('CI passing');
    expect(ciWord({ conclusion: null, unknown: true })).toBe('no CI reported');
  });
});

describe('no status is green', () => {
  const tones = ['neutral', 'attention', 'warning', 'danger'];
  it('maps every status onto a Badge tone', () => {
    const all = [
      ...['planned', 'building', 'deployed', 'parked', 'scrapped', 'scaffolded'].map(lifecycleTone),
      ...['planned', 'active', 'complete', 'parked', 'cancelled'].map(phaseStatusTone),
      ...['todo', 'in_progress', 'blocked', 'done', 'cancelled'].map(taskStatusTone),
      ...['critical', 'high', 'medium', 'low'].map(severityTone),
    ];
    for (const tone of all) expect(tones).toContain(tone);
  });

  it('makes deployed, done and complete neutral — finished work is not an alarm or a celebration', () => {
    expect(lifecycleTone('deployed')).toBe('neutral');
    expect(taskStatusTone('done')).toBe('neutral');
    expect(phaseStatusTone('complete')).toBe('neutral');
  });

  it('spends hue only on what needs you', () => {
    expect(taskStatusTone('blocked')).toBe('danger');
    expect(severityTone('critical')).toBe('danger');
    expect(severityTone('high')).toBe('danger');
    expect(severityTone('medium')).toBe('warning');
    expect(phaseStatusTone('active')).toBe('attention');
  });
});

describe('words', () => {
  it('labels the critical and high figure "Critical + high"', () => {
    expect(CRITICAL_PLUS_HIGH).toBe('Critical + high');
  });

  it('gives a breakdown of the non-zero parts, or the empty line', () => {
    expect(breakdown([{ n: 1, one: 'critical' }, { n: 2, one: 'high' }], 'none')).toBe('1 critical · 2 high');
    expect(breakdown([{ n: 0, one: 'critical' }], 'none')).toBe('none');
    expect(breakdown([{ n: 2, one: 'task', other: 'tasks' }], 'none')).toBe('2 tasks');
  });
});

describe('which drift checks could run', () => {
  it('needs the right part of the plan for each check', () => {
    const onlyTask = { phases: 0, requirements: 0, tasks: 1 };
    expect(checkMeasurable('stale-task', onlyTask)).toBe(true);
    expect(checkMeasurable('failed-exit-gate', onlyTask)).toBe(false);
    expect(checkMeasurable('coverage-hole', { phases: 1, requirements: 0, tasks: 0 })).toBe(false);
    expect(checkMeasurable('orphan-adr', { phases: 0, requirements: 0, tasks: 0 })).toBe(false);
    expect(checkMeasurable('orphan-adr', onlyTask)).toBe(true);
  });
});
