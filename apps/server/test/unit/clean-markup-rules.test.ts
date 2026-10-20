import { describe, expect, it } from 'vitest';
import {
  cleanMarkdown,
  cleanPlain,
  planRow,
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

  it('strips an opening ** that never closes, as in a truncated tripwire cell', () => {
    const { value } = cleanPlain('**Golden corpus word accuracy drops below 90%');
    expect(value).toBe('Golden corpus word accuracy drops below 90%');
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
    // The backticks go (plain field), but `x[i[0]]` was code and keeps its brackets.
    expect(cleanPlain('Fix `x[i[0]]` lookup').value).toBe('Fix x[i[0]] lookup');
  });

  it('logs every substitution it makes', () => {
    const { substitutions } = cleanPlain('**A** [[B|C]] `d` ]]');
    expect(substitutions.map((s) => s.rule)).toEqual(['wiki-link', 'bold', 'stray-brackets', 'backtick', 'backtick', 'whitespace']);
    expect(substitutions[0]).toEqual({ rule: 'wiki-link', from: '[[B|C]]', to: 'C' });
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
    const plan = planRow({ term: '**Asset**', aliases: ['**thing**', 'item'], definition: 'A **kept** `x`' }, fields);
    expect(plan?.map((c) => c.field)).toEqual(['term', 'aliases']);
    expect(plan?.[0]).toMatchObject({ before: '**Asset**', after: 'Asset' });
    expect(plan?.[1]).toMatchObject({ before: ['**thing**', 'item'], after: ['thing', 'item'] });
  });

  it('is null for a clean row, which is what makes a second run a no-op', () => {
    expect(planRow({ term: 'Asset', aliases: [], definition: 'x' }, fields)).toBeNull();
  });

  it('leaves a field that would become empty as it is', () => {
    expect(planRow({ term: '**', aliases: [], definition: '' }, fields)).toBeNull();
  });

  it('drops an alias that was only residue', () => {
    const plan = planRow({ term: 'T', aliases: ['**', 'real'], definition: '' }, fields);
    expect(plan?.[0]?.after).toEqual(['real']);
  });
});
