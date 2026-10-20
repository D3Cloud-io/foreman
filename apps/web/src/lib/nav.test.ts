import { describe, expect, it } from 'vitest';
import { needsYou } from '../components/shellSignals';
import { globalItems, libraryItems, tabBarItems } from './nav';
import { currentSectionSlug, isRecordPage, KNOWLEDGE_ROWS, PROJECT_ROWS, projectCodeFor, SECTIONS } from './project';

/** FRM-T-16.4: the shell's arrangement, from FRM-ADR-025 and FRM-DA-001. */
describe('the project a page belongs to', () => {
  it('is the path’s code inside a project', () => {
    expect(projectCodeFor('/projects/BND')).toBe('BND');
    expect(projectCodeFor('/projects/BND/drift')).toBe('BND');
    expect(projectCodeFor('/projects')).toBeNull();
  });

  it('is the ID’s prefix on a flat record page, with no route change', () => {
    expect(projectCodeFor('/requirements/BND-REQ-001')).toBe('BND');
    expect(projectCodeFor('/tasks/BND-T-1.2')).toBe('BND');
    expect(projectCodeFor('/findings/BND-CR-001')).toBe('BND');
    expect(isRecordPage('/requirements/BND-REQ-001')).toBe(true);
  });

  it('is nobody’s for the inbox, a codeless ID, or a path that is not a record', () => {
    expect(projectCodeFor('/findings')).toBeNull();
    expect(projectCodeFor('/project-ideas/PI-007')).toBeNull();
    expect(projectCodeFor('/requirements/PI-007')).toBeNull();
    expect(projectCodeFor('/requirements/not-an-id')).toBeNull();
    expect(projectCodeFor('/toString/BND-REQ-001')).toBeNull();
    expect(isRecordPage('/findings')).toBe(false);
  });

  it('names the section a record is a page of', () => {
    expect(currentSectionSlug('/requirements/BND-REQ-001')).toBe('requirements');
    expect(currentSectionSlug('/tasks/BND-T-1.2')).toBe('phases');
    expect(currentSectionSlug('/findings/BND-CR-001')).toBeNull();
    expect(currentSectionSlug('/projects/BND/adrs')).toBe('adrs');
    expect(currentSectionSlug('/projects/BND')).toBeNull();
  });
});

describe('the sidebar', () => {
  it('drops Projects inside a project, so its rows fit 900px', () => {
    const ctx = { board: false, admin: true };
    expect(globalItems(ctx, true).map((item) => item.label)).toEqual(['Home', 'Findings', 'Search']);
    expect(globalItems(ctx, false).map((item) => item.label)).toEqual(['Home', 'Projects', 'Findings', 'Search']);
  });

  it('keeps Connect an agent in the Library, and Health out of the navigation', () => {
    const labels = libraryItems({ board: false, admin: true }).map((item) => item.label);
    expect(labels).toContain('Connect an agent');
    expect(labels).not.toContain('Health');
  });

  it('puts Drift second in a project, and every section in exactly one place', () => {
    expect(PROJECT_ROWS[0]).toBe('drift');
    const placed = [...PROJECT_ROWS, ...KNOWLEDGE_ROWS];
    expect(new Set(placed).size).toBe(placed.length);
    expect([...placed].sort()).toEqual(SECTIONS.map((section) => section.slug).sort());
  });
});

describe('the tab bar', () => {
  it('follows the project the shell resolved, and offers none for an unknown one', () => {
    const ctx = { board: false, admin: true };
    expect(tabBarItems(ctx, 'BND').map((item) => item.to)).toEqual(['/', '/projects', '/findings', '/search', '/projects/BND']);
    expect(tabBarItems(ctx, null).map((item) => item.to)).toEqual(['/', '/projects', '/findings', '/search', '/project-ideas']);
  });
});

describe('a count', () => {
  const label = (n: number) => `Findings, ${String(n)} open critical`;

  it('is shown only for something that needs you', () => {
    expect(needsYou(2, label)).toEqual({ count: 2, countLabel: 'Findings, 2 open critical' });
  });

  it('is not shown at zero, or before the answer arrives', () => {
    expect(needsYou(0, label)).toEqual({});
    expect(needsYou(null, label)).toEqual({});
  });
});
