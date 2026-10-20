import { describe, expect, it } from 'vitest';
import type { GuidelineRow, PortfolioGroup, PortfolioResponse, PortfolioRow } from './api';
import {
  ACCENTS,
  accentColor,
  applicableGuidelines,
  describeChange,
  guidelineChange,
  listJoin,
  moveBy,
  portfolioSections,
  sectionSummary,
  siteLabel,
} from './groups';
import { navItems, settingsItems } from './nav';
import { routeFor } from './router';

/** FRM-T-17.3: the rules the Groups screens share, written once. */

describe('accents', () => {
  it('maps every accent the API can send to a design-system token, never a literal', () => {
    const values = ['foreman', 'shipyard', 'auth', 'bindery', 'ui', 'clearwhen', 'qr', 'floorspec', 'neutral'] as const;
    for (const accent of values) {
      expect(accentColor(accent)).toMatch(/^var\(--color-[a-z0-9-]+\)$/);
    }
    expect(ACCENTS.map((entry) => entry.value).sort()).toEqual([...values].sort());
  });

  it('paints neutral as the muted text colour', () => {
    expect(accentColor('neutral')).toBe('var(--color-fg-muted)');
  });
});

describe('the guideline consequence of a move', () => {
  const all = ['GL-001', 'GL-002', 'GL-003', 'GL-005'];
  const d3 = [...all, 'GL-004', 'GL-006'];

  it('names what stops applying and what still does, D3 Cloud → Dormice (17.05)', () => {
    const change = guidelineChange([d3], all);
    expect(change).toEqual({ stop: ['GL-004', 'GL-006'], start: [], keep: all });
    expect(describeChange(change, ['KURO', 'BURR'])).toBe(
      'GL-004 and GL-006 stop applying to KURO and BURR. GL-001, GL-002, GL-003 and GL-005 still apply.',
    );
  });

  it('names what starts applying when a project joins the group with more', () => {
    const change = guidelineChange([all], d3);
    expect(change.start).toEqual(['GL-004', 'GL-006']);
    expect(change.stop).toEqual([]);
    expect(describeChange(change, ['PW'])).toBe(
      'GL-004 and GL-006 start applying to PW. GL-001, GL-002, GL-003 and GL-005 still apply.',
    );
  });

  it('unions the changes across projects leaving different groups, and keeps only what every one had', () => {
    const change = guidelineChange([d3, ['GL-001', 'GL-009']], all);
    expect(change.stop).toEqual(['GL-004', 'GL-006', 'GL-009']);
    expect(change.start).toEqual(['GL-002', 'GL-003', 'GL-005']);
    expect(change.keep).toEqual(['GL-001']);
  });

  it('is no change when the target is where they already are', () => {
    expect(guidelineChange([d3], d3)).toEqual({ stop: [], start: [], keep: [...d3].sort((a, b) => a.localeCompare(b)) });
  });

  it('sorts by number, so GL-010 comes after GL-009', () => {
    expect(guidelineChange([['GL-010', 'GL-009']], []).stop).toEqual(['GL-009', 'GL-010']);
  });
});

describe('applicable guidelines', () => {
  const row = (humanId: string, appliesTo: 'all' | 'groups', groups: string[] = [], status: 'active' | 'retired' = 'active'): GuidelineRow => ({
    id: humanId,
    humanId,
    title: humanId,
    area: 'Process',
    decision: '',
    rationale: null,
    guidance: null,
    status,
    appliesTo,
    groups,
    createdAt: '',
    updatedAt: '',
  });
  const rows = [row('GL-004', 'groups', ['GRP-001']), row('GL-001', 'all'), row('GL-007', 'all', [], 'retired')];

  it('gives a group its own and every all-project guideline, active only', () => {
    expect(applicableGuidelines(rows, 'GRP-001').map((r) => r.humanId)).toEqual(['GL-001', 'GL-004']);
  });

  it('gives the ungrouped only the all-project ones', () => {
    expect(applicableGuidelines(rows, null).map((r) => r.humanId)).toEqual(['GL-001']);
  });
});

