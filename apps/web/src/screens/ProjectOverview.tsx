import { useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Cluster,
  EmptyState,
  Grid,
  IconButton,
  Link,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Page,
  Section,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { Ellipsis, UsersRound } from 'lucide-react';
import { foreman, type Brief, type CommitRow, type DriftItem, type ProjectGroupRef } from '../lib/api';
import { applicableGuidelines, listJoin } from '../lib/groups';
import { GroupChip, MoveToGroupDialog, useMoveToast } from '../ui/groups';
import { replaceLocation, useLocation } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { EditForm, LIFECYCLES } from './EditForms';
import { ProjectHeader } from '../components/ProjectHeader';
import { dayOf, shortSha } from '../components/RealityStrip';
import { forgetBrief } from '../lib/project';
import { plainText } from '../lib/text';
import { checkMeasurable, measurable, plural, readCount, taskStatusTone } from '../ui/status';
import { CATEGORIES } from './DriftView';
import './ProjectOverview.css';

/**
 * S-09 — a project's overview.
 *
 * It is the brief, rendered (FRM-REQ-247). The same call a Claude session makes answers this
 * screen, which is the point of both surfaces being peers: they cannot disagree, because there is
 * only one answer.
 *
 * The reality strip is the header's own second row (see `ProjectHeader`), so it is not repeated
 * here. Under it, three things in the order a session starts with them: **What's next** (three
 * tasks to pick up), **What drifted** (by kind, each with the way in) and **Recent reality**
 * (commits, and the attributions waiting for a decision). The grid of section tiles is gone — the
 * sidebar already carries every section, from every screen.
 */

/** How many next tasks the overview names. The brief carries five; three is a glance. */
const NEXT_SHOWN = 3;
/** How many commits, and how many waiting attributions, Recent reality lists. */
const COMMITS_SHOWN = 4;
const WAITING_SHOWN = 3;

export function ProjectOverview({ code }: { code: string }) {
  const { state, refresh } = useAsync(() => foreman.brief(code), [code]);
  // The brief does not carry the group (FRM-T-17.2 adds scope to it); the project row does.
  const project = useAsync(() => foreman.project(code), [code]);
  const groups = useAsync(() => foreman.groups(), []);
  // What drifted, item by item: the brief carries the counts, and this is the lines under them.
  const drift = useAsync(() => foreman.drift(code), [code]);
  // Recent reality: the newest commits with what each is attributed to.
  const commits = useAsync(() => foreman.commits(code), [code]);
  const guidelines = useAsync(() => foreman.guidelines(), []);
  const [moving, setMoving] = useState(false);
  // `?move=1` opens Move to group… — where a toast elsewhere sends you to finish a move that did
  // not happen (a converted idea whose group did not stick). Once, then the address is cleaned.
  const { search } = useLocation();
  const askedToMove = useRef(false);
  const listingReady = groups.state.status === 'ready';
  useEffect(() => {
    if (askedToMove.current || !listingReady) return;
    if (new URLSearchParams(search).get('move') !== '1') return;
    askedToMove.current = true;
    setMoving(true);
    replaceLocation(`/projects/${code}`);
  }, [search, listingReady, code]);
  const toastMove = useMoveToast(() => {
    project.reload();
    groups.reload();
  });

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
          heading={state.notFound ? `No project called ${code}` : 'That project did not load'}
        >
          {state.notFound ? 'Check the code, or pick one from Projects.' : state.message}
        </EmptyState>
      </Page>
    );
  }

  const brief = state.value;
  const phase = brief.activePhase;
  const group: ProjectGroupRef | null = project.state.status === 'ready' ? project.state.value.group : null;
  const listing = groups.state.status === 'ready' ? groups.state.value : null;

  // What the plan lets each signal measure (FRM-REQ-241). While the project row loads there is no
  // answer; if it fails to load the plan is *unknown*, so nothing is measurable and no zero can
  // read clean — what is found still shows.
  const counts =
    project.state.status === 'loading'
      ? ('loading' as const)
      : project.state.status === 'ready'
        ? project.state.value.counts
        : null;
  const can =
    counts === 'loading' || counts === null
      ? { hasPlan: false, drift: false, coverage: false, blocked: false }
      : measurable(counts);
  // Drift is clean only when every check could run on what is recorded: a project with one phase
  // and nothing else ran two of six, and "0 · clean" would claim all six (FRM-REQ-241).
  const allDriftChecks =
    counts !== 'loading' && counts !== null && CATEGORIES.every((c) => checkMeasurable(c.key, counts));
  const driftSignal = readCount(brief.drift.total, { measured: can.drift && allDriftChecks });
  const open = phase === null ? 0 : Math.max(0, phase.tasks.total - phase.tasks.done - phase.tasks.cancelled);
  const next = brief.nextTasks.slice(0, NEXT_SHOWN);

  return (
    <Page>
      <ProjectHeader
        code={code}
        {...(brief.project.pitch === null ? {} : { description: brief.project.pitch })}
        {...(project.state.status === 'ready'
          ? {
              // Beside the lifecycle: the library's PageHeader has no slot beside its title yet.
              badge:
                group === null ? (
                  <span className="fm-chip fm-chip--quiet">Ungrouped</span>
                ) : (
                  <GroupChip name={group.name} accent={group.accent} href={`/groups/${group.slug}`} />
                ),
            }
          : {})}
        actions={
          <>
          <EditForm
            title={`Edit ${brief.project.name}`}
            // The code is absent on purpose: it is immutable, and every human ID embeds it.
            description="A project's code cannot change — every ID in it embeds the code."
            path={`/api/projects/${code}`}
            trigger={<Button>Edit</Button>}
            onSaved={() => {
              // The sidebar and the breadcrumb read a cached brief. Without this they keep showing
              // the old name until a reload, on the one screen where you just changed it.
              forgetBrief(code);
              refresh();
            }}
            initial={{
              name: brief.project.name,
              lifecycle: brief.project.lifecycle,
              pitch: brief.project.pitch ?? '',
            }}
            fields={[
              { name: 'name', label: 'Name', kind: 'text' },
              { name: 'lifecycle', label: 'Lifecycle', kind: 'select', options: LIFECYCLES },
              { name: 'pitch', label: 'Pitch', kind: 'textarea', optional: true },
            ]}
          />
          {listing !== null && (
            <Menu>
              <MenuTrigger>
                <IconButton icon={<Ellipsis />} label={`More for ${brief.project.name}`} variant="secondary" />
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem icon={<UsersRound />} onSelect={() => { setMoving(true); }}>
                  Move to group…
                </MenuItem>
              </MenuContent>
            </Menu>
          )}
          </>
        }
      />

      <Stack gap="24">
        {counts !== 'loading' && counts !== null && !can.hasPlan && (
          <Card padding="md">
            <Stack gap="4">
              <strong>{brief.project.name} has no plan in Foreman yet.</strong>
              <span className="fm-muted">
                These signals start reporting once it has requirements and phases.
              </span>
            </Stack>
          </Card>
        )}

        <Grid minItemWidth="md">
          <Section
            title="What's next"
            surface="card"
            description={phase === null ? undefined : `in P-${phase.number} · ${String(open)} open`}
            actions={
              phase === null ? undefined : (
                <Link href={`/projects/${code}/phases/${phase.humanId}`}>Phase gate</Link>
              )
            }
          >
            {phase === null ? (
              <EmptyState kind="empty" size="inline" heading="No phase is active">
                Add a phase, or mark one active.
              </EmptyState>
            ) : next.length === 0 ? (
              <EmptyState kind="empty" size="inline" heading="Nothing ready to pick up">
                {brief.blocked.length > 0
                  ? 'Everything open is blocked.'
                  : 'Add a task to the active phase.'}
              </EmptyState>
            ) : (
              <Stack gap="6">
                {next.map((task) => (
                  <a key={task.humanId} className="fm-next" href={`/tasks/${task.humanId}`}>
                    <code className="fm-item__id">{task.humanId}</code>
                    <span className="fm-item__title">{plainText(task.title)}</span>
                    <span className="fm-next__meta">
                      {task.size !== null && (
                        <Badge tone="neutral" size="sm">
                          {task.size}
                        </Badge>
                      )}
                      <Badge tone={taskStatusTone(task.status)} size="sm">
                        {task.status === 'in_progress' ? 'in progress' : task.status === 'todo' ? 'to do' : task.status}
                      </Badge>
                    </span>
                    {task.requirements !== undefined && task.requirements.length > 0 && (
                      <span className="fm-next__why fm-muted">{task.requirements.join(', ')}</span>
                    )}
                  </a>
                ))}
                {open > next.length && (
                  <Link href={`/projects/${code}/phases/${phase.humanId}`}>
                    {`+${String(open - next.length)} more in ${phase.humanId}`}
                  </Link>
                )}
              </Stack>
            )}
            {brief.blocked.length > 0 && (
              <Stack gap="6">
                <span className="fm-next__blocked">
                  {plural(brief.blocked.length, 'task cannot', 'tasks cannot')} start
                </span>
                {brief.blocked.slice(0, NEXT_SHOWN).map((task) => (
                  <a key={task.humanId} className="fm-next" href={`/tasks/${task.humanId}`}>
                    <code className="fm-item__id">{task.humanId}</code>
                    <span className="fm-item__title">{plainText(task.title)}</span>
                    <span className="fm-next__meta">
                      <Badge tone={taskStatusTone('blocked')} size="sm">
                        blocked
                      </Badge>
                    </span>
                    <span className="fm-next__why fm-muted">{task.reason ?? 'no reason recorded'}</span>
                  </a>
                ))}
              </Stack>
            )}
          </Section>

          <Section
            title="What drifted"
            surface="card"
            description={
              driftSignal.state === 'not-measurable'
                ? 'not measurable yet'
                : `${String(brief.drift.total)} across ${plural(
                    CATEGORIES.filter((c) => brief.drift.counts[c.key] > 0).length,
                    'kind',
                    'kinds',
                  )}`
            }
            actions={<Link href={`/projects/${code}/drift`}>All drift</Link>}
          >
            <DriftByKind
              code={code}
              brief={brief}
              items={drift.state.status === 'ready' ? drift.state.value.items : null}
              measured={driftSignal.state !== 'not-measurable'}
              planKnown={counts !== null}
            />
          </Section>
        </Grid>

        <Section
          title="Recent reality"
          surface="card"
          description={mainVersusDeployed(brief)}
          actions={<Link href={`/projects/${code}/activity`}>Activity</Link>}
        >
          <RecentReality
            code={code}
            brief={brief}
            commits={commits.state.status === 'ready' ? commits.state.value.items : null}
          />
        </Section>

        {project.state.status === 'ready' && (
          <Section
            title="Group"
            surface="card"
            actions={
              listing === null ? undefined : (
                <Button variant="ghost" size="sm" onClick={() => { setMoving(true); }}>
                  Move to group…
                </Button>
              )
            }
          >
            <GroupSummary
              group={group}
              guidelines={
                guidelines.state.status === 'ready'
                  ? applicableGuidelines(guidelines.state.value.items, group?.humanId ?? null)
                  : null
              }
            />
          </Section>
        )}
      </Stack>

      {listing !== null && (
        <MoveToGroupDialog
          open={moving}
          onOpenChange={setMoving}
          projects={[{ code, name: brief.project.name }]}
          listing={listing}
          onMoved={(result, codes, targetName, origin) => {
            project.reload();
            groups.reload();
            toastMove(result, codes, targetName, origin);
          }}
        />
      )}
    </Page>
  );
}

