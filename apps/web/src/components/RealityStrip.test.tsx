import { describe, expect, it, vi } from 'vitest';
import type { Brief } from '../lib/api';
import { evidenceLine, readStrip, shortSha } from './RealityStrip';
import { formatDate } from '../lib/text';
import { forgetBrief, onBriefForgotten } from '../lib/project';

/** FRM-T-18.8: the reality strip, read honestly (FRM-REQ-247, FRM-REQ-241, FRM-DA-008). */

const ZERO = {
  'coverage-hole': 0,
  'stale-task': 0,
  'fired-tripwire': 0,
  'failed-exit-gate': 0,
  'orphan-adr': 0,
  'screen-drift': 0,
};

const brief = (over: Partial<Brief> = {}): Brief => ({
  project: { code: 'BND', name: 'Bindery', lifecycle: 'building', pitch: null },
  activePhase: {
    humanId: 'BND-P-9',
    number: '9',
    name: 'Consolidation',
    objective: null,
    exitDemo: null,
    tasks: { done: 8, cancelled: 0, total: 12 },
  },
  nextTasks: [],
  blocked: [],
  openCriticals: [],
  openCriticalTotal: 0,
  ci: { conclusion: null, commitSha: null, at: null, unknown: true },
  unconfirmedAttributions: 0,
  drift: { counts: ZERO, total: 0 },
  recentCommits: [],
  evidence: { doneWithCommit: 5, done: 8, since: '2026-08-29T10:00:00.000Z' },
  deployed: { sha: 'sha-3f8e21c', at: '2026-08-30T09:00:00.000Z', ahead: 4 },
  ...over,
});

const FULL_PLAN = { phases: 3, requirements: 20, tasks: 40, openFindings: 0 };
const cell = (cells: ReturnType<typeof readStrip>, key: string) => {
  const found = cells.find((c) => c.key === key);
  if (found === undefined) throw new Error(`no ${key} cell`);
  return found;
};

describe('the evidenced fraction', () => {
  it('is a neutral sentence with the date attribution began, not a percentage', () => {
    expect(evidenceLine({ doneWithCommit: 5, done: 8, since: '2026-08-29T10:00:00.000Z' }, 8)).toBe(
      `5 of 8 done tasks have a commit · attribution since ${formatDate('2026-08-29T10:00:00.000Z')}`,
    );
  });

  it('says how many done tasks predate attribution rather than counting them against it', () => {
    expect(evidenceLine({ doneWithCommit: 3, done: 4, since: '2026-08-29T10:00:00.000Z' }, 8)).toBe(
      `3 of 4 done tasks have a commit · attribution since ${formatDate('2026-08-29T10:00:00.000Z')} · 4 done before attribution began`,
    );
  });

  it('with no attribution yet has nothing to compare, and says so', () => {
    expect(evidenceLine({ doneWithCommit: 0, done: 0, since: null }, 8)).toContain('no commit attributed yet');
  });

  it('is silent when the brief predates it', () => {
    expect(evidenceLine(undefined, 8)).toBeNull();
  });
});

