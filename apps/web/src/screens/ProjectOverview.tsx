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
import { foreman, type Brief, type ProjectGroupRef } from '../lib/api';
import { applicableGuidelines, listJoin } from '../lib/groups';
import { GroupChip, MoveToGroupDialog, useMoveToast } from '../ui/groups';
import { replaceLocation, useLocation } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { percentClosed } from '../lib/completion';
import { EditForm, LIFECYCLES } from './EditForms';
import { ProjectHeader } from '../components/ProjectHeader';
import { forgetBrief, SECTIONS } from '../lib/project';
import { plainText } from '../lib/text';
import { Donut, StatCard } from '../ui/viz';
import { SERIES } from '../ui/tone';
import {
  breakdown,
  ciTone,
  ciWord,
  CRITICAL_PLUS_HIGH,
  checkMeasurable,
  measurable,
  plural,
  readCount,
  severityTone,
  taskStatusTone,
} from '../ui/status';
import { CATEGORIES } from './DriftView';

/**
 * S-09 — a project's overview.
 *
 * It is the brief, rendered. The same call a Claude session makes answers this screen, which is the
 * point of both surfaces being peers: they cannot disagree, because there is only one answer.
 *
 * What changed is the arrangement. It was two description lists — "Phase: 1 — Retrieval", "Tasks:
 * 11 of 13 done" — which is a correct answer you have to read twice to feel. The phase now has a
 * ring, the four drift figures are four numbers you can see from across the room, and the three
 * lists that matter are cards rather than bullets.
 *
 * The row of section links is gone: the sidebar carries them now, from every screen rather than
 * only from this one.
 */

function CiLine({ ci }: { ci: Brief['ci'] }) {
  return (
    <Cluster gap="8" align="center">
      <Badge tone={ciTone(ci.conclusion, ci.unknown)} size="sm">
        {ci.unknown ? 'CI never reported' : ciWord(ci)}
      </Badge>
      {ci.commitSha !== null && <code className="fm-card__code">{ci.commitSha.slice(0, 7)}</code>}
    </Cluster>
  );
}

