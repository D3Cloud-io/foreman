import { useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  Link,
  Page,
  SegmentedControl,
  Skeleton,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { foreman, type StatusWrite, type TaskRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { EditForm, PHASE_STATUSES, SIZES } from './EditForms';
import { GateChecks } from '../components/GateChecks';
import { ProjectHeader } from '../components/ProjectHeader';
import { realityChanged } from '../components/RealityStrip';
import { PhaseBoard } from './PhaseBoard';
import { StatusControl } from './StatusControl';

/**
 * S-11 — one phase, and its tasks.
 *
 * A blocked task shows its reason in the row rather than behind a click. The vault's failure was
 * that you could see work had stopped and never why; putting the reason one interaction away is
 * how that happens again.
 *
 * Under the header, the phase is its exit gate (FRM-REQ-247): the server's own checks, listed as the
 * requirements for calling it complete — see `GateChecks`.
 */

export function PhaseDetail({ code, phaseHumanId }: { code: string; phaseHumanId: string }) {
  const phases = useAsync(() => foreman.phases(code), [code]);
  const tasks = useAsync(() => foreman.tasks(code, phaseHumanId), [code, phaseHumanId]);
  const [view, setView] = useState<'list' | 'board'>('list');

  // A status write lands in place (FRM-T-18.4): the row takes the server's answer, and the tasks
  // and the phase — whose status and counts may have rolled up — are re-read without a skeleton,
  // so the table keeps its sort and the select keeps focus.
  const onStatusChanged = (result?: StatusWrite) => {
    if (result !== undefined) {
      tasks.update((page) => ({
        ...page,
        items: page.items.map((row) =>
          row.humanId === result.humanId
            ? { ...row, status: result.status, blockedReason: result.blockedReason ?? null }
            : row,
        ),
      }));
    }
    tasks.refresh();
    phases.refresh();
    // The strip's evidence and the gate both read what a status just changed.
    realityChanged(code);
  };

  const phase =
    phases.state.status === 'ready'
      ? phases.state.value.items.find((p) => p.humanId === phaseHumanId)
      : undefined;

  const columns: TableColumn<TaskRow>[] = [
    {
      key: 'humanId',
      header: 'ID',
      width: '9rem',
      sortable: true,
      cell: (row) => (
        <Link href={`/tasks/${row.humanId}`}>
          <code>{row.humanId}</code>
        </Link>
      ),
    },
    {
      key: 'title',
      header: 'Task',
      sortable: true,
      cell: (row) => (
        <>
          {row.title}
          {row.status === 'blocked' ? (
            // In the row, not behind a click: "stopped, and nobody recorded why" is the failure
            // this whole product exists to stop repeating.
            <div className="fm-muted">{row.blockedReason ?? 'no reason recorded'}</div>
          ) : null}
        </>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      width: '11rem',
      // A control, not a badge: status is changeable from every screen that shows it.
      cell: (row) => <StatusControl task={row} code={code} onChanged={onStatusChanged} />,
    },
    { key: 'size', header: 'Size', width: '5rem', cell: (row) => row.size ?? '—' },
    {
      key: 'requirements',
      header: 'Satisfies',
      width: '12rem',
      cell: (row) =>
        row.requirements.length === 0 ? (
          <span className="fm-muted">nothing</span>
        ) : (
          <code>{row.requirements.join(', ')}</code>
        ),
    },
  ];

  if (phases.state.status === 'loading') {
    return (
      <Page>
        <Skeleton lines={6} />
      </Page>
    );
  }

  if (phases.state.status === 'ready' && phase === undefined) {
    return (
      <Page>
        <EmptyState kind="no-results" heading={`${code} has no phase ${phaseHumanId}`}>
          Pick one from the phases list.
        </EmptyState>
      </Page>
    );
  }

  return (
    <Page>
      <ProjectHeader
        code={code}
        section="phases"
        title={phase === undefined ? phaseHumanId : `${phase.number} — ${phase.name}`}
        {...(phase?.objective === undefined || phase.objective === null ? {} : { description: phase.objective })}
        actions={
          phase === undefined ? undefined : (
            <>
              <SegmentedControl
                items={[
                  { value: 'list', label: 'List' },
                  { value: 'board', label: 'Board' },
                ]}
                value={view}
                onValueChange={(next) => { setView(next === 'board' ? 'board' : 'list'); }}
                size="sm"
                aria-label="How to show the tasks"
              />
              <Badge tone={phase.status === 'active' ? 'attention' : 'neutral'}>{phase.status}</Badge>
              <EditForm
                title={`Edit ${phase.humanId}`}
                // No number field: it is embedded in the human ID, and the ID is immutable.
                description="A phase cannot be renumbered — its ID embeds the number."
                path={`/api/projects/${code}/phases/${phase.humanId}`}
                trigger={<Button>Edit</Button>}
                onSaved={() => {
                  phases.refresh();
                  realityChanged(code);
                }}
                initial={{
                  name: phase.name,
                  status: phase.status,
                  size: phase.size ?? '',
                  objective: phase.objective ?? '',
                  exitDemo: phase.exitDemo ?? '',
                }}
                fields={[
                  { name: 'name', label: 'Name', kind: 'text' },
                  { name: 'status', label: 'Status', kind: 'select', options: PHASE_STATUSES },
                  { name: 'size', label: 'Size', kind: 'select', options: SIZES, optional: true },
                  { name: 'objective', label: 'Objective', kind: 'textarea', optional: true },
                  {
                    name: 'exitDemo',
                    label: 'Exit demo',
                    kind: 'textarea',
                    optional: true,
                    help: 'What you would show to call this phase done.',
                  },
                ]}
              />
            </>
          )
        }
      />

      {phase === undefined ? null : (
        <GateChecks
          code={code}
          phaseHumanId={phaseHumanId}
          exitDemo={phase.exitDemo}
          stamp={`${phase.status}:${phase.exitDemo ?? ''}:${
            tasks.state.status === 'ready'
              ? tasks.state.value.items.map((task) => `${task.humanId}=${task.status}`).join(',')
              : ''
          }`}
        />
      )}

      {tasks.state.status === 'loading' ? (
        <Skeleton lines={5} />
      ) : tasks.state.status === 'error' ? (
        <EmptyState kind="error" heading="The tasks did not load">
          {tasks.state.message}
        </EmptyState>
      ) : view === 'board' ? (
        <PhaseBoard tasks={tasks.state.value.items} code={code} onChanged={onStatusChanged} />
      ) : (
        <Table
          caption={`Tasks in ${phaseHumanId}`}
          captionHidden
          columns={columns}
          rows={tasks.state.value.items}
          rowKey={(row) => row.humanId}
          empty={
            <EmptyState kind="empty" size="inline" heading="No tasks in this phase">
              A phase with no tasks has an objective and no way to reach it.
            </EmptyState>
          }
        />
      )}
    </Page>
  );
}
