/**
 * The one place a signal becomes a tone and a label (FRM-REQ-241, FRM-DA-002, DS D-016/D-086).
 *
 * Every figure the console reports is in one of three states:
 *
 * - **needs you** — something is there, and seeing it should change what you do next. Spent in
 *   `danger` or `warning`, nowhere else.
 * - **clean** — the check ran, over something that exists, and found nothing. Neutral. Never green:
 *   a healthy tile is not coloured (D-016 amended by D-086).
 * - **not measurable yet** — the check could not run, or only some of what it covers reported. Muted
 *   and neutral, and the detail says what is missing. Never rendered as clean.
 *
 * Tones are `@d3cloud/ui` `Badge` tones and nothing else: neutral, attention, warning, danger. There
 * is no `success` here and no way to ask for one.
 *
 * This module is pure — no React, no fetch — so the rules are tested once, in `status.test.ts`.
 */

/** The tones `Badge` offers. The console invents none of its own. */
export type BadgeTone = 'neutral' | 'attention' | 'warning' | 'danger';

export type SignalState = 'needs-you' | 'clean' | 'not-measurable';

export interface Signal {
  readonly state: SignalState;
  readonly tone: BadgeTone;
  /** The word the badge carries. Colour is never the only signal. */
  readonly label: string;
}

export const LABEL_NEEDS_YOU = 'needs you';
export const LABEL_CLEAN = 'clean';
export const LABEL_NOT_MEASURABLE = 'not measurable yet';

/**
 * The label for the open critical and high findings. The server query, `brief.openCriticals` and the
 * phase exit gate all count critical plus high; only the words on the screen say so.
 */
export const CRITICAL_PLUS_HIGH = 'Critical + high';

export function needsYou(severity: 'danger' | 'warning' = 'warning'): Signal {
  return { state: 'needs-you', tone: severity, label: LABEL_NEEDS_YOU };
}

export const CLEAN: Signal = { state: 'clean', tone: 'neutral', label: LABEL_CLEAN };

export const NOT_MEASURABLE: Signal = {
  state: 'not-measurable',
  tone: 'neutral',
  label: LABEL_NOT_MEASURABLE,
};

/**
 * A count, read honestly. Something there needs you whether or not the plan is complete; nothing
 * there is clean only if the check could run (`measured`) — otherwise it is not measurable yet.
 */
export function readCount(
  count: number,
  options: { measured: boolean; severity?: 'danger' | 'warning' },
): Signal {
  if (count > 0) return needsYou(options.severity ?? 'warning');
  return options.measured ? CLEAN : NOT_MEASURABLE;
}

/**
 * A count summed over several projects. Anything there needs you; nothing there is clean only if
 * **every** project could be measured. A zero over eight projects of which one has no plan is a
 * zero over seven, and "clean" would claim eight — so it is not measurable yet, and `unmeasured`
 * names who is missing.
 */
export function readAcross(
  count: number,
  options: { unmeasured: readonly string[]; total: number; severity?: 'danger' | 'warning' },
): Signal {
  if (count > 0) return needsYou(options.severity ?? 'warning');
  return options.unmeasured.length === 0 && options.total > 0 ? CLEAN : NOT_MEASURABLE;
}

/** What the figure's value shows: the number when it was measured, an em dash when it was not. */
export function readValue(signal: Signal, value: number | string): string {
  return signal.state === 'not-measurable' ? '—' : String(value);
}

export interface PlanCounts {
  readonly phases: number;
  readonly requirements: number;
  readonly tasks: number;
}

/**
 * What the plan lets each project signal measure. Without a phase, a requirement or a task there is
 * nothing to compare with what shipped, and a zero means "not asked" — PW's overview said "No drift"
 * and "Every Must has a task" for a project with neither.
 *
 * - `drift` needs something planned at all.
 * - `coverage` needs a requirement or a task to cover or cite.
 * - `blocked` needs a task to be blocked.
 */
export function measurable(counts: PlanCounts): {
  readonly hasPlan: boolean;
  readonly drift: boolean;
  readonly coverage: boolean;
  readonly blocked: boolean;
} {
  const hasPlan = counts.phases > 0 || counts.requirements > 0 || counts.tasks > 0;
  return {
    hasPlan,
    drift: hasPlan,
    coverage: counts.requirements > 0 || counts.tasks > 0,
    blocked: counts.tasks > 0,
  };
}

/**
 * Is a portfolio row's project planned — an active phase, or any task. The portfolio carries no
 * requirement count, so this is the plan as far as that row can say.
 */
export function rowPlanned(row: {
  readonly phase: unknown;
  readonly tasks: { readonly open: number; readonly blocked: number; readonly done: number; readonly cancelled: number };
}): boolean {
  const tasks = row.tasks.open + row.tasks.blocked + row.tasks.done + row.tasks.cancelled;
  return measurable({ phases: row.phase === null ? 0 : 1, requirements: 0, tasks }).hasPlan;
}