describe('sections', () => {
  const row = (code: string): PortfolioRow => ({
    code,
    name: code,
    lifecycle: 'building',
    phase: null,
    tasks: { open: 0, blocked: 0, done: 0, cancelled: 0 },
    openCriticals: 0,
    ci: { conclusion: null, unknown: true },
    unconfirmedAttributions: 0,
    drift: {
      counts: { 'coverage-hole': 0, 'stale-task': 0, 'fired-tripwire': 0, 'failed-exit-gate': 0, 'orphan-adr': 0, 'screen-drift': 0 },
      total: 2,
    },
    lastActivityAt: null,
    group: null,
  });
  const group = (humanId: string, name: string, codes: string[]): PortfolioGroup => ({
    humanId,
    name,
    slug: name.toLowerCase(),
    accent: 'neutral',
    siteUrl: null,
    projects: codes.map(row),
  });
  const portfolio: PortfolioResponse = {
    items: [],
    nextCursor: null,
    total: 0,
    groups: [group('GRP-001', 'D3 Cloud', ['FRM']), group('GRP-002', 'Dormice', ['KURO', 'BURR'])],
    ungrouped: { humanId: null, name: 'Ungrouped', slug: 'ungrouped', projects: [row('PW')] },
  };

  it('keeps the server’s group order and each group’s own order, Ungrouped last (FRM-REQ-224)', () => {
    const sections = portfolioSections(portfolio);
    expect(sections.map((s) => s.name)).toEqual(['D3 Cloud', 'Dormice', 'Ungrouped']);
    expect(sections[1]?.rows.map((r) => r.code)).toEqual(['KURO', 'BURR']);
    expect(sections.at(-1)?.group).toBeNull();
  });

  it('joins descriptions by ID, and does without them', () => {
    const sections = portfolioSections(portfolio, new Map([['GRP-002', 'A burrow for pointless projects']]));
    expect(sections[1]?.group?.description).toBe('A burrow for pointless projects');
    expect(sections[0]?.group?.description).toBeNull();
  });

  it('has no Ungrouped section when narrowed to a group', () => {
    expect(portfolioSections({ ...portfolio, ungrouped: null }).map((s) => s.name)).toEqual(['D3 Cloud', 'Dormice']);
  });

  it('sums a heading’s figures from its rows', () => {
    expect(sectionSummary(portfolio.groups[1]?.projects ?? [])).toBe('2 projects · 2 building · 4 drift');
  });
});

describe('small helpers', () => {
  it('joins lists the way the screens say them', () => {
    expect(listJoin([])).toBe('');
    expect(listJoin(['KURO'])).toBe('KURO');
    expect(listJoin(['KURO', 'BURR'])).toBe('KURO and BURR');
    expect(listJoin(['A', 'B', 'C'])).toBe('A, B and C');
  });

  it('moves one place, and not past an end', () => {
    expect(moveBy(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveBy(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveBy(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveBy(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });

  it('shows a site as its host', () => {
    expect(siteLabel('https://dormice.ai/')).toBe('dormice.ai');
    expect(siteLabel('https://d3cloud.io/fixes')).toBe('d3cloud.io/fixes');
  });
});

describe('where groups live in the console', () => {
  it('routes the list and one group by its slug', () => {
    expect(routeFor('/groups')).toEqual({ screen: 'groups' });
    expect(routeFor('/groups/dormice')).toEqual({ screen: 'group', humanId: 'dormice' });
    expect(routeFor('/groups/dormice/extra').screen).toBe('not-found');
  });

  it('puts Groups first under Settings, and not on a fund board', () => {
    expect(settingsItems({ board: false, admin: true }).map((item) => item.label)).toEqual(['Groups', 'Health', 'API tokens']);
    expect(settingsItems({ board: true, admin: true }).map((item) => item.label)).toEqual(['Health', 'API tokens']);
    expect(navItems({ board: false, admin: true }).map((item) => item.label)).toEqual([
      'Home',
      'Projects',
      'Findings',
      'Project ideas',
      'Guidelines',
      'Search',
    ]);
  });
});
