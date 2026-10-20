import { StatusDot } from '@d3cloud/ui';
import type { HealthReport } from '../lib/api';

/**
 * The sidebar's footer line: whether Foreman itself needs a look, linking to `/system` where the
 * whole report is (FRM-ADR-025). It replaced the Health row in the navigation — a destination you
 * open to learn that nothing is wrong is a row that costs a click to say nothing.
 *
 * Built from the design system's `StatusDot`, composed as Shipyard's host line is rather than
 * copied from it. Healthy is the quiet `idle` dot and no colour — there is no green "all good" in
 * the system (D-016). Something to look at is `warning`, with how many and the first of them in
 * words. Before the report arrives it says nothing at all, rather than "healthy" on no evidence.
 */
export function HealthLine({ health }: { health: HealthReport | 'error' | null }) {
  if (health === null) return null;

  const problems = health === 'error' ? ['The health report did not load.'] : health.problems;
  const first = problems[0];

  return (
    <a href="/system" className="fm-health">
      <StatusDot tone={first === undefined ? 'idle' : 'warning'} size="sm">
        <span className="fm-health__label">
          {first === undefined ? 'Foreman healthy' : `Health · ${String(problems.length)} to look at`}
        </span>
      </StatusDot>
      {first === undefined ? null : <span className="fm-health__line">{first}</span>}
    </a>
  );
}
