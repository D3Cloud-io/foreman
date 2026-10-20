import { Badge, Card, Cluster, EmptyState, Grid, Page, PageHeader, Section, Skeleton, Stack } from '@d3cloud/ui';
import { ScopeNotice, UnknownScope, useScopeView } from '../components/ScopeSwitcher';
import type { ReactNode } from 'react';
import { foreman, type DriftAcross as DriftAcrossResult } from '../lib/api';
import { scopeOf } from '../lib/scope';
import { useAsync } from '../lib/useAsync';
import { StatCard } from '../ui/viz';
import { readAcross, rowPlanned } from '../ui/status';
import { CATEGORIES } from './DriftView';

/**
 * Drift across projects (FRM-T-17.4, FRM-ADR-024) — `/drift`, narrowed by `?group=`.
 *
 * Home's Drift figure, opened: the same engine as each project's drift view, summed by category
 * and then listed by project in Home's order, each a link to that project's own drift. A project
 * with nothing apart is listed too, quieter — "no drift" is an answer, and a project missing from
 * the list reads as one nobody checked.
 */

function plural(n: number, one: string, other: string): string {
  return `${String(n)} ${n === 1 ? one : other}`;
}

export function DriftAcross({ search }: { search: string }) {
  const scope = scopeOf(search);
  const { phrase } = useScopeView();
  const { state } = useAsync(() => foreman.driftAcross(scope), [scope]);
  // Which projects have a plan to measure against; without it a zero here means "not asked".
  const portfolio = useAsync(() => foreman.portfolio(scope), [scope]);
  const unplanned =
    portfolio.state.status === 'ready'
      ? portfolio.state.value.items.filter((row) => !rowPlanned(row)).map((row) => row.code)
      : [];

  const header = (
    <PageHeader
      title="Drift"
      description={`Where the plan and what is actually true have come apart${phrase === null ? '' : `, across ${phrase}`}.`}
      {...(state.status === 'ready'
        ? { count: state.value.items.length, countNoun: { one: 'project', other: 'projects' } }
        : {})}
    />
  );

  // One tree for every state — header, the scope bar, then the body — so the switcher on the bar
  // is the same element while a new scope loads, and keeps focus across it.
  let body: ReactNode;
  if (state.status === 'loading' || portfolio.state.status === 'loading') {
    body = <Skeleton lines={8} />;
  } else if (state.status === 'error') {
    body =
      state.notFound && scope !== null ? (
        <UnknownScope scope={scope} />
      ) : (
        <EmptyState kind="error" heading="Drift did not load">
          {state.message}
        </EmptyState>
      );
  } else {
    body = <DriftBody value={state.value} phrase={phrase} unplanned={unplanned} />;
  }

  return (
    <Page>
      {header}
      <ScopeNotice />
      {body}
    </Page>
  );
}

function DriftBody({
  value,
  phrase,
  unplanned,
}: {
  value: DriftAcrossResult;
  phrase: string | null;
  /** Projects with no plan: their drift is not measurable yet, whatever it counts. */
  unplanned: readonly string[];
}) {
  const { items, drift } = value;
  const drifting = items.filter((project) => project.total > 0);
  const level = items.filter((project) => project.total === 0 && !unplanned.includes(project.project));
  const unmeasured = items.filter((project) => project.total === 0 && unplanned.includes(project.project));
  const reading = readAcross(drift.total, { unmeasured: unmeasured.map((project) => project.project), total: items.length });
  const where = phrase ?? 'this scope';

  return (
    <Stack gap="24">
      {items.length === 0 ? (
        <EmptyState kind="empty" heading="No projects here">
          Nothing is in {where} yet.
        </EmptyState>
      ) : drift.total === 0 ? (
        <Card padding="md">
          <Stack gap="8">
            <Cluster gap="8" align="center">
              <h2 className="fm-subheading">{reading.state === 'clean' ? '0 drift' : 'Not measurable yet'}</h2>
              <Badge tone="neutral" size="sm">
                {reading.label}
              </Badge>
            </Cluster>
            <span className="fm-muted">
              {reading.state === 'clean'
                ? `Across ${where}, every check ran and found nothing: every Must has a task, nothing is stale, no tripwire has fired, and every completed phase would still pass its gate.`
                : `Across ${where}, nothing drifts where it can be measured, but ${unmeasured
                    .map((project) => project.project)
                    .join(', ')} ${unmeasured.length === 1 ? 'has' : 'have'} no plan yet, so its drift is not measurable yet.`}
            </span>
          </Stack>
        </Card>
      ) : (
        <Grid minItemWidth="sm">
          {CATEGORIES.map((category) => {
            const count = drift.counts[category.key];
            return (
              <StatCard
                key={category.key}
                label={category.label}
                value={count}
                signal={readAcross(count, { unmeasured: unplanned, total: items.length })}
                detail={category.blurb}
              />
            );
          })}
        </Grid>
      )}

      {drifting.length > 0 && (
        <Section title="Projects with drift" surface="card" description="Most apart first.">
          <Stack gap="4" as="ul" aria-label="Projects with drift">
            {[...drifting]
              .sort((a, b) => b.total - a.total)
              .map((project) => (
                <li key={project.project}>
                  <a className="fm-item fm-item--stacked" href={`/projects/${project.project}/drift`}>
                    <Cluster gap="8" align="center">
                      <code className="fm-code-chip">{project.project}</code>
                      <span className="fm-item__title">{project.name}</span>
                      <span className="fm-muted">{plural(project.total, 'item', 'items')}</span>
                    </Cluster>
                    <span className="fm-muted">
                      {CATEGORIES.filter((category) => (project.counts[category.key] ?? 0) > 0)
                        .map((category) => `${category.label}: ${String(project.counts[category.key] ?? 0)}`)
                        .join(' · ')}
                    </span>
                  </a>
                </li>
              ))}
          </Stack>
        </Section>
      )}

      {level.length > 0 && (
        <p className="fm-muted">
          0 drift: {level.map((project) => project.project).join(', ')}.
        </p>
      )}
      {unmeasured.length > 0 && (
        <p className="fm-muted">
          Not measurable yet, no plan: {unmeasured.map((project) => project.project).join(', ')}.
        </p>
      )}
    </Stack>
  );
}
