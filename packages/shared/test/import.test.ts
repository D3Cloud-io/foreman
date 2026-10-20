import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseChecklist,
  parseFrontmatter,
  parseMoscow,
  parsePhaseHeading,
  parsePhaseMeta,
  parseSections,
  parseTables,
  rewriteCitations,
} from '../src/index.js';

/**
 * The importer's parsers, against the **real files** in `fixtures/vault/` (T-8.1 … T-8.5).
 *
 * The fixtures were copied in before a line of parser was written, which is the point: a parser
 * written against imagined input passes its own tests and then meets a corpus that uses both YAML
 * styles, a `Src` column of round codes, and a scope of work with no task IDs at all.
 */

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures/vault');
const read = (path: string) => readFileSync(join(FIXTURES, path), 'utf8');

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, found);
    else if (entry.endsWith('.md')) found.push(path);
  }
  return found;
}

describe('the fixtures are the real thing', () => {
  it('holds files from more than one project', () => {
    const files = walk(FIXTURES);
    expect(files.length).toBeGreaterThan(8);
    expect(new Set(files.map((f) => f.replace(`${FIXTURES}/`, '').split('/')[0])).size).toBeGreaterThan(3);
  });
});

describe('frontmatter, in both styles the corpus uses (T-8.2)', () => {
  it('reads inline lists — Bindery writes tags this way', () => {
    const { data, present } = parseFrontmatter(read('Bindery/Requirements Register.md'));
    expect(present).toBe(true);
    expect(data['project']).toBe('bindery');
    expect(data['tags']).toContain('type/requirements');
    expect(data['aliases']).toContain('Bindery REQ');
  });

  it('reads block lists — the vault templates write them this way', () => {
    const { data } = parseFrontmatter(
      ['---', 'tags:', '  - project/foreman', '  - type/adr', 'status: accepted', '---', '# Title'].join('\n'),
    );
    expect(data['tags']).toEqual(['project/foreman', 'type/adr']);
    expect(data['status']).toBe('accepted');
  });

  it('never coerces a version into a number', () => {
    // `1.10` becoming 1.1 is the kind of corruption nobody notices for a year.
    const { data } = parseFrontmatter(['---', 'version: 1.10', '---', ''].join('\n'));
    expect(data['version']).toBe('1.10');
  });

  it('treats a file with no frontmatter as a normal file, not an error', () => {
    const parsed = parseFrontmatter('# Just a heading\n\nSome prose.');
    expect(parsed.present).toBe(false);
    expect(parsed.body).toContain('Just a heading');
  });

  it('leaves the body without the frontmatter it removed', () => {
    const { body } = parseFrontmatter(read('Bindery/Requirements Register.md'));
    expect(body.startsWith('---')).toBe(false);
    expect(body).toContain('# Bindery');
  });
});

describe('the registers, as tables (T-8.2)', () => {
  const register = parseFrontmatter(read('Bindery/Requirements Register.md'));
  const tables = parseTables(register.body);

  it('finds every table in the register, not just the first', () => {
    // 210 requirements across several tables, each under its own heading.
    expect(tables.length).toBeGreaterThan(3);
  });

  it('keys cells by their header, including the Src column of round codes', () => {
    const first = tables.find((t) => t.headers.includes('ID'));
    const row = first?.rows[0];
    expect(row?.['ID']).toMatch(/^REQ-\d+$/);
    expect(row?.['Pri']).toMatch(/^[MSCW]$/);
    // `R2`, `RT`, `EC` — the round code the plan warned about.
    expect(row?.['Src']).toMatch(/^[A-Z]+\d*$/);
  });

  it('reads every requirement in the file, not a prefix of them', () => {
    const rows = tables.filter((t) => t.headers.includes('ID')).flatMap((t) => t.rows);
    const ids = rows.map((r) => r['ID']).filter((id) => /^REQ-\d+$/.test(id ?? ''));
    // Bindery's register is 210 requirements. Silently reading 30 is the failure to catch here.
    expect(ids.length).toBeGreaterThan(150);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not mistake a line of prose containing pipes for a table', () => {
    const tables = parseTables('Some prose | with a pipe in it\n\nAnd more.');
    expect(tables).toEqual([]);
  });
});

