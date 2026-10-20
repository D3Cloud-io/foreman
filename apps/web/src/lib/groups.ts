import type { GroupAccent, GroupListing } from '@foreman/shared';
import type { GuidelineRow, PortfolioResponse, PortfolioRow } from './api';

/**
 * Groups, as the console reasons about them (FRM-ADR-024): the families one Foreman holds.
 *
 * Everything here is a pure function over what the API already answered, so the rules — which
 * colour an accent is, which guidelines a move changes, what order Home's sections come in — are
 * written once and tested once, rather than re-derived by each screen that shows a group.
 */

/**
 * The accents a group may take, in the order the board's editor draws them (17.08).
 *
 * The board names the Design Language's Brand variables (`product/foreman`, `product/shipyard`…),
 * but `@d3cloud/ui` 1.7 ships no product palette as CSS: its runtime tokens stop at the semantic
 * set and the six avatar tints. So each accent is mapped onto the nearest runtime token — the
 * avatar foregrounds are the library's categorical hues, legible as a dot on both themes — and
 * where there are more accents than hues two share one. That is safe only because **an accent is
 * never the only signal**: the group's name is printed beside every dot, everywhere.
 */
export const ACCENTS: readonly { value: GroupAccent; label: string; color: string }[] = [
  { value: 'foreman', label: 'Foreman', color: 'var(--color-avatar-2-fg)' },
  { value: 'shipyard', label: 'Shipyard', color: 'var(--color-avatar-3-fg)' },
  { value: 'auth', label: 'D3 Auth', color: 'var(--color-accent)' },
  { value: 'bindery', label: 'Bindery', color: 'var(--color-avatar-6-fg)' },
  { value: 'clearwhen', label: 'Clearwhen', color: 'var(--color-avatar-5-fg)' },
  { value: 'qr', label: 'QR', color: 'var(--color-info)' },
  { value: 'floorspec', label: 'Floorspec', color: 'var(--color-success)' },
  { value: 'ui', label: 'D3 UI', color: 'var(--color-avatar-1-fg)' },
  { value: 'neutral', label: 'Neutral', color: 'var(--color-fg-muted)' },
];

/** The CSS colour an accent paints with — always a token, never a literal. */
export function accentColor(accent: GroupAccent): string {
  return ACCENTS.find((entry) => entry.value === accent)?.color ?? 'var(--color-fg-muted)';
}

export function accentLabel(accent: GroupAccent): string {
  return ACCENTS.find((entry) => entry.value === accent)?.label ?? 'Neutral';
}

/** "A", "A and B", "A, B and C" — how every list of codes on these screens reads. */
export function listJoin(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/** `GL-004` sorts before `GL-010`: by number, not by string. */
function byGuidelineNumber(a: string, b: string): number {
  const n = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? 0);
  return n(a) - n(b) || a.localeCompare(b);
}

/** What a move does to the guidelines that apply, worked out before it happens (17.05). */
export interface GuidelineChange {
  /** Applied to at least one moving project before, and not after. */
  readonly stop: readonly string[];
  /** Applies after, and did not before to at least one moving project. */
  readonly start: readonly string[];
  /** Applied before to every moving project, and still does. */
  readonly keep: readonly string[];
}

/**
 * The guideline consequence of moving projects out of their groups into `target`.
 *
 * `sources` is the set of guidelines that applied to each group a moving project leaves — one entry
 * per distinct source, the ungrouped included. Projects already in the target contribute a source
 * equal to it, which changes nothing, as it should.
 */
export function guidelineChange(
  sources: readonly (readonly string[])[],
  target: readonly string[],
): GuidelineChange {
  const after = new Set(target);
  const stop = new Set<string>();
  const start = new Set<string>();
  for (const source of sources) {
    const before = new Set(source);
    for (const id of before) if (!after.has(id)) stop.add(id);
    for (const id of after) if (!before.has(id)) start.add(id);
  }
  const keep = target.filter((id) => sources.every((source) => source.includes(id)));
  return {
    stop: [...stop].sort(byGuidelineNumber),
    start: [...start].sort(byGuidelineNumber),
    keep: [...new Set(keep)].sort(byGuidelineNumber),
  };
}

export function changes(change: GuidelineChange): boolean {
  return change.stop.length > 0 || change.start.length > 0;
}

/** The sentence the Move dialog shows under its warning. */
export function describeChange(change: GuidelineChange, codes: readonly string[]): string {
  const who = listJoin(codes);
  const parts: string[] = [];
  if (change.stop.length > 0) {
    parts.push(`${listJoin(change.stop)} ${change.stop.length === 1 ? 'stops' : 'stop'} applying to ${who}.`);
  }
  if (change.start.length > 0) {
    parts.push(`${listJoin(change.start)} ${change.start.length === 1 ? 'starts' : 'start'} applying to ${who}.`);
  }
  if (change.keep.length > 0) {
    parts.push(`${listJoin(change.keep)} still ${change.keep.length === 1 ? 'applies' : 'apply'}.`);
  }
  return parts.length === 0 ? 'No guideline applies before or after.' : parts.join(' ');
}

