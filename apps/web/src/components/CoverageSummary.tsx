import { Cluster, EmptyState, Grid, Section, Skeleton } from '@d3cloud/ui';
import { foreman } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { Donut, StatCard } from '../ui/viz';
import { SERIES } from '../ui/tone';
import { plural, readCount } from '../ui/status';

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
  // With no Must there is no share to compute, and 100% would be a claim about nothing.
  const percent =
    requirements.musts === 0
      ? null
      : Math.round((requirements.mustsCovered / requirements.musts) * 100);
  const register = `/projects/${code}/requirements`;
  const noun = (n: number) => plural(n, 'requirement', 'requirements');

  return (
    <Section title="The register at a glance" surface="card">
      {requirements.total === 0 ? (
        <EmptyState kind="empty" size="inline" heading="No requirements yet">
          Nothing to cover, so coverage is not measurable yet.
        </EmptyState>
      ) : (
        <Cluster gap="24" align="center">
          <Donut
            size={112}
            legend
            segments={[
              { label: 'Musts covered', value: requirements.mustsCovered, color: SERIES.done },
              { label: 'Musts uncovered', value: uncoveredMusts, color: SERIES.warning },
            ]}
            label={percent === null ? '—' : `${String(percent)}%`}
            caption={percent === null ? 'No Musts yet' : 'Musts covered'}
          />
          <Grid minItemWidth="sm" className="fm-glance">
            <StatCard
              label="Requirements"
              value={requirements.total}
              detail={`${String(requirements.musts)} of them Must · ${String(requirements.covered)} covered`}
              href={register}
              action="Open the register"
            />
            <StatCard
              label="Uncovered Musts"
              value={requirements.musts === 0 ? '—' : uncoveredMusts}
              signal={readCount(uncoveredMusts, { measured: requirements.musts > 0 })}
              detail={
                requirements.musts === 0
                  ? 'No Must requirements recorded'
                  : uncoveredMusts === 0
                    ? `All ${String(requirements.musts)} Musts are cited by a task`
                    : `${String(uncoveredMusts)} of ${String(requirements.musts)} Musts have no task citing them`
              }
              href={`${register}?uncovered=true&priority=M`}
              action="Open the uncovered Musts"
            />
            <StatCard
              label="No acceptance test"
              value={withoutAcceptanceTest.length}
              signal={readCount(withoutAcceptanceTest.length, { measured: true })}
              detail={`Of ${noun(requirements.total)}, nothing says what done means`}
            />
            <StatCard
              label="EARS warnings"
              value={earsWarnings.length}
              signal={readCount(earsWarnings.length, { measured: true })}
              detail={`Of ${noun(requirements.total)} do not read as EARS — the lint warns, never blocks`}
              href={`${register}?earsLint=warned`}
              action="Open the warned requirements"
            />
            <StatCard
              label="Tasks citing nothing"
              value={tasksWithoutRequirements.length}
              signal={readCount(tasksWithoutRequirements.length, { measured: true })}
              detail="Tasks that satisfy no requirement"
            />
          </Grid>
        </Cluster>
      )}
    </Section>
  );
}
