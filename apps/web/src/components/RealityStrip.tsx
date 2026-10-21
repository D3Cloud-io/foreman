import { useEffect } from 'react';
import { Skeleton } from '@d3cloud/ui';
import { foreman, type Brief, type DriftItem, type ProjectDetail } from '../lib/api';
import { briefFor, forgetBrief, onBriefForgotten } from '../lib/project';
import { useAsync } from '../lib/useAsync';
import {
  ciTone,
  checkMeasurable,
  CRITICAL_PLUS_HIGH,
  measurable,
  readCount,
  type BadgeTone,
} from '../ui/status';
import './RealityStrip.css';

/**
 * The reality strip (FRM-REQ-247, board D-08, FRM-DA-008): the single project header's second row.
 *
 * Six cells that answer "where is this project, and does the repo agree" from whichever screen of
 * it you are on: the phase in flight, how much of the done work is *evidenced*, drift, critical and
 * high findings, CI, and what is deployed against main. The overview shows each with its detail
 * line; every other screen shows the compact row.
 *
 * Three rules shape it, and each is a reading the cells below make rather than a style:
 *
 * - **Evidence is a neutral fraction.** "5 of 8 done tasks have a commit, attribution since
 *   2026-08-29" — never a second progress bar and never red. A task finished before attribution
 *   began is left out by the server; the strip says how many.
 * - **A signal is a word first.** Colour is spent only on what needs you; "clean", "never
 *   reported" and "not measurable yet" are neutral, and none of them is ever "green" (D-016/D-086).
 * - **Unmeasured is not clean.** Drift reads the plan's own counts (FRM-REQ-241): a project with no
 *   plan shows "—", and one with only a phase does not claim all six checks ran.
 */

/** The six drift kinds, so the strip does not import a screen (DriftView imports the header). */
const DRIFT_KINDS: readonly DriftItem['category'][] = [
  'coverage-hole',
  'stale-task',
  'fired-tripwire',
  'failed-exit-gate',
  'orphan-adr',
  'screen-drift',
];

/** The server caps the brief's findings list at this many; a list this long may be longer still. */
const BRIEF_FINDINGS_CAP = 5;

export interface Cell {
  readonly key: 'phase' | 'tasks' | 'drift' | 'findings' | 'ci' | 'deployed';
  readonly label: string;
  /** The label on the compact row, where space is the constraint. */
  readonly compactLabel: string;
  readonly value: string;
  /** What the value is read in: a word, so the tone is never the only signal. */
  readonly detail: string | null;
  readonly href: string | null;
  /** Hue is spent on `warning` and `danger` only; `neutral` is plain ink. */
  readonly tone: BadgeTone;
  /** True when the figure is not measured — muted, and never read as clean. */
  readonly muted: boolean;
}

/** An ISO instant as the date the strip shows: `2026-08-30`. Stable across locales. */
export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** A deployed image's SHA as it is read aloud: `sha-3f8e21c…` or a long digest, as seven characters. */
export function shortSha(imageSha: string): string {
  return imageSha.replace(/^sha-/, '').replace(/^sha256:/, '').slice(0, 7);
}

/**
 * "5 of 8 done tasks have a commit · attribution since 2026-08-29" — the evidenced half of the
 * tasks cell, or null when the brief does not carry it. Pure so the wording is tested once.
 */
export function evidenceLine(
  evidence: Brief['evidence'],
  declaredDone: number,
): string | null {
  if (evidence === undefined) return null;
  if (evidence.since === null) return 'no commit attributed yet, so nothing to compare done work with';
  const since = dayOf(evidence.since);
  const predating = Math.max(0, declaredDone - evidence.done);
  const tail = predating > 0 ? ` · ${String(predating)} done before attribution began` : '';
  if (evidence.done === 0) return `no done work since attribution began, ${since}${tail}`;
  const noun = evidence.done === 1 ? 'done task has' : 'done tasks have';
  return `${String(evidence.doneWithCommit)} of ${String(evidence.done)} ${noun} a commit · attribution since ${since}${tail}`;
}

