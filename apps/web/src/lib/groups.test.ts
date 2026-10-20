import type { GroupListing, GroupWithProjects } from '@foreman/shared';
import { describe, expect, it } from 'vitest';
import type { GuidelineRow } from './api';
import {
  ACCENTS,
  accentColor,
  applicableGuidelines,
  describeChange,
  guidelineChange,
  listJoin,
  moveBy,
  sectionsOf,
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
  const group = (humanId: string, name: string, position: number, codes: string[]): GroupWithProjects => ({
    id: humanId,
    humanId,
    name,
    slug: name.toLowerCase(),
    description: null,
    siteUrl: null,
    accent: 'neutral',
    position,
    createdAt: '',
    updatedAt: '',
    projects: codes.map((code, index) => ({ code, name: code, slug: code, lifecycle: 'building', pitch: null, position: index })),
    counts: { projects: codes.length, guidelines: 0 },
  });
  const listing: GroupListing = {
    // Out of order on purpose: the position decides, not the array.
    items: [group('GRP-002', 'Dormice', 1, ['KURO', 'BURR']), group('GRP-001', 'D3 Cloud', 0, ['FRM'])],
    ungrouped: {
      humanId: null,
      name: 'Ungrouped',
      slug: 'ungrouped',
      projects: [{ code: 'PW', name: 'PW', slug: 'pw', lifecycle: 'planned', pitch: null, position: 0 }],
      counts: { projects: 1 },
    },
    total: 2,
  };
  const rows = ['BURR', 'FRM', 'KURO', 'NEW', 'PW'].map((code) => ({ code }));

  it('puts the groups in their order, each in its own order, and Ungrouped last (FRM-REQ-224)', () => {
    const sections = sectionsOf(listing, rows);
    expect(sections.map((s) => s.name)).toEqual(['D3 Cloud', 'Dormice', 'Ungrouped']);
    expect(sections[1]?.rows.map((r) => r.code)).toEqual(['KURO', 'BURR']);
  });

  it('keeps a project the listing does not know yet, in Ungrouped, rather than dropping it', () => {
    expect(sectionsOf(listing, rows).at(-1)?.rows.map((r) => r.code)).toEqual(['PW', 'NEW']);
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
