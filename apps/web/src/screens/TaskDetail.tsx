import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  Link,
  Page,
  PageHeader,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { foreman } from '../lib/api';
import { Markdown } from '../components/Markdown';
import { useAsync } from '../lib/useAsync';
import { EditForm, SIZES } from './EditForms';
import { OpenInConstellation } from '../components/OpenInConstellation';

/**
 * S-12 — one task: what it is for, what it declares, what it satisfies, and what cites it.
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

export function TaskDetail({ humanId }: { humanId: string }) {
  const { state, reload } = useAsync(() => foreman.entity(humanId), [humanId]);

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

  return (
    <Page>
      <PageHeader
        title={task.title}
        description={humanId}
        actions={
          <>
            <Badge tone={task.status === 'blocked' ? 'danger' : 'neutral'}>{task.status}</Badge>
            <OpenInConstellation path={`item/${humanId}`} />
            <EditForm
              title={`Edit ${humanId}`}
              path={`/api/projects/${projectCode}/tasks/${humanId}`}
              trigger={<Button>Edit</Button>}
              onSaved={reload}
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

      {task.body === null ? null : (
        <Card>
          <CardTitle>Context</CardTitle>
          <Markdown>{task.body}</Markdown>
        </Card>
      )}

      <Card>
        <CardTitle>What it is</CardTitle>
        <DescriptionList>
          <DescriptionItem term="Project">
            <Link href={`/projects/${projectCode}`}>{projectCode}</Link>
          </DescriptionItem>
          {task.phase === null ? null : (
            <DescriptionItem term="Phase">
              <Link href={`/projects/${projectCode}/phases/${task.phase.humanId}`}>
                {task.phase.name}
              </Link>
            </DescriptionItem>
          )}
          <DescriptionItem term="Size">{task.size ?? '—'}</DescriptionItem>
          {task.doneWhen === null ? null : (
            <DescriptionItem term="Done when">{task.doneWhen}</DescriptionItem>
          )}
          <DescriptionItem term="Started">
            {task.startedAt === null
              ? startedWhenMissing(task.status)
              : new Date(task.startedAt).toLocaleDateString()}
          </DescriptionItem>
          <DescriptionItem term="Completed">
            {task.completedAt === null ? 'not yet' : new Date(task.completedAt).toLocaleDateString()}
          </DescriptionItem>
        </DescriptionList>
      </Card>

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
    </Page>
  );
}
