import { describe, expect, it } from 'vitest';
import {
  cleanMarkdown,
  cleanPlain,
  planRow,
  splitCellReason,
  wikiLinkText,
  type FieldSpec,
} from '../../src/cli/clean-markup-rules.js';

/**
 * FRM-T-18.11 / FRM-REQ-250: the substitution rules of `clean-markup`, without a database.
 * The examples are the ones the audit (FRM-DA-011) found in the live glossary and risk register.
 */
describe('cleanPlain — a field the console prints as plain text', () => {
  it('strips the bold the importer left on a glossary term', () => {
    expect(cleanPlain('**Asset**').value).toBe('Asset');
    expect(cleanPlain('**`field_provenance`**').value).toBe('field_provenance');
  });

  it('strips the bold around the head of a tripwire cell, and strikethrough', () => {
    expect(cleanPlain('**Golden corpus word accuracy** drops below 90%').value).toBe(
      'Golden corpus word accuracy drops below 90%',
    );
    expect(cleanPlain('Use ~~the old~~ importer').value).toBe('Use the old importer');
    expect(cleanPlain('~~Superseded~~ task').substitutions[0]?.rule).toBe('strike');
  });

  it('leaves an unclosed ** alone: nothing says it is emphasis', () => {
    expect(cleanPlain('**Golden corpus word accuracy drops below 90%').value).toBe(
      '**Golden corpus word accuracy drops below 90%',
    );
  });

  it('removes the backticks and keeps what they wrapped', () => {
    expect(cleanPlain('Add `pnpm run relint` to CI').value).toBe('Add pnpm run relint to CI');
  });

  it('rewrites a wiki link to its label, else to its target', () => {
    expect(cleanPlain('See [[Some Note]] now').value).toBe('See Some Note now');
    expect(cleanPlain('See [[Some Note|the note]] now').value).toBe('See the note now');
    expect(cleanPlain('Cites [[Note|FRM-REQ-012]]').value).toBe('Cites FRM-REQ-012');
    expect(cleanPlain('Cites [[FRM-REQ-012]]').value).toBe('Cites FRM-REQ-012');
  });

  it('shows a target without its folder, heading or extension', () => {
    expect(wikiLinkText('Folder/Sub/Note.md#Section')).toBe('Note');
    expect(wikiLinkText('#Just a heading')).toBe('Just a heading');
    expect(wikiLinkText('Note\\|Label')).toBe('Label');
    expect(cleanPlain('![[Embedded note]]').value).toBe('Embedded note');
  });

  it('removes the stray ]] a half-converted wiki link leaves on a title', () => {
    expect(cleanPlain('Write the importer ]]').value).toBe('Write the importer');
    expect(cleanPlain('[[ Write the importer').value).toBe('Write the importer');
  });

  it('leaves brackets inside a code span in step with the code', () => {
    expect(cleanPlain('Fix `x[i[0]]` lookup').value).toBe('Fix x[i[0]] lookup');
  });

  // Code-like text in a plain field (the verifier's examples): the markers are not markers.
  it.each([
    ['CI paths filter: `apps/**` and `packages/**`', 'CI paths filter: apps/** and packages/**'],
    ['Glob src/**/*.ts', 'Glob src/**/*.ts'],
    ['Accept `**kwargs`', 'Accept **kwargs'],
    ['Accept **kwargs in the wrapper', 'Accept **kwargs in the wrapper'],
    ['x**2 + y**2', 'x**2 + y**2'],
    ['arr[b[0]]', 'arr[b[0]]'],
    ['Matrix [[1,2],[3,4]]', 'Matrix [[1,2],[3,4]]'],
    ['a[[i]] indexing', 'a[[i]] indexing'],
    ['A lone ` backtick', 'A lone ` backtick'],
    ['Does 5 ** 2 equal 25', 'Does 5 ** 2 equal 25'],
  ])('leaves code-like text alone: %s', (input, expected) => {
    expect(cleanPlain(input).value).toBe(expected);
  });

  it('still cleans residue sitting beside code-like text', () => {
    expect(cleanPlain('**Globs** like `apps/**` ]]').value).toBe('Globs like apps/**');
  });

  it('logs every substitution it makes', () => {
    const { substitutions } = cleanPlain('**A** [[B|C]] `d` ]]');
    expect(substitutions.map((s) => s.rule)).toEqual(['backtick', 'wiki-link', 'bold', 'stray-brackets', 'whitespace']);
    expect(substitutions[1]).toEqual({ rule: 'wiki-link', from: '[[B|C]]', to: 'C' });
  });

  it('leaves clean text byte-for-byte alone, whitespace included', () => {
    for (const text of ['Plain title', 'Two  spaces kept', ' padded ', '5 * 3 = 15', 'a_b_c', 'x[0]']) {
      const out = cleanPlain(text);
      expect(out.value).toBe(text);
      expect(out.substitutions).toEqual([]);
    }
  });

  it('is idempotent: its output has nothing left to clean', () => {
    for (const text of ['**Asset**', '**`a`** and [[X|Y]] ]]', '**open', '[[a]] [[b|c]] **d**']) {
      const once = cleanPlain(text).value;
      const twice = cleanPlain(once);
      expect(twice.value).toBe(once);
      expect(twice.substitutions).toEqual([]);
    }
  });
});

