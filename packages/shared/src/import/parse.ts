/**
 * Reading the vault's markdown (T-8.2).
 *
 * Written against the real files in `fixtures/vault/`, which is the whole point of copying them in
 * first: a parser written against imagined input passes its own tests and then meets a corpus that
 * uses both YAML styles, a `Src` column of round codes, and a scope of work with no task IDs at all.
 */

import { isStorablePhaseNumber } from '../entities/spine.js';

export interface Frontmatter {
  readonly data: Record<string, unknown>;
  /** The document with its frontmatter removed, so offsets into the body are honest. */
  readonly body: string;
  /** True when the file opened with `---` at all. A file with none is not an error. */
  readonly present: boolean;
}

/**
 * Frontmatter, in both styles the corpus actually uses.
 *
 * ```yaml
 * tags: [type/requirements, project/bindery]   # inline — Bindery
 * tags:                                        # block — the vault's own templates
 *   - project/foreman
 * ```
 *
 * Hand-parsed rather than handed to a YAML library: the subset in use is small and flat, and a
 * full YAML parser brings anchors, multi-document streams and arbitrary type coercion — three
 * things no vault file needs and any of which could turn a date into something surprising.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (match === null) return { data: {}, body: text, present: false };

  const data: Record<string, unknown> = {};
  const lines = (match[1] ?? '').split(/\r?\n/);

  let currentKey: string | null = null;
  let block: string[] = [];

  const flush = () => {
    if (currentKey !== null && block.length > 0) data[currentKey] = block;
    currentKey = null;
    block = [];
  };

  for (const line of lines) {
    // A block-style list item belongs to the key above it.
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item !== null && currentKey !== null) {
      block.push(unquote(item[1] ?? ''));
      continue;
    }

    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (pair === null) continue;
    flush();

    const key = pair[1] ?? '';
    const raw = (pair[2] ?? '').trim();

    if (raw === '') {
      // Either a block list follows, or the value really is empty. Decided by what comes next.
      currentKey = key;
      continue;
    }
    data[key] = scalar(raw);
  }
  flush();

  return { data, body: text.slice(match[0].length), present: true };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function scalar(raw: string): unknown {
  // Inline list: `[a, b, c]`. The corpus uses this for `tags` and `aliases`.
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((part) => unquote(part));
  }
  const value = unquote(raw);
  // Deliberately no number or boolean coercion. `version: 1.10` is a string in every file that
  // has one, and turning it into 1.1 is the kind of corruption nobody notices for a year.
  return value;
}

// ─── Markdown tables ───────────────────────────────────────────────────────

export interface MarkdownTable {
  readonly headers: string[];
  readonly rows: Record<string, string>[];
  /** The line the table started on, for a reconciliation note that can be checked. */
  readonly line: number;
}

/**
 * Every pipe table in a body, keyed by header.
 *
 * The registers are tables, and a register is the densest thing in the corpus — 439 requirements
 * across several tables in one file, each with its own section heading above it.
 */
export function parseTables(body: string): MarkdownTable[] {
  const lines = body.split(/\r?\n/);
  const tables: MarkdownTable[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i];
    const divider = lines[i + 1];
    if (header === undefined || divider === undefined) continue;
    if (!header.trim().startsWith('|')) continue;
    // The divider is what makes it a table rather than a line that happens to contain pipes.
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(divider)) continue;

    const headers = splitRow(header);
    const rows: Record<string, string>[] = [];

    let j = i + 2;
    for (; j < lines.length; j += 1) {
      const line = lines[j];
      if (line === undefined || !line.trim().startsWith('|')) break;

      const cells = splitRow(line);
      const row: Record<string, string> = {};
      for (const [index, name] of headers.entries()) row[name] = cells[index] ?? '';
      rows.push(row);
    }

    tables.push({ headers, rows, line: i + 1 });
    i = j - 1;
  }

  return tables;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

// ─── Checkbox lists ────────────────────────────────────────────────────────

export interface ChecklistItem {
  readonly done: boolean;
  /**
   * The raw marker between the brackets, lower-cased. `x` is done and a space is not, but the
   * corpus also uses `~` for in progress and `→` for promoted elsewhere, and those are tasks too.
   */
  readonly marker: string;
  readonly text: string;
  /**
   * The phase-level heading this item sat under — the `##`, or a `### Phase N` — never a
   * subheading. It read "the nearest heading of any level", and d3cloud.io's scope of work puts
   * `### Deliverables` and `### Tasks` under every `## Phase N`, so every item's section was
   * `Tasks`, no phase parsed, and 199 tasks imported into no phase at all.
   */
  readonly section: string | null;
  /**
   * The subheading within the section: a `###`/`####` heading, or a bold label on a line of its
   * own (`**Deliverables**`, `**Tasks**`), which is how Clearwhen and D3 Auth write the same thing.
   */
  readonly subsection: string | null;
  /** Leading indentation in columns, a tab counted as four. */
  readonly indent: number;
  /**
   * A bare bold line with indented children — `- [ ] **Repo setup**` — is a heading for the
   * checkboxes under it, not a piece of work. Importing it as a task counted the work twice and
   * produced a task nobody could finish except by finishing its children.
   */
  readonly isGroup: boolean;
  /** The name of the group this item sits inside, if any: `Repo setup`. */
  readonly group: string | null;
  readonly line: number;
}

