import { Card, Cluster, EmptyState, Grid, Page, Section, Skeleton, Stack } from '@d3cloud/ui';
import { api, type PhaseRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { percentClosed } from '../lib/completion';
import { ProjectHeader } from '../components/ProjectHeader';
import { plainText } from '../lib/text';
import { Donut, Pill, SegmentBar } from '../ui/viz';
import { phaseStatusTone, SERIES } from '../ui/tone';

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
 */

/**
 * A phase with its task counts, as the server counted them (FRM-REQ-242). The browser counts
 * nothing here: it used to tally one page of `/tasks`, capped at 200, so a project of 212 tasks
 * drew its last phases as empty while the overview said 8 of 12.
 */
export interface PhaseWithProgress extends PhaseRow {
  readonly tasks: { readonly done: number; readonly cancelled: number; readonly total: number };
}

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
    <Card padding="md" href={`/projects/${code}/phases/${phase.humanId}`} interactive>
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
            <Pill tone={phaseStatusTone(phase.status)}>{phase.status}</Pill>
          </Cluster>
          <span className="fm-card__title">{plainText(phase.name)}</span>
          <span className="fm-muted">
            {total === 0
              ? 'No tasks'
              : `${String(done)} of ${String(total)} done${cancelled === 0 ? '' : `, ${String(cancelled)} cancelled`}`}
            {phase.size === null ? '' : ` · ${phase.size}`}
          </span>
          {/* Worth saying out loud: a phase with no exit demo has no definition of done. */}
          {phase.exitDemo === null && <Pill tone="warning" dot>no exit demo</Pill>}
        </Stack>
      </Cluster>
    </Card>
  );
}

export function Phases({ code }: { code: string }) {
  const phases = useAsync(
    () => api.get<{ items: PhaseWithProgress[] }>(`/api/projects/${code}/phase-progress`),
    [code],
  );

  const items = phases.state.status === 'ready' ? phases.state.value.items : [];

  const counted: Counted[] = items.map((phase) => ({
    phase,
    done: phase.tasks.done,
    cancelled: phase.tasks.cancelled,
    total: phase.tasks.total,
  }));

  const complete = items.filter((phase) => phase.status === 'complete').length;
  const active = items.filter((phase) => phase.status === 'active').length;
  const cancelled = items.filter((phase) => phase.status === 'cancelled').length;
  const parked = items.filter((phase) => phase.status === 'parked').length;
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
          </Section>

          <Grid minItemWidth="md">
            {counted.map((row) => (
              <PhaseCard key={row.phase.humanId} counted={row} code={code} />
            ))}
          </Grid>
        </Stack>
      )}
    </Page>
  );
}
