import {
  Alert,
  Badge,
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
import { useAsync } from '../lib/useAsync';
import { EditForm, PRIORITIES } from './EditForms';
import { ProjectHeader } from '../components/ProjectHeader';
import { PropertyRail, type RailRow } from '../components/PropertyRail';
import { RealitySection } from '../components/RealitySection';
import { realityChanged } from '../components/RealityStrip';
import { OpenInConstellation } from '../components/OpenInConstellation';
import { HistoryDrawer } from '../components/HistoryDrawer';

/**
 * S-14 — one requirement: what it says, how the lint read it, what would prove it, and what
 * satisfies it.
 *
 * The screen's one rule: **no covering task is flagged, never merely empty.** An empty section reads
 * as "nothing to show here"; this is the opposite — it is the thing the register exists to surface.
 *
 * Its priority and phase are edited in a rail beside it, in place (FRM-REQ-247), and its Reality
 * section lists the commits, CI results and deployments of the tasks that satisfy it.
 */

interface RequirementEntity {
  humanId: string;
  statement: string;
  priority: string;
  source: string | null;
  acceptanceTest: string | null;
  earsPattern: string;
  earsLintOk: boolean;
  earsLintNote: string | null;
  phase: { humanId: string; name: string } | null;
  tasks: { humanId: string; title: string; status: string }[];
}

const PRIORITY_LABEL: Record<string, string> = {
  M: 'Must',
  S: 'Should',
  C: 'Could',
  W: "Won't",
};

function RequirementRail({
  requirement,
  projectCode,
  onChanged,
}: {
  requirement: RequirementEntity;
  projectCode: string;
  onChanged: () => void;
}) {
  const humanId = requirement.humanId;
  const phases = useAsync(() => foreman.phases(projectCode), [projectCode]);
  const list: readonly PhaseProgressRow[] = phases.state.status === 'ready' ? phases.state.value.items : [];
  const current = list.find((phase) => phase.humanId === requirement.phase?.humanId);
  const phaseLabel = (phase: PhaseProgressRow) => `${phase.number} — ${phase.name}`;
  const backlog = 'Backlog — no phase';

  const rows: RailRow[] = [
    {
      kind: 'select',
      key: 'priority',
      label: 'Priority',
      ariaLabel: `Priority of ${humanId}`,
      value: requirement.priority,
      options: PRIORITIES,
      write: (next) => ({
        run: () => foreman.updateRequirement(projectCode, humanId, { priority: next }),
        message: () => `${humanId} is now ${PRIORITY_LABEL[next] ?? next}`,
        undone: `Undone — ${humanId} is ${PRIORITY_LABEL[requirement.priority] ?? requirement.priority} again`,
      }),
    },
    list.length === 0
      ? {
          kind: 'text',
          key: 'phase',
          label: 'Phase',
          children:
            requirement.phase === null ? (
              // Not a defect: an unassigned requirement is the backlog (FRM-REQ-049).
              <span className="fm-muted">{backlog}</span>
            ) : (
              <Link href={`/projects/${projectCode}/phases/${requirement.phase.humanId}`}>
                {requirement.phase.name}
              </Link>
            ),
        }
      : {
          kind: 'select',
          key: 'phase',
          label: 'Phase',
          ariaLabel: `Phase of ${humanId}`,
          value: current?.id ?? 'none',
          options: [{ value: 'none', label: backlog }, ...list.map((p) => ({ value: p.id, label: phaseLabel(p) }))],
          write: (next) => {
            const target = list.find((p) => p.id === next);
            return {
              run: () => foreman.updateRequirement(projectCode, humanId, { phaseId: next === 'none' ? null : next }),
              message: () =>
                target === undefined ? `${humanId} returned to the backlog` : `${humanId} assigned to ${phaseLabel(target)}`,
              undone: `Undone — ${humanId} is ${current === undefined ? 'in the backlog' : `in ${phaseLabel(current)}`} again`,
            };
          },
        },
    {
      kind: 'text',
      key: 'project',
      label: 'Project',
      children: <Link href={`/projects/${projectCode}`}>{projectCode}</Link>,
    },
    { kind: 'text', key: 'ears', label: 'EARS pattern', children: requirement.earsPattern },
    { kind: 'text', key: 'source', label: 'Source', children: requirement.source ?? '—' },
  ];

  return <PropertyRail subject={humanId} rows={rows} onChanged={onChanged} />;
}

export function RequirementDetail({ humanId }: { humanId: string }) {
  // `refresh`, not `reload`: after a save or an undo the page re-reads in place (FRM-T-18.4).
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
          heading={
            state.notFound
              ? `Nothing here is called ${humanId}`
              : 'That requirement did not load'
          }
        >
          {state.notFound ? 'Check the ID, or find it in the register.' : state.message}
        </EmptyState>
      </Page>
    );
  }

  const requirement = state.value.entity as unknown as RequirementEntity;
  const { backlinks, projectCode } = state.value;
  const isMust = requirement.priority === 'M';
  // After a write or an undo: the page re-reads in place, and so does the strip.
  const changed = () => {
    refresh();
    realityChanged(projectCode);
  };

  return (
    <Page>
      <ProjectHeader
        code={projectCode}
        section="requirements"
        // The shell draws this page's trail above it, so the header does not draw a second.
        trail="none"
        title={requirement.statement}
        description={humanId}
        actions={
          <>
            <OpenInConstellation path={`item/${humanId}`} />
            <HistoryDrawer entity={humanId} onUndone={changed} />
            <EditForm
              title={`Edit ${humanId}`}
              path={`/api/projects/${projectCode}/requirements/${humanId}`}
              trigger={<Button>Edit</Button>}
              onSaved={changed}
              initial={{
                statement: requirement.statement,
                priority: requirement.priority,
                acceptanceTest: requirement.acceptanceTest ?? '',
                source: requirement.source ?? '',
              }}
              fields={[
                {
                  name: 'statement',
                  label: 'Statement',
                  kind: 'textarea',
                  help: 'The lint re-reads this on save, and warns rather than refusing.',
                },
                {
                  name: 'priority',
                  label: 'Priority',
                  kind: 'select',
                  options: [
                    { value: 'M', label: 'Must' },
                    { value: 'S', label: 'Should' },
                    { value: 'C', label: 'Could' },
                    { value: 'W', label: "Won't" },
                  ],
                },
                {
                  name: 'acceptanceTest',
                  label: 'Acceptance test',
                  kind: 'textarea',
                  optional: true,
                  help: 'What would show this is satisfied.',
                },
                {
                  name: 'source',
                  label: 'Source',
                  kind: 'text',
                  optional: true,
                  help: 'Where it came from — a discovery session, an audit finding, a decision.',
                },
              ]}
            />
          </>
        }
      />

      {requirement.earsLintOk ? null : (
        <Alert tone="warning" title={`Read as ${requirement.earsPattern}`}>
          <Stack gap="4">
            <span>{requirement.earsLintNote ?? 'The lint could not read this as a behaviour.'}</span>
            <span>Stored all the same: the lint warns, it never refuses.</span>
          </Stack>
        </Alert>
      )}

      <div className="fm-record">
        <div className="fm-record__main">
          <Card>
            <CardTitle>How it would be proved</CardTitle>
            {requirement.acceptanceTest === null || requirement.acceptanceTest.trim() === '' ? (
              <EmptyState kind="empty" size="inline" heading="No acceptance test">
                Nothing can be checked against this, so nothing can ever settle whether it is met.
              </EmptyState>
            ) : (
              requirement.acceptanceTest
            )}
          </Card>

          <RealitySection
            humanId={humanId}
            kind="requirement"
            projectCode={projectCode}
            stamp={`${requirement.priority}:${requirement.phase?.humanId ?? ''}:${requirement.tasks.map((t) => `${t.humanId}=${t.status}`).join(',')}`}
          />

          <Card>
            <CardTitle>Satisfied by</CardTitle>
            {requirement.tasks.length === 0 ? (
              // Flagged, not empty (S-14). For a Must this is what holds a phase closed.
              <Alert tone={isMust ? 'danger' : 'warning'} title="No task satisfies this">
                {isMust
                  ? 'It is a Must, so its phase cannot be completed until something covers it.'
                  : 'Nothing is planned that would satisfy it.'}
              </Alert>
            ) : (
              <Stack gap="8" as="ul">
                {requirement.tasks.map((task) => (
                  <li key={task.humanId}>
                    <Link href={`/tasks/${task.humanId}`}>{task.humanId}</Link> — {task.title}{' '}
                    <Badge tone={task.status === 'blocked' ? 'danger' : 'neutral'}>{task.status}</Badge>
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
          <RequirementRail requirement={requirement} projectCode={projectCode} onChanged={changed} />
        </div>
      </div>
    </Page>
  );
}