describe('cleanMarkdown — a body rendered as Markdown', () => {
  it('keeps bold and backticks, which are meaning here', () => {
    const text = 'The **ledger** stores `field_provenance`.';
    expect(cleanMarkdown(text)).toEqual({ value: text, substitutions: [] });
  });

  it('rewrites a complete wiki link, which no renderer understands', () => {
    expect(cleanMarkdown('See [[Architecture|the architecture]] and [[Notes]].').value).toBe(
      'See the architecture and Notes.',
    );
  });

  it('leaves a stray ]] alone: it may be code', () => {
    expect(cleanMarkdown('index a[b[0]] is fine').value).toBe('index a[b[0]] is fine');
  });

  it('does not touch an indented code block', () => {
    const text = 'Example:\n\n    [[Not a link]]\n    more\n\nBut [[this]] is.';
    expect(cleanMarkdown(text).value).toBe('Example:\n\n    [[Not a link]]\n    more\n\nBut this is.');
  });

  it('does not take a matrix or an index for a wiki link', () => {
    expect(cleanMarkdown('m = [[1,2],[3,4]] and a[[i]]').value).toBe('m = [[1,2],[3,4]] and a[[i]]');
  });

  it('does not touch a wiki link inside a code span or a fence', () => {
    const text = 'Write `[[Not a link]]` literally.\n\n```md\n[[Also not]]\n```\n\nBut [[this]] is.';
    expect(cleanMarkdown(text).value).toBe(
      'Write `[[Not a link]]` literally.\n\n```md\n[[Also not]]\n```\n\nBut this is.',
    );
  });
});

describe('planRow', () => {
  const fields: FieldSpec[] = [
    { name: 'term', kind: 'plain' },
    { name: 'aliases', kind: 'plain-list' },
    { name: 'definition', kind: 'markdown' },
  ];

  it('lists only the fields that change, with their before and after', () => {
    const { changes } = planRow({ term: '**Asset**', aliases: ['**thing**', 'item'], definition: 'A **kept** `x`' }, fields);
    expect(changes.map((c) => c.field)).toEqual(['term', 'aliases']);
    expect(changes[0]).toMatchObject({ before: '**Asset**', after: 'Asset' });
    expect(changes[1]).toMatchObject({ before: ['**thing**', 'item'], after: ['thing', 'item'] });
  });

  it('is empty for a clean row, which is what makes a second run a no-op', () => {
    expect(planRow({ term: 'Asset', aliases: [], definition: 'x' }, fields)).toEqual({ changes: [], review: [] });
  });

  it('leaves a field that would become empty as it is', () => {
    expect(planRow({ term: '**', aliases: [], definition: '' }, fields).changes).toEqual([]);
  });

  it('keeps an alias that is only a lone marker, since nothing says it is residue', () => {
    const { changes } = planRow({ term: 'T', aliases: ['~~', '**real**'], definition: '' }, fields);
    expect(changes[0]?.after).toEqual(['~~', 'real']);
    const dropped = planRow({ term: 'T', aliases: ['``', '**real**'], definition: '' }, fields);
    expect(dropped.changes[0]?.after).toEqual(['``', 'real']);
  });

  it('cleans the fields the verifier found raw: objective, exit demo, acceptance test, done-when', () => {
    const f: FieldSpec[] = ['objective', 'exitDemo', 'acceptanceTest', 'doneWhen'].map((name) => ({ name, kind: 'plain' }));
    const { changes } = planRow(
      {
        objective: '**Ship** it, per [[D3 Auth/Scope of Work|D3 Auth]]',
        exitDemo: 'Demo [[Plan]]',
        acceptanceTest: '~~old~~ new **test**',
        doneWhen: 'Done',
      },
      f,
    );
    expect(changes.map((c) => [c.field, c.after])).toEqual([
      ['objective', 'Ship it, per D3 Auth'],
      ['exitDemo', 'Demo Plan'],
      ['acceptanceTest', 'old new test'],
    ]);
  });
});

describe('cells split at an escaped pipe are reported, not repaired', () => {
  const cell: FieldSpec[] = [{ name: 'mitigation', kind: 'plain', cell: true }, { name: 'tripwire', kind: 'plain', cell: true }];

  it('spots the three shapes a split leaves', () => {
    expect(splitCellReason('Bindery/ADR-006 — Cloudflare Tunnel and Access for Ingress\\')).toMatch(/backslash/);
    expect(splitCellReason('See [[D3 Auth/Scope')).toMatch(/wiki link/);
    expect(splitCellReason('ADR-006). App-level JWT stays')).toMatch(/mid-parenthesis/);
    expect(splitCellReason('A balanced (aside) cell')).toBeNull();
  });

  it('leaves the cell unchanged even when it also holds residue, and says which field', () => {
    const plan = planRow(
      { mitigation: '**Tunnel** and Access\\', tripwire: 'ADR-006). App-level JWT' },
      cell,
    );
    expect(plan.changes).toEqual([]);
    expect(plan.review.map((r) => [r.field, r.text])).toEqual([
      ['mitigation', '**Tunnel** and Access\\'],
      ['tripwire', 'ADR-006). App-level JWT'],
    ]);
  });

  it('does not flag a plain field that is not a cell', () => {
    expect(planRow({ title: 'ends with a backslash\\' }, [{ name: 'title', kind: 'plain' }])).toEqual({ changes: [], review: [] });
  });
});