/** Which family the project is in, and what that binds it to (17.12). */
function GroupSummary({
  group,
  guidelines,
}: {
  group: ProjectGroupRef | null;
  guidelines: readonly { humanId: string; appliesTo: string }[] | null;
}) {
  const ids = (guidelines ?? []).map((row) => row.humanId);
  const own = (guidelines ?? []).filter((row) => row.appliesTo === 'groups').map((row) => row.humanId);
  return (
    <Stack gap="8">
      <Cluster gap="8" align="center">
        {group === null ? (
          <span className="fm-chip fm-chip--quiet">Ungrouped</span>
        ) : (
          <GroupChip name={group.name} accent={group.accent} href={`/groups/${group.slug}`} />
        )}
      </Cluster>
      {guidelines !== null && (
        <span className="fm-muted">
          {ids.length === 0
            ? 'No active guideline applies.'
            : `${String(ids.length)} ${ids.length === 1 ? 'guideline applies' : 'guidelines apply'}: ${listJoin(ids)}${
                own.length > 0 && group !== null ? `, including the ${group.name}-only ${listJoin(own)}` : ''
              }.`}
          {group === null ? ' In no group, only the guidelines for every project apply.' : ''}
        </span>
      )}
    </Stack>
  );
}

/** "main is 4 commits ahead of what is deployed" — the one sentence the strip's last cell abbreviates. */
export function mainVersusDeployed(brief: Pick<Brief, 'deployed'>): string {
  const deployed = brief.deployed ?? null;
  if (deployed === null) return 'nothing is recorded as deployed';
  if (deployed.ahead === null) return `deployed ${shortSha(deployed.sha)}, which is not a commit Foreman knows`;
  if (deployed.ahead === 0) return 'main is what is deployed';
  return `main is ${plural(deployed.ahead, 'commit', 'commits')} ahead of what is deployed`;
}

