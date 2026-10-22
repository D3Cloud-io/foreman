import { EmptyState, Link, Page, Skeleton, Table } from '@d3cloud/ui';
import type {
  Screen,
  ScreenTheme,
  ScreenVerdictKind,
  ScreenVersion,
  ScreenViewport,
} from '@foreman/shared';
import { ProjectHeader } from '../components/ProjectHeader';
import { priorityColumns, usePhone, type PriorityColumn } from '../ui/tablePriority';
import { foreman } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { Tone } from '../ui/tone';
import { Pill } from '../ui/viz';

/**
 * A project's screens (FRM-REQ-196): each with what it should look like, and the last word on
 * whether what was built matches.
 *
 * The thumbnail is the proposal rather than the capture because the list answers "which screen is
 * this", and the design is the version somebody meant. The verdict is the capture's, because it is
 * the only thing here that says whether the two agree.
 */

export const VERDICT_LABEL: Record<ScreenVerdictKind, string> = {
  matches: 'Matches',
  drifted_accepted: 'Drifted — accepted',
  drifted_fix: 'Drifted — fix',
};

/** A fix still owed is the one that should catch the eye; an accepted drift is a decision made. */
export const VERDICT_TONE: Record<ScreenVerdictKind, Tone> = {
  matches: 'success',
  drifted_accepted: 'warning',
  drifted_fix: 'danger',
};

/** "desktop dark", the way the alt text and the drop zone both say a variant. */
export function variantLabel(viewport: ScreenViewport, theme: ScreenTheme): string {
  return `${viewport} ${theme}`;
}

/** The version for one (viewport, theme), from a list that holds at most one of each. */
export function versionFor(
  versions: readonly ScreenVersion[],
  viewport: ScreenViewport,
  theme: ScreenTheme,
): ScreenVersion | null {
  return versions.find((v) => v.viewport === viewport && v.theme === theme) ?? null;
}

/**
 * The image a row shows: the current desktop dark proposal, else any current proposal — a screen
 * designed only for mobile is still recognisable by its mobile frame.
 */
export function thumbnailFor(screen: Screen): ScreenVersion | null {
  return (
    versionFor(screen.current.proposals, 'desktop', 'dark') ?? screen.current.proposals[0] ?? null
  );
}

/**
 * The newest verdict on the most recent capture of any variant. A verdict on an older capture says
 * nothing about what is built now, so it is not carried forward.
 */
export function latestVerdict(screen: Pick<Screen, 'current'>): ScreenVerdictKind | null {
  let latest: ScreenVersion | null = null;
  for (const capture of screen.current.captures) {
    if (latest === null || capture.createdAt > latest.createdAt) latest = capture;
  }
  return latest?.verdicts[0]?.verdict ?? null;
}

export function VerdictPill({ verdict }: { verdict: ScreenVerdictKind | null }) {
  return verdict === null ? (
    <Pill>none</Pill>
  ) : (
    <Pill tone={VERDICT_TONE[verdict]}>{VERDICT_LABEL[verdict]}</Pill>
  );
}

export function Screens({ code }: { code: string }) {
  const { state } = useAsync(() => foreman.screens(code), [code]);

  // Below 768px the screen is the title and its link; the ID, route and gaps fold under it, the
  // built verdict stays as the status, and the thumbnail goes (it is on the screen's own page).
  const screenColumns: PriorityColumn<Screen>[] = [
    {
      key: 'humanId',
      header: 'ID',
      width: '9rem',
      phone: 'fold',
      foldLabel: '',
      foldCell: (row) => <code>{row.humanId}</code>,
      cell: (row) => (
        <Link href={`/projects/${code}/screens/${row.humanId}`}>
          <code>{row.humanId}</code>
        </Link>
      ),
    },
    {
      key: 'thumbnail',
      header: 'Proposal',
      width: '8rem',
      phone: 'hide',
      cell: (row) => {
        const thumb = thumbnailFor(row);
        return thumb === null ? (
          <span className="fm-muted">no proposal</span>
        ) : (
          <img
            className="fm-screen-thumb"
            src={thumb.url}
            alt={`Proposed design for ${row.name}, ${variantLabel(thumb.viewport, thumb.theme)}`}
            loading="lazy"
          />
        );
      },
    },
    {
      key: 'name',
      header: 'Screen',
      phone: 'host',
      phoneCell: (row) => (
        <Link className="fm-rowlink" href={`/projects/${code}/screens/${row.humanId}`}>
          {row.name}
        </Link>
      ),
      cell: (row) => row.name,
    },
    {
      key: 'route',
      header: 'Route',
      phone: 'fold',
      foldLabel: '',
      cell: (row) =>
        row.route === null ? <span className="fm-muted">—</span> : <code>{row.route}</code>,
    },
    {
      key: 'verdict',
      header: 'Built',
      width: '11rem',
      phoneWidth: '9rem',
      cell: (row) => <VerdictPill verdict={latestVerdict(row)} />,
    },
    {
      key: 'gaps',
      header: 'Gaps',
      width: '5rem',
      phone: 'fold',
      numeric: true,
      cell: (row) => row.components.filter((c) => c.kind === 'gap').length,
    },
  ];

  const columns = priorityColumns(screenColumns, usePhone());

  return (
    <Page>
      <ProjectHeader
        code={code}
        section="screens"
        description="Each screen's design beside what was built, and whether they match."
        {...(state.status === 'ready' ? { count: state.value.items.length, countNoun: { one: 'screen', other: 'screens' } } : {})}
      />

      {state.status === 'loading' ? (
        <Skeleton lines={6} />
      ) : state.status === 'error' ? (
        <EmptyState kind="error" heading="The screens did not load">
          {state.message}
        </EmptyState>
      ) : (
        <Table
          caption={`Screens of ${code}`}
          captionHidden
          columns={columns}
          rows={state.value.items}
          rowKey={(row) => row.humanId}
          empty={
            <EmptyState kind="empty" size="inline" heading="No screens yet">
              A screen arrives with its first Figma export, through MCP or the API.
            </EmptyState>
          }
        />
      )}
    </Page>
  );
}
