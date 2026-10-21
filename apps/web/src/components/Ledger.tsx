import { useId, useState } from 'react';
import { Badge, IconButton } from '@d3cloud/ui';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { FindingsPage, PortfolioRow } from '../lib/api';
import { scopedHref, UNGROUPED } from '../lib/scope';
import { AccentDot } from '../ui/groups';
import {
  breakdown,
  ciTone,
  CRITICAL_PLUS_HIGH,
  plural,
  readAcross,
  readCi,
  readValue,
  rowPlanned,
  type BadgeTone,
  type Signal,
} from '../ui/status';
import { relativeDay } from '../ui/tone';
import './Ledger.css';

/**
 * Home as one portfolio ledger (FRM-T-18.6, FRM-REQ-245, FRM-DA-006, board D-06).
 *
 * Three pieces, read top to bottom: a compact strip of figures for the scope, one ungrouped
 * "Needs you" strip across every group, and — in `Home` — a ledger per group. A ledger row is one
 * project: code, name and lifecycle; its active phase with how many of its tasks are closed; the next
 * task; drift; what needs the operator; and CI, including **never**. Deployed-versus-main and last
 * activity are in the row's disclosure, not columns.
 *
 * Everything a row says is read from the portfolio row: the console makes no call per project, and
 * `foreman_portfolio` carries the same fields, so the two answer identically.
 *
 * **Colour is never the only signal.** A signal is a word first; the tone only says how loudly. And
 * nothing here is green: a clean figure is neutral (FRM-REQ-241).
 */

/** What the "Needs you" figure links to. */
export const NEEDS_YOU_ID = 'needs-you';
/** The first ledger on Home, which the CI figure links to. */
export const CI_ANCHOR_ID = 'ci';

// ─── Reading a row ─────────────────────────────────────────────────────────

export type CiWord = 'passing' | 'failing' | 'other' | 'never';

/** The served `ciState`, falling back to what `ci` says for a row that predates it. */
export function ciWordOf(row: PortfolioRow): CiWord {
  if (row.ciState !== undefined) return row.ciState;
  if (row.ci.unknown) return 'never';
  if (ciTone(row.ci.conclusion, false) === 'danger') return 'failing';
  return row.ci.conclusion === 'success' ? 'passing' : 'other';
}

/** The next task, with an absent field (a row that predates it) read as none. */
function nextOf(row: PortfolioRow): { humanId: string; title: string } | null {
  return row.nextTask ?? null;
}

export function taskTotal(row: PortfolioRow): number {
  return row.tasks.open + row.tasks.blocked + row.tasks.done + row.tasks.cancelled;
}

/** One thing that needs the operator, as a link to the list that shows it. */
export interface Reason {
  readonly key: 'critical' | 'blocked' | 'ci' | 'review';
  readonly label: string;
  readonly tone: BadgeTone;
  readonly href: string;
}

/**
 * Why a project needs you: critical or high findings, blocked work, a failing CI run, proposals
 * waiting for review. `withCi` is false in a ledger row, which has a CI column of its own.
 *
 * The findings list takes no project filter, so the link narrows to the project's family — a list
 * the project's findings are in — rather than to a page that does not exist.
 */
export function reasonsOf(row: PortfolioRow, withCi: boolean): Reason[] {
  const reasons: Reason[] = [];
  if (row.openCriticals > 0) {
    reasons.push({
      key: 'critical',
      label: `${String(row.openCriticals)} ${CRITICAL_PLUS_HIGH.toLowerCase()}`,
      tone: 'danger',
      href: scopedHref('/findings', row.group?.slug ?? UNGROUPED),
    });
  }
  if (row.tasks.blocked > 0) {
    reasons.push({
      key: 'blocked',
      label: `${String(row.tasks.blocked)} blocked`,
      tone: 'danger',
      href: `/projects/${row.code}/phases`,
    });
  }
  if (withCi && ciWordOf(row) === 'failing') {
    reasons.push({ key: 'ci', label: 'CI failing', tone: 'danger', href: `/projects/${row.code}/activity` });
  }
  if (row.unconfirmedAttributions > 0) {
    reasons.push({
      key: 'review',
      label: `${String(row.unconfirmedAttributions)} to review`,
      tone: 'warning',
      href: `/projects/${row.code}/activity`,
    });
  }
  return reasons;
}

export interface NeedsYouItem {
  readonly row: PortfolioRow;
  readonly reasons: readonly Reason[];
}

