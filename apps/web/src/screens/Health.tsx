import {
  Alert,
  Badge,
  Cluster,
  EmptyState,
  Grid,
  Page,
  PageHeader,
  Section,
  Skeleton,
  Stack,
  Table,
} from '@d3cloud/ui';
import { foreman, type HealthReport, type TechRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { Pill, SegmentBar, StatCard } from '../ui/viz';
import { relativeDay, SERIES } from '../ui/tone';
import { priorityColumns, usePhone, type PriorityColumn } from '../ui/tablePriority';

/**
 * S-26 and S-07 — is Foreman itself well, and what is everything made of.
 *
 * The health half exists so an alert has somewhere to point (T-7.4 before T-7.5): an email saying
 * "the queue has stalled" is only useful if there is a screen that shows what it stalled on.
 */

const when = (iso: string | null): string =>
  iso === null ? 'never' : new Date(iso).toLocaleString();

function Problems({ report }: { report: HealthReport }) {
  if (report.ok) {
    return (
      <Alert tone="info" title="Everything is running">
        The queue is moving, the nightly dump is current, and the restore drill has been performed.
      </Alert>
    );
  }
  return (
    <Alert
      tone="danger"
      title={
        report.problems.length === 1
          ? 'One thing needs attention'
          : `${String(report.problems.length)} things need attention`
      }
    >
      <Stack gap="4" as="ul">
        {report.problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </Stack>
    </Alert>
  );
}

export function Health() {
  const health = useAsync(() => foreman.healthReport(), []);
  const tech = useAsync(() => foreman.tech(), []);

  // Below 768px: the technology is the title and how many versions it is on stays as the status;
  // its kind and who uses it fold into the sub-line (FRM-REQ-249).
  const techColumns: PriorityColumn<TechRow>[] = [
    { key: 'name', header: 'Technology', width: '14rem', sortable: true, phone: 'host', cell: (row) => row.name },
    { key: 'category', header: 'Kind', width: '9rem', phone: 'fold', foldLabel: '', cell: (row) => row.category },
    {
      key: 'projects',
      header: 'Used by',
      phone: 'fold',
      cell: (row) =>
        row.projects
          .map((p) => `${p.code}${p.version === null ? '' : ` ${p.version}`}`)
          .join(' · '),
    },
    {
      key: 'spread',
      header: 'Versions',
      width: '7rem',
      phoneWidth: '6rem',
      numeric: true,
      cell: (row) => {
        const versions = new Set(row.projects.map((p) => p.version ?? 'unknown'));
        return versions.size > 1 ? (
          // Four projects on three versions of one thing is a fact nobody notices until one of
          // them cannot be upgraded.
          <Badge tone="attention">{versions.size}</Badge>
        ) : (
          versions.size
        );
      },
    },
  ];

  const columns = priorityColumns(techColumns, usePhone());

  return (
    <Page>
      <PageHeader title="Health" description="Foreman's own state, and what everything is built on." />

      {health.state.status === 'loading' ? (
        <Skeleton lines={8} />
      ) : health.state.status === 'error' ? (
        <EmptyState kind="error" heading="Health did not load">
          {health.state.message}
        </EmptyState>
      ) : (
        <>
          <Stack gap="24">
            <Problems report={health.state.value} />

            {/* The queue, as three figures and a bar. `failed` is the one that turns `/health`
                red, so it gets the tint; waiting work is normal and does not. */}
            <Grid minItemWidth="sm">
              <StatCard
                label="Waiting"
                value={health.state.value.queue.queued}
                tone={health.state.value.queue.stalled ? 'danger' : 'neutral'}
                detail={
                  health.state.value.queue.stalled
                    ? 'Stalled — queued with nothing running'
                    : `Oldest ${relativeDay(health.state.value.queue.oldestQueuedAt)}`
                }
              />
              <StatCard
                label="Running"
                value={health.state.value.queue.running}
                tone="accent"
                detail="In a worker right now"
              />
              <StatCard
                label="Failed"
                value={health.state.value.queue.failed}
                tone={health.state.value.queue.failed === 0 ? 'neutral' : 'danger'}
                detail={
                  health.state.value.queue.failed === 0
                    ? 'Nothing dead-lettered'
                    : 'Out of attempts'
                }
              />
              <StatCard
                label="Restore drill"
                // The one that matters: an untested backup is not a backup (R-04).
                value={relativeDay(health.state.value.lastRestoreDrill)}
                tone={health.state.value.lastRestoreDrill === null ? 'danger' : 'neutral'}
                detail={
                  health.state.value.lastRestoreDrill === null
                    ? 'Never performed'
                    : 'Last proved recoverable'
                }
              />
            </Grid>

            <Grid minItemWidth="md">
              <Section title="The queue" surface="card">
                <SegmentBar
                  segments={[
                    { label: 'Running', value: health.state.value.queue.running, color: SERIES.active },
                    { label: 'Waiting', value: health.state.value.queue.queued, color: SERIES.waiting },
                    { label: 'Failed', value: health.state.value.queue.failed, color: SERIES.blocked },
                  ]}
                />
              </Section>

              <Section title="Last seen" surface="card">
                <Stack gap="6">
                  <Seen label="Ingest" at={health.state.value.lastIngest} />
                  <Seen label="Reconcile" at={health.state.value.lastReconcile} />
                  <Seen
                    label="Backup"
                    at={health.state.value.lastBackup?.at ?? null}
                    extra={
                      health.state.value.lastBackup === null
                        ? undefined
                        : `${String(Math.round(health.state.value.lastBackup.bytes / 1024))} KiB`
                    }
                  />
                  <Seen label="Restore drill" at={health.state.value.lastRestoreDrill} />
                </Stack>
              </Section>
            </Grid>

            {health.state.value.stageFailures.length > 0 && (
              <Section
                title="Recent stage failures"
                surface="card"
                description="A stage that failed is a stage that can be replayed alone."
              >
                <Stack gap="8">
                  {health.state.value.stageFailures.map((failure) => (
                    <div
                      key={`${failure.jobKind}:${failure.stage}:${failure.at}`}
                      className="fm-item fm-item--stacked"
                    >
                      <Cluster gap="8" align="center">
                        <Pill tone="danger" dot>
                          {failure.jobKind}
                        </Pill>
                        <code className="fm-item__id">{failure.stage}</code>
                        <span className="fm-muted">{when(failure.at)}</span>
                      </Cluster>
                      <span className="fm-muted">{failure.error}</span>
                    </div>
                  ))}
                </Stack>
              </Section>
            )}
          </Stack>
        </>
      )}

      <Section title="What everything is built on" surface="card">
        {tech.state.status !== 'ready' ? (
          <Skeleton lines={5} />
        ) : (
          <Stack gap="12">
            {tech.state.value.disagreements.length === 0 ? null : (
              <Alert
                tone="warning"
                title={`${String(tech.state.value.disagreements.length)} technologies are on different versions`}
              >
                {tech.state.value.disagreements.map((row) => row.name).join(', ')}
              </Alert>
            )}
            <Table
              caption="Technologies across every project"
              captionHidden
              density="compact"
              columns={columns}
              rows={tech.state.value.items}
              rowKey={(row) => row.name}
              empty={
                <EmptyState kind="empty" size="inline" heading="Nothing inventoried yet">
                  No project has recorded what it is built on.
                </EmptyState>
              }
            />
          </Stack>
        )}
      </Section>
    </Page>
  );
}

/** One "when did this last happen" row. An em dash is never "just now". */
function Seen({ label, at, extra }: { label: string; at: string | null; extra?: string | undefined }) {
  return (
    <div className="fm-fact">
      <span className="fm-fact__label">{label}</span>
      <span className={at === null ? 'fm-fact__value fm-fact__value--warning' : 'fm-fact__value'}>
        {at === null ? 'never' : relativeDay(at)}
        {extra === undefined ? '' : ` · ${extra}`}
      </span>
    </div>
  );
}