/** `**Repo setup**` or `**Repo setup:**` alone on the line — the shape of a grouping item. */
const BARE_BOLD = /^\*\*([^*]+?):?\*\*:?\s*$/;

/** A bold label that is the whole line: `**Deliverables**`, `**Deliverables & Tasks**`. */
const BOLD_LABEL = /^\s*\*\*([^*]+?):?\*\*:?\s*$/;

/**
 * Checkbox items, with the phase and subheading above them and the group around them.
 *
 * Clearwhen's scope of work is **free text with no task IDs** — `- [x] Capabilities: WeatherKit
 * (app ID), App Group entitlement` — and it is not an outlier: twelve scopes of work in the corpus
 * have no task IDs at all. Those become synthesized, flagged tasks (T-8.4), which is the only way
 * those projects import at all.
 */
export function parseChecklist(body: string): ChecklistItem[] {
  const lines = body.split(/\r?\n/);
  const items: (ChecklistItem & { parent: number | null })[] = [];
  let section: string | null = null;
  let subsection: string | null = null;
  // The open items above this one, shallowest first, as indices into `items`.
  let stack: number[] = [];
  let fenced = false;

  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;

    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const text = (heading[2] ?? '').trim();
      // A `### Phase 3` is still a phase: the level is how it was written, the name is what it is.
      if ((heading[1] ?? '').length === 2 || parsePhaseHeading(text) !== null) {
        section = text;
        subsection = null;
      } else {
        subsection = text;
      }
      stack = [];
      continue;
    }

    const label = BOLD_LABEL.exec(line);
    if (label !== null && !/^\s*[-*]\s/.test(line)) {
      subsection = (label[1] ?? '').trim();
      stack = [];
      continue;
    }

    /**
     * Any single character between the brackets, not just a space or an `x`.
     *
     * This read `[ xX]`, so a row using any other marker matched nothing and was skipped in
     * silence — no task, and no line in the reconciliation report, because the report accounts for
     * *files* and the file was read fine. Bindery's scope of work uses `~` for in progress and `→`
     * for promoted, and the cutover dry run put five real tasks on the floor that way, four of
     * them the in-progress ones that are the most interesting rows in the file.
     */
    const item = /^(\s*)[-*]\s+\[(.)\]\s+(.*)$/.exec(line);
    if (item === null) continue;

    const indent = (item[1] ?? '').replace(/\t/g, '    ').length;
    while (stack.length > 0 && (items[stack.at(-1) ?? 0]?.indent ?? 0) >= indent) stack.pop();

    const marker = (item[2] ?? ' ').toLowerCase();
    items.push({
      done: marker === 'x',
      marker,
      text: (item[3] ?? '').trim(),
      section,
      subsection,
      indent,
      isGroup: false,
      group: null,
      line: index + 1,
      parent: stack.at(-1) ?? null,
    });
    stack.push(items.length - 1);
  }

  // A bare bold item is a group only if something is indented under it. A bold item with no
  // children is a task somebody emphasised, and it stays one.
  const isGroup = items.map((it, i) => BARE_BOLD.test(it.text) && items.some((c) => c.parent === i));
  const groupOf = (i: number | null): string | null => {
    for (let at = i; at !== null; at = items[at]?.parent ?? null) {
      if (isGroup[at] === true) return (BARE_BOLD.exec(items[at]?.text ?? '')?.[1] ?? '').trim();
    }
    return null;
  };

  return items.map(({ parent, ...it }, i) => ({
    ...it,
    isGroup: isGroup[i] === true,
    group: groupOf(parent),
  }));
}

/**
 * `## Phase 8.5 — The Half Phase` → `{ number: '8.5', name: 'The Half Phase' }`.
 *
 * Subtitler writes `## Phase 0: Foundation`, so a colon separates as well as a dash.
 *
 * A number the phase column cannot hold (`Phase 10000`, `Phase 1.234`) is not read as a phase:
 * writing it would overflow `numeric(6,2)` or round away from its human ID (FRM-T-027).
 */
