import {
  Alert,
  Badge,
  EmptyState,
  Page,
  Skeleton,
  Table,
} from '@d3cloud/ui';
import { foreman, type RiskRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { ProjectHeader } from '../components/ProjectHeader';
import { priorityColumns, usePhone, type PriorityColumn } from '../ui/tablePriority';

/**
 * The Risk Register, generated (T-4.12, FRM-REQ-073, ADR-006).
 *
 * The column that earns the screen is **Tripwire**: a risk without a named condition is a worry,
 * and a worry is something you re-read and feel bad about rather than something that ever fires.
 */

const LEVEL_TONE: Record<string, 'danger' | 'attention' | 'neutral'> = {
  high: 'danger',
  medium: 'attention',
  low: 'neutral',
};

export function RiskRegister({ code }: { code: string }) {
  const { state } = useAsync(() => foreman.risks(code), [code]);

  // Below 768px: the risk is the title, its status stays, and ID, likelihood, impact and the
  // tripwire fold into the sub-line (FRM-REQ-249).
  const riskColumns: PriorityColumn<RiskRow>[] = [
    { key: 'humanId', header: 'ID', width: '7rem', phone: 'fold', foldLabel: '', cell: (row) => row.humanId },
    { key: 'title', header: 'Risk', phone: 'host', cell: (row) => row.title },
    {
      key: 'likelihood',
      header: 'Likelihood',
      width: '7rem',
      phone: 'fold',
      cell: (row) => <Badge tone={LEVEL_TONE[row.likelihood] ?? 'neutral'}>{row.likelihood}</Badge>,
    },
    {
      key: 'impact',
      header: 'Impact',
      width: '6rem',
      phone: 'fold',
      cell: (row) => <Badge tone={LEVEL_TONE[row.impact] ?? 'neutral'}>{row.impact}</Badge>,
    },
    {
      key: 'tripwire',
      header: 'Tripwire',
      phone: 'fold',
      cell: (row) =>
        row.tripwire === null || row.tripwire.trim() === '' ? (
          <span className="fm-muted">none named — this is a worry, not a risk</span>
        ) : (
          row.tripwire
        ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '7rem',
      phoneWidth: '7.5rem',
      cell: (row) =>
        row.status === 'fired' ? (
          <Badge tone="danger">
            fired{row.firedAt === null ? '' : ` ${row.firedAt.slice(0, 10)}`}
          </Badge>
        ) : (
          <Badge tone="neutral">{row.status}</Badge>
        ),
    },
  ];

  const columns = priorityColumns(riskColumns, usePhone());

  const fired =
    state.status === 'ready' ? state.value.items.filter((r) => r.status === 'fired') : [];

  return (
    <Page>
      <ProjectHeader
        code={code}
        section="risks"
        description={`Generated for ${code}. Each risk with the condition that forces a re-plan.`}
      />

      {fired.length === 0 ? null : (
        <Alert
          tone="danger"
          title={`${String(fired.length)} tripwire${fired.length === 1 ? '' : 's'} has fired`}
        >
          {fired.map((r) => `${r.humanId} — ${r.title}`).join('; ')}
        </Alert>
      )}

      {state.status === 'loading' ? (
        <Skeleton lines={8} />
      ) : state.status === 'error' ? (
        <EmptyState kind="error" heading="The risks did not load">
          {state.message}
        </EmptyState>
      ) : (
        <Table
          caption={`Risk register for ${code}`}
          captionHidden
          density="compact"
          columns={columns}
          rows={state.value.items}
          rowKey={(row) => row.humanId}
          empty={
            <EmptyState kind="empty" size="inline" heading="No risks recorded">
              A project with no recorded risks has either none or no register.
            </EmptyState>
          }
        />
      )}
    </Page>
  );
}
