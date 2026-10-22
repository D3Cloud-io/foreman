import { useEffect, useState, type ReactNode } from 'react';
import {
  ActionBar,
  Badge,
  Button,
  Checkbox,
  Cluster,
  EmptyState,
  FilterBar,
  FormField,
  Link,
  Page,
  PageHeader,
  Select,
  Skeleton,
  Stack,
  TabPanel,
  Tabs,
  useToast,
} from '@d3cloud/ui';
import { Ban, Check, Eye, RotateCcw, X } from 'lucide-react';
import { ScopeNotice, UnknownScope, useScopeView } from '../components/ScopeSwitcher';
import { foreman, type FindingRow, type FindingsPage } from '../lib/api';
import { replaceLocation } from '../lib/router';
import { scopeOf, withParams } from '../lib/scope';
import { statusWords } from '../lib/mutate';
import { useAsync, type AsyncHandle } from '../lib/useAsync';
import { plainText } from '../lib/text';
import { severityTone } from '../ui/status';
import { FindingRecord, useFindingVerdict, verdictApplies, writeVerdict, type FindingVerdict } from './FindingDetail';
import {
  KeyHint,
  ReasonDialog,
  SplitView,
  TAB_LABEL,
  TRIAGE_TABS,
  TriageRow,
  effectiveSelection,
  moveSelection,
  partitionBulk,
  projectOf,
  select,
  selectionOf,
  spanOf,
  tabHref,
  tabOf,
  useBulk,
  useScrollToSelected,
  useTriageKeys,
  type TriageTab,
} from './triage';
import { DriftTab, useDriftTriage } from './TriageDrift';
import { ReviewTab, useReviewQueue } from './TriageReview';
import { BlockedTab } from './TriageBlocked';

/**
 * S-05 — the triage surface (FRM-REQ-120, FRM-REQ-246, FRM-T-18.7, design review FRM-DA-007).
 *
 * `/findings` was a ranked table nobody could act on: what agents wrote was visible and nothing
 * could be ruled on. It is now the one place to rule — four tabs, one list per kind of record, each
 * a list and the selected record beside it:
 *
 * - **Findings** — every open finding in the scope, worst first, with Acknowledge (a), Mark fixed
 *   (f), Reopen (r) and Won't fix (w, with a reason), each one audit event with Undo; and bulk
 *   verdicts over a selection, which are N events and N undos.
 * - **Drift** — each item offers the action that would resolve it as a prefilled editor you save;
 *   nothing is created in one keystroke. Accepting drift needs a reason.
 * - **Review** — attributions agents proposed, Confirm (y) or Reject (n), moving on by itself.
 * - **Blocked** — the blocked tasks in the scope, each with a status editor.
 *
 * There is no "Changes" feed and no new route: per-record history is the History drawer.
 * The tab, the selection, the scope and the filters all live in the URL.
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

const SEVERITIES = [
  { key: 'critical', label: 'Critical' },
  { key: 'high', label: 'High' },
  { key: 'medium', label: 'Medium' },
  { key: 'low', label: 'Low' },
] as const;

export interface FindingFilters {
  readonly severity: string;
  readonly lens: string;
  readonly status: string;
  readonly project: string;
}

/** The Findings tab's filters, from the URL. `open` is the default status, so its absence. */
export function filtersOf(search: string): FindingFilters {
  const params = new URLSearchParams(search);
  return {
    severity: params.get('severity') ?? ANY,
    lens: params.get('lens') ?? ANY,
    status: params.get('status') ?? 'open',
    project: params.get('project') ?? ANY,
  };
}

/** What a finding's row says it is: its status, and "acknowledged" for an open one somebody accepted. */
export function rowState(row: Pick<FindingRow, 'status' | 'verified'>): string {
  if (row.status === 'open' && row.verified === 'confirmed') return 'acknowledged';
  return statusWords(row.status);
}

