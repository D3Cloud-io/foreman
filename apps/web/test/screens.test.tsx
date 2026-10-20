import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScreenProposalCreate, type Screen, type ScreenVersion } from '@foreman/shared';
import { routeFor } from '../src/lib/router';
import { sectionFor, SECTIONS } from '../src/lib/project';
import { figmaUrl, isPng, MANUAL_SOURCE, manualProvenance } from '../src/screens/ScreenDetail';
import { latestVerdict, thumbnailFor, VerdictPill } from '../src/screens/Screens';

/** FRM-T-12.3: the Screens list and detail — what they choose to show, and what a drop sends. */

const SHA = 'a'.repeat(64);

function version(over: Partial<ScreenVersion>): ScreenVersion {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'proposal',
    blobSha256: SHA,
    url: `/api/blobs/${SHA}`,
    viewport: 'desktop',
    theme: 'dark',
    status: 'current',
    figmaFileKey: 'abc123',
    figmaNodeId: '12:34',
    figmaFileVersion: '1',
    commitSha: null,
    createdBy: 'user:dev@localhost',
    createdAt: '2026-10-19T10:00:00.000Z',
    verdicts: [],
    ...over,
  };
}

function screen(current: Screen['current']): Screen {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    humanId: 'EXMP-SCR-001',
    name: 'Inbox',
    route: '/inbox',
    figmaFileKey: null,
    figmaNodeId: null,
    createdAt: '2026-10-19T09:00:00.000Z',
    updatedAt: '2026-10-19T09:00:00.000Z',
    current,
    components: [],
  };
}

describe('screens in the console', () => {
  it('is a section of every project, routed for the list and for one screen', () => {
    expect(SECTIONS.some((s) => s.slug === 'screens')).toBe(true);
    expect(sectionFor('/projects/EXMP/screens/EXMP-SCR-001')?.label).toBe('Screens');
    expect(routeFor('/projects/EXMP/screens')).toEqual({ screen: 'screens', code: 'EXMP' });
    expect(routeFor('/projects/EXMP/screens/EXMP-SCR-001')).toEqual({
      screen: 'screen',
      code: 'EXMP',
      humanId: 'EXMP-SCR-001',
    });
  });

  it('links a Figma frame with the node ID spelled the way a URL spells it', () => {
    expect(figmaUrl('abc123', '12:34')).toBe('https://www.figma.com/design/abc123?node-id=12-34');
    expect(figmaUrl('abc123', null)).toBe('https://www.figma.com/design/abc123');
    // A drop has no file behind it, so there is nothing to link to (FRM-REQ-197).
    expect(figmaUrl(MANUAL_SOURCE, MANUAL_SOURCE)).toBeNull();
    expect(figmaUrl(null, '1:2')).toBeNull();
  });

  it('files a dropped PNG under the screen’s frame, or `manual`, in a shape the API accepts', () => {
    const now = new Date('2026-10-19T12:34:56.789Z');
    const bare = manualProvenance({ figmaFileKey: null, figmaNodeId: null }, now);
    expect(bare).toEqual({
      figmaFileKey: 'manual',
      figmaNodeId: 'manual',
      figmaFileVersion: '2026-10-19T12:34:56.789Z',
    });
    const framed = manualProvenance({ figmaFileKey: 'abc123', figmaNodeId: '12:34' }, now);
    expect(framed.figmaFileKey).toBe('abc123');
    expect(framed.figmaNodeId).toBe('12:34');

    for (const provenance of [bare, framed]) {
      const parsed = ScreenProposalCreate.safeParse({
        blobSha256: SHA,
        viewport: 'mobile',
        theme: 'light',
        ...provenance,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('takes a PNG and refuses anything else before uploading it', () => {
    expect(isPng({ type: 'image/png', name: 'frame.png' })).toBe(true);
    expect(isPng({ type: '', name: 'FRAME.PNG' })).toBe(true);
    expect(isPng({ type: 'image/jpeg', name: 'frame.jpg' })).toBe(false);
    expect(isPng({ type: '', name: 'notes.txt' })).toBe(false);
  });

  it('shows the desktop dark proposal as the thumbnail, and any proposal when there is none', () => {
    const mobile = version({ viewport: 'mobile', theme: 'light', blobSha256: 'b'.repeat(64) });
    const desktopDark = version({});
    expect(thumbnailFor(screen({ proposals: [mobile, desktopDark], captures: [] }))).toBe(desktopDark);
    expect(thumbnailFor(screen({ proposals: [mobile], captures: [] }))).toBe(mobile);
    expect(thumbnailFor(screen({ proposals: [], captures: [] }))).toBeNull();
  });

  it('reports the newest verdict on the most recent capture (FRM-REQ-195)', () => {
    const verdict = (kind: 'matches' | 'drifted_fix') => ({
      id: '00000000-0000-4000-8000-0000000000aa',
      versionId: '00000000-0000-4000-8000-000000000002',
      verdict: kind,
      reviewer: 'user:dev@localhost',
      note: kind === 'matches' ? null : 'spacing',
      createdAt: '2026-10-19T11:00:00.000Z',
    });
    const older = version({ kind: 'capture', status: null, createdAt: '2026-10-18T10:00:00.000Z', verdicts: [verdict('matches')] });
    const newer = version({
      kind: 'capture',
      status: null,
      viewport: 'mobile',
      createdAt: '2026-10-19T10:00:00.000Z',
      verdicts: [verdict('drifted_fix'), verdict('matches')],
    });
    expect(latestVerdict(screen({ proposals: [], captures: [older, newer] }))).toBe('drifted_fix');
    expect(latestVerdict(screen({ proposals: [], captures: [] }))).toBeNull();
    // A capture nobody has judged yet is "none", not the verdict on an older one.
    const unjudged = version({ kind: 'capture', status: null, createdAt: '2026-10-20T10:00:00.000Z' });
    expect(latestVerdict(screen({ proposals: [], captures: [older, unjudged] }))).toBeNull();
  });

  it('says a verdict in words, never by colour alone', () => {
    expect(renderToStaticMarkup(<VerdictPill verdict="drifted_fix" />)).toContain('Drifted — fix');
    expect(renderToStaticMarkup(<VerdictPill verdict="drifted_accepted" />)).toContain('Drifted — accepted');
    expect(renderToStaticMarkup(<VerdictPill verdict={null} />)).toContain('none');
  });
});