export function parsePhaseHeading(heading: string): { number: string; name: string } | null {
  const match = /^Phase\s+(\d+(?:\.\d+)?)\s*(?:[—–:-]\s*(.+))?$/i.exec(heading.trim());
  if (match === null) return null;
  const number = match[1] ?? '';
  if (!isStorablePhaseNumber(Number(number))) return null;
  const name = (match[2] ?? '').trim();
  return { number, name: name.length > 0 ? name : `Phase ${number}` };
}

export interface PhaseMeta {
  readonly objective: string | null;
  readonly size: 'XS' | 'S' | 'M' | 'L' | 'XL' | null;
}

/**
 * Each phase's objective and size, keyed by its heading.
 *
 * The corpus writes these three ways — `> [!example] Objective · Size: M` over a quoted
 * paragraph, `> **Objective:** …`, and `**Objective:** …` — and the brief shows the objective of
 * the active phase, which read `null` for every imported project because nothing looked.
 */
export function parsePhaseMeta(body: string): Map<string, PhaseMeta> {
  const lines = body.split(/\r?\n/);
  const meta = new Map<string, PhaseMeta>();
  let phase: string | null = null;
  let fenced = false;

  const sizeIn = (text: string): PhaseMeta['size'] => {
    const m = /\bSize\b[\s:·*`]*(XS|XL|S|M|L)\b/.exec(text);
    return (m?.[1] as PhaseMeta['size'] | undefined) ?? null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;

    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const text = (heading[2] ?? '').trim();
      if (parsePhaseHeading(text) !== null) phase = text;
      else if ((heading[1] ?? '').length === 2) phase = null;
      continue;
    }
    if (phase === null || meta.has(phase)) continue;

    const callout = /^>\s*\[![\w-]+\][+-]?\s*(.*\bObjective\b.*)$/i.exec(line);
    if (callout !== null) {
      const body: string[] = [];
      for (let j = i + 1; j < lines.length && /^>/.test(lines[j] ?? ''); j += 1) {
        body.push((lines[j] ?? '').replace(/^>\s?/, ''));
      }
      const objective = body.join(' ').replace(/\s+/g, ' ').trim();
      meta.set(phase, { objective: objective.length > 0 ? objective : null, size: sizeIn(callout[1] ?? '') });
      continue;
    }

    const inline = /^(?:>\s*)?\*\*Objective:?\*\*:?\s*(.+)$/i.exec(line);
    if (inline !== null) {
      const objective = (inline[1] ?? '').trim();
      meta.set(phase, { objective, size: sizeIn(objective) });
    }
  }

  return meta;
}

// ─── MoSCoW feature scope ──────────────────────────────────────────────────

export interface MoscowItem {
  readonly priority: 'M' | 'S' | 'C' | 'W';
  readonly statement: string;
  /** The author's own label for the row, when there is one — `M10`, `F3`. */
  readonly label: string | null;
  readonly line: number;
}

const TIER: Record<string, MoscowItem['priority']> = { must: 'M', should: 'S', could: 'C', won: 'W' };

/** `🟥 **Must**`, `**Must Have**`, `Won't (v1)` → the tier; anything else → null. */
function tierOfCell(cell: string): MoscowItem['priority'] | null {
  const m = /^(must|should|could|won['’]?t)\b/i.exec(cell.replace(/^[^A-Za-z]+/, ''));
  // `won't` and `wont` both key as `won`; the other three are already their own key.
  return m === null ? null : (TIER[(m[1] ?? '').toLowerCase().replace(/^won.*$/, 'won')] ?? null);
}

/**
 * A heading or callout title names a tier only with "have" after it — `Must Have — Pilot MVP`,
 * `Won't Have (this cycle)` — so a heading that merely begins with "Should" is left alone.
 */
function tierOfTitle(title: string): MoscowItem['priority'] | null {
  const clean = title.replace(/^[^A-Za-z]+/, '');
  return /^(must|should|could|won['’]?t)[\s-]+have\b/i.test(clean) ? tierOfCell(clean) : null;
}

function cleanStatement(text: string): string {
  return text
    .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Requirements from a discovery document's MoSCoW scope, for a project with no register.
 *
 * d3cloud.io's requirements are a table — `| **Must** | Feature | Notes |` — and eight other
 * projects not yet imported write the same thing six different ways: a tier column (`Tier`,
 * `Priority`, with or without an emoji or "Have"), a tier heading over a table or a list
 * (`### Must Have — …`), or a tier callout over checkboxes (`> [!todo] Must Have`). All of them
 * say the same two things per row: what, and how much it matters.
 *
 * A table with neither a tier column nor a tier above it is some other table and is skipped.
 */
export function parseMoscow(body: string): MoscowItem[] {
  const lines = body.split(/\r?\n/);
  const items: MoscowItem[] = [];
  // The tier in force on each line, from a heading or a callout — what a table beneath inherits.
  const tierAt: (MoscowItem['priority'] | null)[] = [];
  let headingTier: MoscowItem['priority'] | null = null;
  let calloutTier: MoscowItem['priority'] | null = null;
  let fenced = false;

  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) {
      tierAt.push(null);
      continue;
    }

    const heading = /^#{2,4}\s+(.*)$/.exec(line);
    if (heading !== null) {
      headingTier = tierOfTitle(heading[1] ?? '');
      calloutTier = null;
      tierAt.push(headingTier);
      continue;
    }

    const callout = /^>\s*\[![\w-]+\][+-]?\s*(.*)$/.exec(line);
    if (callout !== null) {
      calloutTier = tierOfTitle(callout[1] ?? '');
      tierAt.push(calloutTier ?? headingTier);
      continue;
    }
    if (!line.startsWith('>')) calloutTier = null;

    const tier = calloutTier ?? headingTier;
    tierAt.push(tier);
    if (tier === null) continue;

    // A top-level list item under a tier — `> - [ ] Account creation`, `- Offline mode`.
    const bullet = calloutTier !== null
      ? /^>\s?(?:[-*]|\d+\.)\s+(?:\[.\]\s+)?(.+)$/.exec(line)
      : /^(?:[-*]|\d+\.)\s+(?:\[.\]\s+)?(.+)$/.exec(line);
    if (bullet !== null) {
      const statement = cleanStatement(bullet[1] ?? '');
      if (statement.length > 0) items.push({ priority: tier, statement, label: null, line: index + 1 });
    }
  }

  const norm = (h: string) => h.replace(/\*/g, '').trim().toLowerCase();
  // D3 QR's Won't Have table sits inside a callout, every row quoted. Unquoting keeps the line
  // numbers, so the tier above still lines up.
  const unquoted = lines.map((line) => line.replace(/^>\s?/, '')).join('\n');
  for (const table of parseTables(unquoted)) {
    const headers = table.headers;
    const tierCol = headers.find((h) => ['tier', 'priority', 'moscow', 'pri'].includes(norm(h)));
    const inherited = tierAt[table.line - 1] ?? null;
    if (tierCol === undefined && inherited === null) continue;

    const idCol = headers.find((h) => ['#', 'id', 'ref'].includes(norm(h)));
    const statementCol =
      headers.find((h) => ['requirement', 'feature', 'capability', 'req'].includes(norm(h))) ??
      headers.find((h) => h !== tierCol && h !== idCol && !['notes', 'note'].includes(norm(h)));
    if (statementCol === undefined) continue;
    const detailCol = headers.find(
      (h) => h !== statementCol && ['description', 'details'].includes(norm(h)),
    );

    for (const [offset, row] of table.rows.entries()) {
      const tier = tierCol === undefined ? inherited : tierOfCell(row[tierCol] ?? '');
      if (tier === null) continue;

      const label = idCol === undefined ? null : (row[idCol] ?? '').trim() || null;
      // Battlefront packs a tier's features into one cell with `·` between them.
      const parts = (row[statementCol] ?? '').split(/\s+·\s+/).map(cleanStatement).filter((p) => p.length > 0);
      const detail = detailCol === undefined ? '' : cleanStatement(row[detailCol] ?? '');
      for (const part of parts) {
        const statement = parts.length === 1 && detail.length > 0 ? `${part} — ${detail}` : part;
        items.push({ priority: tier, statement, label, line: table.line + 2 + offset });
      }
    }
  }

  return items.sort((a, b) => a.line - b.line);
}

/** The `##` and `###` headings of a body, with the prose under each — a document's sections. */
export interface Section {
  readonly heading: string;
  readonly body: string;
  readonly level: number;
}

export function parseSections(body: string): Section[] {
  const lines = body.split(/\r?\n/);
  const sections: Section[] = [];

  let current: { heading: string; level: number; lines: string[] } | null = null;
  let fenced = false;

  for (const line of lines) {
    // A `##` inside a fenced block is code, not a heading. Missing this splits a document at a
    // comment in a shell sample.
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;

    const heading = fenced ? null : /^(#{2,3})\s+(.*)$/.exec(line);
    if (heading !== null) {
      if (current !== null) {
        sections.push({
          heading: current.heading,
          body: current.lines.join('\n').trim(),
          level: current.level,
        });
      }
      current = { heading: (heading[2] ?? '').trim(), level: (heading[1] ?? '##').length, lines: [] };
      continue;
    }
    current?.lines.push(line);
  }

  if (current !== null) {
    sections.push({
      heading: current.heading,
      body: current.lines.join('\n').trim(),
      level: current.level,
    });
  }

  return sections;
}
