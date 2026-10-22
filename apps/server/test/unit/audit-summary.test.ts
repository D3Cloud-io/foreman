import { describe, expect, it } from 'vitest';
import { eventIds, summarize } from '../../src/domain/audit.js';

/**
 * The sentence an audit event reads as in a record's history (FRM-T-18.3, FRM-REQ-243), and the
 * helper that keeps a response's `auditEventIds` honest. Pure functions, so no database.
 */

const base = { actor: 'matthew@demers.dev', entityType: 'task', entityHumanId: 'FRM-T-18.3' };

describe('eventIds', () => {
  it('keeps the order and drops the events that did not happen', () => {
    expect(eventIds('own', null, 'a', undefined, 'b')).toEqual(['own', 'a', 'b']);
  });
});

describe('summarize', () => {
  it('names a creation by its ID and its title', () => {
    expect(
      summarize({ ...base, action: 'create', before: null, after: { title: 'Undo, server side' } }),
    ).toBe('Created task FRM-T-18.3 “Undo, server side”');
  });

  it('reads an update as the fields that changed, with short values', () => {
    const text = summarize({
      ...base,
      action: 'update',
      before: { title: 'Same', status: 'todo', updatedAt: 'a' },
      after: { title: 'Same', status: 'done', updatedAt: 'b' },
    });
    expect(text).toBe('Changed status (todo → done) on FRM-T-18.3 “Same”');
  });

  it('gives only the field name when a value is too long to read in a sentence', () => {
    const text = summarize({
      ...base,
      action: 'update',
      before: { body: 'x'.repeat(80) },
      after: { body: 'y'.repeat(80) },
    });
    expect(text).toMatch(/^Changed body on FRM-T-18\.3/);
  });

  it('collapses a long list of changes', () => {
    const before = { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 };
    const after = { a: 2, b: 2, c: 2, d: 2, e: 2, f: 2 };
    expect(summarize({ ...base, action: 'update', before, after })).toContain('and 3 more');
  });

  it('says so when a save changed nothing anyone can see', () => {
    const row = { title: 'T', updatedAt: 'a' };
    expect(
      summarize({ ...base, action: 'update', before: row, after: { ...row, updatedAt: 'b' } }),
    ).toMatch(/no visible change/);
  });

  it('reads a delete from the snapshot it kept, since the event has nothing else', () => {
    expect(
      summarize({ ...base, action: 'delete', before: { title: 'Gone' }, after: { deleted: true } }),
    ).toBe('Deleted task FRM-T-18.3 “Gone”');
  });

  it('reads a rollup as the move and its cause', () => {
    expect(
      summarize({
        actor: 'rollup via FRM-T-18.3',
        action: 'update',
        entityType: 'phase',
        entityHumanId: 'FRM-P-18',
        before: { status: 'planned' },
        after: { status: 'active' },
      }),
    ).toBe('FRM-P-18 moved status planned → active because of FRM-T-18.3');
  });

  it('reads links, unlinks and their reversal', () => {
    const link = { event: 'link', to: 'FRM-REQ-243', kind: 'satisfies' };
    expect(summarize({ ...base, action: 'create', before: null, after: link })).toBe(
      'Linked FRM-T-18.3 to FRM-REQ-243 (satisfies)',
    );
    expect(
      summarize({ ...base, action: 'delete', before: link, after: { ...link, event: 'unlink' } }),
    ).toBe('Unlinked FRM-T-18.3 from FRM-REQ-243 (satisfies)');
    expect(
      summarize({ ...base, action: 'undo', before: link, after: { ...link, event: 'unlink' } }),
    ).toBe('Reversed the satisfies link between FRM-T-18.3 and FRM-REQ-243');
  });

  it('reads a reorder and the renumbering a change caused', () => {
    expect(
      summarize({
        ...base,
        entityType: 'group',
        entityHumanId: 'GRP-001',
        action: 'update',
        before: null,
        after: { event: 'reorder', scope: 'projects', cause: 'FRM created' },
      }),
    ).toBe('Reordered projects after FRM created');
  });

  it('names a token by its prefix and never its value', () => {
    expect(
      summarize({
        actor: 'a',
        action: 'create',
        entityType: 'api_token',
        entityHumanId: 'frm_abcdefgh',
        before: null,
        after: { name: 'CI', scopes: ['read'], prefix: 'frm_abcdefgh' },
      }),
    ).toBe('Issued API token frm_abcdefgh “CI”');
  });

  it('reads an undo as an undo of the record it touched', () => {
    expect(
      summarize({ ...base, action: 'undo', before: { title: 'T' }, after: { title: 'T0' } }),
    ).toBe('Undid an earlier change to task FRM-T-18.3 “T0”');
  });
});