/** The projects that need you, across groups: the loudest first, then by how much, then by code. */
export function needsYouOf(rows: readonly PortfolioRow[]): NeedsYouItem[] {
  const loud = (item: NeedsYouItem) => (item.reasons.some((reason) => reason.tone === 'danger') ? 0 : 1);
  return rows
    .map((row) => ({ row, reasons: reasonsOf(row, true) }))
    .filter((item) => item.reasons.length > 0)
    .sort(
      (a, b) =>
        loud(a) - loud(b) || b.reasons.length - a.reasons.length || a.row.code.localeCompare(b.row.code),
    );
}

/** The figures for whatever rows are in view. One derivation: the strip and the stat cards read it. */
export function figuresOf(rows: readonly PortfolioRow[]) {
  const building = rows.filter((row) => row.lifecycle === 'building');
  const criticals = rows.reduce((sum, row) => sum + row.openCriticals, 0);
  const drift = rows.reduce((sum, row) => sum + row.drift.total, 0);
  const blockedIn = rows.filter((row) => row.tasks.blocked > 0);
  const blocked = rows.reduce((sum, row) => sum + row.tasks.blocked, 0);
  const unplanned = rows.filter((row) => !rowPlanned(row)).map((row) => row.code);
  const noTasks = rows.filter((row) => taskTotal(row) === 0);
  const ci = readCi(rows);
  const blockedSignal = readAcross(blocked, { unmeasured: noTasks.map((row) => row.code), total: rows.length });
  const driftSignal = readAcross(drift, { unmeasured: unplanned, total: rows.length });
  // Codes never go inside a figure that is a link: its accessible name is all of its text. They are
  // said once, beneath, as plain text.
  const notes = [
    building.length === 0 ? null : `Building: ${building.map((row) => row.code).join(', ')}`,
    blockedIn.length === 0
      ? null
      : `Blocked in: ${blockedIn.map((row) => `${row.code} (${String(row.tasks.blocked)})`).join(', ')}`,
    unplanned.length === 0 ? null : `No plan yet: ${unplanned.join(', ')}`,
    ci.silent.length === 0 ? null : `Never sent a CI result: ${ci.silent.join(', ')}`,
    ci.failing.length === 0 ? null : `CI failing: ${ci.failing.join(', ')}`,
  ].filter((line): line is string => line !== null);
  return { building, criticals, drift, blockedIn, blocked, unplanned, noTasks, ci, blockedSignal, driftSignal, notes };
}

/** The CI figure's detail without project codes — those go in the notes line. */
export function ciDetail(ci: ReturnType<typeof readCi>): string {
  const parts: string[] = [];
  if (ci.failing.length > 0) parts.push(`${plural(ci.failing.length, 'project is', 'projects are')} failing`);
  if (ci.silent.length > 0) {
    parts.push(`${plural(ci.silent.length, 'project has', 'projects have')} never sent a CI result`);
  }
  if (parts.length === 0) parts.push(ci.total === 0 ? 'No projects to report.' : 'Every project reports, none failing.');
  return parts.join(' · ');
}

// ─── The stat strip ────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  foot,
  signal,
  href,
}: {
  label: string;
  value: string | number;
  foot: string;
  signal?: Signal;
  href?: string;
}) {
  const body = (
    <>
      <span className="fm-sstat__label">{label}</span>
      <span className="fm-sstat__row">
        <span className="fm-sstat__value">{value}</span>
        {signal !== undefined && (
          <Badge tone={signal.tone} size="sm" className="fm-badge">
            {signal.label}
          </Badge>
        )}
      </span>
      <span className="fm-sstat__foot">{foot}</span>
    </>
  );
  return href === undefined ? (
    <div className="fm-sstat">{body}</div>
  ) : (
    <a className="fm-sstat fm-sstat--link" href={href}>
      {body}
    </a>
  );
}

/**
 * The compact strip: Projects, Needs you, Critical + high, Blocked tasks, Drift, CI · reporting —
 * each a link to the list it counts, carrying the scope. Each is one of three states (FRM-REQ-241):
 * a zero over projects some of which could not be measured is never "clean".
 */
