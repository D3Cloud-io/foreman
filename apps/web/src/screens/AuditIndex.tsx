import {
  Badge,
  EmptyState,
  Page,
  Skeleton,
  Table,
} from '@d3cloud/ui';
import { foreman, type AuditRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { ProjectHeader } from '../components/ProjectHeader';
import { priorityColumns, usePhone, type PriorityColumn } from '../ui/tablePriority';
import { formatDate } from '../lib/text';
import { rowAnchor, useRowAnchor } from '../lib/useRowAnchor';

/**
 * The Audit Index, generated (T-4.12, FRM-REQ-073, ADR-006).
 *
 * The vault kept this as a file every audit skill appended to, which meant the index and the
 * findings could disagree — and did. Counting the findings cannot.
 */

export function AuditIndex({ code }: { code: string }) {
  const { state } = useAsync(() => foreman.audits(code), [code]);

  // Below 768px: the audit's ID is the title, its status stays, and kind, date, scope, rounds and
  // findings fold into the sub-line (FRM-REQ-249).
  const auditColumns: PriorityColumn<AuditRow>[] = [
    { key: 'humanId', header: 'ID', width: '8rem', phone: 'host', cell: (row) => rowAnchor(row.humanId, row.humanId) },
    {
      key: 'kind',
      header: 'Kind',
      width: '9rem',
      phone: 'fold',
      foldLabel: '',
      cell: (row) => <Badge tone="neutral">{row.kind.replace(/_/g, ' ')}</Badge>,
    },
    {
      key: 'runDate',
      header: 'Run',
      width: '8rem',
      phone: 'fold',
      sortable: true,
      cell: (row) => formatDate(row.runDate),
    },
    {
      key: 'scope',
      header: 'Scope',
      phone: 'fold',
      cell: (row) => row.scope ?? <span className="fm-muted">whole project</span>,
    },
    { key: 'rounds', header: 'Rounds', width: '5rem', numeric: true, phone: 'fold', cell: (row) => row.rounds },
    {
      key: 'findings',
      header: 'Findings',
      width: '12rem',
      phone: 'fold',
      cell: (row) =>
        row.findings.total === 0 ? (
          <span className="fm-muted">none</span>
        ) : (
          <>
            {row.findings.open} open of {row.findings.total}
            {row.findings.critical + row.findings.high === 0 ? null : (
              <>
                {' '}
                <Badge tone="danger">
                  {row.findings.critical + row.findings.high} critical/high
                </Badge>
              </>
            )}
          </>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '7rem',
      phoneWidth: '6.5rem',
      cell: (row) => (
        <Badge tone={row.status === 'running' ? 'attention' : 'neutral'}>{row.status}</Badge>
      ),
    },
  ];

  const columns = priorityColumns(auditColumns, usePhone());
  useRowAnchor(state.status === 'ready' && state.value.items.length > 0);

  return (
    <Page>
      <ProjectHeader
        code={code}
        section="audits"
        description={`Generated for ${code} — the counts come from the findings, so they cannot disagree with them.`}
      />

      {state.status === 'loading' ? (
        <Skeleton lines={6} />
      ) : state.status === 'error' ? (
        <EmptyState kind="error" heading="The audits did not load">
          {state.message}
        </EmptyState>
      ) : (
        <Table
          caption={`Audits of ${code}`}
          captionHidden
          density="compact"
          columns={columns}
          rows={state.value.items}
          rowKey={(row) => row.humanId}
          empty={
            <EmptyState kind="empty" size="inline" heading="No audits run">
              Nothing has been reviewed against this project yet.
            </EmptyState>
          }
        />
      )}
    </Page>
  );
}