export function Findings({ search }: { search: string }) {
  const tab = tabOf(search);
  const scope = scopeOf(search);
  const filters = filtersOf(search);
  const { phrase, current } = useScopeView();

  // Every tab's read starts at once: each tab carries its count, and a count is only honest once the
  // list it counts has been read. Each re-reads in place after its own verdicts.
  const findings = useAsync(
    () =>
      foreman.findings({
        severity: filters.severity,
        lens: filters.lens,
        status: filters.status,
        project: filters.project,
        group: scope ?? '',
      }),
    [filters.severity, filters.lens, filters.status, filters.project, scope],
  );
  // `?project=` narrows every tab, not only Findings (FRM-T-18.15).
  const project = projectOf(search);
  const drift = useDriftTriage(scope, project);
  const review = useReviewQueue(scope, project);
  const blocked = useAsync(() => foreman.tasksAcross('blocked', scope, project), [scope, project]);
  // What the other tabs say they cover: the project, within the scope when there is one.
  const tabPhrase = project === null ? phrase : phrase === null ? project : `${project} in ${phrase}`;

  const setTab = (next: string) => {
    if ((TRIAGE_TABS as readonly string[]).includes(next)) replaceLocation(tabHref(search, next as TriageTab));
  };
  useTriageKeys((key) => {
    const index = ['tab-1', 'tab-2', 'tab-3', 'tab-4'].indexOf(key);
    const next = TRIAGE_TABS[index];
    if (next === undefined) return false;
    setTab(next);
    return true;
  });

  const unknown =
    scope !== null &&
    [findings.state, drift.state, review.state, blocked.state].some((s) => s.status === 'error' && s.notFound);

  const count = (n: number | null): { count?: number } => (n === null ? {} : { count: n });
  const counts: Record<TriageTab, number | null> = {
    findings: findings.state.status === 'ready' ? findings.state.value.total : null,
    drift: drift.state.status === 'ready' ? drift.state.value.items.length : null,
    review: review.state.status === 'ready' ? review.waiting : null,
    blocked: blocked.state.status === 'ready' ? blocked.state.value.total : null,
  };

  let panel: ReactNode;
  switch (tab) {
    case 'drift':
      panel = <DriftTab search={search} handle={drift} phrase={tabPhrase} />;
      break;
    case 'review':
      panel = <ReviewTab search={search} queue={review} phrase={tabPhrase} />;
      break;
    case 'blocked':
      panel = <BlockedTab search={search} handle={blocked} phrase={tabPhrase} />;
      break;
    default:
      panel = (
        <FindingsTab
          search={search}
          handle={findings}
          filters={filters}
          phrase={phrase}
          emptyGroup={scope !== null && current !== undefined && current.count === 0 ? current.name : null}
          scoped={scope !== null}
        />
      );
  }

  return (
    <Page>
      <PageHeader
        title="Findings"
        description={
          scope === null
            ? 'Everything waiting on a verdict from you, worst first. Agents propose; nothing here is true until you say so.'
            : `Everything${phrase === null ? '' : ` in ${phrase}`} waiting on a verdict from you, worst first.`
        }
      />
      <ScopeNotice />
      {unknown ? (
        <UnknownScope scope={scope} />
      ) : (
        <div className="fm-triage">
          <Tabs
            aria-label="What to triage"
            activationMode="manual"
            value={tab}
            onValueChange={setTab}
            items={TRIAGE_TABS.map((value) => ({
              value,
              label: TAB_LABEL[value],
              ...count(counts[value]),
              ...(counts[value] === null
                ? {}
                : { countLabel: `${TAB_LABEL[value]}, ${String(counts[value])} waiting` }),
            }))}
          >
            <TabPanel value={tab}>{panel}</TabPanel>
          </Tabs>
        </div>
      )}
    </Page>
  );
}

// ─── The Findings tab ──────────────────────────────────────────────────────

