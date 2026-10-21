import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * FRM-REQ-251 — the console's copy does not refer to the retired vault.
 *
 * Every string literal, template fragment and run of JSX text in the console's source is read, and
 * none may say "vault" — comments are not read, because they are not user-visible. The one
 * exception is the Import dialog, which imports *from* the archived vault: its CLI flag is `--path`
 * to that folder, and a dialog that called it something else would send the operator looking for a
 * folder that does not exist. The exception is exact — a file, a string and a reason — and an entry
 * that no longer matches anything fails too, so the list cannot go stale.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

interface Allowed {
  readonly file: string;
  readonly text: string;
  readonly reason: string;
}

const IMPORT_DIALOG = 'The Import dialog imports from the archived vault; the CLI flag is --path to it.';

const ALLOWED: readonly Allowed[] = [
  { file: 'screens/Projects.tsx', text: '<vault>', reason: IMPORT_DIALOG },
  { file: 'screens/Projects.tsx', text: 'Import from the archived vault', reason: IMPORT_DIALOG },
  { file: 'screens/Projects.tsx', text: 'vault', reason: 'The Import dialog input\'s form name; it is never shown.' },
  { file: 'screens/Projects.tsx', text: 'Vault', reason: IMPORT_DIALOG },
  { file: 'screens/Projects.tsx', text: "The vault's root folder on the host.", reason: IMPORT_DIALOG },
  { file: 'screens/Projects.tsx', text: '../d3cloud-archive/D3 Cloud Vault', reason: IMPORT_DIALOG },
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The user-visible text in a source file: string literals, template fragments and JSX text. */
function stringsIn(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push(node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) found.push(node.text);
    else if (ts.isJsxText(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

describe('console copy (FRM-REQ-251)', () => {
  const offences = sources(SRC).flatMap((path) => {
    const file = relative(SRC, path).split('\\').join('/');
    return stringsIn(path, readFileSync(path, 'utf8'))
      .filter((text) => /vault/i.test(text))
      .map((text) => ({ file, text: text.trim() }));
  });

  it('says "vault" nowhere but the Import dialog', () => {
    const stray = offences.filter(
      (o) => !ALLOWED.some((a) => a.file === o.file && a.text === o.text),
    );
    expect(stray).toEqual([]);
  });

  it('keeps the allowlist exact: every entry still matches a string, and has a reason', () => {
    for (const entry of ALLOWED) {
      expect(entry.reason).not.toBe('');
      expect(offences.some((o) => o.file === entry.file && o.text === entry.text)).toBe(true);
    }
  });

  it('reads strings, not comments', () => {
    const found = stringsIn('x.tsx', "// the vault\nconst a = 'one'; const b = <p>two {`three ${a} four`}</p>;");
    expect(found.join('|')).toContain('one');
    expect(found).toEqual(expect.arrayContaining(['one', 'two ', 'three ', ' four']));
    expect(found.join(' ')).not.toMatch(/vault/);
    expect(stringsIn('y.tsx', "const c = 'the Vault';").some((s) => /vault/i.test(s))).toBe(true);
  });
});