/** Where each kind of drift is dealt with, and what the action there is called. */
function driftAction(code: string, category: DriftItem['category'], first: DriftItem | undefined): { href: string; label: string } {
  switch (category) {
    case 'coverage-hole':
      return { href: `/projects/${code}/requirements?uncovered=true`, label: 'Open coverage' };
    case 'stale-task':
      return { href: first === undefined ? `/projects/${code}/phases` : `/tasks/${first.humanId}`, label: 'Set status' };
    case 'fired-tripwire':
      return { href: `/projects/${code}/risks`, label: 'Open risk' };
    case 'failed-exit-gate':
      return {
        href: first === undefined ? `/projects/${code}/phases` : `/projects/${code}/phases/${first.humanId}`,
        label: 'Review gate',
      };
    case 'orphan-adr':
      return { href: `/projects/${code}/adrs`, label: 'Cite or supersede' };
    case 'screen-drift':
      return {
        href: first === undefined ? `/projects/${code}/screens` : `/projects/${code}/screens/${first.humanId}`,
        label: 'Open screens',
      };
  }
}

/**
 * Drift by kind, each kind a row with the way in (FRM-REQ-247). The counts are the brief's — the
 * drift engine's own — and the lines under them are the engine's items, so a row says what is
 * wrong in the engine's words, not the console's.
 */
