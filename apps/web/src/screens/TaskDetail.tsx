import {
  Alert,
  Button,
  Card,
  CardTitle,
  EmptyState,
  Link,
  Page,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { foreman, type PhaseProgressRow } from '../lib/api';
import { Markdown } from '../components/Markdown';
import { useAsync } from '../lib/useAsync';
import { EditForm, SIZES } from './EditForms';
import { OpenInConstellation } from '../components/OpenInConstellation';
import { HistoryDrawer } from '../components/HistoryDrawer';
import { StatusControl } from './StatusControl';
import { ProjectHeader } from '../components/ProjectHeader';
import { PropertyRail, type RailRow } from '../components/PropertyRail';
import { RealitySection } from '../components/RealitySection';
import { realityChanged } from '../components/RealityStrip';

/**
 * S-12 — one task: what it is for, what it declares, what it satisfies, and what cites it.
 *
 * Its properties — status, phase, size — are edited in a rail beside it, in place (FRM-REQ-247), and
 * its Reality section lists the commits, CI results and deployments behind it.
 */

interface TaskEntity {
  humanId: string;
  title: string;
  status: string;
  blockedReason: string | null;
  size: string | null;
  doneWhen: string | null;
  /** Markdown: what the task is about, in the owner's words. */
  body: string | null;
  idSynthesized: boolean;
  startedAt: string | null;
  completedAt: string | null;
  files: string[];
  requirements: { humanId: string; statement: string }[];
  dependsOn: DependencyEdge[];
  dependedOnBy: DependencyEdge[];
  phase: { humanId: string; name: string } | null;
}

interface DependencyEdge {
  humanId: string;
  title: string;
  status: string;
}

/** A task waits on unfinished work until every task it depends on is done or cancelled. */
function isUnfinished(edge: DependencyEdge): boolean {
  return edge.status !== 'done' && edge.status !== 'cancelled';
}

function DependencyList({ edges }: { edges: DependencyEdge[] }) {
  return (
    <Stack gap="8" as="ul">
      {edges.map((edge) => (
        <li key={edge.humanId}>
          <Link href={`/tasks/${edge.humanId}`}>
            <code>{edge.humanId}</code>
          </Link>{' '}
          — {edge.title} <span className="fm-muted">({edge.status.replace('_', ' ')})</span>
        </li>
      ))}
    </Stack>
  );
}

/**
 * What "Started" says when nothing was recorded. A done task with no start was never recorded as
 * started — "not yet" would say it is still to come, which a finished task cannot be.
 */
export function startedWhenMissing(status: string): string {
  return status === 'done' ? 'not recorded' : 'not yet';
}

/**
 * The task's rail: status, phase and size as controls, and where it started and finished as facts.
 * Phases are read here (not by the page) because the page does not know the project until the task
 * has loaded.
 */
function TaskRail({
  task,
  projectCode,
  onChanged,
}: {
  task: TaskEntity;
  projectCode: string;
  onChanged: () => void;
}) {
  const phases = useAsync(() => foreman.phases(projectCode), [projectCode]);
  const list: readonly PhaseProgressRow[] = phases.state.status === 'ready' ? phases.state.value.items : [];
  const current = list.find((phase) => phase.humanId === task.phase?.humanId);
  const phaseLabel = (phase: PhaseProgressRow) => `${phase.number} — ${phase.name}`;

  const rows: RailRow[] = [
    {
      kind: 'node',
      key: 'status',
      label: 'Status',
      // A control, not a badge: the status changes here as on the phase, with Undo.
      children: <StatusControl task={task} code={projectCode} onChanged={onChanged} />,
    },
    list.length === 0
      ? {
          kind: 'text',
          key: 'phase',
          label: 'Phase',
          children:
            task.phase === null ? (
              <span className="fm-muted">none</span>
            ) : (
              <Link href={`/projects/${projectCode}/phases/${task.phase.humanId}`}>{task.phase.name}</Link>
            ),
        }
      : {
          kind: 'select',
          key: 'phase',
          label: 'Phase',
          ariaLabel: `Phase of ${task.humanId}`,
          value: current?.id ?? 'none',
          options: [{ value: 'none', label: 'No phase' }, ...list.map((p) => ({ value: p.id, label: phaseLabel(p) }))],
          write: (next) => {
            const target = list.find((p) => p.id === next);
            return {
              run: () => foreman.updateTask(projectCode, task.humanId, { phaseId: next === 'none' ? null : next }),
              message: () =>
                target === undefined ? `${task.humanId} moved out of its phase` : `${task.humanId} moved to ${phaseLabel(target)}`,
              undone: `Undone — ${task.humanId} is back in ${current === undefined ? 'no phase' : phaseLabel(current)}`,
            };
          },
        },
    {
      kind: 'select',
      key: 'size',
      label: 'Size',
      ariaLabel: `Size of ${task.humanId}`,
      value: task.size ?? 'none',
      // A size cannot be cleared once set, so "No size" is offered only while there is none.
      options: [...(task.size === null ? [{ value: 'none', label: 'No size' }] : []), ...SIZES],
      write: (next) =>
        next === 'none'
          ? null
          : {
              run: () => foreman.updateTask(projectCode, task.humanId, { size: next }),
              message: () => `${task.humanId} sized ${next}`,
              undone: `Undone — ${task.humanId} is ${task.size ?? 'unsized'} again`,
            },
    },
    {
      kind: 'text',
      key: 'project',
      label: 'Project',
      children: <Link href={`/projects/${projectCode}`}>{projectCode}</Link>,
    },
    {
      kind: 'text',
      key: 'started',
      label: 'Started',
      children:
        task.startedAt === null ? startedWhenMissing(task.status) : new Date(task.startedAt).toLocaleDateString(),
    },
    {
      kind: 'text',
      key: 'completed',
      label: 'Completed',
      children: task.completedAt === null ? 'not yet' : new Date(task.completedAt).toLocaleDateString(),
    },
  ];

  return <PropertyRail subject={task.humanId} rows={rows} onChanged={onChanged} />;
}

export function TaskDetail({ humanId }: { humanId: string }) {
  // `refresh`, not `reload`: after a write or an undo the page re-reads in place (FRM-T-18.4).
  const { state, refresh } = useAsync(() => foreman.entity(humanId), [humanId]);

  if (state.status === 'loading') {
    return (
      <Page>
        <Skeleton lines={8} />
      </Page>
    );
  }

  if (state.status === 'error') {
    return (
      <Page>
        <EmptyState
          kind={state.notFound ? 'no-results' : 'error'}
          heading={state.notFound ? `Nothing here is called ${humanId}` : 'That task did not load'}
        >
          {state.notFound ? 'Check the ID, or find it from its phase.' : state.message}
        </EmptyState>
      </Page>
    );
  }

  // `/api/entities/:id` answers for any kind, so `/tasks/EXMP-REQ-001` reads a requirement — which
  // has no `files` or `dependsOn`, and blanked the console when they were read as a task's.
  if (state.value.type !== 'task') {
    return (
      <Page>
        <EmptyState kind="no-results" heading={`Nothing here is called ${humanId}`}>
          {`${humanId} is a ${state.value.type}, not a task.`}
        </EmptyState>
      </Page>
    );
  }

  const task = state.value.entity as unknown as TaskEntity;
  const { backlinks, projectCode } = state.value;

  // After a write or an undo: the page re-reads in place, and so does the strip.
  const changed = () => {
    refresh();
    realityChanged(projectCode);
  };

  return (
    <Page>
      <ProjectHeader
        code={projectCode}
        section="phases"
        // The shell draws this page's trail above it, so the header does not draw a second.
        trail="none"
        title={task.title}
        description={humanId}
        actions={
          <>
            <OpenInConstellation path={`item/${humanId}`} />
            <HistoryDrawer entity={humanId} onUndone={changed} />
            <EditForm
              title={`Edit ${humanId}`}
              path={`/api/projects/${projectCode}/tasks/${humanId}`}
              trigger={<Button>Edit</Button>}
              onSaved={changed}
              initial={{
                title: task.title,
                size: task.size ?? '',
                doneWhen: task.doneWhen ?? '',
                body: task.body ?? '',
                ...(task.status === 'blocked'
                  ? { blockedReason: task.blockedReason ?? '' }
                  : {}),
              }}
              fields={[
                { name: 'title', label: 'Title', kind: 'text' },
                { name: 'size', label: 'Size', kind: 'select', options: SIZES, optional: true },
                {
                  name: 'doneWhen',
                  label: 'Done when',
                  kind: 'textarea',
                  optional: true,
                  help: 'What would show this task is finished.',
                },
                {
                  name: 'body',
                  label: 'Context',
                  kind: 'textarea',
                  optional: true,
                  help: 'Markdown. What this is about and why, in your own words.',
                },
                // Offered only while the task is blocked: a reason with nothing to explain is
                // a field nobody knows how to fill in.
                ...(task.status === 'blocked'
                  ? [
                      {
                        name: 'blockedReason',
                        label: 'What is blocking it',
                        kind: 'textarea' as const,
                        help: 'Required while the task is blocked.',
                      },
                    ]
                  : []),
              ]}
            />
          </>
        }
      />

      {task.status === 'blocked' ? (
        <Alert tone="danger" title="Blocked">
          {task.blockedReason ?? 'No reason was recorded, which should not be possible.'}
        </Alert>
      ) : null}

      {task.idSynthesized ? (
        <Alert tone="warning" title="This ID was synthesized">
          The importer invented it from the task&rsquo;s phase and position, because the source had
          none. It is not a canonical ID somebody chose.
        </Alert>
      ) : null}

      <div className="fm-record">
        <div className="fm-record__main">
          {task.doneWhen === null ? null : (
            <Card>
              <CardTitle>Done when</CardTitle>
              {task.doneWhen}
            </Card>
          )}

          {task.body === null ? null : (
            <Card>
              <CardTitle>Context</CardTitle>
              <Markdown>{task.body}</Markdown>
            </Card>
          )}

          <RealitySection
            humanId={humanId}
            kind="task"
            projectCode={projectCode}
            doneClaimed={task.status === 'done'}
            stamp={`${task.status}:${task.phase?.humanId ?? ''}`}
          />

          <Card>
            <CardTitle>Satisfies</CardTitle>
            {task.requirements.length === 0 ? (
              <EmptyState kind="empty" size="inline" heading="No requirements">
                A task satisfying nothing is work with no stated reason — which is what a coverage hole
                looks like from the other side.
              </EmptyState>
            ) : (
              <Stack gap="8" as="ul">
                {task.requirements.map((requirement) => (
                  <li key={requirement.humanId}>
                    <code>{requirement.humanId}</code> — {requirement.statement}
                  </li>
                ))}
              </Stack>
            )}
          </Card>

          {task.dependsOn.length === 0 && task.dependedOnBy.length === 0 ? null : (
            <Card>
              <CardTitle>Dependencies</CardTitle>
              <Stack gap="12">
                {task.dependsOn.length === 0 ? null : (
                  <div>
                    <p>
                      {task.dependsOn.some(isUnfinished)
                        ? 'Waits on unfinished work, so the brief holds it back:'
                        : 'Depends on, all finished:'}
                    </p>
                    <DependencyList edges={task.dependsOn} />
                  </div>
                )}
                {task.dependedOnBy.length === 0 ? null : (
                  <div>
                    <p>Needed before:</p>
                    <DependencyList edges={task.dependedOnBy} />
                  </div>
                )}
              </Stack>
            </Card>
          )}

          <Card>
            <CardTitle>Declared files</CardTitle>
            {task.files.length === 0 ? (
              <EmptyState kind="empty" size="inline" heading="No files declared">
                Declared paths are the weakest attribution signal, and the only one that works before a
                commit mentions the task by ID.
              </EmptyState>
            ) : (
              <Stack gap="4" as="ul">
                {task.files.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </Stack>
            )}
          </Card>

          {backlinks.length === 0 ? null : (
            <Card>
              <CardTitle>Cited by</CardTitle>
              <Stack gap="8" as="ul">
                {backlinks.map((link) => (
                  <li key={`${link.fromType}:${link.humanId ?? link.title}`}>
                    <code>{link.humanId ?? link.fromType}</code> — {link.title}{' '}
                    <span className="fm-muted">({link.kind})</span>
                  </li>
                ))}
              </Stack>
            </Card>
          )}
        </div>
        <div className="fm-record__rail">
          <TaskRail task={task} projectCode={projectCode} onChanged={changed} />
        </div>
      </div>
    </Page>
  );
}
