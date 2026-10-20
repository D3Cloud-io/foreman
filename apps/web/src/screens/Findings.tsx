import {

  EmptyState,
  FilterBar,
  FormField,
  Link,
  Page,
  PageHeader,
  Select,
  Grid,
  Skeleton,
  Stack,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { ScopeBar, UnknownScope, useScopeView } from '../components/ScopeSwitcher';
import { foreman, type FindingRow } from '../lib/api';
import { replaceLocation } from '../lib/router';
import { scopeOf, withParams } from '../lib/scope';
import { useAsync } from '../lib/useAsync';
import { plainText } from '../lib/text';
import { Pill, SegmentBar, StatCard } from '../ui/viz';
import { SERIES, severityTone } from '../ui/tone';

/**
 * S-05 — every open finding, every project, ranked (FRM-REQ-120).
 *
 * The screen that justifies the phase. 127 findings lived four directory levels deep across two
 * vault folders, and "what is the worst thing outstanding anywhere" was not a question anybody
 * could ask without opening files one at a time.
 *
 * **Still a table, deliberately.** At this volume a card each would be a hundred cards, which is
 * the list problem with more padding — and the question here really is comparative, which is what
 * a table is for. What it gained is a summary that answers "how bad is it" before you read a row,
 * and four counts that are also the filter: seeing `12 high` and clicking it is one gesture.
 */

const LENSES = [
  'architecture',
  'security',
  'correctness',
  'performance',
  'accessibility',
  'data',
  'testing',
  'maintainability',
  'dependencies',
  'operability',
];

const ANY = '';

export function Findings({ search }: { search: string }) {
  // Every filter lives in the URL, beside the scope (FRM-T-17.4): a filtered inbox is a link, and
  // changing the scope keeps the filters because the switcher rewrites only `group`. The screen is
  // not remounted per query, so a Select keeps focus while its own change re-reads the list.
  const params = new URLSearchParams(search);
  const severity = params.get('severity') ?? ANY;
  const lens = params.get('lens') ?? ANY;
  const status = params.get('status') ?? 'open';
  const setFilter = (key: 'severity' | 'lens' | 'status', value: string) => {
    // `open` is the default status, so it is the absence of one.
    replaceLocation(withParams(`/findings${search}`, { [key]: key === 'status' && value === 'open' ? null : value }));
  };
  const setSeverity = (value: string) => { setFilter('severity', value); };
  const setLens = (value: string) => { setFilter('lens', value); };
  const setStatus = (value: string) => { setFilter('status', value); };

  const scope = scopeOf(search);
  const { phrase, current } = useScopeView();
  /** A scope with no projects has nothing to deal with, which is not the same as all of it dealt with. */
  const emptyGroup = scope !== null && current !== undefined && current.count === 0;
  const findings = useAsync(
    () => foreman.findings({ severity, lens, status, group: scope ?? '' }),
    [severity, lens, status, scope],
  );

  const columns: TableColumn<FindingRow>[] = [
    {
      key: 'severity',
      header: 'Severity',
      width: '6.5rem',
      cell: (row) => <Pill tone={severityTone(row.severity)}>{row.severity}</Pill>,
    },
    {
      key: 'project',
      header: 'Project',
      width: '6rem',
      sortable: true,
      cell: (row) => <Link href={`/projects/${row.project}`}>{row.project}</Link>,
    },
    {
      key: 'humanId',
      header: 'ID',
      width: '8rem',
      cell: (row) => <Link href={`/findings/${row.humanId}`}>{row.humanId}</Link>,
    },
    { key: 'title', header: 'Finding', cell: (row) => plainText(row.title) },
    {
      key: 'lenses',
      header: 'Lenses',
      width: '11rem',
      cell: (row) =>
        row.lenses.length === 0 ? <span className="fm-muted">—</span> : row.lenses.join(', '),
    },
    {
      key: 'verified',
      header: 'Verified',
      width: '7rem',
      cell: (row) =>
        row.verified === 'confirmed' ? (
          <Pill tone="success">confirmed</Pill>
        ) : (
          // Said out loud rather than left blank: 123 of 127 real findings were never
          // independently verified, and a blank reads as "fine".
          <span className="fm-muted">{row.verified}</span>
        ),
    },
    {
      key: 'location',
      header: 'Where',
      cell: (row) =>
        row.locations.length === 0 ? (
          <span className="fm-muted">not pinned</span>
        ) : (
          <code>
            {row.locations[0]?.path}
            {row.locations.length > 1 ? ` +${String(row.locations.length - 1)}` : ''}
          </code>
        ),
    },
  ];

  const items = findings.state.status === 'ready' ? findings.state.value.items : [];
  const count = (level: string) => items.filter((f) => f.severity === level).length;
  const criticals = count('critical');

  // The counts describe what is on screen, so they follow the lens and status filters and change
  // when those do. A summary computed over a different set than the table below it is a summary
  // that lies quietly.
  const severities = [
    { key: 'critical', label: 'Critical', value: count('critical'), color: SERIES.blocked },
    { key: 'high', label: 'High', value: count('high'), color: SERIES.blocked },
    { key: 'medium', label: 'Medium', value: count('medium'), color: SERIES.warning },
    { key: 'low', label: 'Low', value: count('low'), color: SERIES.waiting },
  ];

  return (
    <Page>
      <PageHeader
        title="Findings"
        description={
          scope === null
            ? 'Every project at once, worst first — the question the vault could not answer.'
            : `${status === 'open' ? 'Open findings' : 'Findings'}${phrase === null ? '' : ` across ${phrase}`}, worst first.`
        }
        {...(findings.state.status === 'ready'
          ? {
              count: findings.state.value.items.length,
              countNoun: { one: 'finding', other: 'findings' },
            }
          : {})}
      />
      <ScopeBar />

      {findings.state.status === 'ready' && items.length > 0 && (
        <Stack gap="16">
          <Grid minItemWidth="sm">
            {severities.map((level) => (
              <StatCard
                key={level.key}
                label={level.label}
                value={level.value}
                tone={
                  level.value === 0
                    ? 'neutral'
                    : level.key === 'critical' || level.key === 'high'
                      ? 'danger'
                      : level.key === 'medium'
                        ? 'warning'
                        : 'neutral'
                }
                detail={severity === level.key ? 'Filtering by this' : 'Show only these'}
                selected={severity === level.key}
                // A second click clears it: a filter you can turn on and not off is a trap.
                onClick={() => { setSeverity(severity === level.key ? ANY : level.key); }}
              />
            ))}
          </Grid>
          <SegmentBar segments={severities} />
        </Stack>
      )}

      <FilterBar
        aria-label="Filter the findings"
        trailing={
          criticals > 0 ? (
            <Pill tone="danger">
              {criticals} critical{criticals === 1 ? '' : 's'} open
            </Pill>
          ) : null
        }
      >
        <FormField label="Severity">
          <Select
            value={severity}
            onValueChange={setSeverity}
            options={[
              { value: ANY, label: 'Any severity' },
              { value: 'critical', label: 'Critical' },
              { value: 'high', label: 'High' },
              { value: 'medium', label: 'Medium' },
              { value: 'low', label: 'Low' },
            ]}
          />
        </FormField>
        <FormField label="Lens">
          <Select
            value={lens}
            onValueChange={setLens}
            options={[
              { value: ANY, label: 'Any lens' },
              ...LENSES.map((l) => ({ value: l, label: l })),
            ]}
          />
        </FormField>
        <FormField label="Status">
          <Select
            value={status}
            onValueChange={setStatus}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'fixed', label: 'Fixed' },
              { value: 'deferred', label: 'Deferred' },
              { value: 'wont_fix', label: "Won't fix" },
            ]}
          />
        </FormField>
      </FilterBar>

      {findings.state.status === 'loading' ? (
        <Skeleton lines={10} />
      ) : findings.state.status === 'error' && findings.state.notFound && scope !== null ? (
        <UnknownScope scope={scope} />
      ) : findings.state.status === 'error' ? (
        <EmptyState kind="error" heading="The findings did not load">
          {findings.state.message}
        </EmptyState>
      ) : (
        <Table
          caption={phrase === null ? 'Findings' : `Findings across ${phrase}`}
          captionHidden
          density="compact"
          columns={columns}
          rows={findings.state.value.items}
          rowKey={(row) => row.humanId}
          maxHeight="70vh"
          stickyHeader
          empty={
            emptyGroup ? (
              <EmptyState kind="empty" heading={`${current.name} has no projects`}>
                So it has no findings. Move projects into it from{' '}
                <Link variant="inline" href="/projects">
                  Projects
                </Link>
                .
              </EmptyState>
            ) : (
              <EmptyState
                kind={status === 'open' ? 'empty' : 'no-results'}
                heading={
                  status !== 'open'
                    ? 'Nothing matches'
                    : scope === null
                      ? 'Nothing open anywhere'
                      : phrase === null
                        ? 'Nothing open'
                        : `Nothing open across ${phrase}`
                }
              >
                {status !== 'open'
                  ? 'Widen the filters.'
                  : scope === null
                    ? 'Every finding in every project has been dealt with — which is a success state.'
                    : 'Every finding in these projects has been dealt with — which is a success state.'}
              </EmptyState>
            )
          }
        />
      )}
    </Page>
  );
}