/** "1 critical, 2 high" — the non-zero parts of a breakdown, joined; `empty` when all are zero. */
export function breakdown(
  parts: readonly { readonly n: number; readonly one: string; readonly other?: string }[],
  empty: string,
): string {
  const shown = parts
    .filter((part) => part.n > 0)
    .map((part) => `${String(part.n)} ${part.n === 1 ? part.one : (part.other ?? part.one)}`);
  return shown.length === 0 ? empty : shown.join(' · ');
}

export function plural(n: number, one: string, other: string): string {
  return `${String(n)} ${n === 1 ? one : other}`;
}

// ─── CI ────────────────────────────────────────────────────────────────────

export interface CiRow {
  readonly code: string;
  readonly ci: { readonly conclusion: string | null; readonly unknown: boolean };
}

export interface CiReading {
  /** "1 of 8" — the figure. */
  readonly value: string;
  readonly reporting: number;
  readonly total: number;
  readonly signal: Signal;
  /** Projects whose last result was a failure. */
  readonly failing: readonly string[];
  /** Projects that have never sent a result. */
  readonly silent: readonly string[];
  readonly detail: string;
}

/**
 * CI across a set of projects: how many have reported, and what they said.
 *
 * It is **clean only when every project reported and none failed**. A project nothing was ingested
 * for has not passed, it has not been asked — so while any is silent the tile is "not measurable
 * yet", never "Green". A failure among those that did report still needs you, because the
 * unreported ones cannot make a failure less true.
 */
export function readCi(rows: readonly CiRow[]): CiReading {
  const reported = rows.filter((row) => !row.ci.unknown);
  const failing = reported.filter((row) => isFailure(row.ci.conclusion)).map((row) => row.code);
  const silent = rows.filter((row) => row.ci.unknown).map((row) => row.code);
  const total = rows.length;
  const value = `${String(reported.length)} of ${String(total)}`;

  let signal: Signal;
  if (failing.length > 0) signal = needsYou('danger');
  else if (silent.length > 0 || total === 0) signal = NOT_MEASURABLE;
  else signal = CLEAN;

  const parts: string[] = [];
  if (failing.length > 0) parts.push(`${plural(failing.length, 'project is', 'projects are')} failing: ${failing.join(', ')}`);
  if (silent.length > 0) {
    parts.push(`${plural(silent.length, 'project has', 'projects have')} never sent a CI result: ${silent.join(', ')}`);
  }
  if (parts.length === 0) parts.push(total === 0 ? 'No projects to report.' : 'Every project reports, none failing.');

  return { value, reporting: reported.length, total, signal, failing, silent, detail: parts.join(' · ') };
}

function isFailure(conclusion: string | null): boolean {
  return conclusion === 'failure' || conclusion === 'timed_out';
}

/**
 * One project's CI as a badge tone. `unknown` is not `success`: a project nothing was ingested for
 * has not passed. A pass is neutral — there is no green.
 */
export function ciTone(conclusion: string | null, unknown: boolean): BadgeTone {
  if (unknown) return 'neutral';
  if (isFailure(conclusion)) return 'danger';
  switch (conclusion) {
    case 'success':
    case 'cancelled':
    case 'skipped':
      return 'neutral';
    default:
      return 'warning';
  }
}

/** One project's CI in words. */
export function ciWord(ci: { conclusion: string | null; unknown: boolean }): string {
  if (ci.unknown) return 'no CI reported';
  if (ci.conclusion === 'success') return 'CI passing';
  if (isFailure(ci.conclusion)) return 'CI failing';
  return `CI ${ci.conclusion ?? 'pending'}`;
}

// ─── Entity statuses ───────────────────────────────────────────────────────

/**
 * Lifecycle is a fact about a project, not a call to act: every state is neutral, and the word is
 * the signal. `deployed` and `scrapped` stay apart by being different words (WCAG 1.4.1), not by
 * one of them being green.
 */
export function lifecycleTone(_lifecycle: string): BadgeTone {
  return 'neutral';
}

/**
 * Exactly the server's phase status, toned. `complete` is neutral — done work is not an alarm and
 * not a celebration — and the client never re-derives it (FRM-ADR-018).
 */
export function phaseStatusTone(status: string): BadgeTone {
  return status === 'active' ? 'attention' : 'neutral';
}

export function taskStatusTone(status: string): BadgeTone {
  switch (status) {
    case 'blocked':
      return 'danger';
    case 'in_progress':
      return 'attention';
    default:
      return 'neutral';
  }
}

export function severityTone(severity: string): BadgeTone {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'danger';
    case 'medium':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function findingStatusTone(status: string): BadgeTone {
  return status === 'open' ? 'danger' : 'neutral';
}
