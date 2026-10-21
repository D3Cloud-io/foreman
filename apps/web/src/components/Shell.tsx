import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  AccountMenu,
  AppShell,
  AppShellBrand,
  MenuItem,
  MenuSeparator,
  SideNav,
  SideNavGroup,
  SideNavItem,
  TabBar,
  ThemeSwitch,
  useAppShell,
} from '@d3cloud/ui';
import {
  BookMarked,
  BookText,
  CalendarRange,
  FileStack,
  GitBranch,
  LayoutDashboard,
  Library,
  Lightbulb,
  ListChecks,
  ListTodo,
  MonitorSmartphone,
  Radar,
  ScrollText,
  Search as SearchIcon,
  ShieldAlert,
  SquareStack,
  Table2,
} from 'lucide-react';
import { ForemanMark } from '../brand/ForemanMark';
import { ApiError, type Brief } from '../lib/api';
import { FINDINGS, globalItems, libraryItems, SEARCH, tabBarItems, type NavContext, type NavItem } from '../lib/nav';
import {
  briefFor,
  currentSectionSlug,
  isRecordPage,
  KNOWLEDGE_ROWS,
  onBriefForgotten,
  PROJECT_ROWS,
  projectCodeFor,
  recordTrailEnd,
  section,
} from '../lib/project';
import { navigate, routeFor } from '../lib/router';
import { useScope } from '../lib/scope';
import { dialogIsOpen, IS_MAC, isPaletteChord, shortcutFor } from '../lib/shortcuts';
import { useAsync } from '../lib/useAsync';
import { CommandPalette } from './CommandPalette';
import { HealthLine } from './HealthLine';
import { NavDisclosure } from './NavDisclosure';
import { NotFound } from './NotFound';
import { ScopeSwitcher } from './ScopeSwitcher';
import { ShortcutSheet } from './ShortcutSheet';
import { needsYou, useShellSignals } from './shellSignals';

/**
 * The signed-in frame: the design system's AppShell in its default, raised tone, composed as
 * Shipyard's `apps/web/src/components/Shell.tsx` is (FRM-ADR-025) — the sidebar on `surface`, each
 * screen's cards straight on the page ground, `AppShellBrand` with the Foreman mark as the home
 * link, counts only for what needs you, and a health line above the account menu in the footer.
 *
 * - **From `lg` (1024px)** a sidebar: the scope switcher's slot, three or four of the console's own
 *   destinations and the Library, then the project you are in — six rows and Knowledge — which fits
 *   a 1440×900 laptop with Drift above the fold (FRM-DA-001).
 * - **Below it** a top bar whose menu button opens a drawer, and a bottom tab bar of five. The tab
 *   bar carries the everyday destinations, so the drawer holds the rest: the project's rows and the
 *   Library. `lib/nav.ts` says which five and why.
 *
 * The project comes from the page: `/projects/CODE/…`, or a record's ID prefix on the flat record
 * routes (`lib/project.ts`). A code no project has renders the not-found page with no project block.
 */

/** True from `lg` up — the AppShell's own line between sidebar and drawer, and where the tab bar hides. */
const WIDE = '(min-width: 1024px)';

