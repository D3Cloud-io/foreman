import { Badge, Card, Cluster, EmptyState, Grid, Link, Page, Section, Skeleton, Stack } from '@d3cloud/ui';
import { foreman, type PhaseRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { percentClosed } from '../lib/completion';
import { ProjectHeader } from '../components/ProjectHeader';
import { plainText } from '../lib/text';
import { Donut, SegmentBar } from '../ui/viz';
import { SERIES } from '../ui/tone';
import { phaseStatusTone, plural } from '../ui/status';

/**
 * S-10 — the phases of one project.
 *
 * **Ordered by build order, not by number**, and it defaults to that. Bindery built 0 through 8.5,
 * then 9 to 11, then 13 to 16, with 12 still ahead: sorting these numerically would put a phase
 * nobody has started in the middle of the finished ones.
 *
 * Twenty-two phases as twenty-two table rows told you their names and made you compute the shape
 * of the project yourself — a `8 / 8` in a cell is a fraction you have to divide. Each phase is a
 * card with a ring now, and the strip at the top is the whole project in one bar.
 *
 * **A phase shows the server's status, word for word** (FRM-ADR-018, FRM-DA-002) — never a status
 * the client worked out for itself — and a missing exit demo is a neutral chip beside it that links
 * to Drift, where the absence is counted. Neither is coloured: a complete phase is neither an alarm
 * nor a celebration.
 */

interface Counted {
  readonly phase: PhaseRow;
  readonly done: number;
  readonly cancelled: number;
  readonly total: number;
}

export function PhaseCard({ counted, code }: { counted: Counted; code: string }) {
  const { phase, done, cancelled, total } = counted;
  const percent = percentClosed(done, cancelled, total);

  return (
    <Card padding="md">
      <Cluster gap="16" align="center">
        <Donut
          size={72}
          segments={[
            { label: 'Done', value: done, color: SERIES.done },
            { label: 'Cancelled', value: cancelled, color: SERIES.quiet },
            {
              label: 'Remaining',
              value: Math.max(0, total - done - cancelled),
              color: SERIES.waiting,
            },
          ]}
          label={total === 0 ? '—' : `${String(percent)}%`}
        />
        <Stack gap="4" className="fm-grow">
          <Cluster gap="8" align="center" justify="between">
            <span className="fm-phase__number">Phase {phase.number}</span>
            <Badge tone={phaseStatusTone(phase.status)} size="sm">
              {phase.status}
            </Badge>
          </Cluster>
          <Link href={`/projects/${code}/phases/${phase.humanId}`}>
            <span className="fm-card__title">{plainText(phase.name)}</span>
          </Link>
          <span className="fm-muted">
            {total === 0
              ? 'No tasks'
              : `${String(done)} of ${String(total)} done${cancelled === 0 ? '' : `, ${String(cancelled)} cancelled`}`}
            {phase.size === null ? '' : ` · ${phase.size}`}
          </span>
          {/* Worth saying out loud: a phase with no exit demo has no definition of done. Neutral,
              and a link to Drift, which is where it is counted. */}
          {phase.exitDemo === null && (
            <a className="fm-chip fm-chip--link fm-chip--quiet" href={`/projects/${code}/drift`}>
              no exit demo
            </a>
          )}
        </Stack>
      </Cluster>
    </Card>
  );
}

/**
 * The open work leads (FRM-T-18.16): active phases first, then parked and planned ones in build
 * order. Finished and cancelled phases need no ring — a wall of identical 100% rings buried the one
 * phase still moving — so they go to one compact row each underneath. A missing exit demo is said
 * once, in the summary above with its link to Drift, not on every finished row.
 */
export function splitPhases<T extends { phase: { status: string } }>(rows: readonly T[]): {
  readonly open: T[];
  readonly closed: T[];
} {
  const closedStatus = new Set(['complete', 'cancelled']);
  const open = rows.filter((row) => !closedStatus.has(row.phase.status));
  // A stable sort keeps build order inside each band.
  const band = (status: string) => (status === 'active' ? 0 : 1);
  open.sort((a, b) => band(a.phase.status) - band(b.phase.status));
  return { open, closed: rows.filter((row) => closedStatus.has(row.phase.status)) };
}

function ClosedPhaseRow({ counted, code }: { counted: Counted; code: string }) {
  const { phase, done, cancelled, total } = counted;
  return (
    <li className="fm-phase-done__row">
      <span className="fm-phase-done__number">Phase {phase.number}</span>
      <Link className="fm-phase-done__name" href={`/projects/${code}/phases/${phase.humanId}`}>
        {plainText(phase.name)}
      </Link>
      {phase.status === 'cancelled' && (
        <Badge tone={phaseStatusTone(phase.status)} size="sm">
          cancelled
        </Badge>
      )}
      <span className="fm-phase-done__count">
        {total === 0 ? 'No tasks' : `${String(done)} of ${String(total)} done`}
        {cancelled === 0 ? '' : `, ${String(cancelled)} cancelled`}
      </span>
    </li>
  );
}

export function Phases({ code }: { code: string }) {
  // Each phase arrives with its task counts, counted by the server over the whole set; this
  // screen counts nothing (FRM-REQ-242).
  const phases = useAsync(() => foreman.phases(code), [code]);

  const items = phases.state.status === 'ready' ? phases.state.value.items : [];

  const counted: Counted[] = items.map((phase) => ({
    phase,
    done: phase.tasks.done,
    cancelled: phase.tasks.cancelled,
    total: phase.tasks.total,
  }));

  const split = splitPhases(counted);
  const complete = items.filter((phase) => phase.status === 'complete').length;
  const active = items.filter((phase) => phase.status === 'active').length;
  const cancelled = items.filter((phase) => phase.status === 'cancelled').length;
  const parked = items.filter((phase) => phase.status === 'parked').length;
  const completeWithoutDemo = items.filter(
    (phase) => phase.status === 'complete' && phase.exitDemo === null,
  ).length;
  const planned = items.length - complete - active - cancelled - parked;

  return (
    <Page>
      <ProjectHeader
        code={code}
        section="phases"
        description="In the order they are being built, which is not the order they are numbered."
        {...(phases.state.status === 'ready'
          ? { count: items.length, countNoun: { one: 'phase', other: 'phases' } }
          : {})}
      />

      {phases.state.status === 'loading' ? (
        <Skeleton lines={5} />
      ) : phases.state.status === 'error' ? (
        <EmptyState kind="error" heading="The phases did not load">
          {phases.state.message}
        </EmptyState>
      ) : items.length === 0 ? (
        <EmptyState kind="empty" heading="No phases yet">
          A project without phases has no plan to compare reality against.
        </EmptyState>
      ) : (
        <Stack gap="24">
          <Section title="The shape of the project" surface="card">
            <SegmentBar
              segments={[
                { label: 'Complete', value: complete, color: SERIES.done },
                { label: 'Active', value: active, color: SERIES.active },
                { label: 'Planned', value: planned, color: SERIES.waiting },
                { label: 'Cancelled', value: cancelled, color: SERIES.quiet },
                { label: 'Parked', value: parked, color: SERIES.warning },
              ]}
            />
            {completeWithoutDemo > 0 && (
              <p className="fm-muted">
                {plural(completeWithoutDemo, 'complete phase has', 'complete phases have')} no exit demo ·{' '}
                <Link variant="inline" href={`/projects/${code}/drift`}>
                  Drift
                </Link>
              </p>
            )}
          </Section>

          {split.open.length > 0 && (
            <Grid minItemWidth="md">
              {split.open.map((row) => (
                <PhaseCard key={row.phase.humanId} counted={row} code={code} />
              ))}
            </Grid>
          )}

          {split.closed.length > 0 && (
            <Section
              title={split.open.length === 0 ? `Every phase is closed · ${String(split.closed.length)}` : `Complete · ${String(split.closed.length)}`}
              surface="card"
            >
              <ul className="fm-phase-done" aria-label="Closed phases">
                {split.closed.map((row) => (
                  <ClosedPhaseRow key={row.phase.humanId} counted={row} code={code} />
                ))}
              </ul>
            </Section>
          )}
        </Stack>
      )}
    </Page>
  );
}