describe('the strip', () => {
  it('carries phase, declared vs evidenced, drift, critical + high, CI and deployed vs main', () => {
    const cells = readStrip('BND', brief(), FULL_PLAN);
    expect(cells.map((c) => c.key)).toEqual(['phase', 'tasks', 'drift', 'findings', 'ci', 'deployed']);
    expect(cell(cells, 'phase')).toMatchObject({
      value: 'P-9 Consolidation',
      detail: 'BND-P-9 · 4 tasks open',
      href: '/projects/BND/phases/BND-P-9',
    });
    expect(cell(cells, 'tasks')).toMatchObject({ value: '8 of 12 done', tone: 'neutral' });
    expect(cell(cells, 'tasks').detail).toContain('5 of 8 done tasks have a commit');
    expect(cell(cells, 'deployed')).toMatchObject({ value: '3f8e21c', detail: `main +4 · ${formatDate('2026-08-30T09:00:00.000Z')}` });
  });

  it('never makes evidence red, however little there is', () => {
    const cells = readStrip('BND', brief({ evidence: { doneWithCommit: 0, done: 8, since: '2026-08-29T00:00:00Z' } }), FULL_PLAN);
    expect(cell(cells, 'tasks').tone).toBe('neutral');
  });

  it('reads CI that never reported as never reported, neutral, and not as passing', () => {
    const ci = cell(readStrip('BND', brief(), FULL_PLAN), 'ci');
    expect(ci).toMatchObject({ value: 'never reported', detail: 'no run has posted', tone: 'neutral', muted: true });
  });

  it('spends danger on a failing run and on open critical findings, and nowhere green', () => {
    const cells = readStrip(
      'BND',
      brief({
        ci: { conclusion: 'failure', commitSha: 'abcdef0123', at: '2026-10-01T00:00:00Z', unknown: false },
        openCriticals: [{ humanId: 'BND-CR-1', severity: 'critical', title: 't', location: null }],
        openCriticalTotal: 1,
      }),
      FULL_PLAN,
    );
    expect(cell(cells, 'ci')).toMatchObject({ value: 'failure', tone: 'danger' });
    expect(cell(cells, 'findings')).toMatchObject({ value: '1', tone: 'danger' });
    for (const c of cells) expect(['neutral', 'attention', 'warning', 'danger']).toContain(c.tone);
  });

  it('shows the true total of open critical and high findings, not the length of the capped list', () => {
    const listed = Array.from({ length: 5 }, (_, i) => ({
      humanId: `BND-CR-${String(i)}`,
      severity: 'high',
      title: 't',
      location: null,
    }));
    const findings = cell(readStrip('BND', brief({ openCriticals: listed, openCriticalTotal: 17 }), FULL_PLAN), 'findings');
    expect(findings).toMatchObject({ value: '17', tone: 'danger' });
    expect(findings.value).not.toContain('+');
  });

  it('does not read drift as clean for a project with no plan (FRM-REQ-241)', () => {
    const drift = cell(readStrip('BND', brief(), { phases: 0, requirements: 0, tasks: 0, openFindings: 0 }), 'drift');
    expect(drift).toMatchObject({ value: '—', detail: 'not measurable yet', muted: true });
  });

  it('does not read drift as clean for a project with only a phase: most checks could not run', () => {
    const drift = cell(readStrip('BND', brief(), { phases: 1, requirements: 0, tasks: 0, openFindings: 0 }), 'drift');
    expect(drift.detail).not.toBe('clean');
    expect(drift.value).toBe('—');
  });

  it('does not read drift as clean when the plan could not be read at all', () => {
    expect(cell(readStrip('BND', brief(), null), 'drift').detail).toBe('not measurable yet');
  });

  it('names how many kinds of drift there are when there is some', () => {
    const drift = cell(
      readStrip('BND', brief({ drift: { counts: { ...ZERO, 'stale-task': 2, 'orphan-adr': 1 }, total: 3 } }), FULL_PLAN),
      'drift',
    );
    expect(drift).toMatchObject({ value: '3', tone: 'warning' });
    expect(drift.detail).toBe('2 kinds · needs you');
  });

  it('says plainly when nothing is deployed, or main has not moved, or the deployed commit is unknown', () => {
    const at = (deployed: Exclude<Brief['deployed'], undefined>) => cell(readStrip('BND', brief({ deployed }), FULL_PLAN), 'deployed');
    expect(at(null)).toMatchObject({ value: 'not recorded', muted: true });
    expect(at({ sha: 'sha-3f8e21c', at: '2026-08-30T00:00:00Z', ahead: 0 }).detail).toBe(`main is deployed · ${formatDate('2026-08-30T00:00:00Z')}`);
    expect(at({ sha: 'sha-3f8e21c', at: '2026-08-30T00:00:00Z', ahead: null }).detail).toBe(`main unknown · ${formatDate('2026-08-30T00:00:00Z')}`);
  });

  it('shortens an image tag or digest to seven characters', () => {
    expect(shortSha('sha-3f8e21c9d0')).toBe('3f8e21c');
    expect(shortSha('sha256:abcdef0123456789')).toBe('abcdef0');
  });

  it('says there is no phase when none is in flight', () => {
    const cells = readStrip('BND', brief({ activePhase: null }), FULL_PLAN);
    expect(cell(cells, 'phase')).toMatchObject({ value: 'No phase active', muted: true });
    expect(cell(cells, 'tasks').value).toBe('—');
  });
});

/** A rename forgets the cached brief; whatever shows it must be told (FRM-T-18.8). */
describe('forgetting a brief', () => {
  it('tells every subscriber which project, and stops once unsubscribed', () => {
    const heard = vi.fn();
    const off = onBriefForgotten(heard);
    forgetBrief('BND');
    expect(heard).toHaveBeenCalledWith('BND');
    off();
    forgetBrief('BND');
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
