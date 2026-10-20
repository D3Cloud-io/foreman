import { useState } from 'react';
import {
  Button,
  Checkbox,
  Cluster,
  EmptyState,
  Link,
  Page,
  PageHeader,
  SearchField,
  Select,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { Check, Minus } from 'lucide-react';
import { ScopeNotice, UnknownScope } from '../components/ScopeSwitcher';
import { foreman, type PortfolioRow } from '../lib/api';
import { matchScope, scopeOf, scopeOptions, UNGROUPED as UNGROUPED_SCOPE, useScope } from '../lib/scope';
import { useAsync } from '../lib/useAsync';
import { descriptionsOf, portfolioSections, sectionSummary } from '../lib/groups';
import { AccentDot, MoveToGroupDialog, useMoveToast } from '../ui/groups';
import { Pill } from '../ui/viz';
import { ciTone, lifecycleTone } from '../ui/tone';

/**
 * Projects — every project, grouped (17.04, FRM-REQ-229, FRM-REQ-231).
 *
 * A table with a section per group in the order set on the Groups screen, Ungrouped last: the
 * columns are the ones you compare down (lifecycle, phase, drift, CI), and the group header says
 * how the family is doing as a whole. Rows carry a checkbox; with any selected, a bar offers
 * **Move to group…**, which opens the dialog that says what the move does to the guidelines before
 * it happens. The toast after it has Undo.
 *
 * Moving is a button, never a drag (FRM-REQ-230, FRM-REQ-125): the whole of it is reachable by
 * Tab and Space.
 *
 * One `<table>` with a `<tbody>` per group rather than a library Table per group: the library's
 * Table has no row groups, and a table per group would repeat its header row once a family.
 */

/** The Select's value for every project. Never sent: an unscoped read names no group. */
const ALL = 'all';

function phaseLabel(row: PortfolioRow): string {
  if (row.phase !== null) return `P-${row.phase.number} · ${row.phase.name}`;
  const total = row.tasks.open + row.tasks.blocked + row.tasks.done + row.tasks.cancelled;
  return total === 0 ? 'Not started' : 'No active phase';
}

function ciLabel(row: PortfolioRow): string {
  if (row.ci.unknown) return 'No CI';
  if (row.ci.conclusion === 'success') return 'CI';
  if (row.ci.conclusion === 'failure' || row.ci.conclusion === 'timed_out') return 'CI failing';
  return `CI ${row.ci.conclusion ?? 'pending'}`;
}

export function Projects({ search }: { search: string }) {
  // The group filter is the scope (FRM-T-17.4): `?group=` in the URL, read by the server, so
  // Projects narrowed to Dormice is the same set as Home and Findings narrowed to it. Every state
  // is header, scope bar, body, so the switcher keeps focus while a new scope loads.
  const scope = scopeOf(search);
  const { setScope } = useScope();
  const portfolio = useAsync(() => foreman.portfolio(scope), [scope]);
  const groups = useAsync(() => foreman.groups(), []);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [moving, setMoving] = useState(false);

  const reload = () => {
    portfolio.reload();
    groups.reload();
  };
  const toastMove = useMoveToast(reload);

  const ready = portfolio.state.status === 'ready' && groups.state.status === 'ready';
  const rows = portfolio.state.status === 'ready' ? portfolio.state.value.items : [];

  const header = (
    <PageHeader
      title="Projects"
      description="Every project Foreman tracks, by group, and where each one actually is."
      {...(ready ? { count: rows.length, countNoun: { one: 'project', other: 'projects' } } : {})}
    />
  );

  if (portfolio.state.status === 'error' && portfolio.state.notFound && scope !== null) {
    return (
      <Page>
        {header}
        <ScopeNotice />
        <UnknownScope scope={scope} />
      </Page>
    );
  }

  if (portfolio.state.status === 'error' || groups.state.status === 'error') {
    const message =
      portfolio.state.status === 'error'
        ? portfolio.state.message
        : groups.state.status === 'error'
          ? groups.state.message
          : '';
    return (
      <Page>
        {header}
        <ScopeNotice />
        <EmptyState kind="error" heading="The projects did not load">
          {message}
        </EmptyState>
      </Page>
    );
  }

  if (portfolio.state.status !== 'ready' || groups.state.status !== 'ready') {
    return (
      <Page>
        {header}
        <ScopeNotice />
        <Skeleton lines={6} />
      </Page>
    );
  }

  const listing = groups.state.value;
  const needle = query.trim().toLowerCase();
  const matches = (row: PortfolioRow) =>
    needle === '' || row.code.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle);
  // The server has already narrowed the sections to the scope.
  const sections = portfolioSections(portfolio.state.value, descriptionsOf(listing))
    .map((section) => ({ ...section, shown: section.rows.filter(matches) }))
    // With a filter typed, a family with nothing matching is noise; without one it is a family.
    .filter((section) => needle === '' ? section.group !== null || section.rows.length > 0 : section.shown.length > 0);

  const visible = sections.flatMap((section) => section.shown.map((row) => row.code));
  const chosen = rows.filter((row) => selected.has(row.code));
  const allShown = visible.length > 0 && visible.every((code) => selected.has(code));
  const someShown = visible.some((code) => selected.has(code));

  const toggle = (code: string, on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(code);
      else next.delete(code);
      return next;
    });
  };

  const scopes = scopeOptions(listing);
  const groupOptions = scopes.map((option) => ({
    value: option.value ?? ALL,
    label: option.value === null ? 'All groups' : option.name,
  }));
  const groupFilter = matchScope(scope, scopes)?.value ?? ALL;
  const onlyUngrouped = scope?.toLowerCase() === UNGROUPED_SCOPE;

  return (
    <Page>
      {header}
      <ScopeNotice />
      <Stack gap="16">
        <Cluster gap="12" align="center" justify="between">
          <Cluster gap="12" align="center" className="fm-filters">
            <SearchField
              aria-label="Filter by code or name"
              placeholder="Filter by code or name"
              value={query}
              onChange={(event) => { setQuery(event.target.value); }}
            />
            <Select
              aria-label="Group"
              options={groupOptions}
              value={groupFilter}
              onValueChange={(next) => { setScope(next === ALL ? null : next); }}
            />
          </Cluster>
          <span className="fm-muted">
            Grouped in the order set in <Link variant="inline" href="/groups">Settings → Groups</Link>
          </span>
        </Cluster>

        {chosen.length > 0 && (
          <div className="fm-selection" role="region" aria-label="Selected projects">
            <Cluster gap="12" align="center">
              <span className="fm-selection__count" aria-live="polite">
                {chosen.length} selected
              </span>
              <code className="fm-selection__codes">{chosen.map((row) => row.code).join(', ')}</code>
            </Cluster>
            <Cluster gap="8" align="center">
              <Button variant="primary" size="sm" onClick={() => { setMoving(true); }}>
                Move to group…
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setSelected(new Set()); }}>
                Clear
              </Button>
            </Cluster>
          </div>
        )}

        {rows.length === 0 && scope === null ? (
          <EmptyState kind="empty" heading="No projects yet">
            Import the vault, or convert a project idea, to start.
          </EmptyState>
        ) : sections.length === 0 && needle === '' && onlyUngrouped ? (
          <EmptyState kind="empty" heading="No project is ungrouped">
            Every project is in a group.
          </EmptyState>
        ) : sections.length === 0 ? (
          <EmptyState kind="no-results" heading="Nothing matches">
            {onlyUngrouped
              ? `No ungrouped project has ${query.trim()} in its code or name.`
              : `No project has ${query.trim()} in its code or name.`}
          </EmptyState>
        ) : (
          <div className="fm-gtable-wrap">
            <table className="fm-gtable">
              <caption className="fm-visually-hidden">Projects, by group</caption>
              <thead>
                <tr>
                  <th scope="col" className="fm-gtable__select">
                    <Checkbox
                      aria-label="Select every project shown"
                      checked={allShown ? true : someShown ? 'indeterminate' : false}
                      checkIcon={allShown ? <Check /> : <Minus />}
                      onCheckedChange={() => {
                        setSelected((current) => {
                          const next = new Set(current);
                          for (const code of visible) {
                            if (allShown) next.delete(code);
                            else next.add(code);
                          }
                          return next;
                        });
                      }}
                    />
                  </th>
                  <th scope="col">Code</th>
                  <th scope="col">Name</th>
                  <th scope="col" className="fm-gtable__wide">Lifecycle</th>
                  <th scope="col" className="fm-gtable__wide">Active phase</th>
                  <th scope="col" className="fm-gtable__wide fm-gtable__num">Drift</th>
                  <th scope="col">CI</th>
                </tr>
              </thead>
              {sections.map((section) => (
                <tbody key={section.key}>
                  <tr className={`fm-gtable__group${section.group === null ? ' fm-gtable__group--quiet' : ''}`}>
                    <th scope="rowgroup" colSpan={7}>
                      <span className="fm-gtable__groupname">
                        {section.group !== null && <AccentDot accent={section.group.accent} size="sm" />}
                        {section.name}
                      </span>
                      <span className="fm-muted">
                        {section.group === null
                          ? `${String(section.rows.length)} ${section.rows.length === 1 ? 'project' : 'projects'}`
                          : sectionSummary(section.rows)}
                      </span>
                    </th>
                  </tr>
                  {section.shown.length === 0 && (
                    <tr>
                      <td />
                      <td colSpan={6} className="fm-muted">
                        No projects yet — select some above and choose Move to group…
                      </td>
                    </tr>
                  )}
                  {section.shown.map((row) => {
                    const on = selected.has(row.code);
                    return (
                      <tr key={row.code} className={on ? 'fm-gtable__row--on' : undefined}>
                        <td className="fm-gtable__select">
                          <Checkbox
                            aria-label={`Select ${row.code} ${row.name}`}
                            checked={on}
                            checkIcon={<Check />}
                            onCheckedChange={(next) => { toggle(row.code, next === true); }}
                          />
                        </td>
                        <td>
                          <code className="fm-gtable__code">{row.code}</code>
                        </td>
                        <td>
                          <a className="fm-gtable__name" href={`/projects/${row.code}`}>
                            {row.name}
                          </a>
                          <span className="fm-muted fm-gtable__sub">
                            {row.lifecycle} · {phaseLabel(row)}
                          </span>
                        </td>
                        <td className="fm-gtable__wide">
                          <Pill tone={lifecycleTone(row.lifecycle)}>{row.lifecycle}</Pill>
                        </td>
                        <td className="fm-gtable__wide">{phaseLabel(row)}</td>
                        <td className="fm-gtable__wide fm-gtable__num">{row.drift.total}</td>
                        <td>
                          <Pill tone={ciTone(row.ci.conclusion, row.ci.unknown)} dot>
                            {ciLabel(row)}
                          </Pill>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        )}
      </Stack>
      {/* On a phone the bar is fixed over the foot of the list; this keeps the last row clear of it. */}
      {chosen.length > 0 && <div className="fm-selection-clear" aria-hidden="true" />}

      <MoveToGroupDialog
        open={moving}
        onOpenChange={setMoving}
        projects={chosen.map((row) => ({ code: row.code, name: row.name }))}
        listing={listing}
        onMoved={(result, codes, targetName, origin) => {
          setSelected(new Set());
          reload();
          toastMove(result, codes, targetName, origin);
        }}
      />
    </Page>
  );
}