export function StatStrip({
  rows,
  scope,
  projectsDetail,
  severities = null,
}: {
  rows: readonly PortfolioRow[];
  scope: string | null;
  projectsDetail: string;
  severities?: FindingsPage['counts'] | null;
}) {
  const f = figuresOf(rows);
  const needing = needsYouOf(rows).length;
  const lifecycles = breakdown(
    ['building', 'deployed', 'planned', 'scaffolded', 'parked', 'scrapped'].map((lifecycle) => ({
      n: rows.filter((row) => row.lifecycle === lifecycle).length,
      one: lifecycle,
    })),
    'None yet',
  );
  return (
    <div className="fm-sstrip">
      <div className="fm-sstrip__cells">
        <Stat
          label="Projects"
          value={rows.length}
          foot={`${lifecycles} · ${projectsDetail}`}
          href={scopedHref('/projects', scope)}
        />
        <Stat
          label="Needs you"
          value={needing}
          foot={needing === 0 ? 'Nothing waiting on you' : 'Listed just below'}
          href={`#${NEEDS_YOU_ID}`}
        />
        <Stat
          label={CRITICAL_PLUS_HIGH}
          value={f.criticals}
          signal={readAcross(f.criticals, { unmeasured: [], total: rows.length, severity: 'danger' })}
          foot={
            f.criticals === 0
              ? 'None open'
              : severities === null
                ? `${String(f.criticals)} open`
                : breakdown(
                    [
                      { n: severities.critical, one: 'critical' },
                      { n: severities.high, one: 'high' },
                    ],
                    `${String(f.criticals)} open`,
                  )
          }
          href={scopedHref('/findings', scope)}
        />
        <Stat
          label="Blocked tasks"
          value={readValue(f.blockedSignal, f.blocked)}
          signal={f.blockedSignal}
          foot={
            f.blocked > 0
              ? `in ${plural(f.blockedIn.length, 'project', 'projects')}`
              : f.blockedSignal.state === 'clean'
                ? 'None waiting'
                : `${plural(f.noTasks.length, 'project has', 'projects have')} no tasks yet`
          }
          // The Blocked tab of the findings board (FRM-T-18.7), narrowed to the scope.
          href={scopedHref('/findings?tab=blocked', scope)}
        />
        <Stat
          label="Drift"
          value={readValue(f.driftSignal, f.drift)}
          signal={f.driftSignal}
          foot={
            f.drift > 0
              ? 'Plan and reality apart'
              : f.unplanned.length === 0
                ? 'Plan and reality agree'
                : `${plural(f.unplanned.length, 'project has', 'projects have')} no plan yet`
          }
          href={scopedHref('/drift', scope)}
        />
        <Stat
          label="CI · reporting"
          value={f.ci.value}
          signal={f.ci.signal}
          foot={ciDetail(f.ci)}
          href={`#${CI_ANCHOR_ID}`}
        />
      </div>
      {f.notes.length > 0 && <p className="fm-muted fm-sstrip__notes">{f.notes.join(' · ')}</p>}
    </div>
  );
}

// ─── Needs you ─────────────────────────────────────────────────────────────

const STRIP_LIMIT = 6;


/**
 * The chips that say why. `compact` is a ledger row's: on a phone a row has room for ONE chip — the
 * most urgent, which `reasonsOf` lists first — so the rest are named as text ("+2 more") and live in
 * the Needs-you strip, where every reason is a link. On a wide screen all chips show.
 */
function ReasonLinks({ reasons, compact = false }: { reasons: readonly Reason[]; compact?: boolean }) {
  return (
    <ul className={`fm-reasons${compact ? ' fm-reasons--compact' : ''}`}>
      {reasons.map((reason) => (
        <li key={reason.key}>
          <a className="fm-reasons__link" href={reason.href}>
            <Badge tone={reason.tone} size="sm" className="fm-badge">
              {reason.label}
            </Badge>
          </a>
        </li>
      ))}
      {compact && reasons.length > 1 && (
        <li className="fm-reasons__more">+{reasons.length - 1} more</li>
      )}
    </ul>
  );
}

/**
 * ONE strip at the top, across every group (FRM-DA-006): the projects with critical or high
 * findings, blocked work, a failing CI run or proposals waiting for review. Not a card per group —
 * what needs you does not respect a family boundary.
 */