function DriftByKind({
  code,
  brief,
  items,
  measured,
  planKnown,
}: {
  code: string;
  brief: Brief;
  /** The engine's items, or null while they load or when they did not. */
  items: readonly DriftItem[] | null;
  measured: boolean;
  planKnown: boolean;
}) {
  if (!measured) {
    return (
      <EmptyState kind="empty" size="inline" heading="Not measurable yet">
        {planKnown
          ? 'The checks need a plan to compare with what shipped: requirements, phases and tasks.'
          : "The project's plan could not be read, so this is not measured."}
      </EmptyState>
    );
  }
  const kinds = CATEGORIES.filter((category) => brief.drift.counts[category.key] > 0);
  if (kinds.length === 0) {
    return <span className="fm-muted">0 drift · the checks found nothing in what is recorded</span>;
  }
  return (
    <Stack gap="8">
      {kinds.map((category) => {
        const mine = (items ?? []).filter((item) => item.category === category.key);
        const first = mine[0];
        const action = driftAction(code, category.key, first);
        return (
          <div key={category.key} className="fm-drifted" data-kind={category.key}>
            <span className="fm-drifted__count">{brief.drift.counts[category.key]}</span>
            <div className="fm-drifted__what">
              <strong>{category.label}</strong>
              {first === undefined ? (
                <span className="fm-muted">{category.blurb}</span>
              ) : (
                <span className="fm-muted">
                  {mine
                    .slice(0, 2)
                    .map((item) => item.humanId)
                    .join(', ')}
                  {mine.length > 2 ? ` and ${String(mine.length - 2)} more` : ''} — {first.detail}
                </span>
              )}
            </div>
            <a className="fm-drifted__action" href={action.href}>
              {action.label}
            </a>
          </div>
        );
      })}
    </Stack>
  );
}

