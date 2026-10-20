import {
  Activity as ActivityIcon,
  Compass,
  FolderKanban,
  FolderOpen,
  Home as HomeIcon,
  KeyRound,
  Lightbulb,
  ListChecks,
  Search,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { projectCodeFor } from './project';

/** One destination of the console's own: the same list feeds the sidebar and the tab bar. */
export interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly Icon: LucideIcon;
  /** Whether `path` is this destination, or a page that belongs to it. */
  readonly current: (path: string) => boolean;
}

/** Who is looking, which decides what the console offers (ADR-016). */
export interface NavContext {
  /** `board` is the innovation-fund deployment: submissions, not a portfolio. */
  readonly board: boolean;
  readonly admin: boolean;
}

const owns = (prefix: string) => (path: string) => path === prefix || path.startsWith(`${prefix}/`);

const DASHBOARD: NavItem = { to: '/', label: 'Dashboard', Icon: HomeIcon, current: (path) => path === '/' };
const PROJECTS: NavItem = { to: '/projects', label: 'Projects', Icon: FolderKanban, current: (path) => path === '/projects' };
const FINDINGS: NavItem = { to: '/findings', label: 'Findings', Icon: ListChecks, current: owns('/findings') };
const SEARCH: NavItem = { to: '/search', label: 'Search', Icon: Search, current: (path) => path === '/search' };

function projectIdeas(ctx: NavContext): NavItem {
  return {
    to: '/project-ideas',
    label: ctx.board ? 'Submissions' : 'Project ideas',
    Icon: Lightbulb,
    current: owns('/project-ideas'),
  };
}

const MEMBERS: NavItem = { to: '/members', label: 'Members', Icon: Users, current: (path) => path === '/members' };

/**
 * The console's own destinations, in sidebar order: a fixed set that does not grow with the data.
 * The project list used to live in the sidebar and would have been unusable at twenty projects —
 * it is a screen of its own now, and project ideas sit beside it because they are what becomes one.
 *
 * A fund board has submissions, not a portfolio. The ledger's screens are still reachable by URL —
 * the data is the same shape — but leading with them would describe a product nobody there uses.
 */
export function navItems(ctx: NavContext): readonly NavItem[] {
  return [
    DASHBOARD,
    ...(ctx.board ? [] : [PROJECTS]),
    projectIdeas(ctx),
    ...(ctx.board ? [] : [{ to: '/guidelines', label: 'Guidelines', Icon: Compass, current: (path: string) => path === '/guidelines' }]),
    ...(ctx.board && ctx.admin ? [MEMBERS] : []),
    FINDINGS,
    SEARCH,
    { to: '/system', label: 'Health', Icon: ActivityIcon, current: (path) => path === '/system' },
    { to: '/tokens', label: 'API tokens', Icon: KeyRound, current: (path) => path === '/tokens' },
  ];
}

/**
 * The phone's tab bar: at most five destinations (FRM-REQ-217, D-088).
 *
 * The sidebar holds eight of the console's own destinations and, inside a project, fourteen more —
 * twenty-two links that cannot sit under a thumb. So below `lg` the console splits them the way
 * Shipyard does, with one difference Shipyard does not need:
 *
 * - **The tab bar** carries the four a person reaches for from anywhere — Dashboard, Projects
 *   (Submissions on a board), Findings and Search — and a fifth that follows where they are:
 *   **the project they are in**, labelled by its code, so its overview is one tap from any of its
 *   sections; outside a project, **Project ideas** (Members for a board's admin).
 * - **The drawer** behind the top bar's menu button keeps the whole sidebar: every global
 *   destination and the current project's sections. Shipyard's three destinations all fit the
 *   bar, so its drawer is down to the account menu; Foreman's do not, and a destination that is
 *   only on a laptop is a destination a phone cannot reach. The drawer is also where the account
 *   menu, the theme and Sign out live on a phone.
 *
 * A "More" tab that opened the drawer would have been the textbook fifth slot, but AppShell owns
 * the drawer's open state and offers no way to open it from outside, and TabBar.Item is always a
 * link. A tab that duplicated the menu button would have been a second control for one thing.
 */
export function tabBarItems(path: string, ctx: NavContext): readonly NavItem[] {
  const items: NavItem[] = [DASHBOARD, ctx.board ? projectIdeas(ctx) : PROJECTS, FINDINGS, SEARCH];
  const code = projectCodeFor(path);
  if (code !== null) {
    items.push({ to: `/projects/${code}`, label: code, Icon: FolderOpen, current: owns(`/projects/${code}`) });
  } else if (!ctx.board) {
    items.push(projectIdeas(ctx));
  } else if (ctx.admin) {
    items.push(MEMBERS);
  }
  return items;
}