export function NeedsYouStrip({ rows }: { rows: readonly PortfolioRow[] }) {
  const titleId = useId();
  const [all, setAll] = useState(false);
  const items = needsYouOf(rows);
  const shown = all ? items : items.slice(0, STRIP_LIMIT);
  const f = figuresOf(rows);
  // "Nothing needs you" over projects that could not be measured is not the whole truth.
  const caveat = [
    f.ci.silent.length > 0 ? `CI is not reported for ${String(f.ci.silent.length)}` : null,
    f.unplanned.length > 0 ? `drift is not measured for ${String(f.unplanned.length)}` : null,
  ].filter((part): part is string => part !== null);

  return (
    <div role="group" aria-labelledby={titleId} className="fm-needsyou" id={NEEDS_YOU_ID}>
      <div className="fm-needsyou__head">
        <h2 id={titleId} className="fm-needsyou__title">
          Needs you
        </h2>
        {items.length > 0 && (
          <Badge tone="attention" size="sm" className="fm-badge">
            {items.length}
          </Badge>
        )}
        <span className="fm-muted">
          {items.length === 0
            ? `Nothing in what is measured${caveat.length === 0 ? '.' : ` — ${caveat.join('; ')}.`}`
            : 'Across every group, worst first.'}
        </span>
      </div>
      {items.length > 0 && (
        <ul className="fm-needsyou__grid">
          {shown.map(({ row, reasons }) => (
            <li key={row.code} className="fm-ny">
              <div className="fm-ny__top">
                <a className="fm-ny__project" href={`/projects/${row.code}`}>
                  <code className="fm-code-chip">{row.code}</code>
                  <span className="fm-truncate">{row.name}</span>
                </a>
                <span className="fm-ny__group">
                  {row.group !== null && <AccentDot accent={row.group.accent} size="sm" />}
                  <span className="fm-truncate">{row.group?.name ?? 'Ungrouped'}</span>
                </span>
              </div>
              <ReasonLinks reasons={reasons} />
              {nextOf(row) !== null && (
                <span className="fm-ny__ctx fm-truncate">
                  Next: {nextOf(row)?.humanId} {nextOf(row)?.title}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {items.length > STRIP_LIMIT && (
        <button
          type="button"
          className="fm-needsyou__more"
          aria-expanded={all}
          onClick={() => {
            setAll(!all);
          }}
        >
          {all ? 'Show fewer' : `Show all ${String(items.length)}`}
        </button>
      )}
    </div>
  );
}

// ─── The ledger ────────────────────────────────────────────────────────────

function phaseCell(row: PortfolioRow) {
  const total = taskTotal(row);
  const closed = row.tasks.done + row.tasks.cancelled;
  if (!rowPlanned(row)) {
    return (
      <>
        <span className="fm-lrow__l1">No plan yet</span>
        <span className="fm-lrow__l2">not measurable yet</span>
      </>
    );
  }
  const label =
    row.phase !== null ? `P-${row.phase.number} · ${row.phase.name}` : total === 0 ? 'Not started' : 'No active phase';
  const width = total === 0 ? 0 : (closed / total) * 100;
  return (
    <>
      {row.phase !== null ? (
        <a className="fm-lrow__l1 fm-lrow__link" href={`/projects/${row.code}/phases/${row.phase.humanId}`} title={label}>
          <span className="fm-truncate">{label}</span>
        </a>
      ) : (
        <span className="fm-lrow__l1">{label}</span>
      )}
      <span className="fm-lrow__bar">
        {/* The words say it; the bar is how fast you see it. Neutral: progress is not a mood (D-016). */}
        <span className="fm-bar" aria-hidden="true">
          <span className="fm-bar__fill" style={{ width: `${String(width)}%` }} />
        </span>
        <span className="fm-lrow__l2">{total === 0 ? 'no tasks yet' : `${String(closed)} of ${String(total)} tasks`}</span>
      </span>
    </>
  );
}

function deployedLine(row: PortfolioRow): string {
  const d = row.deployed;
  if (d === undefined || d === null) return 'Never recorded as deployed.';
  const sha = d.sha.replace(/^sha-/, '').slice(0, 7);
  const when = `deployed ${relativeDay(d.at)}`;
  if (d.ahead === null) return `${sha} ${when}; how far main has moved is unknown, because that SHA is not a commit Foreman has seen.`;
  if (d.ahead === 0) return `${sha} ${when}; main is the same commit.`;
  return `${sha} ${when}; main is ${plural(d.ahead, 'commit', 'commits')} ahead.`;
}

function LedgerRow({ row }: { row: PortfolioRow }) {
  const [open, setOpen] = useState(false);
  const moreId = useId();
  const planned = rowPlanned(row);
  const ci = ciWordOf(row);
  const reasons = reasonsOf(row, false);
  const next = nextOf(row);
  const total = taskTotal(row);
  const closed = row.tasks.done + row.tasks.cancelled;

  return (
    <li className={`fm-lrow${open ? ' fm-lrow--open' : ''}`}>
      <div className="fm-lrow__x">
        <IconButton
          size="sm"
          icon={open ? <ChevronDown /> : <ChevronRight />}
          label={`Show details for ${row.name}`}
          aria-expanded={open}
          aria-controls={moreId}
          onClick={() => {
            setOpen(!open);
          }}
        />
      </div>

      <div className="fm-lrow__project">
        <a className="fm-lrow__l1 fm-lrow__link" href={`/projects/${row.code}`}>
          <code className="fm-code-chip">{row.code}</code>
          <span className="fm-truncate fm-lrow__name">{row.name}</span>
        </a>
        <span className="fm-lrow__l2 fm-lrow__life">{row.lifecycle}</span>
      </div>

      <div className="fm-lrow__phase">{phaseCell(row)}</div>

      <div className="fm-lrow__next">
        {next !== null ? (
          <a className="fm-lrow__link" href={`/tasks/${next.humanId}`} title={`${next.humanId} ${next.title}`}>
            <span className="fm-lrow__id">{next.humanId}</span>
            <span className="fm-lrow__title fm-truncate">{next.title}</span>
          </a>
        ) : (
          <span className="fm-muted">{planned ? 'Nothing ready' : '—'}</span>
        )}
      </div>

      <div className={`fm-lrow__drift${planned && row.drift.total > 0 ? '' : ' fm-lrow__drift--quiet'}`}>
        {planned ? (
          <a className={`fm-lrow__driftlink${row.drift.total > 0 ? ' fm-lrow__driftlink--some' : ''}`} href={`/projects/${row.code}/drift`}>
            {String(row.drift.total)}
            <span className="fm-lrow__unit"> drift</span>
          </a>
        ) : (
          <span className="fm-muted">
            —<span className="fm-visually-hidden"> drift not measurable yet</span>
          </span>
        )}
      </div>

      <div className="fm-lrow__need">
        {reasons.length > 0 ? (
          <ReasonLinks reasons={reasons} compact />
        ) : (
          <span className="fm-muted">
            —<span className="fm-visually-hidden"> nothing needs you here</span>
          </span>
        )}
      </div>

      {/* A phone's line break between the project line and the phase line; hidden elsewhere. */}
      <span className="fm-lrow__br" aria-hidden="true" />

      <div className="fm-lrow__ci">
        <a className="fm-lrow__cilink" href={`/projects/${row.code}/activity`}>
          {/* What CI said, in words (`ciWord`'s "CI cancelled"): a cancelled run is not a pass. */}
          <Badge tone={ciTone(row.ci.conclusion, row.ci.unknown)} size="sm" className="fm-badge">
            <span className="fm-visually-hidden">CI </span>
            {ci === 'other' ? (row.ci.conclusion ?? 'pending').replace(/_/g, ' ') : ci}
          </Badge>
        </a>
      </div>

      <div id={moreId} className="fm-lrow__more" hidden={!open}>
        <dl className="fm-lrow__dl">
          <div>
            <dt>Deployed vs main</dt>
            <dd>{deployedLine(row)}</dd>
          </div>
          <div>
            <dt>Last activity</dt>
            <dd>
              {row.lastActivityAt === null
                ? 'No commits ingested yet.'
                : `Last commit ${relativeDay(row.lastActivityAt)} (${row.lastActivityAt.slice(0, 10)}).`}
            </dd>
          </div>
          <div>
            <dt>Plan</dt>
            <dd>
              {`${row.lifecycle} · ${total === 0 ? 'no tasks yet' : `${String(closed)} of ${String(total)} tasks closed, ${String(row.tasks.open)} open, ${String(row.tasks.blocked)} blocked`}${planned ? ` · ${String(row.drift.total)} drift` : ''}`}
            </dd>
          </div>
        </dl>
        <p className="fm-lrow__acts">
          <a className="fm-lrow__act" href={`/projects/${row.code}`}>
            Open the project
          </a>
          <a className="fm-lrow__act" href={`/projects/${row.code}/drift`}>
            Open its drift
          </a>
        </p>
      </div>
    </li>
  );
}

/**
 * One group's ledger: a header of the six columns and a row per project, in the order given. The
 * header is for the eye; every cell states its own meaning in words, so a screen reader reads a
 * list of projects and not a grid of fragments.
 */
export function Ledger({ rows, anchor }: { rows: readonly PortfolioRow[]; anchor?: string }) {
  return (
    <div className="fm-ledger" id={anchor}>
      <div className="fm-ledger__head" aria-hidden="true">
        <span className="fm-lrow__x" />
        <span className="fm-lrow__project">Project</span>
        <span className="fm-lrow__phase">Active phase</span>
        <span className="fm-lrow__next">Next task</span>
        <span className="fm-lrow__drift">Drift</span>
        <span className="fm-lrow__need">Needs you</span>
        <span className="fm-lrow__ci">CI</span>
      </div>
      <ul className="fm-ledger__rows">
        {rows.map((row) => (
          <LedgerRow key={row.code} row={row} />
        ))}
      </ul>
    </div>
  );
}