/** What an attribution says about a commit, in words: confirmed to a task, waiting, or none. */
export function attributionWords(commit: Pick<CommitRow, 'attributions'>): string {
  const live = commit.attributions.filter((a) => a.rejectedAt === null);
  const confirmed = live.filter((a) => a.confirmed).map((a) => a.task.humanId);
  if (confirmed.length > 0) return confirmed.join(', ');
  const waiting = live.filter((a) => !a.confirmed);
  if (waiting.length > 0) return `suggested ${waiting.map((a) => a.task.humanId).join(', ')} · waiting`;
  return 'no task';
}

/** Recent commits with what each is attributed to, and the attributions waiting for a decision. */
function RecentReality({
  code,
  brief,
  commits,
}: {
  code: string;
  brief: Brief;
  commits: readonly CommitRow[] | null;
}) {
  const recent = commits === null ? null : commits.slice(0, COMMITS_SHOWN);
  const waiting =
    commits === null
      ? []
      : commits.flatMap((commit) =>
          commit.attributions
            .filter((a) => !a.confirmed && a.rejectedAt === null)
            .map((a) => ({ commit, task: a.task.humanId })),
        );
  return (
    <Stack gap="16">
      {recent === null ? (
        // The commits did not read: the brief's own three still say something.
        brief.recentCommits.length === 0 ? (
          <span className="fm-muted">No commit has been ingested for this project.</span>
        ) : (
          <Stack gap="6">
            {brief.recentCommits.map((commit) => (
              <div key={commit.sha} className="fm-recent">
                <code className="fm-item__id">{commit.sha}</code>
                <span className="fm-item__title">{plainText(commit.message)}</span>
                <span className="fm-muted fm-recent__when">{dayOf(commit.at)}</span>
              </div>
            ))}
          </Stack>
        )
      ) : recent.length === 0 ? (
        <span className="fm-muted">No commit has been ingested for this project.</span>
      ) : (
        <Stack gap="6">
          {recent.map((commit) => (
            <div key={commit.id} className="fm-recent">
              <code className="fm-item__id">{commit.sha.slice(0, 7)}</code>
              <span className="fm-item__title">{plainText(commit.message.split('\n')[0] ?? '')}</span>
              <span className="fm-muted fm-recent__when">{dayOf(commit.committedAt)}</span>
              <span className="fm-recent__why fm-muted">{attributionWords(commit)}</span>
            </div>
          ))}
        </Stack>
      )}

      <Stack gap="6">
        <strong className="fm-recent__heading">Attributions waiting · {brief.unconfirmedAttributions}</strong>
        {brief.unconfirmedAttributions === 0 ? (
          <span className="fm-muted">Nothing is waiting for a decision.</span>
        ) : (
          <>
            <span className="fm-muted">
              Suggested from file paths. Not counted as evidence until you confirm (ADR-005).
            </span>
            {waiting.slice(0, WAITING_SHOWN).map((row) => (
              <div key={`${row.commit.sha}:${row.task}`} className="fm-recent">
                <code className="fm-item__id">{row.commit.sha.slice(0, 7)}</code>
                <span className="fm-item__title">
                  → <a href={`/tasks/${row.task}`}>{row.task}</a>
                </span>
              </div>
            ))}
            <Link href={`/projects/${code}/activity`}>Review in Activity</Link>
          </>
        )}
      </Stack>
    </Stack>
  );
}