/** The active guidelines that apply to a group, or to the ungrouped (`null`) — by ID, in order. */
export function applicableGuidelines(
  guidelines: readonly GuidelineRow[],
  groupHumanId: string | null,
): GuidelineRow[] {
  return guidelines
    .filter((row) => row.status === 'active')
    .filter(
      (row) =>
        row.appliesTo === 'all' || (groupHumanId !== null && row.groups.includes(groupHumanId)),
    )
    .sort((a, b) => byGuidelineNumber(a.humanId, b.humanId));
}

/** A group as a section heading needs it. `description` comes from `/api/groups`, when read. */
export interface SectionGroup {
  readonly humanId: string;
  readonly name: string;
  readonly slug: string;
  readonly accent: GroupAccent;
  readonly siteUrl: string | null;
  readonly description: string | null;
}

/** One section of Home or Projects: a group, or the ungrouped (`group: null`), with its rows. */
export interface Section<Row> {
  readonly key: string;
  readonly group: SectionGroup | null;
  readonly name: string;
  readonly rows: readonly Row[];
}

/**
 * Home's and Projects' sections, straight from the grouped portfolio (FRM-T-17.2): one per group
 * in the group order, each holding its rows in the group's own order, then the ungrouped last
 * (FRM-REQ-224). The server sections them, so the console never re-derives membership or order.
 *
 * The portfolio's groups carry no description, so it is joined from `/api/groups` by ID when that
 * has been read; a heading without one is still a heading.
 */
export function portfolioSections(
  portfolio: PortfolioResponse,
  descriptions: ReadonlyMap<string, string | null> = new Map(),
): Section<PortfolioRow>[] {
  const groups = portfolio.groups.map((group) => ({
    key: group.humanId,
    group: {
      humanId: group.humanId,
      name: group.name,
      slug: group.slug,
      accent: group.accent,
      siteUrl: group.siteUrl,
      description: descriptions.get(group.humanId) ?? null,
    },
    name: group.name,
    rows: group.projects,
  }));
  return portfolio.ungrouped === null
    ? groups
    : [...groups, { key: 'ungrouped', group: null, name: 'Ungrouped', rows: portfolio.ungrouped.projects }];
}

/** Each group's description, by ID, from a `/api/groups` listing. */
export function descriptionsOf(listing: GroupListing | null): Map<string, string | null> {
  return new Map((listing?.items ?? []).map((group) => [group.humanId, group.description]));
}

/** The figures a group's heading carries: "11 projects · 5 building · 139 drift". */
export function sectionSummary(rows: readonly PortfolioRow[]): string {
  const building = rows.filter((row) => row.lifecycle === 'building').length;
  const drift = rows.reduce((sum, row) => sum + row.drift.total, 0);
  const projects = `${String(rows.length)} ${rows.length === 1 ? 'project' : 'projects'}`;
  return `${projects} · ${String(building)} building · ${String(drift)} drift`;
}

/** `https://dormice.ai/` → `dormice.ai`: what a site link shows. */
export function siteLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}

/** A list with the item at `index` moved one place up (`-1`) or down (`+1`); unchanged at an end. */
export function moveBy<T>(items: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= items.length || to < 0 || to >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(index, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

// ─── Remembered per viewer ─────────────────────────────────────────────────

/**
 * Whether a Home section is collapsed, remembered per group in this browser. Storage can be absent
 * or throw (a private window, blocked site data), so every access is guarded and the default —
 * expanded — is what renders when it fails.
 */
const COLLAPSED = 'foreman.home.collapsed.';

export function readCollapsed(key: string): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED + key) === '1';
  } catch {
    return false;
  }
}

export function writeCollapsed(key: string, collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(COLLAPSED + key, '1');
    else window.localStorage.removeItem(COLLAPSED + key);
  } catch {
    // Not remembered, which is the cost of storage being unavailable — the section still toggles.
  }
}

const FIRST_RUN = 'foreman.home.groups-intro-dismissed';

export function readIntroDismissed(): boolean {
  try {
    return window.localStorage.getItem(FIRST_RUN) === '1';
  } catch {
    return false;
  }
}

export function writeIntroDismissed(): void {
  try {
    window.localStorage.setItem(FIRST_RUN, '1');
  } catch {
    // The card comes back next visit; nothing else is lost.
  }
}