/** How the strip reads one project: the brief, and the plan's own counts for what is measurable. */
export function readStrip(code: string, brief: Brief, counts: ProjectDetail['counts'] | null): Cell[] {
  const phase = brief.activePhase;
  const done = phase?.tasks.done ?? 0;
  const cancelled = phase?.tasks.cancelled ?? 0;
  const total = phase?.tasks.total ?? 0;
  const open = Math.max(0, total - done - cancelled);

  // Drift is clean only when every check could run on what is recorded; unknown counts mean the
  // plan could not be read, so nothing is measurable and no zero reads clean.
  const allChecks = counts !== null && DRIFT_KINDS.every((kind) => checkMeasurable(kind, counts));
  const driftSignal = readCount(brief.drift.total, {
    measured: counts !== null && measurable(counts).drift && allChecks,
  });
  const kinds = DRIFT_KINDS.filter((kind) => brief.drift.counts[kind] > 0).length;

  const criticals = brief.openCriticals.length;
  const ci = brief.ci;
  const deployed = brief.deployed ?? null;

  const tasksDetail = evidenceLine(brief.evidence, done);

  return [
    {
      key: 'phase',
      label: 'In flight',
      compactLabel: 'In flight',
      value: phase === null ? 'No phase active' : `P-${phase.number} ${phase.name}`,
      detail: phase === null ? null : `${phase.humanId} · ${String(open)} ${open === 1 ? 'task' : 'tasks'} open`,
      href: phase === null ? `/projects/${code}/phases` : `/projects/${code}/phases/${phase.humanId}`,
      tone: 'neutral',
      muted: phase === null,
    },
    {
      key: 'tasks',
      label: 'Tasks · declared / evidenced',
      compactLabel: 'Tasks',
      value: total === 0 ? '—' : `${String(done)} of ${String(total)} done`,
      detail: total === 0 ? 'no tasks in the phase' : tasksDetail,
      href: phase === null ? null : `/projects/${code}/phases/${phase.humanId}`,
      tone: 'neutral',
      muted: total === 0,
    },
    {
      key: 'drift',
      label: 'Drift',
      compactLabel: 'Drift',
      value: driftSignal.state === 'not-measurable' ? '—' : String(brief.drift.total),
      detail:
        driftSignal.state === 'needs-you'
          ? `${String(kinds)} ${kinds === 1 ? 'kind' : 'kinds'} · ${driftSignal.label}`
          : driftSignal.label,
      href: `/projects/${code}/drift`,
      tone: driftSignal.tone,
      muted: driftSignal.state === 'not-measurable',
    },
    {
      key: 'findings',
      label: CRITICAL_PLUS_HIGH,
      compactLabel: CRITICAL_PLUS_HIGH,
      value: `${String(criticals)}${criticals >= BRIEF_FINDINGS_CAP ? '+' : ''}`,
      detail: criticals === 0 ? 'none open' : 'open findings',
      href: `/findings?project=${code}`,
      tone: criticals > 0 ? 'danger' : 'neutral',
      muted: false,
    },
    {
      key: 'ci',
      label: 'CI',
      compactLabel: 'CI',
      value: ci.unknown ? 'never reported' : ci.conclusion === 'success' ? 'passing' : (ci.conclusion ?? 'pending').replace(/_/g, ' '),
      detail: ci.unknown
        ? 'no run has posted'
        : [ci.commitSha === null ? null : ci.commitSha.slice(0, 7), ci.at === null ? null : dayOf(ci.at)]
            .filter((part) => part !== null)
            .join(' · '),
      href: `/projects/${code}/activity`,
      tone: ciTone(ci.conclusion, ci.unknown),
      muted: ci.unknown,
    },
    {
      key: 'deployed',
      label: 'Deployed vs main',
      compactLabel: 'Deployed',
      value: deployed === null ? 'not recorded' : shortSha(deployed.sha),
      detail:
        deployed === null
          ? 'no deploy recorded'
          : `${deployed.ahead === null ? 'main unknown' : deployed.ahead === 0 ? 'main is deployed' : `main +${String(deployed.ahead)}`} · ${dayOf(deployed.at)}`,
      href: `/projects/${code}/activity`,
      tone: 'neutral',
      muted: deployed === null,
    },
  ];
}

// ─── Reading it ──────────────────────────────────────────────────────────

/**
 * The plan's counts, by project, held for the session and dropped by `realityChanged`. Small and
 * separate from the brief's cache because only this strip reads them.
 */
const planCounts = new Map<string, Promise<ProjectDetail['counts'] | null>>();

function countsFor(code: string): Promise<ProjectDetail['counts'] | null> {
  const cached = planCounts.get(code);
  if (cached !== undefined) return cached;
  // A project that cannot be read is an unknown plan, not a failed strip: nothing is measurable.
  const pending = foreman.project(code).then(
    (project) => project.counts,
    () => null,
  );
  planCounts.set(code, pending);
  return pending;
}

/** The cells whose detail line the compact row drops: the figure says it. */
const COMPACT_QUIET: ReadonlySet<Cell['key']> = new Set(['phase', 'findings', 'deployed']);

// The plan's counts go stale with the brief: drop them whenever it is forgotten, before any strip
// re-reads. Registered at load, so it runs ahead of every component's own listener.
onBriefForgotten((code) => {
  planCounts.delete(code);
});

/**
 * Say that something the strip reads has changed — a task's status, a requirement's phase, a
 * rename. Drops the cached brief, which tells every mounted heading and strip to re-read in place.
 */
export function realityChanged(code: string): void {
  forgetBrief(code);
}

export function RealityStrip({ code, compact = false }: { code: string; compact?: boolean }) {
  const { state, refresh } = useAsync(
    () => Promise.all([briefFor(code), countsFor(code)]),
    [code],
  );

  useEffect(() => {
    return onBriefForgotten((forgottenCode) => {
      if (forgottenCode === code) refresh();
    });
  }, [code, refresh]);

  const className = compact ? 'fm-reality fm-reality--compact' : 'fm-reality';

  if (state.status === 'loading') {
    // Holds the row's height, so the page under the header does not jump when it arrives.
    return (
      <div className={className} aria-busy="true" aria-label="Reality" role="group">
        <Skeleton lines={compact ? 1 : 2} />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className={className} role="group" aria-label="Reality">
        <span className="fm-muted">The reality strip did not load: {state.message}</span>
      </div>
    );
  }

  const [brief, counts] = state.value;
  return (
    <div className={className} role="group" aria-label="Reality">
      {readStrip(code, brief, counts).map((cell) => {
        const body = (
          <>
            <span className="fm-reality__label">{compact ? cell.compactLabel : cell.label}</span>
            <span
              className={`fm-reality__value fm-reality__value--${cell.muted ? 'muted' : cell.tone}`}
              data-cell={cell.key}
            >
              {cell.value}
            </span>
            {cell.detail !== null && !(compact && COMPACT_QUIET.has(cell.key)) ? (
              <span className="fm-reality__detail">{cell.detail}</span>
            ) : null}
          </>
        );
        return cell.href === null ? (
          <div key={cell.key} className="fm-reality__cell">
            {body}
          </div>
        ) : (
          <a key={cell.key} className="fm-reality__cell" href={cell.href}>
            {body}
          </a>
        );
      })}
    </div>
  );
}