function subscribeWide(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

/** The project the page claims, and whether it exists. */
type ProjectState =
  | { status: 'none' }
  | { status: 'unknown'; code: string }
  /** `name` is the code until the brief arrives: a title that appears late shifts every row under it. */
  | { status: 'known'; code: string; name: string };

function useProject(path: string): ProjectState {
  const claimed = projectCodeFor(path);
  const { state, refresh } = useAsync<Brief | 'unknown' | null>(
    () =>
      claimed === null
        ? Promise.resolve(null)
        : briefFor(claimed).catch((error: unknown) => {
            if (error instanceof ApiError && (error.status === 404 || error.status === 400)) return 'unknown';
            throw error;
          }),
    [claimed],
  );
  // A rename (or any write that forgets the brief) re-reads the sidebar's project in place.
  useEffect(
    () =>
      onBriefForgotten((code) => {
        if (code === claimed) refresh();
      }),
    [claimed, refresh],
  );

  if (claimed === null) return { status: 'none' };
  if (state.status !== 'ready' || state.value === null) {
    // Loading, or a brief that failed for another reason: the project is shown by its code. A
    // server that is down is not evidence that the project does not exist.
    return { status: 'known', code: claimed, name: claimed };
  }
  if (state.value === 'unknown') return { status: 'unknown', code: claimed };
  return { status: 'known', code: claimed, name: state.value.project.name };
}

/**
 * The console's keys (FRM-REQ-244): ⌘K (Ctrl K elsewhere) and `/` open the command palette, `?`
 * opens the shortcut sheet — from anywhere in the console, and the rules for when are
 * `lib/shortcuts.ts`'s `shortcutFor`. Not while a dialog is open, since navigating would throw away
 * what is in it; `/` and `?` never from a text field, where they are characters; ⌘K from a
 * single-line field, but not from a multi-line one or an editable region, which is where an unsaved
 * draft lives. ⌘K with the palette already open closes it.
 *
 * Search keeps its row and its page: the palette's ⌘↵ is that page, for the same query.
 */
function useShortcuts(paletteOpen: boolean, setPaletteOpen: (open: boolean) => void, openSheet: () => void): void {
  // Read by the listener, which is bound once.
  const open = useRef(paletteOpen);
  open.current = paletteOpen;
  // The key that last opened or closed something, until it is released: its auto-repeats are
  // swallowed, so a held ⌘K does not flicker the palette and a held `/` or `?` cannot type itself
  // into the input that has just taken focus.
  const held = useRef<string | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) {
        if (held.current === event.key.toLowerCase()) event.preventDefault();
        return;
      }
      if (open.current && isPaletteChord(event, IS_MAC) && !event.defaultPrevented) {
        event.preventDefault();
        held.current = event.key.toLowerCase();
        setPaletteOpen(false);
        return;
      }
      const action = shortcutFor(event, { mac: IS_MAC, dialogOpen: dialogIsOpen(document) });
      if (action === null) return;
      event.preventDefault();
      held.current = event.key.toLowerCase();
      if (action === 'palette') setPaletteOpen(true);
      else openSheet();
    };
    // A Mac sends no keyup for `k` while ⌘ is down, so letting go of a modifier ends it as well.
    const onUp = (event: KeyboardEvent) => {
      if (['Meta', 'Control', 'Shift'].includes(event.key) || event.key.toLowerCase() === held.current) {
        held.current = null;
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onUp);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('keyup', onUp);
    };
  }, [setPaletteOpen, openSheet]);
}