describe('scopes of work (T-8.4)', () => {
  it('reads Bindery’s tasks, which carry IDs', () => {
    const { body } = parseFrontmatter(read('Bindery/Scope of Work.md'));
    const items = parseChecklist(body);

    expect(items.length).toBeGreaterThan(100);
    expect(items.some((i) => /\*\*T-0\.1\*\*/.test(i.text))).toBe(true);
    // Completion state is carried, because it is the only record that the work was done.
    expect(items.some((i) => i.done)).toBe(true);
  });

  it('reads Clearwhen’s tasks, which carry none at all', () => {
    const { body } = parseFrontmatter(read('Clearwhen/Scope of Work.md'));
    const items = parseChecklist(body);

    expect(items.length).toBeGreaterThan(20);
    // Not one task ID in the file. These become synthesized and flagged, which is the only way
    // this project imports at all.
    expect(items.every((i) => !/\bT-\d+\.\d+\b/.test(i.text))).toBe(true);
    expect(items.some((i) => i.section !== null)).toBe(true);
  });

  it('keeps the heading each item sat under, which is its phase', () => {
    const { body } = parseFrontmatter(read('Bindery/Scope of Work.md'));
    const items = parseChecklist(body);
    const phase = items.find((i) => i.section?.startsWith('Phase 0') === true);
    expect(phase).toBeDefined();
  });
});

/**
 * d3cloud.io's scope of work, the shape that imported as 199 tasks in no phase (2026-09-24).
 *
 * `## Phase N — Name`, then `### Deliverables` and `### Tasks` under each, and the tasks nested:
 * a bold line (`- [ ] **Repo setup**`) with indented checkboxes under it. Seven of the fourteen
 * projects still in the archive are written this way.
 */
describe('a scope of work with subheadings and grouped tasks (d3cloud.io)', () => {
  const { body } = parseFrontmatter(read('d3cloud.io/Scope of Work.md'));
  const items = parseChecklist(body);

  it('puts every item under its phase, not under the Tasks heading beneath it', () => {
    const phases = new Set(items.map((i) => i.section));
    expect([...phases].every((section) => parsePhaseHeading(section ?? '') !== null)).toBe(true);
    expect(phases.size).toBe(5);
  });

  it('keeps the subheading, so deliverables can be told apart from tasks', () => {
    expect(new Set(items.map((i) => i.subsection))).toEqual(new Set(['Deliverables', 'Tasks']));
    expect(items.filter((i) => i.subsection === 'Deliverables')).toHaveLength(34);
  });

  it('marks a bare bold line with children as a group, and names it on each child', () => {
    const groups = items.filter((i) => i.isGroup);
    expect(groups).toHaveLength(31);
    expect(groups.every((g) => /^\*\*[^*]+\*\*$/.test(g.text))).toBe(true);

    const commit = items.find((i) => i.text.startsWith('Initial commit'));
    expect(commit?.group).toBe('Repo setup');
    expect(commit?.isGroup).toBe(false);
  });

  it('leaves no bare bold heading among the items that are not groups', () => {
    const work = items.filter((i) => !i.isGroup && i.subsection === 'Tasks');
    expect(work).toHaveLength(134);
    expect(work.filter((i) => /^\*\*[^*]+\*\*:?$/.test(i.text))).toEqual([]);
  });

  it('reads each phase’s objective and size from its callout', () => {
    const meta = parsePhaseMeta(body);
    const zero = meta.get('Phase 0 — Foundation & Deploy Proof');
    expect(zero?.size).toBe('M');
    expect(zero?.objective).toMatch(/^Stand up the repo/);
    expect(meta.get('Phase 1 — Visual Foundation')?.size).toBe('S');
  });
});

describe('group detection, at its edges', () => {
  it('keeps a bold item with no children as a task', () => {
    const items = parseChecklist('## Phase 0 — A\n- [ ] **Ship it**\n- [ ] Next thing\n');
    expect(items.map((i) => i.isGroup)).toEqual([false, false]);
  });

  it('does not take a bold label followed by prose as a group — D3 Auth’s go-live line is work', () => {
    const { body } = parseFrontmatter(read('D3 Auth/Scope of Work.md'));
    const goLive = parseChecklist(body).find((i) => i.text.startsWith('**Go-live'));
    expect(goLive?.isGroup).toBe(false);
  });

  it('reads a bold label on its own line as a subheading, the way Clearwhen writes it', () => {
    const { body } = parseFrontmatter(read('Clearwhen/Scope of Work.md'));
    const labels = new Set(parseChecklist(body).map((i) => i.subsection));
    expect(labels.has('Deliverables')).toBe(true);
    expect(labels.has('Tasks')).toBe(true);
  });

  it('keeps Bindery’s Phase 10 tasks in Phase 10, under its 10a–10d subheadings', () => {
    const { body } = parseFrontmatter(read('Bindery/Scope of Work.md'));
    const task = parseChecklist(body).find((i) => i.text.includes('**T-10.1**'));
    expect(task?.section).toMatch(/^Phase 10 —/);
    expect(task?.subsection).toBe('10a — The front door');
  });
});

