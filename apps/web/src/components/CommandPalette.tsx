import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CommandPalette as Palette,
  CommandPaletteHint,
  type CommandPaletteGroup,
  type CommandPaletteItem,
} from '@d3cloud/ui';
import {
  ArrowRight,
  CornerDownRight,
  FolderKanban,
  MonitorSmartphone,
  Search,
  UsersRound,
} from 'lucide-react';
import { foreman, type PortfolioRow, type SearchHit } from '../lib/api';
import { globalItems, libraryItems, type NavContext } from '../lib/nav';
import { navigate } from '../lib/router';
import { matchScope, scopeName, scopeOptions, useScope } from '../lib/scope';
import {
  exactId,
  goTo,
  groupEntries,
  hitHref,
  jumpTarget,
  MOD_KEY,
  projectEntries,
  screenEntries,
  searchHref,
  sectionEntries,
  type GoToEntry,
  type GoToKind,
  type GroupRef,
  type ScreenRef,
} from '../lib/shortcuts';
import './CommandPalette.css';

/**
 * ⌘K and `/` (FRM-REQ-244, FRM-T-18.5): one palette over any screen, built on `@d3cloud/ui`'s
 * CommandPalette.
 *
 * - **An exact human ID** — any kind, `parseAnyId` — is one *Jump to* row, resolved here before any
 *   request, so Enter goes straight to the record.
 * - **Anything else** lists *Go to* (screens, projects, groups, and a project's sections for a
 *   query like `bnd drift`) and then *Records* from `/api/search`, in the scope you are in.
 * - **⌘↵** hands the query to `/search`, which stays the full-results page of the same query.
 *
 * No actions yet: they wait for undo (FRM-T-18.4), so there is no group for them and nothing is
 * shown in its place. The library listens for no keys; `Shell` binds them and sets `open`.
 */

const RECORD_LIMIT = 8;
/** A query shorter than this is not sent: one letter matches half the ledger. */
const MIN_QUERY = 2;
const DEBOUNCE_MS = 200;

const GO_TO_ICONS: Record<GoToKind, ReactNode> = {
  screen: <MonitorSmartphone />,
  project: <FolderKanban />,
  group: <UsersRound />,
  section: <CornerDownRight />,
};

/** The reference data "Go to" draws on, loaded the first time the palette opens. */
interface Directory {
  readonly projects: readonly Pick<PortfolioRow, 'code' | 'name'>[];
  readonly groups: readonly GroupRef[];
  readonly options: ReturnType<typeof scopeOptions>;
}

const EMPTY: Directory = { projects: [], groups: [], options: [] };

function useDirectory(open: boolean): Directory {
  const [directory, setDirectory] = useState<Directory | null>(null);
  useEffect(() => {
    if (!open || directory !== null) return;
    let live = true;
    // Either may fail on its own: Go to still lists the screens, which need neither.
    void Promise.allSettled([foreman.portfolio(), foreman.groups()]).then(([portfolio, groups]) => {
      if (!live) return;
      setDirectory({
        projects: portfolio.status === 'fulfilled' ? portfolio.value.items : [],
        groups: groups.status === 'fulfilled' ? groups.value.items : [],
        options: groups.status === 'fulfilled' ? scopeOptions(groups.value) : [],
      });
    });
    return () => {
      live = false;
    };
  }, [open, directory]);
  return directory ?? EMPTY;
}

type Records =
  | { status: 'idle' }
  | { status: 'loading'; hits: readonly SearchHit[] }
  | { status: 'ready'; hits: readonly SearchHit[] }
  | { status: 'error' };