export function ProjectOverview({ code }: { code: string }) {
  const { state, reload } = useAsync(() => foreman.brief(code), [code]);
  // The brief does not carry the group (FRM-T-17.2 adds scope to it); the project row does.
  const project = useAsync(() => foreman.project(code), [code]);
  const groups = useAsync(() => foreman.groups(), []);
  // The counts under "Coverage holes" (Musts with no task / tasks citing nothing).
  const coverage = useAsync(() => foreman.coverage(code), [code]);
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
  const done = phase?.tasks.done ?? 0;
  const cancelled = phase?.tasks.cancelled ?? 0;
  const total = phase?.tasks.total ?? 0;
  const percent = percentClosed(done, cancelled, total);
  const group: ProjectGroupRef | null = project.state.status === 'ready' ? project.state.value.group : null;
  const listing = groups.state.status === 'ready' ? groups.state.value : null;

  // What the plan lets each signal measure (FRM-REQ-241). While the project row loads there is no
  // answer, so the tiles wait rather than show a zero as clean. If it fails to load the plan is
  // *unknown*: nothing is measurable, so no zero can read clean — what is found still shows.
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
  const planUnknown = counts === null;
  const holes = brief.drift.counts['coverage-hole'];
  const coverageSignal = readCount(holes, { measured: can.coverage });
  // Drift is clean only when every drift check could run on what is recorded: a project with one
  // phase and nothing else ran two of six, and "0 · clean" would claim all six (FRM-REQ-241).
  const allDriftChecks =
    counts !== 'loading' && counts !== null && CATEGORIES.every((c) => checkMeasurable(c.key, counts));
  const driftSignal = readCount(brief.drift.total, { measured: can.drift && allDriftChecks });
  const blockedSignal = readCount(brief.blocked.length, { measured: can.blocked });
  const unmeasuredWhy = (nothing: string) =>
    planUnknown ? "The project's plan could not be read, so this is not measured" : nothing;
  const holesDetail =
    coverage.state.status === 'ready'
      ? breakdown(
          [
            { n: coverage.state.value.uncoveredMusts.length, one: 'Must with no task', other: 'Musts with no task' },
            {
              n: coverage.state.value.tasksWithoutRequirements.length,
              one: 'task citing nothing',
              other: 'tasks citing nothing',
            },
          ],
          plural(holes, 'coverage hole', 'coverage holes'),
        )
      : plural(holes, 'coverage hole', 'coverage holes');
  const blockedLink =
    brief.blocked.length === 1 && brief.blocked[0] !== undefined
      ? { href: `/tasks/${brief.blocked[0].humanId}`, action: 'Open the blocked task' }
      : brief.blocked.length > 1 && phase !== null
        ? { href: `/projects/${code}/phases/${phase.humanId}`, action: 'Open the phase board' }
        : { href: `/projects/${code}/phases`, action: 'Open the phases' };

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
              reload();
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
        {counts === 'loading' ? (
          <Skeleton lines={3} />
        ) : (
          <Grid minItemWidth="sm">
            <StatCard
              label="Coverage holes"
              value={coverageSignal.state === 'not-measurable' ? '—' : holes}
              signal={coverageSignal}
              detail={
                coverageSignal.state === 'not-measurable'
                  ? unmeasuredWhy('No requirements or tasks recorded, so there is nothing to cover')
                  : holes === 0
                    ? '0 coverage holes · every Must has a task, every task a reason'
                    : holesDetail
              }
              href={`/projects/${code}/drift`}
              action={holes === 0 ? 'Open drift' : 'Open the coverage holes'}
            />
            <StatCard
              label={CRITICAL_PLUS_HIGH}
              value={brief.openCriticals.length}
              signal={readCount(brief.openCriticals.length, { measured: true, severity: 'danger' })}
              detail={breakdown(
                [
                  { n: brief.openCriticals.filter((f) => f.severity === 'critical').length, one: 'critical' },
                  { n: brief.openCriticals.filter((f) => f.severity === 'high').length, one: 'high' },
                ],
                'No open critical or high findings',
              )}
              // The findings screen is the list; `project` narrows it to this one.
              href={`/findings?project=${code}`}
              action={brief.openCriticals.length === 0 ? 'Open findings' : `Open ${plural(brief.openCriticals.length, 'finding', 'findings')}`}
            />
            <StatCard
              label="Drift"
              value={driftSignal.state === 'not-measurable' ? '—' : brief.drift.total}
              signal={driftSignal}
              detail={
                driftSignal.state === 'not-measurable'
                  ? unmeasuredWhy('No phases, tasks or requirements to compare with what shipped')
                  : brief.drift.total === 0
                    ? '0 drift · the checks found nothing in what is recorded'
                    : breakdown(
                        CATEGORIES.map((category) => ({
                          n: brief.drift.counts[category.key],
                          one: category.label.toLowerCase(),
                        })),
                        'Plan against reality',
                      )
              }
              href={`/projects/${code}/drift`}
              action={driftSignal.state === 'not-measurable' ? 'Why: see drift' : 'Open drift'}
            />
            <StatCard
              label="Blocked"
              value={blockedSignal.state === 'not-measurable' ? '—' : brief.blocked.length}
              signal={blockedSignal}
              detail={
                blockedSignal.state === 'not-measurable'
                  ? unmeasuredWhy('No tasks yet')
                  : brief.blocked.length === 0
                    ? 'No task is waiting on another'
                    : `${plural(brief.blocked.length, 'task cannot', 'tasks cannot')} start`
              }
              {...blockedLink}
            />
          </Grid>
        )}

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
          <Section title="In flight" surface="card">
            {phase === null ? (
              <EmptyState kind="empty" size="inline" heading="No phase is active">
                Add a phase, or mark one active.
              </EmptyState>
            ) : (
              <Stack gap="16">
                <Cluster gap="20" align="center">
                  <Donut
                    size={104}
                    legend
                    segments={[
                      { label: 'Done', value: done, color: SERIES.done },
                      { label: 'Cancelled', value: cancelled, color: SERIES.quiet },
                      {
                        label: 'Remaining',
                        value: Math.max(0, total - done - cancelled),
                        color: SERIES.waiting,
                      },
                    ]}
                    label={total === 0 ? '—' : `${String(percent)}%`}
                    caption={`${String(done + cancelled)} of ${String(total)}`}
                  />
                  <Stack gap="6" className="fm-grow">
                    <Link href={`/projects/${code}/phases/${phase.humanId}`}>
                      <span className="fm-card__title">
                        {phase.number} — {phase.name}
                      </span>
                    </Link>
                    {phase.objective !== null && (
                      <span className="fm-muted">{phase.objective}</span>
                    )}
                    <CiLine ci={brief.ci} />
                  </Stack>
                </Cluster>
                {phase.exitDemo !== null ? (
                  <div className="fm-callout">
                    <span className="fm-callout__label">Exit demo</span>
                    {phase.exitDemo}
                  </div>
                ) : (
                  // Neutral, and a link to where it is counted: the absence is a drift row, not an
                  // alarm of its own.
                  <a className="fm-chip fm-chip--link fm-chip--quiet" href={`/projects/${code}/drift`}>
                    no exit demo
                  </a>
                )}
              </Stack>
            )}
          </Section>

          <Section title="Next up" surface="card">
            {brief.nextTasks.length === 0 ? (
              <EmptyState kind="empty" size="inline" heading="Nothing ready to pick up">
                {brief.blocked.length > 0
                  ? 'Everything open is blocked.'
                  : 'Add a task to the active phase.'}
              </EmptyState>
            ) : (
              <Stack gap="6">
                {brief.nextTasks.map((task) => (
                  <a key={task.humanId} className="fm-item" href={`/tasks/${task.humanId}`}>
                    <code className="fm-item__id">{task.humanId}</code>
                    <span className="fm-item__title">{plainText(task.title)}</span>
                    {task.size !== null && <Badge tone="neutral" size="sm">{task.size}</Badge>}
                  </a>
                ))}
              </Stack>
            )}
          </Section>
        </Grid>

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

        {brief.blocked.length > 0 && (
          <Section title="Blocked" surface="card" description="Work to unblock, not work to do.">
            <Stack gap="8">
              {brief.blocked.map((task) => (
                <a key={task.humanId} className="fm-item fm-item--stacked" href={`/tasks/${task.humanId}`}>
                  <Cluster gap="8" align="center">
                    <Badge tone={taskStatusTone('blocked')} size="sm">
                      blocked
                    </Badge>
                    <code className="fm-item__id">{task.humanId}</code>
                    <span className="fm-item__title">{plainText(task.title)}</span>
                  </Cluster>
                  <span className="fm-muted">{task.reason ?? 'no reason recorded'}</span>
                </a>
              ))}
            </Stack>
          </Section>
        )}

        {brief.openCriticals.length > 0 && (
          <Section
            title={CRITICAL_PLUS_HIGH}
            surface="card"
            actions={<Link href="/findings">The inbox</Link>}
          >
            <Stack gap="8">
              {brief.openCriticals.map((finding) => (
                <Card key={finding.humanId} padding="sm" href={`/findings/${finding.humanId}`} interactive>
                  <Stack gap="4">
                    <Cluster gap="8" align="center">
                      <Badge tone={severityTone(finding.severity)} size="sm">{finding.severity}</Badge>
                      <code className="fm-card__code">{finding.humanId}</code>
                    </Cluster>
                    <span className="fm-finding__title">{plainText(finding.title)}</span>
                    {finding.location !== null && (
                      <code className="fm-muted fm-path">{finding.location}</code>
                    )}
                  </Stack>
                </Card>
              ))}
            </Stack>
          </Section>
        )}

        {/* Everything the project holds, as one strip — a map rather than eleven guesses about
            which sidebar item has what you want. */}
        <Section title="Sections" surface="card">
          <SectionMap code={code} />
        </Section>
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

/**
 * Every section of the project, as a strip of tiles.
 *
 * A map, not a menu: the sidebar already lists these, and this is the version you can take in at
 * once from the screen you land on.
 *
 * Deliberately without counts. There is no endpoint that answers "how many ADRs does BND have",
 * and the alternatives were both wrong for a redesign pass — inventing one is API surface added
 * from a screen, and fetching eight lists to read eight totals is eight requests to render a
 * label. Worth adding to the brief later; not worth faking now.
 */
function SectionMap({ code }: { code: string }) {
  return (
    <Grid minItemWidth="sm">
      {SECTIONS.map((section) => (
        <a key={section.slug} className="fm-tile" href={`/projects/${code}/${section.slug}`}>
          <span className="fm-tile__label">{section.label}</span>
          <span className="fm-tile__group">{section.group}</span>
        </a>
      ))}
    </Grid>
  );
}
