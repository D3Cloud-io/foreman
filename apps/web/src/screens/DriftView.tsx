import {
  Badge,
  Card,
  Cluster,
  EmptyState,
  Grid,
  Page,
  Section,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { foreman, type DriftItem } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { ProjectHeader } from '../components/ProjectHeader';
import { plainText } from '../lib/text';
import { SegmentBar, StatCard } from '../ui/viz';
import { SERIES } from '../ui/tone';
import { checkMeasurable, measurable, plural, readCount } from '../ui/status';

/**
 * S-23 — drift: where the plan and reality have come apart (FRM-REQ-126).
 *
 * **Three honest states** (FRM-REQ-241). Drift found needs you; every check run and nothing found is
 * "0 drift", neutral — a healthy screen is not coloured; and a project with no plan has nothing to
 * compare, so its six checks did not run and the screen says so rather than reporting "No drift".
 */

export const CATEGORIES: {
  key: DriftItem['category'];
  label: string;
  blurb: string;
  color: string;
}[] = [
  {
    key: 'coverage-hole',
    color: SERIES.warning,
    label: 'Coverage holes',
    blurb: 'A Must with no task, or work citing no requirement.',
  },
  {
    key: 'stale-task',
    color: SERIES.waiting,
    label: 'Stale tasks',
    blurb: 'In progress, with nothing touching it for a fortnight.',
  },
  {
    key: 'fired-tripwire',
    color: SERIES.blocked,
    label: 'Fired tripwires',
    blurb: 'A risk whose named condition has been met.',
  },
  {
    key: 'failed-exit-gate',
    color: SERIES.blocked,
    label: 'Exit gates',
    blurb: 'A phase marked complete that would not pass its gate today.',
  },
  {
    key: 'orphan-adr',
    color: SERIES.info,
    label: 'Orphan ADRs',
    blurb: 'Accepted and uncited, or a chain that loops.',
  },
  {
    key: 'screen-drift',
    color: SERIES.warning,
    label: 'Screens',
    blurb: 'Built unlike its proposal and marked to fix, or built and never captured.',
  },
];

/** What each check needs before it can run — said when it did not (FRM-REQ-241). */
const NEEDS: Record<DriftItem['category'], string> = {
  'coverage-hole': 'Needs requirements or tasks.',
  'stale-task': 'Needs tasks.',
  'fired-tripwire': 'Needs risks with a tripwire.',
  'failed-exit-gate': 'Needs a completed phase.',
  'orphan-adr': 'Needs accepted decisions.',
  'screen-drift': 'Needs registered screens.',
};

/** Where a drifting entity lives, so a row is a link rather than an instruction to go looking. */
function hrefFor(code: string, item: DriftItem): string {
  switch (item.category) {
    case 'coverage-hole':
      return item.humanId.includes('-REQ-')
        ? `/requirements/${item.humanId}`
        : `/tasks/${item.humanId}`;
    case 'stale-task':
      return `/tasks/${item.humanId}`;
    case 'fired-tripwire':
      return `/projects/${code}/risks`;
    case 'failed-exit-gate':
      return `/projects/${code}/phases/${item.humanId}`;
    case 'orphan-adr':
      return `/projects/${code}/adrs`;
    case 'screen-drift':
      return `/projects/${code}/screens/${item.humanId}`;
  }
}

export function DriftView({ code }: { code: string }) {
  const { state } = useAsync(() => foreman.drift(code), [code]);
  // What the plan lets the checks measure. If the project row cannot be read we cannot tell whether
  // they could run, so a zero is never reported as clean (see below).
  const project = useAsync(() => foreman.project(code), [code]);

  if (state.status === 'loading' || project.state.status === 'loading') {
    return (
      <Page>
        <Skeleton lines={8} />
      </Page>
    );
  }

  if (state.status === 'error') {
    return (
      <Page>
        <EmptyState kind="error" heading="Drift did not load">
          {state.message}
        </EmptyState>
      </Page>
    );
  }

  const drift = state.value;
  const counts = project.state.status === 'ready' ? project.state.value.counts : null;
  const planned = counts !== null && measurable(counts).hasPlan;
  // Clean only when every check could run on what is recorded (FRM-REQ-241); otherwise each check
  // says whether it ran.
  const ran = (key: string) => counts !== null && checkMeasurable(key, counts);
  const allRan = counts !== null && CATEGORIES.every((category) => ran(category.key));

  return (
    <Page>
      <ProjectHeader
        code={code}
        section="drift"
        description="Where the plan and what is actually true have come apart."
      />

      {drift.total === 0 && counts === null ? (
        <EmptyState kind="error" heading="Drift could not be confirmed">
          Nothing drifts that the engine found, but the project's plan could not be read, so whether
          the checks had anything to run on is not known. Reload to try again.
        </EmptyState>
      ) : drift.total === 0 && !allRan ? (
        <Card padding="md">
          <Stack gap="12">
            <Cluster gap="8" align="center">
              <h2 className="fm-subheading">Not measurable yet</h2>
              <Badge tone="neutral" size="sm">
                not measurable yet
              </Badge>
            </Cluster>
            <span className="fm-muted">
              {planned
                ? `${String(CATEGORIES.filter((category) => ran(category.key)).length)} of ${String(CATEGORIES.length)} drift checks could run on what is recorded and found nothing; the others need something that is not recorded yet.`
                : 'No phases, tasks or requirements are recorded, so none of the six drift checks can run on this project. Each needs something that is not recorded yet.'}
            </span>
            <ul className="fm-unmeasured__checks">
              {CATEGORIES.map((category) => (
                <li key={category.key} className="fm-unmeasured__check">
                  <span>
                    <strong>{category.label}</strong>{' '}
                    {!ran(category.key) && <span className="fm-muted">{NEEDS[category.key]}</span>}
                  </span>
                  <Badge tone="neutral" size="sm">
                    {ran(category.key) ? 'ran · nothing found' : 'did not run'}
                  </Badge>
                </li>
              ))}
            </ul>
          </Stack>
        </Card>
      ) : drift.total === 0 ? (
        <Card padding="md">
          <Stack gap="8">
            <Cluster gap="8" align="center">
              <h2 className="fm-subheading">0 drift</h2>
              <Badge tone="neutral" size="sm">
                clean
              </Badge>
            </Cluster>
            <span className="fm-muted">
              The checks found nothing in what is recorded — {plural(counts?.phases ?? 0, 'phase', 'phases')},{' '}
              {plural(counts?.requirements ?? 0, 'requirement', 'requirements')} and{' '}
              {plural(counts?.tasks ?? 0, 'task', 'tasks')}. A check with nothing to look at (no
              completed phase, no tripwire) has nothing to find.
            </span>
          </Stack>
        </Card>
      ) : (
        <Stack gap="24">
          {/* The five kinds, as five figures. A count of zero is still drawn: "no stale tasks" is
              a fact worth reading, and a card that disappears when it is good leaves you counting
              which ones are missing. */}
          <Grid minItemWidth="sm">
            {CATEGORIES.map((category) => {
              const value = drift.counts[category.key] ?? 0;
              return (
                <StatCard
                  key={category.key}
                  label={category.label}
                  value={value}
                  signal={readCount(value, { measured: counts !== null && checkMeasurable(category.key, counts) })}
                  detail={category.blurb}
                />
              );
            })}
          </Grid>

          <Section title="The mix" surface="card">
            <SegmentBar
              segments={CATEGORIES.map((category) => ({
                label: category.label,
                value: drift.counts[category.key] ?? 0,
                color: category.color,
              }))}
            />
          </Section>

          {CATEGORIES.map((category) => {
            const items = drift.items.filter((item) => item.category === category.key);
            if (items.length === 0) return null;

            return (
              <Section
                key={category.key}
                title={category.label}
                surface="card"
                description={category.blurb}
              >
                <Stack gap="4">
                  {items.map((item) => (
                    <a
                      key={`${item.category}:${item.humanId}:${item.detail}`}
                      className="fm-item fm-item--stacked"
                      href={hrefFor(code, item)}
                    >
                      <Cluster gap="8" align="center">
                        <code className="fm-item__id">{item.humanId}</code>
                        <span className="fm-item__title">{plainText(item.title)}</span>
                      </Cluster>
                      {/* Named and explained: "there is drift" sends somebody looking. */}
                      <span className="fm-muted">{plainText(item.detail)}</span>
                    </a>
                  ))}
                </Stack>
              </Section>
            );
          })}
        </Stack>
      )}
    </Page>
  );
}