describe('phase headings', () => {
  it('reads a dash, an en dash, or a colon — Subtitler writes `Phase 0: Foundation`', () => {
    expect(parsePhaseHeading('Phase 8.5 — First Real Corpus')).toEqual({ number: '8.5', name: 'First Real Corpus' });
    expect(parsePhaseHeading('Phase 0: Foundation')).toEqual({ number: '0', name: 'Foundation' });
    expect(parsePhaseHeading('Phase Dependency Graph')).toBeNull();
  });

  it('does not read a number the phase column cannot hold as a phase (FRM-T-027)', () => {
    expect(parsePhaseHeading('Phase 9999.99 — The last one')).toEqual({ number: '9999.99', name: 'The last one' });
    expect(parsePhaseHeading('Phase 10000 — Too far')).toBeNull();
    expect(parsePhaseHeading('Phase 1.234 — Too fine')).toBeNull();
  });
});

describe('MoSCoW feature scopes, as requirements', () => {
  it('reads d3cloud.io’s tier column: every row, its tier from the first cell', () => {
    const { body } = parseFrontmatter(read('d3cloud.io/Discovery & Requirements.md'));
    const rows = parseMoscow(body);
    const count = (p: string) => rows.filter((r) => r.priority === p).length;

    expect(rows).toHaveLength(25);
    expect([count('M'), count('S'), count('C'), count('W')]).toEqual([9, 5, 3, 8]);
    expect(rows[0]?.statement).toBe('Hero section with wordmark + one-line value prop');
    // The decisions table beside it has no tier and is not requirements.
    expect(rows.some((r) => r.statement.startsWith('Authentication') && r.priority !== 'W')).toBe(false);
  });

  it('takes the tier from a heading over a table, with the author’s label and a quoted table', () => {
    const rows = parseMoscow(
      [
        '### Must Have — useless without',
        '| # | Feature | Notes |',
        '|---|---|---|',
        '| M1 | Single URL input | fast |',
        '### Won’t Have — out of scope',
        '> [!danger] Hard no',
        '> | # | Excluded | Why |',
        '> |---|---|---|',
        '> | W1 | User accounts | no backend |',
      ].join('\n'),
    );
    expect(rows).toEqual([
      { priority: 'M', statement: 'Single URL input', label: 'M1', line: 4 },
      { priority: 'W', statement: 'User accounts', label: 'W1', line: 9 },
    ]);
  });

  it('reads checkboxes under a tier callout, and a tier cell with an emoji', () => {
    const rows = parseMoscow(
      [
        '> [!todo] Must Have — MVP is useless without these',
        '> - [ ] Account creation',
        '> - [ ] **Stewards**: designate contacts',
        '',
        '| Priority | Feature | Notes |',
        '|---|---|---|',
        '| 🟥 **Should** | Share sheet | |',
      ].join('\n'),
    );
    expect(rows.map((r) => [r.priority, r.statement])).toEqual([
      ['M', 'Account creation'],
      ['M', 'Stewards: designate contacts'],
      ['S', 'Share sheet'],
    ]);
  });

  it('splits a cell that packs a tier’s features with middots, as Battlefront’s does', () => {
    const rows = parseMoscow('| Priority | Requirement |\n|---|---|\n| **Could Have** | Grenades · iron-sight · ragdoll |');
    expect(rows.map((r) => r.statement)).toEqual(['Grenades', 'iron-sight', 'ragdoll']);
  });

  it('leaves a heading that merely begins with a tier word alone', () => {
    expect(parseMoscow('## Should we ship?\n- [ ] maybe\n')).toEqual([]);
  });
});

describe('documents, as sections', () => {
  it('splits an architecture document at its headings', () => {
    const { body } = parseFrontmatter(read('Bindery/Architecture.md'));
    const sections = parseSections(body);

    expect(sections.length).toBeGreaterThan(3);
    expect(sections.every((s) => s.heading.length > 0)).toBe(true);
  });

  it('does not split on a heading inside a fenced code block', () => {
    const sections = parseSections(
      ['## Real', 'prose', '```bash', '# not a heading', '## also not', '```', '## Second'].join('\n'),
    );
    expect(sections.map((s) => s.heading)).toEqual(['Real', 'Second']);
  });
});

