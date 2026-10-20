import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Cluster,
  EmptyState,
  IconButton,
  Link,
  Page,
  PageHeader,
  Section,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { ArrowUpRight, ChevronDown, ChevronUp } from 'lucide-react';
import type { GroupDetail } from '@foreman/shared';
import { ApiError, foreman, type GuidelineRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { accentLabel, listJoin, moveBy, siteLabel } from '../lib/groups';
import { AccentDot, MoveToGroupDialog, useMoveToast, type MovingProject } from '../ui/groups';
import { useUndoToast } from '../lib/undo';
import { GroupEditor, useGroupListing, useReorderFocus } from './Groups';
import { PortfolioStats, useOpenSeverities } from './Home';

/**
 * One group's page (17.10): what it is, how its projects are doing, the order they sit in inside
 * the group's section on Home and Projects, and which guidelines bind them.
 *
 * Its projects reorder with the same Move up / Move down pair as the Groups screen — no drag — and
 * each has **Move…** to send it to another group, through the same dialog Projects uses.
 */

function plural(n: number, one: string, other: string): string {
  return `${String(n)} ${n === 1 ? one : other}`;
}

/** The guidelines that do not apply here, said by the groups they do apply to. */
function elsewhere(rows: readonly GuidelineRow[], here: string, names: ReadonlyMap<string, string>): string[] {
  const byScope = new Map<string, string[]>();
  for (const row of rows) {
    if (row.status !== 'active' || row.appliesTo !== 'groups' || row.groups.includes(here)) continue;
    const scope = listJoin(row.groups.map((id) => names.get(id) ?? id));
    byScope.set(scope, [...(byScope.get(scope) ?? []), row.humanId]);
  }
  return [...byScope.entries()].map(
    ([scope, ids]) => `${listJoin(ids)} ${ids.length === 1 ? 'applies' : 'apply'} to ${scope} only.`,
  );
}

export function GroupPage({ slug }: { slug: string }) {
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [failed, setFailed] = useState<{ notFound: boolean; message: string } | null>(null);
  const { listing, refresh: refreshListing } = useGroupListing();
  const portfolio = useAsync(() => foreman.portfolio(), []);
  const guidelines = useAsync(() => foreman.guidelines(), []);
  const severities = useOpenSeverities(slug);
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState<MovingProject | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusAfter } = useReorderFocus();

  const load = useCallback(() => {
    foreman
      .group(slug)
      .then((value) => {
        setDetail(value);
        setFailed(null);
      })
      .catch((caught: unknown) => {
        setFailed({
          notFound: caught instanceof ApiError && caught.status === 404,
          message: caught instanceof Error ? caught.message : String(caught),
        });
      });
  }, [slug]);
  useEffect(load, [load]);

  const refresh = () => {
    load();
    refreshListing();
    portfolio.reload();
  };
  const toastMove = useMoveToast(refresh);
  const toastUndoable = useUndoToast();

  const back = <a href="/groups">Groups</a>;

  // `ungrouped` answers the API too, but it is not a group: no accent, no guidelines of its own.
  if (slug === 'ungrouped') {
    return (
      <Page>
        <PageHeader title="Ungrouped" back={back} />
        <EmptyState kind="empty" heading="Ungrouped is not a group">
          It is every project in no group, listed last on <Link variant="inline" href="/projects">Projects</Link>.
        </EmptyState>
      </Page>
    );
  }

  if (failed !== null) {
    return (
      <Page>
        <PageHeader title={failed.notFound ? 'No such group' : 'Group'} back={back} />
        <EmptyState kind={failed.notFound ? 'no-results' : 'error'} heading={failed.notFound ? `No group called ${slug}` : 'That group did not load'}>
          {failed.notFound ? 'It may have been deleted. Every group is on the Groups screen.' : failed.message}
        </EmptyState>
      </Page>
    );
  }

  if (detail === null) {
    return (
      <Page>
        <Skeleton lines={8} />
      </Page>
    );
  }

  const projects = [...detail.projects].sort((a, b) => a.position - b.position);
  const rows =
    portfolio.state.status === 'ready'
      ? projects.flatMap((p) => {
          const row = portfolio.state.status === 'ready' ? portfolio.state.value.items.find((r) => r.code === p.code) : undefined;
          return row === undefined ? [] : [row];
        })
      : [];
  const allGuidelines = guidelines.state.status === 'ready' ? guidelines.state.value.items : [];
  const names = new Map((listing?.items ?? []).map((group) => [group.humanId, group.name]));
  const others = elsewhere(allGuidelines, detail.humanId, names);

  const reorder = (index: number, delta: -1 | 1) => {
    const project = projects[index];
    if (project === undefined) return;
    const next = moveBy(projects, index, delta);
    setDetail({ ...detail, projects: next.map((p, position) => ({ ...p, position })) });
    focusAfter({ id: project.code, dir: delta < 0 ? 'up' : 'down' });
    setFailure(null);
    foreman
      .orderGroupProjects(detail.humanId, next.map((p) => p.code))
      .then((result) => {
        load();
        toastUndoable({
          message: `Moved ${project.name} ${delta < 0 ? 'up' : 'down'}`,
          auditEventIds: result.auditEventIds,
          undone: 'Put the order back',
          reload: refresh,
        });
      })
      .catch((caught: unknown) => {
        setFailure(caught instanceof Error ? caught.message : String(caught));
        load();
      });
  };

  return (
    <Page>
      <PageHeader
        title={detail.name}
        back={back}
        description={
          <span className="fm-break">
            {detail.description ?? ''}
            {detail.siteUrl !== null && (
              <>
                {detail.description === null ? '' : ' · '}
                <a className="fm-break" href={detail.siteUrl} target="_blank" rel="noreferrer" title={detail.siteUrl}>
                  {siteLabel(detail.siteUrl)}
                  <ArrowUpRight aria-hidden="true" className="fm-icon-sm" />
                  <span className="fm-visually-hidden"> (opens in a new tab)</span>
                </a>
              </>
            )}
          </span>
        }
        actions={<Button onClick={() => { setEditing(true); }}>Edit group</Button>}
      />

      <Stack gap="24">
        <p className="fm-group-meta">
          <AccentDot accent={detail.accent} size="sm" />
          {detail.humanId} · Accent: {accentLabel(detail.accent)} ·{' '}
          {plural(detail.counts.projects, 'project', 'projects')} ·{' '}
          {plural(detail.guidelines.length, 'guideline applies', 'guidelines apply')}
        </p>

        {portfolio.state.status === 'ready' && (
          <PortfolioStats
            rows={rows}
            projectsDetail={rows.length === 0 ? 'None yet' : `In ${detail.name}`}
            // Its criticals and drift open scoped to this group (FRM-T-17.4).
            scope={detail.slug}
            severities={severities}
          />
        )}

        {failure !== null && (
          <Alert tone="danger" title="The order did not save" dynamic>
            {failure}
          </Alert>
        )}

        <div className="fm-group-layout">
          <Section
            title={`Projects in ${detail.name}`}
            surface="card"
            description={`Order here is the order inside the ${detail.name} section on Home and Projects.`}
          >
            {projects.length === 0 ? (
              <EmptyState kind="empty" size="inline" heading="No projects yet">
                Move some here from <Link variant="inline" href="/projects">Projects</Link>.
              </EmptyState>
            ) : (
              <ul className="fm-glist fm-glist--plain" aria-label={`Projects in ${detail.name}, in order`}>
                {projects.map((project, index) => {
                  const row = rows.find((r) => r.code === project.code);
                  return (
                    <li key={project.code} className="fm-glist__item">
                      <div className="fm-glist__row">
                        <span className="fm-glist__reorder">
                          <IconButton
                            ref={ref(project.code, 'up')}
                            size="sm"
                            icon={<ChevronUp />}
                            label={`Move ${project.name} up`}
                            disabled={index === 0}
                            onClick={() => { reorder(index, -1); }}
                          />
                          <IconButton
                            ref={ref(project.code, 'down')}
                            size="sm"
                            icon={<ChevronDown />}
                            label={`Move ${project.name} down`}
                            disabled={index === projects.length - 1}
                            onClick={() => { reorder(index, 1); }}
                          />
                        </span>
                        <span className="fm-glist__text">
                          <a className="fm-glist__name" href={`/projects/${project.code}`}>
                            {project.name}
                          </a>
                          <span className="fm-muted">
                            {project.code}
                            {row !== undefined && row.phase !== null ? ` · P-${row.phase.number} · ${row.phase.name}` : ''}
                          </span>
                        </span>
                        <span className="fm-glist__meta">
                          <span className="fm-muted">
                            {project.lifecycle}
                            {row === undefined ? '' : ` · ${String(row.drift.total)} drift`}
                          </span>
                        </span>
                        <span className="fm-glist__actions">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Move ${project.code}…`}
                            onClick={() => { setMoving({ code: project.code, name: project.name }); }}
                          >
                            Move…
                          </Button>
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section title="Guidelines that apply" surface="card">
            <Stack gap="12">
              {detail.guidelines.length === 0 ? (
                <p className="fm-muted fm-group-note">No active guideline applies yet.</p>
              ) : (
                <ul className="fm-plain-list">
                  {detail.guidelines.map((guideline) => (
                    <li key={guideline.humanId} className="fm-gl-line">
                      <code className="fm-item__id">{guideline.humanId}</code>
                      <span>{guideline.title}</span>
                    </li>
                  ))}
                </ul>
              )}
              {others.map((line) => (
                <p key={line} className="fm-muted fm-group-note">
                  {line}
                </p>
              ))}
              <Cluster>
                <Link href="/guidelines">Manage in Guidelines</Link>
              </Cluster>
            </Stack>
          </Section>
        </div>
      </Stack>

      {listing !== null && (
        <>
          <GroupEditor
            editing={editing ? detail : null}
            listing={listing}
            guidelines={allGuidelines}
            onClose={() => { setEditing(false); }}
            onSaved={(saved) => {
              setEditing(false);
              refresh();
              toastUndoable({
                message: `Saved ${saved.name}`,
                auditEventIds: saved.auditEventIds,
                undone: `Put ${saved.name} back as it was`,
                reload: refresh,
              });
            }}
          />
          <MoveToGroupDialog
            open={moving !== null}
            onOpenChange={(next) => { if (!next) setMoving(null); }}
            projects={moving === null ? [] : [moving]}
            listing={listing}
            onMoved={(result, codes, targetName, origin) => {
              setMoving(null);
              refresh();
              toastMove(result, codes, targetName, origin);
            }}
          />
        </>
      )}
    </Page>
  );
}
