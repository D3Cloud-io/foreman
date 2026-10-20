import { Cluster, EmptyState, Grid, Section, Skeleton } from '@d3cloud/ui';
import { foreman } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { Donut, StatCard } from '../ui/viz';
import { SERIES } from '../ui/tone';

/**
 * The state of a project's register, above its register.
 *
 * Two hundred and ten rows is the right answer to "show me the requirements" and no answer at all
 * to "is this register in good shape". The coverage engine already computes the four numbers that
 * answer it; this is them, and the ring says how close to covered the Musts are without anyone
 * dividing 156 by 160 in their head.
 *
 * The EARS figure is here rather than only on a row because it was invisible: every requirement
 * carried an attention badge with no explanation, and the count that would have made that legible
 * was computed and never shown.
 */
export function CoverageSummary({ code }: { code: string }) {
  const { state } = useAsync(() => foreman.coverage(code), [code]);

  if (state.status === 'loading') return <Skeleton lines={3} />;
  // Informational: the register below is usable whether or not this resolves, so a failure here
  // must not take the screen down with it.
  if (state.status === 'error') return null;

  const { requirements, earsWarnings, withoutAcceptanceTest, tasksWithoutRequirements } =
    state.value;
  const uncoveredMusts = requirements.musts - requirements.mustsCovered;
  const percent =
    requirements.musts === 0
      ? 100
      : Math.round((requirements.mustsCovered / requirements.musts) * 100);

  return (
    <Section title="The register at a glance" surface="card">
      {requirements.total === 0 ? (
        <EmptyState kind="empty" size="inline" heading="No requirements yet">
          Nothing to cover.
        </EmptyState>
      ) : (
        <Cluster gap="24" align="center">
          <Donut
            size={112}
            segments={[
              { label: 'Musts covered', value: requirements.mustsCovered, color: SERIES.done },
              { label: 'Musts uncovered', value: uncoveredMusts, color: SERIES.warning },
            ]}
            label={`${String(percent)}%`}
            caption="Musts covered"
          />
          <Grid minItemWidth="sm" className="fm-glance">
            <StatCard
              label="Requirements"
              value={requirements.total}
              detail={`${String(requirements.musts)} of them Must`}
            />
            <StatCard
              label="Uncovered Musts"
              value={uncoveredMusts}
              tone={uncoveredMusts === 0 ? 'success' : 'warning'}
              detail={uncoveredMusts === 0 ? 'Every Must is cited' : 'No task cites them'}
            />
            <StatCard
              label="No acceptance test"
              value={withoutAcceptanceTest.length}
              tone={withoutAcceptanceTest.length === 0 ? 'success' : 'neutral'}
              detail="Nothing says what done means"
            />
            <StatCard
              label="EARS warnings"
              value={earsWarnings.length}
              tone={earsWarnings.length === 0 ? 'success' : 'neutral'}
              detail={
                tasksWithoutRequirements.length === 0
                  ? 'The lint warns, never blocks'
                  : `${String(tasksWithoutRequirements.length)} tasks cite nothing`
              }
            />
          </Grid>
        </Cluster>
      )}
    </Section>
  );
}
