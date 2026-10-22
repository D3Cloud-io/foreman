import { describe, expect, it } from 'vitest';
import {
  ANCHORED_CLASS,
  anchorRow,
  idFromHash,
  rowAnchor,
  ROW_ID_CLASS,
  type AnchorHost,
  type AnchorTarget,
} from './useRowAnchor';

/** FRM-T-18.13: the row named by the fragment scrolls into view, takes focus and is outlined. */

function fakeElement(row?: AnchorTarget) {
  const classes = new Set<string>();
  const calls: string[] = [];
  const scrolls: ScrollIntoViewOptions[] = [];
  const focuses: (FocusOptions | undefined)[] = [];
  const element: AnchorTarget = {
    scrollIntoView: (options) => { calls.push('scroll'); scrolls.push(options); },
    focus: (options) => { calls.push('focus'); focuses.push(options); },
    closest: () => row ?? null,
    classList: { add: (name) => { classes.add(name); }, remove: (name) => { classes.delete(name); } },
  };
  return { element, classes, calls, scrolls, focuses };
}

const hostOf = (byId: Record<string, AnchorTarget>): AnchorHost => ({
  getElementById: (id) => byId[id] ?? null,
});

describe('the id a fragment names', () => {
  it('drops the #, decodes it, and reads nothing from an empty or broken one', () => {
    expect(idFromHash('#BND-ADR-002')).toBe('BND-ADR-002');
    expect(idFromHash('#FRM-T-18.13')).toBe('FRM-T-18.13');
    expect(idFromHash('#a%20b')).toBe('a b');
    expect(idFromHash('')).toBeNull();
    expect(idFromHash('#')).toBeNull();
    expect(idFromHash('#%E0%A4%A')).toBeNull();
  });
});

describe('anchoring a row', () => {
  it('scrolls to the middle, focuses without a second scroll, and outlines the element', () => {
    const card = fakeElement();
    const off = anchorRow(hostOf({ 'BND-ADR-002': card.element }), 'BND-ADR-002', { reducedMotion: false });
    expect(card.calls).toEqual(['scroll', 'focus']);
    expect(card.scrolls[0]).toEqual({ block: 'center', behavior: 'smooth' });
    expect(card.focuses[0]).toEqual({ preventScroll: true });
    expect(card.classes.has(ANCHORED_CLASS)).toBe(true);
    off?.();
    expect(card.classes.has(ANCHORED_CLASS)).toBe(false);
  });

  it('does not scroll smoothly for a person who asked for less motion', () => {
    const card = fakeElement();
    anchorRow(hostOf({ x: card.element }), 'x', { reducedMotion: true });
    expect(card.scrolls[0]?.behavior).toBe('auto');
  });

  it('outlines the table row around the id wrapper and focuses the wrapper', () => {
    const tr = fakeElement();
    const cell = fakeElement(tr.element);
    const off = anchorRow(hostOf({ 'BND-R-001': cell.element }), 'BND-R-001', { reducedMotion: false });
    expect(tr.classes.has(ANCHORED_CLASS)).toBe(true);
    expect(cell.classes.has(ANCHORED_CLASS)).toBe(false);
    expect(cell.calls).toEqual(['scroll', 'focus']);
    off?.();
    expect(tr.classes.has(ANCHORED_CLASS)).toBe(false);
  });

  it('does nothing, and returns nothing to undo, when the row is not on the page', () => {
    expect(anchorRow(hostOf({}), 'BND-ADR-999', { reducedMotion: false })).toBeNull();
  });
});

describe('the id wrapper', () => {
  it('carries the id, can take focus by script but not by Tab', () => {
    const node = rowAnchor('BND-R-001', 'text') as { props: Record<string, unknown>; type: string };
    expect(node.type).toBe('div');
    expect(node.props).toMatchObject({ id: 'BND-R-001', tabIndex: -1, className: ROW_ID_CLASS });
  });
});
