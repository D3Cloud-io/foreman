import {
  Alert,
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

/**
 * S-23 — drift: where the plan and reality have come apart (FRM-REQ-126).
 *
 * **Designed as a success state.** An empty drift screen is the thing to aim for, so the empty
 * state here reads as an achievement rather than as a screen that failed to load — which is the
 * usual accident when "no results" is written once for every table in an app.
 */

const CATEGORIES: {
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

  if (state.status === 'loading') {
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

  return (
    <Page>
      <ProjectHeader
        code={code}
        section="drift"
        description="Where the plan and what is actually true have come apart."
      />

      {drift.total === 0 ? (
        <Alert tone="success" title="No drift">
          Every Must has a task, nothing is stale, no tripwire has fired, every completed phase
          would still pass its gate, and every accepted decision is cited.
        </Alert>
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
                  tone={value === 0 ? 'success' : 'warning'}
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