export function Shell({
  path,
  user,
  nav,
  onSignOut,
  children,
}: {
  path: string;
  user: { displayName: string; email: string };
  nav: NavContext;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const wide = useWide();
  // Every link to a scoped page carries the scope in its href (FRM-T-17.4) — Home, Projects,
  // Findings, Search, the brand — so a new tab or a copied link keeps it; other links drop it.
  const { link } = useScope();
  const project = useProject(path);
  const code = project.status === 'known' ? project.code : null;
  const signals = useShellSignals(path, code);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const openSheet = useCallback(() => {
    setSheetOpen(true);
  }, []);
  useShortcuts(paletteOpen, setPaletteOpen, openSheet);

  // countLabel replaces a link's whole accessible name, so it says where the link goes as well.
  const criticals = needsYou(signals.criticals, (n) => `Findings, ${String(n)} open critical`);
  const countFor = (item: NavItem) => (item.to === FINDINGS.to ? criticals : {});

  const notFound = project.status === 'unknown' || routeFor(path).screen === 'not-found';
  const library = libraryItems(nav);
  const libraryRow = (
    <NavDisclosure
      name="library"
      label="Library"
      icon={<Library />}
      holdsCurrent={library.some((item) => item.current(path))}
    >
      {library.map((item) => (
        <NavRow key={item.to} item={item} path={path} />
      ))}
    </NavDisclosure>
  );
  const projectBlock =
    project.status === 'known' ? (
      <ProjectBlock code={project.code} name={project.name} path={path} unconfirmed={signals.unconfirmed} />
    ) : null;

  return (
    <AppShell
      storageKey="foreman.nav"
      brand={
        <>
          <AppShellBrand name="Foreman" href={link('/')} mark={<ForemanMark decorative className="fm-brand-mark" />} />
          <TopBarScope
            wide={wide}
            onSearch={() => {
              setPaletteOpen(true);
            }}
          />
        </>
      }
      nav={
        <>
          <ScopeSlot />
          {wide ? (
            <SideNav>
              {/* The console's own rows. Titled for a screen reader, which hears the group's name
                  before its links; a sighted reader has the space under the brand. */}
              <SideNavGroup title="Foreman" hideTitle>
                {globalItems(nav, code !== null).map((item) =>
                  item.to === SEARCH.to ? (
                    <SearchRow key={item.to} item={item} path={path} href={link(item.to)} />
                  ) : (
                    <NavRow key={item.to} item={item} path={path} href={link(item.to)} {...countFor(item)} />
                  ),
                )}
                {libraryRow}
              </SideNavGroup>
              {projectBlock}
            </SideNav>
          ) : (
            // On a phone the tab bar carries Home, Projects, Findings and Search, so the drawer is
            // what it does not: the project's rows, then the Library.
            <SideNav>
              {projectBlock}
              <SideNavGroup title="Foreman" hideTitle>
                {libraryRow}
              </SideNavGroup>
            </SideNav>
          )}
        </>
      }
      footer={
        <>
          <HealthLine health={signals.health} />
          <AccountMenu name={user.displayName} detail={user.email}>
            <MenuItem
              onSelect={() => {
                navigate('/tokens');
              }}
            >
              Connect an agent
            </MenuItem>
            <ThemeSwitch label="Theme" />
            <MenuSeparator />
            <MenuItem tone="danger" onSelect={onSignOut}>
              Sign out
            </MenuItem>
          </AccountMenu>
        </>
      }
    >
      {notFound ? (
        <NotFound path={path} code={project.status === 'unknown' ? project.code : null} />
      ) : (
        <>
          {project.status === 'known' && isRecordPage(path) ? (
            <RecordTrail code={project.code} name={project.name} end={recordTrailEnd(path)} />
          ) : null}
          {children}
        </>
      )}
      {wide ? null : (
        <>
          {/* The bar is fixed to the screen's foot; this keeps the page's last line clear of it. */}
          <div className="fm-tabbar-clear" aria-hidden="true" />
          {/* A tab is a plain link: the router's document-level click handler takes it, as it
              takes every other anchor in the console, so the page does not reload. Its href
              carries the scope to a scoped page. */}
          <TabBar aria-label="Primary" className="fm-tabbar">
            {tabBarItems(nav, code).map((item) => (
              <TabBar.Item
                key={item.to}
                href={link(item.to)}
                icon={<item.Icon />}
                label={item.label}
                current={item.current(path)}
                {...countFor(item)}
              />
            ))}
          </TabBar>
        </>
      )}
      {/* Dialogs, portalled to the body: here only so they live and die with the shell. */}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} nav={nav} />
      <ShortcutSheet open={sheetOpen} onOpenChange={setSheetOpen} />
    </AppShell>
  );
}

/**
 * The head of the sidebar, under the brand: the group scope ("D3 Cloud ▾", FRM-T-17.4) — and, when
 * it comes, the project switcher ("BND Bindery ▾") of FRM-DA-001. It is in the drawer too, so a
 * phone gets the same switcher as well as the top bar's chip.
 */
function ScopeSlot(): ReactNode {
  return (
    <div className="fm-scope-slot">
      <ScopeSwitcher presentation="menu" />
    </div>
  );
}

/**
 * The phone's top bar, beside the brand: the scope chip, opening its bottom sheet (FRM-T-17.4), and
 * a search button opening the command palette full-screen (FRM-T-18.5) — a 44px target, since a
 * phone has no ⌘K. The brand is drawn in the top bar and again at the head of the drawer; the drawer
 * already has the sidebar's switcher, so both stand in the top bar only.
 */
function TopBarScope({ wide, onSearch }: { wide: boolean; onSearch: () => void }): ReactNode {
  const { drawer } = useAppShell();
  if (wide || drawer) return null;
  return (
    <div className="fm-topbar-tools">
      <div className="fm-scope-topbar">
        <ScopeSwitcher presentation="sheet" />
      </div>
      <button type="button" className="fm-topbar-search" aria-label="Search" aria-haspopup="dialog" onClick={onSearch}>
        <SearchIcon aria-hidden="true" />
      </button>
    </div>
  );
}

function NavRow({
  item,
  path,
  href,
  count,
  countLabel,
}: {
  item: NavItem;
  path: string;
  /** Where it goes, when that is not just `item.to` — a scoped page keeps the scope. */
  href?: string;
  count?: number;
  countLabel?: string;
}) {
  return (
    <SideNavItem
      href={href ?? item.to}
      icon={<item.Icon />}
      label={item.label}
      current={item.current(path)}
      {...(count === undefined ? {} : { count })}
      {...(countLabel === undefined ? {} : { countLabel })}
    />
  );
}

