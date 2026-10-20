import { useSyncExternalStore, type ReactNode } from 'react';
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
} from '@d3cloud/ui';
import {
  BookText,
  CalendarRange,
  FileStack,
  GitBranch,
  Home as HomeIcon,
  Lightbulb,
  ListChecks,
  ListTodo,
  MonitorSmartphone,
  Radar,
  ScrollText,
  ShieldAlert,
  SquareStack,
  Table2,
} from 'lucide-react';
import { ForemanMark } from '../brand/ForemanMark';
import { navItems, settingsItems, tabBarItems, type NavContext } from '../lib/nav';
import { briefFor, projectCodeFor, SECTIONS } from '../lib/project';
import { useAsync } from '../lib/useAsync';

/**
 * The signed-in frame: the design system's recessed AppShell (FRM-REQ-217), composed the way
 * Shipyard's is. The navigation sinks to the ground and each screen is a sheet laid on it, with
 * every Section a card on the sheet.
 *
 * - **From `lg` (1024px)** a sidebar: the console's own destinations, then the sections of the
 *   project you are in.
 * - **Below it** a top bar whose menu button opens the same sidebar as a drawer, and a bottom tab
 *   bar of five destinations. `lib/nav.ts` says which five and why the drawer keeps everything.
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

  return (
    <AppShell
      storageKey="foreman.nav"
      navTone="recessed"
      brand={<AppShellBrand name="Foreman" href="/" mark={<ForemanMark decorative className="fm-brand-mark" />} />}
      nav={
        <SideNav>
          {navItems(nav).map((item) => (
            <SideNavItem
              key={item.to}
              href={item.to}
              icon={<item.Icon />}
              label={item.label}
              current={item.current(path)}
            />
          ))}
          <ProjectSections path={path} />
          <SideNavGroup title="Settings">
            {settingsItems(nav).map((item) => (
              <SideNavItem
                key={item.to}
                href={item.to}
                icon={<item.Icon />}
                label={item.label}
                current={item.current(path)}
              />
            ))}
          </SideNavGroup>
        </SideNav>
      }
      footer={
        <AccountMenu name={user.displayName} detail={user.email}>
          <ThemeSwitch />
          <MenuSeparator />
          <MenuItem tone="danger" onSelect={onSignOut}>
            Sign out
          </MenuItem>
        </AccountMenu>
      }
    >
      {children}
      {wide ? null : (
        <>
          {/* The bar is fixed to the screen's foot; this keeps the page's last line clear of it. */}
          <div className="fm-tabbar-clear" aria-hidden="true" />
          {/* A tab is a plain link: the router's document-level click handler takes it, as it
              takes every other anchor in the console, so the page does not reload. */}
          <TabBar aria-label="Primary" className="fm-tabbar">
            {tabBarItems(path, nav).map((item) => (
              <TabBar.Item
                key={item.to}
                href={item.to}
                icon={<item.Icon />}
                label={item.label}
                current={item.current(path)}
              />
            ))}
          </TabBar>
        </>
      )}
    </AppShell>
  );
}

/**
 * The sections of the project you are currently in — and nothing when you are not in one.
 *
 * This replaced a list of every project, which had two problems: it grew without bound (nine
 * projects today, and the sidebar is the one surface that cannot scroll away), and it offered the
 * one destination you already had while offering nothing from inside a project. Two clicks into
 * `/projects/BND/adrs` the sidebar showed you ten other projects and no way to Bindery's phases.
 *
 * Grouped the way the tool thinks: what was planned, what was decided, and what is actually there.
 */
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

function ProjectSections({ path }: { path: string }) {
  const code = projectCodeFor(path);
  const { state } = useAsync(
    () => (code === null ? Promise.resolve(null) : briefFor(code)),
    [code],
  );

  if (code === null) return null;

  // The code until the name arrives. A group title that appears a beat late shifts every item
  // under it, which is worse than a title that is briefly terse.
  const name = state.status === 'ready' && state.value !== null ? state.value.project.name : code;
  const groups = ['Plan', 'Knowledge', 'Reality'] as const;

  return (
    <>
      <SideNavGroup title={name}>
        <SideNavItem
          href={`/projects/${code}`}
          icon={<HomeIcon />}
          label="Overview"
          current={path === `/projects/${code}`}
        />
      </SideNavGroup>
      {groups.map((group) => (
        <SideNavGroup key={group} title={group}>
          {SECTIONS.filter((section) => section.group === group).map((section) => (
            <SideNavItem
              key={section.slug}
              href={`/projects/${code}/${section.slug}`}
              icon={SECTION_ICONS[section.slug]}
              label={section.label}
              current={path.startsWith(`/projects/${code}/${section.slug}`)}
            />
          ))}
        </SideNavGroup>
      ))}
    </>
  );
}
