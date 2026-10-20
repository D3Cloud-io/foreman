import {
  Alert,
  Badge,
  Card,
  CardTitle,
  EmptyState,
  Link,
  Page,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { foreman, type ScopeOfWorkTask } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { ProjectHeader } from '../components/ProjectHeader';

/**
 * The Scope of Work, generated (T-3.9, FRM-REQ-074, ADR-006).
 *
 * This screen replaces a document. There is no `scope_of_work` document kind to author, so there is
 * nothing here that can disagree with the phases and tasks it is drawn from — which is the whole
 * argument: the authored version was wrong within a fortnight and nobody noticed for months.
 */

const statusTone = (status: string): 'danger' | 'attention' | 'neutral' =>
  status === 'blocked' ? 'danger' : status === 'in_progress' ? 'attention' : 'neutral';

function Task({ task }: { task: ScopeOfWorkTask }) {
  return (
    <li>
      <Link href={`/tasks/${task.humanId}`}>{task.humanId}</Link> — {task.title}{' '}
      <Badge tone={statusTone(task.status)}>{task.status}</Badge>
      {task.size === null ? null : <span className="fm-muted"> {task.size}</span>}
      {task.satisfies.length === 0 ? (
        // The citation the authored document kept by hand, and its absence said out loud.
        <span className="fm-muted"> · cites no requirement</span>
      ) : (
        <span className="fm-muted"> · {task.satisfies.join(', ')}</span>
      )}
      {task.status === 'blocked' && task.blockedReason !== null ? (
        <div className="fm-muted">blocked: {task.blockedReason}</div>
      ) : null}
    </li>
  );
}

export function ScopeOfWorkView({ code }: { code: string }) {
  const { state } = useAsync(() => foreman.scopeOfWork(code), [code]);

  if (state.status === 'loading') {
    return (
      <Page>
        <Skeleton lines={12} />
      </Page>
    );
  }

  if (state.status === 'error') {
    return (
      <Page>
        <EmptyState kind="error" heading="The scope of work did not load">
          {state.message}
        </EmptyState>
      </Page>
    );
  }

  const sow = state.value;

  return (
    <Page>
      <ProjectHeader
        code={code}
        section="scope-of-work"
        description={`Generated from ${sow.project.code}'s phases and tasks — not a document anybody maintains.`}
      />

      {sow.phases.length === 0 ? (
        <EmptyState kind="empty" heading="No phases yet">
          A project without phases has no plan to generate.
        </EmptyState>
      ) : (
        sow.phases.map((phase) => (
          <Card key={phase.humanId}>
            <CardTitle>
              {phase.number} — {phase.name}
            </CardTitle>
            <Stack gap="12">
              <div>
                <Badge tone={phase.status === 'active' ? 'attention' : 'neutral'}>
                  {phase.status}
                </Badge>{' '}
                <span className="fm-muted">
                  {phase.done} of {phase.tasks.length} done
                  {phase.cancelled === 0 ? '' : `, ${String(phase.cancelled)} cancelled`}
                  {phase.size === null ? '' : ` · ${phase.size}`}
                </span>
              </div>

              {phase.objective === null ? null : <div>{phase.objective}</div>}

              {phase.exitDemo === null ? (
                <Alert tone="warning" title="No exit demo">
                  Nothing states what would show this phase is finished, and it cannot be completed
                  until something does.
                </Alert>
              ) : (
                <div className="fm-muted">Exit demo: {phase.exitDemo}</div>
              )}

              {phase.uncoveredMusts.length === 0 ? null : (
                // Said here rather than only at the gate, so nobody meets it for the first time
                // while trying to close the phase.
                <Alert
                  tone="danger"
                  title={`${String(phase.uncoveredMusts.length)} Must${
                    phase.uncoveredMusts.length === 1 ? '' : 's'
                  } with no task`}
                >
                  {phase.uncoveredMusts.join(', ')} — this phase cannot be completed until something
                  covers them.
                </Alert>
              )}

              {phase.tasks.length === 0 ? (
                <span className="fm-muted">No tasks in this phase.</span>
              ) : (
                <Stack gap="8" as="ul">
                  {phase.tasks.map((task) => (
                    <Task key={task.humanId} task={task} />
                  ))}
                </Stack>
              )}
            </Stack>
          </Card>
        ))
      )}

      {sow.unphased.length === 0 ? null : (
        <Card>
          <CardTitle>Not in any phase</CardTitle>
          <Stack gap="8" as="ul">
            {sow.unphased.map((task) => (
              <Task key={task.humanId} task={task} />
            ))}
          </Stack>
        </Card>
      )}

      <p className="fm-muted">
        Generated {new Date(sow.generatedAt).toLocaleString()}. Nothing here was authored twice.
      </p>
    </Page>
  );
}