describe('checklist markers', () => {
  it('keeps a row whose marker is neither a space nor an x', () => {
    // The cutover dry run found this: the pattern was `[ xX]`, so Bindery's `~` (in progress) and
    // `→` (promoted) rows matched nothing and vanished — no task, and no line in the report, which
    // accounts for files rather than the entities inside them. Five real tasks, four of them the
    // in-progress ones that are the most interesting rows in the file.
    const body = [
      '## Phase 1',
      '- [x] **T-1.1** — Done thing',
      '- [ ] **T-1.2** — Not started',
      '- [~] **T-1.3** — Underway',
      '- [→] **T-1.4** — Promoted elsewhere',
    ].join('\n');

    const items = parseChecklist(body);
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.marker)).toEqual(['x', ' ', '~', '→']);
  });

  it('counts only x as done, so an in-progress task is not reported as finished', () => {
    const items = parseChecklist('- [~] **T-1.3** — Underway\n- [x] **T-1.1** — Done thing');
    expect(items.map((i) => i.done)).toEqual([false, true]);
  });
});

describe('citation rewriting (T-8.5, FRM-REQ-152)', () => {
  it('prefixes a bare ID with the project it belongs to', () => {
    const result = rewriteCitations('Satisfies REQ-021 and REQ-022.', 'BND');
    expect(result.text).toBe('Satisfies BND-REQ-021 and BND-REQ-022.');
    expect(result.substitutions).toHaveLength(2);
  });

  it('logs every substitution with its line and context', () => {
    // A false positive corrupts prose permanently, so every change is reviewable.
    const result = rewriteCitations('Line one.\nSatisfies REQ-021.', 'BND');
    expect(result.substitutions[0]?.line).toBe(2);
    expect(result.substitutions[0]?.context).toContain('Satisfies');
  });

  it('leaves an ID alone when it is part of a file path with spaces in it', () => {
    // Found in the cutover dry run. The span that skips paths only matches one running unbroken to
    // a known extension, and this vault's paths are full of spaces — so `ADR-011` in
    // `D3 Cloud Vault/Bindery/ADR-011 — A Declined File…md` read as open prose and was rewritten,
    // pointing the text at a file that does not exist.
    const line = 'Read — D3 Cloud Vault/Bindery/ADR-011 — A Declined File Is Not a Failure.md; done.';
    const result = rewriteCitations(line, 'BND');

    expect(result.text).toBe(line);
    expect(result.skipped.map((s) => s.because)).toContain(
      'follows a path separator, so it is part of an address',
    );
  });

  it('still rewrites a citation that merely sits near a path', () => {
    // The guard is the separator immediately before the ID, not the presence of a path on the line.
    const result = rewriteCitations('See docs/thing.md and REQ-021.', 'BND');
    expect(result.text).toBe('See docs/thing.md and BND-REQ-021.');
  });

  it('leaves an already-prefixed ID alone', () => {
    const result = rewriteCitations('See BND-REQ-021 and AUTH-T-1.2.', 'BND');
    expect(result.text).toBe('See BND-REQ-021 and AUTH-T-1.2.');
    expect(result.substitutions).toHaveLength(0);
    expect(result.skipped.map((s) => s.because)).toContain('already carries a project prefix');
  });

  it('leaves an ID inside a code span or fence alone', () => {
    const cases = [
      'Use `REQ-021` as the example.',
      'Example:\n\n```\nGET /entities/REQ-021\n```\n',
      'See docs/REQ-021.md for more.',
      'https://example.com/REQ-021',
    ];
    for (const text of cases) {
      const result = rewriteCitations(text, 'BND');
      expect(result.text, text).toBe(text);
    }
  });

  it('does not rewrite a word that merely looks like an ID', () => {
    const result = rewriteCitations('A T-1shirt and a P-3x value.', 'BND');
    expect(result.substitutions).toHaveLength(0);
  });

  it('rewrites the real inline citations in a scope of work without touching anything else', () => {
    const { body } = parseFrontmatter(read('Bindery/Scope of Work.md'));
    const result = rewriteCitations(body, 'BND');

    expect(result.substitutions.length).toBeGreaterThan(50);

    // Every backticked ID in the real file survived untouched. Checking each substitution's line
    // for "an ID inside backticks" is what a first draft did, and it is unsound: a line holding
    // `custom_id`, `REQ-054`, `M` and a bare **T-9.9** matches a naive pair regex *between* two
    // code spans. This asserts the thing that actually matters instead.
    for (const backticked of body.matchAll(/`(REQ-\d+|T-\d+\.\d+)`/g)) {
      expect(result.text, backticked[0]).toContain(backticked[0]);
    }

    // And nothing else moved: each substitution adds exactly the prefix's four characters, so a
    // rewrite that touched anything it did not log would show up in the length.
    expect(result.text.length).toBe(body.length + result.substitutions.length * 4);

    // The skip list is populated, so "nothing was skipped" cannot be why the above passes.
    expect(result.skipped.length).toBeGreaterThan(20);
  });
});