function FindingsTab({
  search,
  handle,
  filters,
  phrase,
  emptyGroup,
  scoped,
}: {
  search: string;
  handle: AsyncHandle<FindingsPage>;
  filters: FindingFilters;
  phrase: string | null;
  /** The scope's name, when it is a group with no projects. */
  emptyGroup: string | null;
  scoped: boolean;
}) {
  const toast = useToast();
  // Filters live in the URL beside the scope (FRM-T-17.4); changing one drops the selection.
  const setFilter = (key: keyof FindingFilters, value: string) => {
    replaceLocation(
      withParams(`/findings${search}`, { [key]: key === 'status' && value === 'open' ? null : value, sel: null }),
    );
  };

  const rows = handle.state.status === 'ready' ? handle.state.value.items : [];
  const ids = rows.map((row) => row.humanId);
  const selected = selectionOf(search);
  const shown = effectiveSelection(ids, selected);
  const picked = selected !== null && ids.includes(selected);
  const row = rows.find((r) => r.humanId === shown) ?? null;
  useScrollToSelected(shown);

  // The bulk selection is the screen's, not the URL's: it is a set being built, not a place.
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const filterKey = `${filters.severity}|${filters.lens}|${filters.status}|${filters.project}`;
  useEffect(() => {
    setChecked(new Set());
  }, [filterKey]);
  const chosen = rows.filter((r) => checked.has(r.humanId));
  const toggle = (id: string) => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => {
    handle.refresh();
    setRefreshKey((k) => k + 1);
  };
  const verdict = useFindingVerdict();
  const bulk = useBulk();
  /** Won't fix, waiting for its reason: one finding, or the bulk selection. */
  const [asking, setAsking] = useState<readonly FindingRow[] | null>(null);

  const BULK_VERB: Record<Exclude<FindingVerdict, 'fixed'>, string> = {
    acknowledge: 'Acknowledged',
    reopen: 'Reopened',
    'wont-fix': 'Marked won’t fix',
  };
  /** What a skipped item already is, for the toast: "2 already acknowledged — skipped". */
  const ALREADY: Record<'acknowledge' | 'reopen', string> = { acknowledge: 'acknowledged', reopen: 'open' };
  const runBulk = (kind: Exclude<FindingVerdict, 'fixed'>, reason = '') => {
    if (bulk.pending || chosen.length === 0) return;
    // Acknowledge and Reopen skip what they would not change (FRM-T-18.15): no PATCH, so no audit
    // event and nothing for Undo to refuse. Won't fix is sent to each, since it also writes the reason.
    const { send, skip } =
      kind === 'wont-fix' ? { send: chosen, skip: [] } : partitionBulk(chosen, (r) => verdictApplies(kind, r));
    const targets = new Map(send.map((r) => [r.humanId, r]));
    void bulk
      .run({
        ids: send.map((r) => r.humanId),
        verb: BULK_VERB[kind],
        noun: { one: 'finding', other: 'findings' },
        write: (id) => writeVerdict({ humanId: id, project: targets.get(id)?.project ?? '' }, kind, reason),
        refresh,
        undone: `Undone — ${String(send.length)} ${send.length === 1 ? 'finding is' : 'findings are'} as ${send.length === 1 ? 'it was' : 'they were'}`,
        skipped: kind === 'wont-fix' || skip.length === 0 ? null : `${String(skip.length)} already ${ALREADY[kind]} — skipped`,
      })
      .then(() => {
        setChecked(new Set());
      });
  };

  const act = (kind: FindingVerdict) => {
    if (chosen.length > 0) {
      if (kind === 'fixed') {
        toast.show({ message: 'Mark fixed takes one finding at a time: each fix needs its own commit.' });
        return;
      }
      if (kind === 'wont-fix') setAsking(chosen);
      else runBulk(kind);
      return;
    }
    if (row === null) return;
    if (kind === 'wont-fix') {
      setAsking([row]);
      return;
    }
    verdict.act({ humanId: row.humanId, project: row.project, status: row.status, verified: row.verified }, kind, {
      refresh,
    });
  };

  useTriageKeys((key) => {
    switch (key) {
      case 'next':
      case 'previous':
        select(search, moveSelection(ids, shown, key === 'next' ? 1 : -1));
        return true;
      case 'toggle':
        if (shown === null) return false;
        toggle(shown);
        return true;
      case 'clear':
        if (checked.size === 0) return false;
        setChecked(new Set());
        return true;
      case 'acknowledge':
        act('acknowledge');
        return true;
      case 'fixed':
        act('fixed');
        return true;
      case 'reopen':
        act('reopen');
        return true;
      case 'wont-fix':
        act('wont-fix');
        return true;
      default:
        return false;
    }
  });

  const ready = handle.state.status === 'ready' ? handle.state.value : null;
  const projects = [...new Set([...rows.map((r) => r.project), ...(filters.project === ANY ? [] : [filters.project])])].sort();

  const filterBar = (
    <Stack gap="12">
      <Cluster gap="8" role="group" aria-label="Severity">
        {SEVERITIES.map((level) => {
          const n = ready?.counts[level.key] ?? 0;
          const on = filters.severity === level.key;
          return (
            <Button
              key={level.key}
              size="sm"
              variant="secondary"
              pressed={on}
              // A second press clears it: a filter you can turn on and not off is a trap.
              onClick={() => {
                setFilter('severity', on ? ANY : level.key);
              }}
            >
              {level.label} <span className="fm-triage__chip-count">{n}</span>
            </Button>
          );
        })}
      </Cluster>
      <FilterBar aria-label="Filter the findings">
        <FormField label="Severity">
          <Select
            value={filters.severity}
            onValueChange={(v) => {
              setFilter('severity', v);
            }}
            options={[
              { value: ANY, label: 'Any severity' },
              ...SEVERITIES.map((s) => ({ value: s.key, label: s.label })),
            ]}
          />
        </FormField>
        <FormField label="Lens">
          <Select
            value={filters.lens}
            onValueChange={(v) => {
              setFilter('lens', v);
            }}
            options={[
              { value: ANY, label: 'Any lens' },
              // A lens is free-form: one in the URL that is not among the ten still shows as chosen.
              ...[...LENSES, ...(filters.lens === ANY || LENSES.includes(filters.lens) ? [] : [filters.lens])].map((l) => ({
                value: l,
                label: l,
              })),
            ]}
          />
        </FormField>
        <FormField label="Status">
          <Select
            value={filters.status}
            onValueChange={(v) => {
              setFilter('status', v);
            }}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'fixed', label: 'Fixed' },
              { value: 'deferred', label: 'Deferred' },
              { value: 'wont_fix', label: "Won't fix" },
            ]}
          />
        </FormField>
        <FormField label="Project">
          <Select
            value={filters.project}
            onValueChange={(v) => {
              setFilter('project', v);
            }}
            options={[{ value: ANY, label: 'Any project' }, ...projects.map((code) => ({ value: code, label: code }))]}
          />
        </FormField>
      </FilterBar>
    </Stack>
  );

  if (handle.state.status === 'loading') {
    return (
      <Stack gap="16">
        {filterBar}
        <Skeleton lines={10} />
      </Stack>
    );
  }
  if (handle.state.status === 'error') {
    return (
      <Stack gap="16">
        {filterBar}
        <EmptyState kind="error" heading="The findings did not load">
          {handle.state.message}
        </EmptyState>
      </Stack>
    );
  }

  if (rows.length === 0) {
    const open = filters.status === 'open';
    return (
      <Stack gap="16">
        {filterBar}
        {emptyGroup !== null ? (
          <EmptyState kind="empty" heading={`${emptyGroup} has no projects`}>
            So it has no findings. Move projects into it from{' '}
            <Link variant="inline" href="/projects">
              Projects
            </Link>
            .
          </EmptyState>
        ) : (
          <EmptyState
            kind={open ? 'empty' : 'no-results'}
            heading={
              !open || filters.severity !== ANY || filters.lens !== ANY || filters.project !== ANY
                ? 'Nothing matches'
                : !scoped
                  ? 'Nothing open anywhere'
                  : phrase === null
                    ? 'Nothing open'
                    : `Nothing open across ${phrase}`
            }
          >
            {!open || filters.severity !== ANY || filters.lens !== ANY || filters.project !== ANY
              ? 'Widen the filters.'
              : !scoped
                ? 'Every finding in every project has been dealt with — which is a success state.'
                : 'Every finding in these projects has been dealt with — which is a success state.'}
          </EmptyState>
        )}
      </Stack>
    );
  }

  const total = ready?.total ?? rows.length;
  const list = (
    <>
      <div className="fm-triage__list-head" aria-live="polite">
        {chosen.length > 0 ? (
          <span>
            <strong>{chosen.length} selected</strong> of {total} · shift-click or <KeyHint k="x" /> to add
          </span>
        ) : (
          <span>
            <strong>
              {total} {filters.status === 'open' ? 'open' : statusWords(filters.status)}
            </strong>
            {phrase === null ? '' : ` · ${phrase}`} · worst first
            {rows.length < total ? ` · showing ${String(rows.length)}` : ''}
          </span>
        )}
      </div>
      <ul className="fm-triage__rows" aria-label="Findings">
        {rows.map((r) => (
          <TriageRow
            key={r.humanId}
            id={r.humanId}
            selected={r.humanId === shown}
            onSelect={(event) => {
              if (event.shiftKey) {
                toggle(r.humanId);
                return;
              }
              select(search, r.humanId);
            }}
            leading={
              <Checkbox
                aria-label={`Select ${r.humanId} for a bulk verdict`}
                checkIcon={<Check />}
                checked={checked.has(r.humanId)}
                onCheckedChange={() => {
                  toggle(r.humanId);
                }}
              />
            }
            trailing={rowState(r)}
          >
            <span className="fm-triage__line">
              <Badge tone={severityTone(r.severity)}>{r.severity}</Badge>
              <code className="fm-triage__id">{r.humanId}</code>
              <span className="fm-triage__project">{r.project}</span>
            </span>
            <span className="fm-triage__text">{plainText(r.title)}</span>
            <span className="fm-triage__sub">{r.lenses.length === 0 ? 'no lens' : r.lenses.join(', ')}</span>
          </TriageRow>
        ))}
      </ul>
    </>
  );

  const index = shown === null ? -1 : ids.indexOf(shown);
  const detail =
    chosen.length > 0 ? (
      <Stack gap="12" className="fm-triage__record">
        <h2 className="fm-triage__title">
          {chosen.length} selected · {spanOf(chosen.map((r) => r.project))}
        </h2>
        <p className="fm-muted">
          {chosen.length} separate verdicts. Each one is its own audit event, so each can be undone on its own — and each
          can refuse on its own if something has changed it since.
        </p>
        <ul className="fm-triage__rows">
          {chosen.map((r) => (
            <li key={r.humanId} className="fm-triage__row">
              <span className="fm-triage__body">
                <span className="fm-triage__line">
                  <Badge tone={severityTone(r.severity)}>{r.severity}</Badge>
                  <code className="fm-triage__id">{r.humanId}</code>
                  <span className="fm-triage__project">{r.project}</span>
                </span>
                <span className="fm-triage__text">{plainText(r.title)}</span>
              </span>
              <span className="fm-triage__state">{rowState(r)}</span>
            </li>
          ))}
        </ul>
      </Stack>
    ) : shown === null ? null : (
      <FindingRecord
        key={shown}
        humanId={shown}
        embedded
        refreshKey={refreshKey}
        onChanged={handle.refresh}
        position={`${String(index + 1)} of ${String(rows.length)}`}
      />
    );

  return (
    <Stack gap="16">
      {filterBar}
      <SplitView
        label="Findings"
        picked={picked}
        list={list}
        detail={detail}
        onBack={() => {
          select(search, null);
        }}
      />
      {chosen.length > 0 ? (
        <div className="fm-triage__bulk" role="region" aria-label="Bulk verdicts">
          <span className="fm-triage__bulk-count">
            {chosen.length} selected · {chosen.length} separate {chosen.length === 1 ? 'verdict' : 'verdicts'}
          </span>
          <ActionBar aria-label="Verdicts on the selected findings" forceVisible className="fm-triage__bulk-bar">
            <ActionBar.Item
              icon={<Eye />}
              label={`Acknowledge ${String(chosen.length)}`}
              disabled={bulk.pending}
              onClick={() => {
                runBulk('acknowledge');
              }}
            />
            <ActionBar.Item
              icon={<Ban />}
              label="Won’t fix…"
              disabled={bulk.pending}
              onClick={() => {
                setAsking(chosen);
              }}
            />
            <ActionBar.Item
              icon={<RotateCcw />}
              label="Reopen"
              disabled={bulk.pending}
              onClick={() => {
                runBulk('reopen');
              }}
            />
            <ActionBar.Item
              icon={<X />}
              label="Clear"
              onClick={() => {
                setChecked(new Set());
              }}
            />
          </ActionBar>
          <span className="fm-muted fm-triage__bulk-note">Mark fixed takes one finding at a time: each fix needs its own commit.</span>
        </div>
      ) : null}
      <ReasonDialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
        title={
          asking !== null && asking.length > 1
            ? `Won’t fix ${String(asking.length)} findings`
            : `Won’t fix ${asking?.[0]?.humanId ?? ''}`
        }
        description="Say why. The reason is kept on each finding, beside its recommendation, and each verdict can be undone."
        label="Why it will not be fixed"
        confirm="Mark won’t fix"
        onSubmit={(reason) => {
          const targets = asking ?? [];
          setAsking(null);
          if (targets.length > 1 || chosen.length > 0) {
            runBulk('wont-fix', reason);
            return;
          }
          const only = targets[0];
          if (only === undefined) return;
          verdict.act(
            { humanId: only.humanId, project: only.project, status: only.status, verified: only.verified },
            'wont-fix',
            { reason, refresh },
          );
        }}
      />
    </Stack>
  );
}
