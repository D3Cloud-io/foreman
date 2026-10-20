import { useState } from 'react';
import {
  Button,
  Card,
  Cluster,
  EmptyState,
  Grid,
  IconButton,
  Page,
  PageHeader,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { ArrowUpRight, ChevronDown, ChevronRight, UsersRound } from 'lucide-react';
import { foreman, type PortfolioRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import {
  descriptionsOf,
  portfolioSections,
  readCollapsed,
  readIntroDismissed,
  sectionSummary,
  siteLabel,
  writeCollapsed,
  writeIntroDismissed,
  type Section,
} from '../lib/groups';
import { navigate } from '../lib/router';
import { AccentDot } from '../ui/groups';
import { Pill, StatCard } from '../ui/viz';
import { ciTone, lifecycleTone } from '../ui/tone';

/**
 * Home — the portfolio by family (17.01, FRM-REQ-224, FRM-REQ-228).
 *
 * One section per group, in the order set on the Groups screen, then Ungrouped last and quieter:
 * each with its name, its site, its line of description and its figures, and a grid of the
 * projects in it. A section collapses from its chevron by keyboard as well as by pointer, and the
 * console remembers it, per group, in this browser.
 *
 * The four figures above are the same ones the project cards add up to: one derivation, read
 * twice, so the summary can never disagree with the cards under it.
 *
 * Membership and order come from `GET /api/groups`; the figures from the portfolio, joined by code.
 * With no group yet, the projects stand in one grid under a card offering to make one (17.14).
 */

function phaseLabel(row: PortfolioRow): string {
  const total = row.tasks.open + row.tasks.blocked + row.tasks.done + row.tasks.cancelled;
  if (row.phase !== null) return `P-${row.phase.number} · ${row.phase.name}`;
  return total === 0 ? 'Not started' : 'No active phase';
}

function ciLabel(row: PortfolioRow): string {
  if (row.ci.unknown) return 'No CI';
  if (row.ci.conclusion === 'success') return 'CI';
  if (row.ci.conclusion === 'failure' || row.ci.conclusion === 'timed_out') return 'CI failing';
  return `CI ${row.ci.conclusion ?? 'pending'}`;
}

/** One project, as the board draws it: code, name, CI, lifecycle, phase, progress, figures. */
export function ProjectTile({ row }: { row: PortfolioRow }) {
  const total = row.tasks.open + row.tasks.blocked + row.tasks.done + row.tasks.cancelled;
  const closed = row.tasks.done + row.tasks.cancelled;
  const width = total === 0 ? 0 : (closed / total) * 100;

  return (
    <Card padding="md" href={`/projects/${row.code}`} interactive>
      <Stack gap="8">
        <div className="fm-tile__head">
          <span className="fm-tile__name">
            <code className="fm-code-chip">{row.code}</code>
            <span className="fm-card__title fm-truncate">{row.name}</span>
          </span>
          <Pill tone={ciTone(row.ci.conclusion, row.ci.unknown)} dot>
            {ciLabel(row)}
          </Pill>
        </div>
        <Pill tone={lifecycleTone(row.lifecycle)}>{row.lifecycle}</Pill>
        <span className="fm-muted fm-truncate">{phaseLabel(row)}</span>
        {/* The figure below says it in words; the bar is how fast you see it. */}
        <span className="fm-progress" aria-hidden="true">
          <span className="fm-progress__fill" style={{ width: `${String(width)}%` }} />
        </span>
        <Cluster gap="8" align="center" justify="between">
          <span className="fm-muted">
            {total === 0 ? 'No tasks yet' : `${String(closed)} of ${String(total)} tasks`}
          </span>
          <span className="fm-muted">
            {row.drift.total} drift · {row.openCriticals} critical{row.openCriticals === 1 ? '' : 's'}
          </span>
        </Cluster>
      </Stack>
    </Card>
  );
}

/** The four figures, for whatever rows are in view. */
export function PortfolioStats({ rows, projectsDetail }: { rows: readonly PortfolioRow[]; projectsDetail: string }) {
  const building = rows.filter((row) => row.lifecycle === 'building');
  const criticals = rows.reduce((sum, row) => sum + row.openCriticals, 0);
  const drift = rows.reduce((sum, row) => sum + row.drift.total, 0);

  return (
    <Grid minItemWidth="sm">
      <StatCard label="Projects" value={rows.length} detail={projectsDetail} />
      <StatCard
        label="Building"
        value={building.length}
        tone={building.length === 0 ? 'neutral' : 'accent'}
        detail={building.length === 0 ? 'Nothing in progress' : building.map((row) => row.code).join(', ')}
      />
      <StatCard
        label="Open criticals"
        value={criticals}
        tone={criticals === 0 ? 'success' : 'danger'}
        detail={criticals === 0 ? 'Nothing on fire' : 'Across these projects'}
        href="/findings"
      />
      <StatCard
        label="Drift"
        value={drift}
        tone={drift === 0 ? 'neutral' : 'warning'}
        detail="Plan and reality apart"
      />
    </Grid>
  );
}

function GroupSection({
  section,
  collapsed,
  onToggle,
}: {
  section: Section<PortfolioRow>;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { group } = section;
  const headingId = `fm-home-${section.key}`;
  const bodyId = `fm-home-${section.key}-projects`;

  return (
    <section aria-labelledby={headingId} className={`fm-gsection${group === null ? ' fm-gsection--quiet' : ''}`}>
      <div className="fm-gsection__head">
        <IconButton
          size="sm"
          icon={collapsed ? <ChevronRight /> : <ChevronDown />}
          label={`${section.name} projects`}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={onToggle}
        />
        <div className="fm-gsection__titles">
          <div className="fm-gsection__titleline">
            {group !== null && <AccentDot accent={group.accent} />}
            <h2 id={headingId} className="fm-gsection__title">
              {section.name}
            </h2>
            {group !== null && group.siteUrl !== null && (
              <a className="fm-gsection__site" href={group.siteUrl} target="_blank" rel="noreferrer">
                {siteLabel(group.siteUrl)}
                <ArrowUpRight aria-hidden="true" className="fm-icon-sm" />
                <span className="fm-visually-hidden"> (opens in a new tab)</span>
              </a>
            )}
          </div>
          <span className="fm-muted">
            {group === null
              ? 'In no group — only the guidelines that apply to all projects apply here.'
              : (group.description ?? '')}
          </span>
        </div>
        <span className="fm-muted fm-gsection__counts">{sectionSummary(section.rows)}</span>
      </div>
      <div id={bodyId} hidden={collapsed}>
        {section.rows.length === 0 ? (
          <p className="fm-muted fm-group-note">No projects yet — move some here from Projects.</p>
        ) : (
          <div className="fm-tiles">
            {section.rows.map((row) => (
              <ProjectTile key={row.code} row={row} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function FirstRun({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Card padding="md" as="section" aria-labelledby="fm-first-run">
      <Cluster gap="16" align="center" justify="between">
        <Cluster gap="12" align="start">
          <UsersRound aria-hidden="true" className="fm-first-run__icon" />
          <Stack gap="4">
            <h2 id="fm-first-run" className="fm-subheading">
              Group your projects
            </h2>
            <span className="fm-muted">
              Families like D3 Cloud and Dormice get their own section and their own guidelines.
            </span>
          </Stack>
        </Cluster>
        <Cluster gap="8" align="center">
          <Button variant="ghost" onClick={onDismiss}>
            Not now
          </Button>
          <Button variant="primary" onClick={() => { navigate('/groups?new=1'); }}>
            Create a group
          </Button>
        </Cluster>
      </Cluster>
    </Card>
  );
}

function plural(n: number, one: string, other: string): string {
  return `${String(n)} ${n === 1 ? one : other}`;
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

function groupsDetail(n: number, ungrouped: number): string {
  const count = n < WORDS.length ? `${WORDS[n] ?? String(n)} ${n === 1 ? 'group' : 'groups'}` : plural(n, 'group', 'groups');
  return `${count} · ${String(ungrouped)} ungrouped`;
}

export function Home() {
  const portfolio = useAsync(() => foreman.portfolio(), []);
  const groups = useAsync(() => foreman.groups(), []);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [introDismissed, setIntroDismissed] = useState(readIntroDismissed);

  const header = (description: string) => <PageHeader title="Home" description={description} />;

  if (portfolio.state.status === 'loading') {
    return (
      <Page>
        {header('Where everything stands.')}
        <Skeleton lines={8} />
      </Page>
    );
  }

  if (portfolio.state.status === 'error') {
    const message = portfolio.state.message;
    return (
      <Page>
        {header('Where everything stands.')}
        <EmptyState kind="error" heading="Home did not load">
          {message}
        </EmptyState>
      </Page>
    );
  }

  const grouped = portfolio.state.value;
  const rows = grouped.items;
  // Only the descriptions come from here: the portfolio's sections carry none. Home renders
  // without them rather than waiting on a second read.
  const listing = groups.state.status === 'ready' ? groups.state.value : null;
  const isCollapsed = (key: string) => collapsed[key] ?? readCollapsed(key);
  const toggle = (key: string) => {
    const next = !isCollapsed(key);
    writeCollapsed(key, next);
    setCollapsed((current) => ({ ...current, [key]: next }));
  };

  if (grouped.groups.length === 0) {
    return (
      <Page>
        {header(`${plural(rows.length, 'project', 'projects')}, and what needs looking at.`)}
        <Stack gap="24">
          {!introDismissed && (
            <FirstRun
              onDismiss={() => {
                writeIntroDismissed();
                setIntroDismissed(true);
              }}
            />
          )}
          <PortfolioStats rows={rows} projectsDetail="No groups yet" />
          {rows.length === 0 ? (
            <EmptyState kind="empty" heading="No projects yet">
              Import the vault, or convert a project idea, to start.
            </EmptyState>
          ) : (
            <div className="fm-tiles">
              {[...rows]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((row) => (
                  <ProjectTile key={row.code} row={row} />
                ))}
            </div>
          )}
        </Stack>
      </Page>
    );
  }

  const sections = portfolioSections(grouped, descriptionsOf(listing)).filter(
    // An empty Ungrouped says nothing worth a heading; an empty group is still a family.
    (section) => section.group !== null || section.rows.length > 0,
  );
  const n = grouped.groups.length;

  return (
    <Page>
      {header(
        `${plural(rows.length, 'project', 'projects')} in ${n < WORDS.length ? (WORDS[n] ?? String(n)).toLowerCase() : String(n)} ${
          n === 1 ? 'group' : 'groups'
        }, and what needs looking at.`,
      )}
      <Stack gap="32">
        <PortfolioStats rows={rows} projectsDetail={groupsDetail(n, grouped.ungrouped?.projects.length ?? 0)} />
        {sections.map((section) => (
          <GroupSection
            key={section.key}
            section={section}
            collapsed={isCollapsed(section.key)}
            onToggle={() => { toggle(section.key); }}
          />
        ))}
      </Stack>
    </Page>
  );
}
