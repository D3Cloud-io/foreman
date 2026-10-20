import {
  Compass,
  FolderKanban,
  FolderOpen,
  Home as HomeIcon,
  Lightbulb,
  ListChecks,
  PlugZap,
  Search,
  Users,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

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

// "Home" since FRM-T-17.3: it is the portfolio by family now, not a wall of charts.
const HOME: NavItem = { to: '/', label: 'Home', Icon: HomeIcon, current: (path) => path === '/' };
const PROJECTS: NavItem = { to: '/projects', label: 'Projects', Icon: FolderKanban, current: (path) => path === '/projects' };
export const FINDINGS: NavItem = { to: '/findings', label: 'Findings', Icon: ListChecks, current: owns('/findings') };
export const SEARCH: NavItem = { to: '/search', label: 'Search', Icon: Search, current: (path) => path === '/search' };

function projectIdeas(ctx: NavContext): NavItem {
  return {
    to: '/project-ideas',
    label: ctx.board ? 'Submissions' : 'Project ideas',
    Icon: Lightbulb,
    current: owns('/project-ideas'),
  };
}

const GUIDELINES: NavItem = { to: '/guidelines', label: 'Guidelines', Icon: Compass, current: (path) => path === '/guidelines' };
const GROUPS: NavItem = { to: '/groups', label: 'Groups', Icon: UsersRound, current: owns('/groups') };
const MEMBERS: NavItem = { to: '/members', label: 'Members', Icon: Users, current: (path) => path === '/members' };
/**
 * The API tokens screen, under the name of what a person goes there to do (D-09): an agent reaches
 * Foreman over MCP with a token minted here. It is in the Library and in the account menu, not a
 * row of its own — it is set up once, then forgotten (FRM-ADR-025).
 */
export const CONNECT_AN_AGENT: NavItem = {
  to: '/tokens',
  label: 'Connect an agent',
  Icon: PlugZap,
  current: (path) => path === '/tokens',
};

/**
 * The console's own destinations at the top of the sidebar: what a person reaches for every day.
 *
 * Inside a project this is three rows — Home, Findings, Search — so the project's own rows fit a
 * 900px-tall laptop with Drift above the fold (FRM-ADR-025, FRM-DA-001). Projects drops out there:
 * the trail on every project page climbs back to it, and the scope switcher at the head of the
 * sidebar (FRM-T-17.4) is the way across to another project. Outside a project it is back, second.
 *
 * A fund board has submissions, not a portfolio, so Submissions takes Projects' place there.
 */
export function globalItems(ctx: NavContext, inProject: boolean): readonly NavItem[] {
  const second = ctx.board ? [projectIdeas(ctx)] : inProject ? [] : [PROJECTS];
  return [HOME, ...second, FINDINGS, SEARCH];
}

/**
 * The Library: destinations reached now and then rather than daily — project ideas, the
 * guidelines, how projects are grouped, and connecting an agent. One row while closed (FRM-DA-001).
 *
 * Health is not here: it is the status line in the sidebar's footer, which says whether it needs a
 * look without being opened. Groups order a portfolio and guidelines govern one, which a fund
 * board does not have; its admin's Members screen lives here instead.
 */
export function libraryItems(ctx: NavContext): readonly NavItem[] {
  if (ctx.board) return [...(ctx.admin ? [MEMBERS] : []), CONNECT_AN_AGENT];
  return [projectIdeas(ctx), GUIDELINES, GROUPS, CONNECT_AN_AGENT];
}

/**
 * The phone's tab bar: at most five destinations (FRM-REQ-217, D-088).
 *
 * - **Four** a person reaches for from anywhere — Home, Projects (Submissions on a board),
 *   Findings and Search.
 * - **A fifth that follows where they are**: the project they are in, labelled by its code, so its
 *   overview is one tap from any of its pages — a requirement, task or finding included, whose
 *   project comes from its ID's prefix (FRM-ADR-008). Outside a project, Project ideas (Members for
 *   a board's admin).
 *
 * `code` is the project the shell has resolved, not whatever the URL claims: an unknown code gets
 * no tab, so `/projects/ZZZ` does not grow a "ZZZ" tab beside its not-found page.
 *
 * The drawer behind the top bar's menu button holds what the bar does not: the project's rows and
 * the Library. A "More" tab was the textbook fifth slot, but AppShell owns the drawer's open state
 * and TabBar.Item is always a link, so it would have been a second control for one thing.
 */
export function tabBarItems(ctx: NavContext, code: string | null): readonly NavItem[] {
  const items: NavItem[] = [HOME, ctx.board ? projectIdeas(ctx) : PROJECTS, FINDINGS, SEARCH];
  if (code !== null) {
    items.push({ to: `/projects/${code}`, label: code, Icon: FolderOpen, current: () => true });
  } else if (!ctx.board) {
    items.push(projectIdeas(ctx));
  } else if (ctx.admin) {
    items.push(MEMBERS);
  }
  return items;
}
