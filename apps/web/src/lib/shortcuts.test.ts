import { describe, expect, it } from 'vitest';
import type { SearchHit } from './api';
import {
  dialogIsOpen,
  exactId,
  goTo,
  groupEntries,
  hitHref,
  isPaletteChord,
  isTextField,
  jumpTarget,
  projectEntries,
  screenEntries,
  searchHref,
  sectionEntries,
  shortcutFor,
  SHORTCUTS,
  triageKeyFor,
  type KeyLike,
  type TargetLike,
} from './shortcuts';

/** FRM-T-18.5: which key opens what, and where a typed ID goes. */

const body: TargetLike = { tagName: 'BODY' };
const input = (type = 'text'): TargetLike => ({ tagName: 'INPUT', type });
const textarea: TargetLike = { tagName: 'TEXTAREA' };
const editable: TargetLike = { tagName: 'DIV', isContentEditable: true };

function press(key: string, extra: Partial<KeyLike> = {}, target: KeyLike['target'] = body): KeyLike {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target, ...extra };
}
const open = { mac: true, dialogOpen: false };

describe('which fields are text', () => {
  it('counts text inputs, textareas, selects and editable regions, not checkboxes or buttons', () => {
    expect(isTextField(input())).toBe(true);
    expect(isTextField(input('search'))).toBe(true);
    expect(isTextField(textarea)).toBe(true);
    expect(isTextField({ tagName: 'SELECT' })).toBe(true);
    expect(isTextField(editable)).toBe(true);
    expect(
      isTextField({ tagName: 'DIV', getAttribute: (name) => (name === 'role' ? 'textbox' : null) }),
    ).toBe(true);
    expect(isTextField(input('checkbox'))).toBe(false);
    expect(isTextField({ tagName: 'BUTTON' })).toBe(false);
    expect(isTextField(body)).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});

describe('⌘K', () => {
  it('opens the palette by the platform’s own modifier only', () => {
    expect(shortcutFor(press('k', { metaKey: true }), open)).toBe('palette');
    expect(shortcutFor(press('K', { metaKey: true }), open)).toBe('palette');
    expect(shortcutFor(press('k', { ctrlKey: true }), open)).toBeNull();
    expect(shortcutFor(press('k', { ctrlKey: true }), { ...open, mac: false })).toBe('palette');
    expect(shortcutFor(press('k', { metaKey: true }), { ...open, mac: false })).toBeNull();
    expect(isPaletteChord(press('k', { metaKey: true, shiftKey: true }), true)).toBe(false);
  });

  it('works from a single-line field, but not a textarea or an editable region', () => {
    expect(shortcutFor(press('k', { metaKey: true }, input()), open)).toBe('palette');
    expect(shortcutFor(press('k', { metaKey: true }, textarea), open)).toBeNull();
    expect(shortcutFor(press('k', { metaKey: true }, editable), open)).toBeNull();
  });

  it('does nothing while a dialog is open', () => {
    expect(shortcutFor(press('k', { metaKey: true }), { ...open, dialogOpen: true })).toBeNull();
  });
});

describe('/ and ?', () => {
  it('open the palette and the sheet outside a field', () => {
    expect(shortcutFor(press('/'), open)).toBe('palette');
    expect(shortcutFor(press('?', { shiftKey: true }), open)).toBe('sheet');
    expect(shortcutFor(press('/', {}, { tagName: 'BUTTON' }), open)).toBe('palette');
  });

  it('never fire in a text field of any kind', () => {
    for (const target of [input(), input('search'), textarea, editable, { tagName: 'SELECT' }]) {
      expect(shortcutFor(press('/', {}, target), open)).toBeNull();
      expect(shortcutFor(press('?', { shiftKey: true }, target), open)).toBeNull();
    }
  });

  it('never fire while a dialog is open, with a modifier held, or once handled', () => {
    expect(shortcutFor(press('/'), { ...open, dialogOpen: true })).toBeNull();
    expect(shortcutFor(press('?'), { ...open, dialogOpen: true })).toBeNull();
    expect(shortcutFor(press('/', { metaKey: true }), open)).toBeNull();
    expect(shortcutFor(press('/', { defaultPrevented: true }), open)).toBeNull();
    expect(shortcutFor(press('/', { isComposing: true }), open)).toBeNull();
    expect(shortcutFor(press('a'), open)).toBeNull();
  });
});

describe('a held key and an input method', () => {
  it('opens nothing on an auto-repeat', () => {
    expect(shortcutFor(press('k', { metaKey: true, repeat: true }), open)).toBeNull();
    expect(shortcutFor(press('/', { repeat: true }), open)).toBeNull();
    expect(shortcutFor(press('?', { repeat: true }), open)).toBeNull();
  });

  it('opens nothing for a key an input method is handling', () => {
    expect(shortcutFor(press('/', { keyCode: 229 }), open)).toBeNull();
    expect(shortcutFor(press('k', { metaKey: true, isComposing: true }), open)).toBeNull();
  });
});

describe('dialogIsOpen', () => {
  it('asks the document for a dialog, an alert dialog or an open <dialog>', () => {
    let asked = '';
    const doc = {
      querySelector: (selector: string) => {
        asked = selector;
        return null;
      },
    };
    expect(dialogIsOpen(doc as never)).toBe(false);
    expect(asked).toContain('[role="dialog"]');
    expect(asked).toContain('[role="alertdialog"]');
    expect(asked).toContain('dialog[open]');
    expect(dialogIsOpen({ querySelector: () => ({}) } as never)).toBe(true);
  });
});

describe('an exact human ID', () => {
  it('is recognised in any kind, in any case, with whitespace', () => {
    for (const id of [
      'BND-REQ-012',
      'FRM-T-18.5',
      'FRM-P-18',
      'EXMP-CR-001',
      'PI-007',
      'GL-004',
      'GRP-002',
      'FRM-ADR-016',
    ]) {
      expect(exactId(id)).toBe(id);
    }
    expect(exactId('  bnd-req-012 ')).toBe('BND-REQ-012');
  });

  it('is not a word, a code, or half an ID', () => {
    for (const text of ['', 'drift', 'BND', 'BND-REQ', 'ingest pipeline', 'BND-REQ-012 foo']) {
      expect(exactId(text)).toBeNull();
    }
  });

  it('goes to the record’s own page, or its project’s list', () => {
    const href = (id: string) => jumpTarget(id, null)?.href;
    expect(href('BND-REQ-012')).toBe('/requirements/BND-REQ-012');
    expect(href('FRM-T-18.5')).toBe('/tasks/FRM-T-18.5');
    expect(href('FRM-P-18')).toBe('/projects/FRM/phases/FRM-P-18');
    expect(href('FRM-ADR-016')).toBe('/projects/FRM/adrs');
    expect(href('FRM-R-001')).toBe('/projects/FRM/risks');
    expect(href('EXMP-CR-001')).toBe('/findings/EXMP-CR-001');
    expect(href('EXMP-DA-001')).toBe('/findings/EXMP-DA-001');
    expect(href('BND-SCR-001')).toBe('/projects/BND/screens/BND-SCR-001');
    expect(href('PI-007')).toBe('/project-ideas/PI-007');
    expect(href('GL-004')).toBe('/guidelines');
  });

  it('sends a kind without a page of its own to Search, which finds it by ID', () => {
    expect(jumpTarget('BND-D-004', null)?.href).toBe('/search?q=BND-D-004');
  });

  it('resolves a group by its slug once the groups are known, and by its ID before', () => {
    const groups = [{ humanId: 'GRP-002', name: 'Dormice', slug: 'dormice' }];
    expect(jumpTarget('GRP-002', groups)).toMatchObject({ href: '/groups/dormice', description: 'Dormice' });
    expect(jumpTarget('GRP-002', null)?.href).toBe('/groups/GRP-002');
    expect(jumpTarget('GRP-009', groups)?.href).toBe('/groups/GRP-009');
  });
});

describe('where a search hit goes', () => {
  const hit = (over: Partial<SearchHit>): SearchHit => ({
    type: 'requirement',
    humanId: 'BND-REQ-012',
    projectCode: 'BND',
    title: 'Ingest',
    snippet: null,
    ...over,
  });

  it('opens the record’s page by kind', () => {
    expect(hitHref(hit({}))).toBe('/requirements/BND-REQ-012');
    expect(hitHref(hit({ type: 'task', humanId: 'BND-T-1.1' }))).toBe('/tasks/BND-T-1.1');
    expect(hitHref(hit({ type: 'finding', humanId: 'BND-CR-001' }))).toBe('/findings/BND-CR-001');
    expect(hitHref(hit({ type: 'adr', humanId: 'BND-ADR-001' }))).toBe('/projects/BND/adrs');
  });

  it('opens a document section’s project documents, and anything else in Search', () => {
    expect(hitHref(hit({ type: 'document_section', humanId: null }))).toBe('/projects/BND/documents');
    expect(hitHref(hit({ type: 'decision', humanId: 'BND-D-004' }))).toBe('/search?q=BND-D-004');
    expect(hitHref(hit({ type: 'term', humanId: null, projectCode: null, title: 'Drift' }))).toBe(
      '/search?q=Drift',
    );
  });
});

describe('the full-results link', () => {
  it('carries the query and the scope', () => {
    expect(searchHref(' ingest  ', null)).toBe('/search?q=ingest');
    expect(searchHref('a b', 'dormice')).toBe('/search?q=a+b&group=dormice');
  });
});

describe('Go to', () => {
  const projects = [
    { code: 'BND', name: 'Bindery' },
    { code: 'FRM', name: 'Foreman' },
  ];
  const groups = [{ humanId: 'GRP-001', name: 'D3 Cloud', slug: 'd3-cloud' }];
  const entries = {
    screens: screenEntries(
      [
        { to: '/', label: 'Home' },
        { to: '/findings', label: 'Findings' },
        { to: '/drift', label: 'Drift across projects' },
      ],
      'dormice',
    ),
    projects: projectEntries(projects),
    groups: groupEntries(groups),
    sections: sectionEntries(projects),
  };

  it('shows the screens alone for an empty query', () => {
    expect(goTo('', entries).map((e) => e.label)).toEqual(['Home', 'Findings', 'Drift across projects']);
  });

  it('keeps the scope on a scoped screen and drops it elsewhere', () => {
    expect(entries.screens.map((e) => e.href)).toEqual([
      '/?group=dormice',
      '/findings?group=dormice',
      '/drift?group=dormice',
    ]);
  });

  it('lists screens, then projects, then groups, matching every word', () => {
    expect(goTo('find', entries).map((e) => e.label)).toEqual(['Findings']);
    expect(goTo('bnd', entries).map((e) => e.href)).toContain('/projects/BND');
    expect(goTo('d3', entries).map((e) => e.label)).toEqual(['D3 Cloud']);
    expect(goTo('zzz', entries)).toEqual([]);
  });

  it('finds a project’s section by project and section words', () => {
    const found = goTo('bnd drift', entries);
    expect(found.map((e) => e.href)).toContain('/projects/BND/drift');
    expect(found.map((e) => e.href)).not.toContain('/projects/FRM/drift');
  });

  it('is capped, so a broad word is a short list', () => {
    expect(goTo('o', entries).length).toBeLessThanOrEqual(8);
  });
});

describe('the sheet’s list', () => {
  it('lists the three opening keys and nothing unbound', () => {
    const keys = SHORTCUTS.flatMap((group) => group.rows.map((row) => row.keys.join(' ')));
    expect(keys.some((k) => k.endsWith('K'))).toBe(true);
    expect(keys).toContain('/');
    expect(keys).toContain('?');
    expect(keys.some((k) => /^g\b/.test(k))).toBe(false);
  });
});

/** FRM-T-18.7: the triage keys on /findings act only outside a text field and with no dialog open. */
describe('the triage keys', () => {
  const free = { dialogOpen: false };

  it('maps each verdict, move and tab key', () => {
    expect(triageKeyFor(press('a'), free)).toBe('acknowledge');
    expect(triageKeyFor(press('f'), free)).toBe('fixed');
    expect(triageKeyFor(press('r'), free)).toBe('reopen');
    expect(triageKeyFor(press('w'), free)).toBe('wont-fix');
    expect(triageKeyFor(press('y'), free)).toBe('confirm');
    expect(triageKeyFor(press('n'), free)).toBe('reject');
    expect(triageKeyFor(press('j'), free)).toBe('next');
    expect(triageKeyFor(press('k'), free)).toBe('previous');
    expect(triageKeyFor(press('x'), free)).toBe('toggle');
    expect(triageKeyFor(press('Escape'), free)).toBe('clear');
    expect(triageKeyFor(press('3'), free)).toBe('tab-3');
    expect(triageKeyFor(press('q'), free)).toBeNull();
  });

  it('never acts while typing — a reason with an r in it does not reopen anything', () => {
    expect(triageKeyFor(press('r', {}, textarea), free)).toBeNull();
    expect(triageKeyFor(press('a', {}, input()), free)).toBeNull();
    expect(triageKeyFor(press('y', {}, editable), free)).toBeNull();
    // A checkbox is not a text field: x on a row's checkbox still selects.
    expect(triageKeyFor(press('x', {}, input('checkbox')), free)).toBe('toggle');
  });

  it('never acts behind a dialog, with a modifier, held down or mid-composition', () => {
    expect(triageKeyFor(press('a'), { dialogOpen: true })).toBeNull();
    expect(triageKeyFor(press('r', { metaKey: true }), free)).toBeNull();
    expect(triageKeyFor(press('r', { ctrlKey: true }), free)).toBeNull();
    expect(triageKeyFor(press('A', { shiftKey: true }), free)).toBeNull();
    expect(triageKeyFor(press('f', { repeat: true }), free)).toBeNull();
    expect(triageKeyFor(press('f', { isComposing: true }), free)).toBeNull();
    expect(triageKeyFor(press('f', { defaultPrevented: true }), free)).toBeNull();
  });

  it('lists every triage key on the sheet', () => {
    const group = SHORTCUTS.find((g) => g.title === 'On Findings');
    const keys = group?.rows.flatMap((row) => row.keys) ?? [];
    for (const key of ['a', 'f', 'r', 'w', 'y', 'n', 'j', 'k', 'x', 'esc', '1', '4']) expect(keys).toContain(key);
  });
});
