import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  FilterBar,
  FormField,
  Link,
  Page,
  Select,
  Skeleton,
  Table,
} from '@d3cloud/ui';
import { foreman, type RequirementFilters, type RequirementRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { ProjectHeader } from '../components/ProjectHeader';
import { CoverageSummary } from '../components/CoverageSummary';
import { priorityColumns, usePhone, type PriorityColumn } from '../ui/tablePriority';

/**
 * S-13 — the register, at the volume it actually has.
 *
 * Four filters, because these are the four questions worth asking of 439 rows: what is a Must, what
 * belongs to this phase, what nothing covers, and what the lint could not read. The backlog — a
 * requirement no phase has claimed — is the phase filter's first option rather than a fifth screen
 * (T-3.1): it is the same table with `phase = none`.
 */

const ANY = 'any';

const PRIORITY_TONE: Record<string, 'danger' | 'attention' | 'neutral'> = {
  M: 'danger',
  S: 'attention',
  C: 'neutral',
  W: 'neutral',
};

const PRIORITY_LABEL: Record<string, string> = {
  M: 'Must',
  S: 'Should',
  C: 'Could',
  W: "Won't",
};

export function Requirements({ code, search }: { code: string; search: string }) {
  // A filtered link is a shareable link: the drift count on the project overview lands here with
  // `?uncovered=true` already applied, rather than on 439 rows and an instruction to go looking.
  const initial = new URLSearchParams(search);
  const [priority, setPriority] = useState(initial.get('priority') ?? ANY);
  const [phase, setPhase] = useState(initial.get('phase') ?? ANY);
  const [coverage, setCoverage] = useState(
    initial.get('uncovered') === 'true'
      ? 'uncovered'
      : initial.get('uncovered') === 'false'
        ? 'covered'
        : ANY,
  );
  const [lint, setLint] = useState(initial.get('earsLint') ?? ANY);

  const phases = useAsync(() => foreman.phases(code), [code]);
  const requirements = useRequirements(code, {
    ...(priority === ANY ? {} : { priority }),
    ...(phase === ANY ? {} : { phase }),
    ...(coverage === ANY ? {} : { uncovered: coverage === 'uncovered' }),
    ...(lint === ANY ? {} : { earsLint: lint as 'ok' | 'warned' }),
  });

  // Below 768px: the statement is the title, headed by its ID as the row's link; the priority stays
  // as the status, and phase, coverage and EARS fold into the sub-line (FRM-REQ-249).
  const requirementColumns: PriorityColumn<RequirementRow>[] = [
    {
      key: 'humanId',
      header: 'ID',
      width: '8.5rem',
      phone: 'hide',
      cell: (row) => <Link href={`/requirements/${row.humanId}`}>{row.humanId}</Link>,
    },
    {
      key: 'priority',
      header: 'Priority',
      width: '5.5rem',
      phoneWidth: '5rem',
      cell: (row) => (
        <Badge tone={PRIORITY_TONE[row.priority] ?? 'neutral'}>
          {PRIORITY_LABEL[row.priority] ?? row.priority}
        </Badge>
      ),
    },
    {
      key: 'statement',
      header: 'Statement',
      phone: 'host',
      phoneCell: (row) => (
        <>
          <Link className="fm-rowlink" href={`/requirements/${row.humanId}`}>
            {row.humanId}
          </Link>
          <div>{row.statement}</div>
        </>
      ),
      cell: (row) => row.statement,
    },
    {
      key: 'phase',
      header: 'Phase',
      width: '7.5rem',
      phone: 'fold',
      cell: (row) =>
        row.phase === null ? <span className="fm-muted">backlog</span> : row.phase.humanId,
    },
    {
      key: 'coveredBy',
      header: 'Covered by',
      width: '7rem',
      phone: 'fold',
      numeric: true,
      cell: (row) =>
        row.coveredBy === 0 ? (
          // The hole is the point of the screen, so it is said rather than left blank.
          <Badge tone="danger">nothing</Badge>
        ) : (
          `${String(row.coveredBy)} task${row.coveredBy === 1 ? '' : 's'}`
        ),
    },
    {
      key: 'ears',
      header: 'EARS',
      width: '7rem',
      phone: 'fold',
      cell: (row) =>
        row.earsLintOk ? (
          row.earsPattern
        ) : (
          <Badge tone="attention" title={row.earsLintNote ?? undefined}>
            {row.earsPattern}
          </Badge>
        ),
    },
  ];

  const columns = priorityColumns(requirementColumns, usePhone());

  const phaseOptions = [
    { value: ANY, label: 'Any phase' },
    { value: 'none', label: 'Backlog — no phase' },
    ...(phases.state.status === 'ready'
      ? phases.state.value.items.map((p) => ({
          value: p.humanId,
          label: `${p.number} · ${p.name}`,
        }))
      : []),
  ];

  return (
    <Page>
      <ProjectHeader
        code={code}
        section="requirements"
        description={`The register for ${code}, and what does or does not satisfy it.`}
      />

      <CoverageSummary code={code} />

      <FilterBar
        aria-label="Filter the requirements"
        trailing={
          requirements.status === 'ready' ? (
            <span className="fm-muted">
              {requirements.total === null || requirements.total === requirements.rows.length
                ? `${String(requirements.rows.length)} shown`
                : `${String(requirements.rows.length)} of ${String(requirements.total)} shown`}
            </span>
          ) : null
        }
      >
        <FormField label="Priority">
          <Select
            value={priority}
            onValueChange={setPriority}
            options={[
              { value: ANY, label: 'Any priority' },
              { value: 'M', label: 'Must' },
              { value: 'S', label: 'Should' },
              { value: 'C', label: 'Could' },
              { value: 'W', label: "Won't" },
            ]}
          />
        </FormField>
        <FormField label="Phase">
          <Select value={phase} onValueChange={setPhase} options={phaseOptions} />
        </FormField>
        <FormField label="Coverage">
          <Select
            value={coverage}
            onValueChange={setCoverage}
            options={[
              { value: ANY, label: 'Covered or not' },
              { value: 'uncovered', label: 'Nothing covers it' },
              { value: 'covered', label: 'Something covers it' },
            ]}
          />
        </FormField>
        <FormField label="EARS lint">
          <Select
            value={lint}
            onValueChange={setLint}
            options={[
              { value: ANY, label: 'Any' },
              { value: 'warned', label: 'Warned' },
              { value: 'ok', label: 'Clean' },
            ]}
          />
        </FormField>
      </FilterBar>

      {requirements.status === 'loading' ? (
        <Skeleton lines={10} />
      ) : requirements.status === 'error' ? (
        <EmptyState kind="error" heading="The requirements did not load">
          {requirements.message}
        </EmptyState>
      ) : (
        <>
          {/* Not virtualized: a virtualized table needs every row the same height, and a
              statement is one line or four. Two hundred rows of DOM is the cheaper trade. */}
          <Table
            caption={`Requirements of ${code}`}
            captionHidden
            density="compact"
            columns={columns}
            rows={requirements.rows}
            rowKey={(row) => row.humanId}
            maxHeight="70vh"
            stickyHeader
            empty={
              <EmptyState kind="no-results" size="inline" heading="No requirements match">
                {priority === ANY && phase === ANY && coverage === ANY && lint === ANY
                  ? 'This project has no requirements yet.'
                  : 'Widen the filters, or this is genuinely empty — which is worth knowing too.'}
              </EmptyState>
            }
          />
          {requirements.cursor === null ? null : (
            <Button onClick={requirements.loadMore} loading={requirements.loadingMore}>
              Show the rest
            </Button>
          )}
        </>
      )}
    </Page>
  );
}

/**
 * The register a page at a time, accumulating.
 *
 * Bindery's register is 210 rows and Foreman's own is 152; the API caps a page at 200. Rather than
 * silently showing the first page and calling it the register, the count says how many of the
 * total are on screen and there is a button for the rest.
 */
interface RequirementsState {
  readonly rows: readonly RequirementRow[];
  readonly total: number | null;
  readonly cursor: string | null;
  readonly status: 'loading' | 'ready' | 'error';
  readonly message: string;
}

function useRequirements(code: string, filters: RequirementFilters) {
  const [state, setState] = useState<RequirementsState>({
    rows: [],
    total: null,
    cursor: null,
    status: 'loading',
    message: '',
  });
  const [loadingMore, setLoadingMore] = useState(false);

  // The filters are an object rebuilt every render, so the effect keys off their content.
  const key = JSON.stringify(filters);

  useEffect(() => {
    let live = true;
    setState({ rows: [], total: null, cursor: null, status: 'loading', message: '' });

    foreman
      .requirements(code, { ...(JSON.parse(key) as RequirementFilters), limit: 200 })
      .then((page) => {
        if (!live) return;
        setState({
          rows: page.items,
          total: page.total,
          cursor: page.nextCursor,
          status: 'ready',
          message: '',
        });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setState((current) => ({
          ...current,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        }));
      });

    return () => {
      live = false;
    };
  }, [code, key]);

  const loadMore = useCallback(() => {
    if (state.cursor === null || loadingMore) return;
    setLoadingMore(true);
    void foreman
      .requirements(code, {
        ...(JSON.parse(key) as RequirementFilters),
        limit: 200,
        cursor: state.cursor,
      })
      .then((page) => {
        setState((current) => ({
          ...current,
          rows: [...current.rows, ...page.items],
          cursor: page.nextCursor,
        }));
      })
      .finally(() => {
        setLoadingMore(false);
      });
  }, [code, key, state.cursor, loadingMore]);

  return { ...state, loadMore, loadingMore };
}