/**
 * Search, with its key hint drawn after the label. `SideNavItem` takes a string label, so the hint
 * is the link's own generated content (`fm-kbd`), with empty alternative text: the key is announced
 * once, by `aria-keyshortcuts`, rather than read out as part of the link's name.
 */
function SearchRow({ item, path, href }: { item: NavItem; path: string; href: string }) {
  return (
    <SideNavItem asChild icon={<item.Icon />} label={item.label} current={item.current(path)}>
      <a
        href={href}
        className="fm-kbd"
        data-kbd={IS_MAC ? '⌘K' : 'Ctrl K'}
        aria-keyshortcuts={IS_MAC ? 'Meta+K' : 'Control+K'}
      />
    </SideNavItem>
  );
}

const SECTION_ICONS: Record<string, ReactNode> = {
  phases: <CalendarRange />,
  requirements: <ListTodo />,
  'scope-of-work': <SquareStack />,
  register: <Table2 />,
  documents: <FileStack />,
  adrs: <ScrollText />,
  risks: <ShieldAlert />,
  glossary: <BookText />,
  ideas: <Lightbulb />,
  activity: <GitBranch />,
  audits: <ListChecks />,
  drift: <Radar />,
  screens: <MonitorSmartphone />,
};

/**
 * The project you are in — and nothing when you are not in one.
 *
 * Six rows always shown, the reality half first: Overview, Drift, Phases, Requirements, Activity,
 * Audits. Everything you look things up in — documents, decisions, risks, the glossary, ideas,
 * screens, and the two generated registers — sits behind one Knowledge row, which opens itself on
 * any of those pages. It was 14 rows under three headings, with Drift 21st of 22 and below the fold
 * of a 900px laptop (FRM-DA-001).
 *
 * Activity carries the one count a project has: attributions waiting for someone to confirm or
 * reject them. Drift's total is not a count here: it never reaches zero, and the overview shows it.
 */
function ProjectBlock({
  code,
  name,
  path,
  unconfirmed,
}: {
  code: string;
  name: string;
  path: string;
  unconfirmed: number | null;
}) {
  const current = currentSectionSlug(path);
  const row = (slug: string) => {
    const s = section(slug);
    return (
      <SideNavItem
        key={slug}
        href={`/projects/${code}/${slug}`}
        icon={SECTION_ICONS[slug]}
        label={s.label}
        current={current === slug}
        {...(slug === 'activity' ? needsYou(unconfirmed, (n) => `Activity, ${String(n)} waiting for review`) : {})}
      />
    );
  };

  return (
    <SideNavGroup title={name}>
      <SideNavItem
        href={`/projects/${code}`}
        icon={<LayoutDashboard />}
        label="Overview"
        current={path === `/projects/${code}`}
      />
      {PROJECT_ROWS.map(row)}
      <NavDisclosure
        name="knowledge"
        label="Knowledge"
        icon={<BookMarked />}
        holdsCurrent={current !== null && KNOWLEDGE_ROWS.includes(current)}
      >
        {KNOWLEDGE_ROWS.map(row)}
      </NavDisclosure>
    </SideNavGroup>
  );
}

/**
 * The trail on a flat record page — a requirement, task or finding — whose project comes from its
 * ID's prefix (FRM-ADR-025). Those screens draw no trail of their own, so before this the only way
 * back to the project from `/requirements/BND-REQ-001` was a three-letter link inside a card.
 * It reads as the project screens' trail does: Projects, the project, then the section the record
 * belongs to — Findings for a finding, whose own page no longer draws a second trail.
 */
function RecordTrail({
  code,
  name,
  end,
}: {
  code: string;
  name: string;
  end: { label: string; href: string } | null;
}) {
  return (
    <nav aria-label="Breadcrumb" className="fm-trail">
      <ol role="list" className="fm-trail__list">
        <li>
          <a href="/projects">Projects</a>
        </li>
        <li>
          <a href={`/projects/${code}`}>{name}</a>
        </li>
        {end === null ? null : (
          <li>
            <a href={end.href}>{end.label}</a>
          </li>
        )}
      </ol>
    </nav>
  );
}
