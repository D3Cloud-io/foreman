import { Alert, Cluster, EmptyState, Grid, Page, PageHeader, Section, Skeleton, Stack } from '@d3cloud/ui';
import { ScopeBar, UnknownScope, useScopeView } from '../components/ScopeSwitcher';
import { foreman } from '../lib/api';
import { scopeOf } from '../lib/scope';
import { useAsync } from '../lib/useAsync';
import { StatCard } from '../ui/viz';
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

  const header = (
    <PageHeader
      title="Drift"
      description={`Where the plan and what is actually true have come apart, across ${phrase}.`}
      {...(state.status === 'ready'
        ? { count: state.value.items.length, countNoun: { one: 'project', other: 'projects' } }
        : {})}
    />
  );

  if (state.status === 'loading') {
    return (
      <Page>
        {header}
        <ScopeBar />
        <Skeleton lines={8} />
      </Page>
    );
  }

  if (state.status === 'error') {
    return (
      <Page>
        {header}
        <ScopeBar />
        {state.notFound && scope !== null ? (
          <UnknownScope scope={scope} />
        ) : (
          <EmptyState kind="error" heading="Drift did not load">
            {state.message}
          </EmptyState>
        )}
      </Page>
    );
  }

  const { items, drift } = state.value;
  const drifting = items.filter((project) => project.total > 0);
  const level = items.filter((project) => project.total === 0);

  return (
    <Page>
      {header}
      <Stack gap="24">
        <ScopeBar />
        {items.length === 0 ? (
          <EmptyState kind="empty" heading="No projects here">
            Nothing is in {phrase} yet.
          </EmptyState>
        ) : drift.total === 0 ? (
          <Alert tone="success" title="No drift">
            Across {phrase}, every Must has a task, nothing is stale, no tripwire has fired, and every
            completed phase would still pass its gate.
          </Alert>
        ) : (
          <Grid minItemWidth="sm">
            {CATEGORIES.map((category) => {
              const value = drift.counts[category.key];
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
            No drift: {level.map((project) => project.project).join(', ')}.
          </p>
        )}
      </Stack>
    </Page>
  );
}