/** `/api/search` for the query, after the typing pauses, in the scope you are in. */
function useRecords(open: boolean, query: string, scope: string | null, skip: boolean): Records {
  const [records, setRecords] = useState<Records>({ status: 'idle' });
  const text = query.trim();
  const wanted = open && !skip && text.length >= MIN_QUERY;
  useEffect(() => {
    if (!wanted) {
      setRecords({ status: 'idle' });
      return;
    }
    let live = true;
    // The previous answer stays on screen, under a spinner, until the new one lands.
    setRecords((was) => ({
      status: 'loading',
      hits: 'hits' in was ? was.hits : [],
    }));
    const timer = window.setTimeout(() => {
      foreman
        .search(text, [], null, scope)
        .then((result) => {
          if (live)
            setRecords({
              status: 'ready',
              hits: result.items.slice(0, RECORD_LIMIT),
            });
        })
        .catch(() => {
          if (live) setRecords({ status: 'error' });
        });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [wanted, text, scope]);
  return records;
}

export function CommandPalette({
  open,
  onOpenChange,
  nav,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nav: NavContext;
}) {
  const { scope } = useScope();
  const [query, setQuery] = useState('');
  const directory = useDirectory(open);

  const id = exactId(query);
  const records = useRecords(open, query, scope, id !== null);

  // A fresh open starts with an empty box.
  const setOpen = (next: boolean) => {
    if (!next) setQuery('');
    onOpenChange(next);
  };

  // ⌘↵ (Ctrl ↵): the same query as the full-results page. Caught before the palette's own Enter,
  // which would otherwise open the highlighted row.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      navigate(searchHref(query, scope));
      setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, query, scope]);

  const screens = useMemo<ScreenRef[]>(
    () => [
      ...globalItems(nav, false),
      ...libraryItems(nav),
      { to: '/drift', label: 'Drift across projects' },
      { to: '/system', label: 'System health' },
    ],
    [nav],
  );
  const entries = useMemo(
    () => ({
      screens: screenEntries(screens, scope),
      projects: projectEntries(directory.projects),
      groups: groupEntries(directory.groups),
      sections: sectionEntries(directory.projects),
    }),
    [screens, scope, directory],
  );

  const go = (href: string) => () => {
    navigate(href);
  };
  const goToItem = (entry: GoToEntry, at: number): CommandPaletteItem => ({
    id: `${at}:${entry.href}`,
    label: entry.label,
    description: entry.description,
    leading: GO_TO_ICONS[entry.kind],
    onSelect: go(entry.href),
  });

  const groups: CommandPaletteGroup[] = [];
  if (id !== null) {
    const target = jumpTarget(id, directory.groups);
    if (target !== null) {
      groups.push({
        id: 'jump',
        label: 'Jump to',
        items: [
          {
            id: target.href,
            label: `Open ${target.label}`,
            description: target.description,
            leading: <ArrowRight />,
            onSelect: go(target.href),
          },
        ],
      });
    }
  } else {
    groups.push({
      id: 'go-to',
      label: 'Go to',
      items: goTo(query, entries).map(goToItem),
    });
    const hits = 'hits' in records ? records.hits : [];
    const scoped = scopeName(scope, matchScope(scope, directory.options));
    groups.push({
      id: 'records',
      label: scope === null ? 'Records' : `Records in ${scoped}`,
      items: hits.map((hit, at) => ({
        id: `${at}:${hit.type}:${hit.humanId ?? hit.title}`,
        label: hit.humanId === null ? hit.title : `${hit.humanId} · ${hit.title}`,
        description: [hit.projectCode, hit.type.replace(/_/g, ' ')]
          .filter((part) => part !== null)
          .join(' · '),
        leading: <Search />,
        onSelect: go(hitHref(hit)),
      })),
    });
  }

  const loading = records.status === 'loading';
  const emptyMessage =
    records.status === 'error' ? 'Search did not run. Screens and projects above still work.' : undefined;

  return (
    <Palette
      open={open}
      onOpenChange={setOpen}
      query={query}
      onQueryChange={setQuery}
      groups={groups}
      label="Search and jump"
      placeholder="Jump to an ID, a screen or a project"
      loading={loading}
      {...(emptyMessage === undefined ? {} : { emptyMessage })}
      className="fm-palette"
      footer={
        <>
          <span className="fm-palette__hints">
            <CommandPaletteHint keys={['↑', '↓']}>navigate</CommandPaletteHint>
            <CommandPaletteHint keys={['↵']}>open</CommandPaletteHint>
            <CommandPaletteHint keys={[MOD_KEY, '↵']}>all results in Search</CommandPaletteHint>
            <CommandPaletteHint keys={['esc']}>close</CommandPaletteHint>
          </span>
          <button
            type="button"
            className="fm-palette__close"
            onClick={() => {
              setOpen(false);
            }}
          >
            Close
          </button>
        </>
      }
    />
  );
}
