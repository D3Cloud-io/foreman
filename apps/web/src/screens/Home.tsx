import { useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  Cluster,
  EmptyState,
  Grid,
  IconButton,
  Link,
  Page,
  PageHeader,
  Section as Panel,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { ArrowUpRight, ChevronDown, ChevronRight, UsersRound } from 'lucide-react';
import { ScopeNotice, UnknownScope, useScopeView } from '../components/ScopeSwitcher';
import { api, foreman, type FindingsPage, type PortfolioRow } from '../lib/api';
import { scopedHref, scopeOf } from '../lib/scope';
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
import { SegmentBar, StatCard } from '../ui/viz';
import {
  breakdown,
  ciTone,
  ciWord,
  CRITICAL_PLUS_HIGH,
  lifecycleTone,
  plural,
  readAcross,
  readCi,
  rowPlanned,
} from '../ui/status';
import { SERIES } from '../ui/tone';
import { CATEGORIES } from './DriftView';

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

/** One project, as the board draws it: code, name, CI, lifecycle, phase, progress, figures. */
export function ProjectTile({ row }: { row: PortfolioRow }) {
  const total = row.tasks.open + row.tasks.blocked + row.tasks.done + row.tasks.cancelled;
  const closed = row.tasks.done + row.tasks.cancelled;
  const width = total === 0 ? 0 : (closed / total) * 100;
  const planned = rowPlanned(row);

  return (
    <Card padding="md" href={`/projects/${row.code}`} interactive>
      <Stack gap="8">
        <div className="fm-tile__head">
          <span className="fm-tile__name">
            <code className="fm-code-chip">{row.code}</code>
            <span className="fm-card__title fm-truncate">{row.name}</span>
          </span>
          <Badge tone={ciTone(row.ci.conclusion, row.ci.unknown)} size="sm" className="fm-badge">
            {ciWord(row.ci)}
          </Badge>
        </div>
        <Badge tone={lifecycleTone(row.lifecycle)} size="sm" className="fm-badge">
          {row.lifecycle}
        </Badge>
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
            {planned ? `${String(row.drift.total)} drift` : 'drift not measurable yet'} ·{' '}
            {String(row.openCriticals)} {CRITICAL_PLUS_HIGH.toLowerCase()}
          </span>
        </Cluster>
      </Stack>
    </Card>
  );
}

function taskTotal(row: PortfolioRow): number {
  return row.tasks.open + row.tasks.blocked + row.tasks.done + row.tasks.cancelled;
}

/**
 * The figures, for whatever rows are in view. `scope` is the one in the URL: the figures' links
 * keep it, so Critical + high in Dormice opens Dormice's findings.
 *
 * Each is one of three states (FRM-REQ-241): needs you, clean, or not measurable yet — and a zero
 * over projects some of which could not be measured is never "clean". Each detail gives its
 * breakdown, and each card opens the list it counts.
 */
export function PortfolioStats({
  rows,
  projectsDetail,
  scope = null,
  severities = null,
}: {
  rows: readonly PortfolioRow[];
  projectsDetail: string;
  scope?: string | null;
  /** Open findings by severity, when read — the breakdown under Critical + high. */
  severities?: FindingsPage['counts'] | null;
}) {
  const building = rows.filter((row) => row.lifecycle === 'building');
  const criticals = rows.reduce((sum, row) => sum + row.openCriticals, 0);
  const drift = rows.reduce((sum, row) => sum + row.drift.total, 0);
  const blockedIn = rows.filter((row) => row.tasks.blocked > 0);
  const blocked = rows.reduce((sum, row) => sum + row.tasks.blocked, 0);
  const unplanned = rows.filter((row) => !rowPlanned(row)).map((row) => row.code);
  const ci = readCi(rows);

  const totals = rows.reduce(
    (sum, row) => ({
      done: sum.done + row.tasks.done,
      cancelled: sum.cancelled + row.tasks.cancelled,
      blocked: sum.blocked + row.tasks.blocked,
      open: sum.open + row.tasks.open,
    }),
    { done: 0, cancelled: 0, blocked: 0, open: 0 },
  );
  const allTasks = totals.done + totals.cancelled + totals.blocked + totals.open;

  const driftBreakdown = CATEGORIES.map((category) => ({
    n: rows.reduce((sum, row) => sum + (row.drift.counts[category.key]), 0),
    one: category.label.toLowerCase(),
  }));

  return (
    <Stack gap="24">
      <Grid minItemWidth="sm">
        <StatCard
          label="Projects"
          value={rows.length}
          detail={`${breakdown(
            ['building', 'deployed', 'planned', 'scaffolded', 'parked', 'scrapped'].map((lifecycle) => ({
              n: rows.filter((row) => row.lifecycle === lifecycle).length,
              one: lifecycle,
            })),
            'None yet',
          )} · ${projectsDetail}`}
          href={scopedHref('/projects', scope)}
          action="Open projects"
        />
        <StatCard
          label="Building"
          value={building.length}
          detail={building.length === 0 ? 'Nothing in progress' : building.map((row) => row.code).join(', ')}
          href={scopedHref('/projects', scope)}
          action="Open projects"
        />
        <StatCard
          label={CRITICAL_PLUS_HIGH}
          value={criticals}
          signal={readAcross(criticals, { unmeasured: [], total: rows.length, severity: 'danger' })}
          detail={
            criticals === 0
              ? 'No open critical or high findings'
              : severities === null
                ? 'Open, across these projects'
                : breakdown(
                    [
                      { n: severities.critical, one: 'critical' },
                      { n: severities.high, one: 'high' },
                    ],
                    'Open, across these projects',
                  )
          }
          href={scopedHref('/findings', scope)}
          action={criticals === 0 ? 'Open findings' : `Open ${plural(criticals, 'finding', 'findings')}`}
        />
        <StatCard
          label="Blocked tasks"
          value={blocked}
          signal={readAcross(blocked, {
            unmeasured: rows.filter((row) => taskTotal(row) === 0).map((row) => row.code),
            total: rows.length,
          })}
          detail={
            blocked === 0
              ? 'No task is waiting on another'
              : blockedIn.map((row) => `${String(row.tasks.blocked)} in ${row.code}`).join(' · ')
          }
          href={blockedIn.length === 1 && blockedIn[0] !== undefined ? `/projects/${blockedIn[0].code}` : scopedHref('/projects', scope)}
          action={blockedIn.length === 1 ? `Open ${blockedIn[0]?.code ?? ''}` : 'Open projects'}
        />
        <StatCard
          label="Drift"
          value={drift}
          signal={readAcross(drift, { unmeasured: unplanned, total: rows.length })}
          detail={
            drift > 0
              ? breakdown(driftBreakdown, 'Plan and reality apart')
              : unplanned.length === 0
                ? 'Plan and reality agree'
                : `${plural(unplanned.length, 'project has', 'projects have')} no plan yet: ${unplanned.join(', ')}`
          }
          href={scopedHref('/drift', scope)}
          action="Open drift"
        />
        <StatCard
          label="CI · reporting"
          value={ci.value}
          signal={ci.signal}
          detail={ci.detail}
          href={scopedHref('/projects', scope)}
          action={ci.silent.length > 0 ? `See the ${String(ci.silent.length)} not reporting` : 'Open projects'}
        />
      </Grid>

      <Panel title="Work across the portfolio" surface="card">
        <Stack gap="8">
          <span>
            <strong>
              {totals.done + totals.cancelled} of {allTasks}
            </strong>{' '}
            <span className="fm-muted">
              tasks closed: {totals.done} done, {totals.cancelled} cancelled. Task status as declared.
            </span>
          </span>
          <SegmentBar
            segments={[
              { label: 'Done', value: totals.done, color: SERIES.done },
              { label: 'Open', value: totals.open, color: SERIES.active },
              { label: 'Blocked', value: totals.blocked, color: SERIES.blocked },
              { label: 'Cancelled', value: totals.cancelled, color: SERIES.quiet },
            ]}
          />
        </Stack>
      </Panel>
    </Stack>
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
              <a className="fm-gsection__site" href={group.siteUrl} target="_blank" rel="noreferrer" title={group.siteUrl}>
                <span className="fm-truncate">{siteLabel(group.siteUrl)}</span>
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

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

function groupsDetail(n: number, ungrouped: number): string {
  const count = n < WORDS.length ? `${WORDS[n] ?? String(n)} ${n === 1 ? 'group' : 'groups'}` : plural(n, 'group', 'groups');
  return `${count} · ${String(ungrouped)} ungrouped`;
}

/**
 * Scoped, what the scope leaves out — "Hidden by scope: D3 Cloud 11 · Ungrouped 1" — and the way
 * back to all of it (D-06). Said, because a Home with two projects on it otherwise reads as a
 * Foreman that tracks two projects.
 */
function HiddenByScope({ shown }: { shown: ReadonlySet<string> }) {
  const { options, hrefFor } = useScopeView();
  const hidden = options.filter((option) => option.value !== null && option.count > 0 && !shown.has(option.key));
  if (hidden.length === 0) return null;
  return (
    <p className="fm-scope-hidden">
      Hidden by scope: {hidden.map((option) => `${option.name} ${String(option.count)}`).join(' · ')}.{' '}
      <Link variant="inline" href={hrefFor(null)}>
        Show all
      </Link>
    </p>
  );
}

export function Home({ search }: { search: string }) {
  // The scope is the URL's (FRM-T-17.4): `/?group=dormice` is Home for Dormice, and a link to it
  // opens there. A new scope is a fresh read of the portfolio.
  const scope = scopeOf(search);
  const { phrase } = useScopeView();
  const portfolio = useAsync(() => foreman.portfolio(scope), [scope]);
  const groups = useAsync(() => foreman.groups(), []);
  // Only for the breakdown under Critical + high ("1 critical · 2 high"): `limit=1` because the
  // counts describe the whole open set, not the page. The tile's figure itself comes from the
  // portfolio, so it never waits on this.
  const findings = useAsync(
    () =>
      api.get<FindingsPage>(
        `/api/findings?limit=1&status=open${scope === null ? '' : `&group=${encodeURIComponent(scope)}`}`,
      ),
    [scope],
  );
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [introDismissed, setIntroDismissed] = useState(readIntroDismissed);

  // Every state is the same frame — header, scope bar, body — so the switcher on the bar is one
  // element across a scope change and its loading, and keeps focus.
  const frame = (description: string, content: ReactNode) => (
    <Page>
      <PageHeader title="Home" description={description} />
      <ScopeNotice />
      {content}
    </Page>
  );

  if (portfolio.state.status === 'loading') {
    return frame('Where everything stands.', <Skeleton lines={8} />);
  }

  if (portfolio.state.status === 'error') {
    return frame(
      'Where everything stands.',
      portfolio.state.notFound && scope !== null ? (
        <UnknownScope scope={scope} />
      ) : (
        <EmptyState kind="error" heading="Home did not load">
          {portfolio.state.message}
        </EmptyState>
      ),
    );
  }

  const grouped = portfolio.state.value;
  const rows = grouped.items;
  // Only the descriptions come from here: the portfolio's sections carry none. Home renders
  // without them rather than waiting on a second read.
  const listing = groups.state.status === 'ready' ? groups.state.value : null;
  const severities = findings.state.status === 'ready' ? findings.state.value.counts : null;
  const isCollapsed = (key: string) => collapsed[key] ?? readCollapsed(key);
  const toggle = (key: string) => {
    const next = !isCollapsed(key);
    writeCollapsed(key, next);
    setCollapsed((current) => ({ ...current, [key]: next }));
  };

  if (scope !== null) {
    // Scoped (17.02): only that family's section — or the ungrouped — and the figures for it.
    const sections = portfolioSections(grouped, descriptionsOf(listing));
    const shown = new Set(sections.map((section) => section.key));
    return frame(
      `${plural(rows.length, 'project', 'projects')}${phrase === null ? '' : ` in ${phrase}`}, and what needs looking at.`,
      <Stack gap="32">
        <PortfolioStats rows={rows} projectsDetail={phrase === null ? 'In this scope' : `In ${phrase}`} scope={scope} severities={severities} />
        {sections.map((section) => (
          <GroupSection
            key={section.key}
            section={section}
            collapsed={isCollapsed(section.key)}
            onToggle={() => { toggle(section.key); }}
          />
        ))}
        <HiddenByScope shown={shown} />
      </Stack>,
    );
  }

  if (grouped.groups.length === 0) {
    return frame(
      `${plural(rows.length, 'project', 'projects')}, and what needs looking at.`,
      <Stack gap="24">
        {!introDismissed && (
          <FirstRun
            onDismiss={() => {
              writeIntroDismissed();
              setIntroDismissed(true);
            }}
          />
        )}
        <PortfolioStats rows={rows} projectsDetail="No groups yet" severities={severities} />
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
      </Stack>,
    );
  }

  const sections = portfolioSections(grouped, descriptionsOf(listing)).filter(
    // An empty Ungrouped says nothing worth a heading; an empty group is still a family.
    (section) => section.group !== null || section.rows.length > 0,
  );
  const n = grouped.groups.length;

  return frame(
    `${plural(rows.length, 'project', 'projects')} in ${n < WORDS.length ? (WORDS[n] ?? String(n)).toLowerCase() : String(n)} ${
      n === 1 ? 'group' : 'groups'
    }, and what needs looking at.`,
    <Stack gap="32">
      <PortfolioStats
        rows={rows}
        projectsDetail={groupsDetail(n, grouped.ungrouped?.projects.length ?? 0)}
        severities={severities}
      />
      {sections.map((section) => (
        <GroupSection
          key={section.key}
          section={section}
          collapsed={isCollapsed(section.key)}
          onToggle={() => { toggle(section.key); }}
        />
      ))}
    </Stack>,
  );
}
