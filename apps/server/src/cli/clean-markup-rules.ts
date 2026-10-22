/**
 * The substitution rules behind `clean-markup` (FRM-T-18.11, FRM-REQ-250), kept apart from the CLI
 * so they can be tested without a database — and so importing them runs nothing.
 *
 * Two kinds of field, and a different rule for each:
 *
 * - **plain** — a title, a term, a tripwire, an objective: text the console prints with `{value}`.
 *   A marker is residue there, so `**x**` becomes `x`, `~~x~~` becomes `x`, a paired `` `x` ``
 *   becomes `x`, and a vault wiki link becomes its label.
 * - **markdown** — a body the console renders as Markdown. `**x**` and backticks are *meaning*
 *   there and are left alone; only a complete `[[wiki link]]`, which no Markdown renderer
 *   understands and so prints literally, is rewritten — and never inside a code span, a fence or an
 *   indented code block, where `[[` is code.
 *
 * **The rules are code-aware, because plain fields hold code-like text too** (`apps/**`,
 * `src/<glob>/*.ts`, `**kwargs`, `x**2 + y**2`, `arr[b[0]]`, `[[1,2],[3,4]]`). So:
 *   - what sits inside a *paired* backtick span is never touched, and only the pair is removed;
 *     a lone backtick is left, because nothing says it is a marker;
 *   - `**` is emphasis only when it opens against a non-word, non-glob character and closes with
 *     one, around text that does not start or end in a space — so `/**`, `x**2` and an
 *     unclosed `**` are left;
 *   - `[[…]]` is a wiki link only when it contains a letter, holds no bracket, and does not follow
 *     a word character (`a[[i]]` is an index);
 *   - a stray `]]` or `[[` is dropped only when it is *unmatched* — the brackets around it balance
 *     without it. `arr[b[0]]` and `[[1,2],[3,4]]` balance, so they stay.
 *
 * **Never guessed at**: a cell the importer split at an escaped pipe (a trailing backslash, a tail
 * that starts mid-parenthesis, an unclosed `[[` at the end) is not repaired. It is returned as a
 * `ReviewNote`, unchanged, for a person.
 */

export type FieldKind = 'plain' | 'markdown' | 'plain-list';

export interface FieldSpec {
  readonly name: string;
  readonly kind: FieldKind;
  /** A table cell, which the importer may have split at an escaped pipe. */
  readonly cell?: boolean;
}

export type Rule = 'wiki-link' | 'bold' | 'strike' | 'backtick' | 'stray-brackets' | 'whitespace';

export interface Substitution {
  readonly rule: Rule;
  readonly from: string;
  readonly to: string;
}

export interface Cleaned {
  readonly value: string;
  readonly substitutions: readonly Substitution[];
}

/** What a wiki link shows: its label, else its target without the folder, the heading or `.md`. */
export function wikiLinkText(inner: string): string {
  // `\|` is how a pipe is written inside a Markdown table cell.
  const pipe = inner.search(/\\?\|/);
  if (pipe !== -1) {
    const label = inner.slice(pipe).replace(/^\\?\|/, '').trim();
    if (label !== '') return label;
  }
  const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  const hash = target.indexOf('#');
  const note = (hash === -1 ? target : target.slice(0, hash)).trim();
  const heading = hash === -1 ? '' : target.slice(hash + 1).trim();
  return (note === '' ? heading : (note.split('/').pop() ?? note)).replace(/\.md$/i, '').trim();
}

/**
 * A wiki link: not after a word character or a bracket (`a[[i]]` is an index), holding a letter and
 * no bracket (`[[1,2],[3,4]]` is a matrix), and not followed by a closing bracket.
 */
const WIKI_LINK = /(?<![\w[\]])(!?)\[\[([^[\]\n]*[A-Za-z][^[\]\n]*)\]\](?!\])/g;

function rewriteWikiLinks(text: string, found: Substitution[]): string {
  return text.replace(WIKI_LINK, (match, _embed: string, inner: string) => {
    const to = wikiLinkText(inner);
    found.push({ rule: 'wiki-link', from: match, to });
    return to;
  });
}

/** Paired inline code spans only (one or two backticks), so a lone backtick is never a delimiter. */
const INLINE_CODE = /``(.+?)``|`([^`\n]+)`/g;

/** Prose (even indexes) and code (odd indexes): fences, then indented blocks, then inline spans. */
function splitCode(text: string): string[] {
  return text.split(
    /((?:^|\n)(?:```|~~~)[\s\S]*?(?:\n(?:```|~~~)[^\n]*(?=\n|$)|$)|(?:^|\n)(?:(?: {4}|\t)[^\n]*(?:\n|$))+|``.+?``|`[^`\n]+`)/,
  );
}

/** The bold that is emphasis: opens and closes against non-word, non-glob characters. */
const BOLD = /(?<![\w*/\\])\*\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*\*(?![\w*/])/g;
const STRIKE = /(?<![\w~])~~(?=[^\s~])([^~\n]+?)(?<=[^\s~])~~(?![\w~])/g;

/** Remove `]]` / `[[` that no bracket balances, leaving `arr[b[0]]` and `[[1,2],[3,4]]` alone. */
function dropUnmatchedPairs(text: string, found: Substitution[]): string {
  const opens: number[] = [];
  const unmatched = new Set<number>();
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '[') opens.push(index);
    else if (char === ']') {
      if (opens.length > 0) opens.pop();
      else unmatched.add(index);
    }
  }
  for (const index of opens) unmatched.add(index);

  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if ((char === '[' || char === ']') && unmatched.has(index) && unmatched.has(index + 1) && text[index + 1] === char) {
      found.push({ rule: 'stray-brackets', from: char + char, to: '' });
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

/** A plain-text field: its markers are residue; code-like text is left as it is. */
export function cleanPlain(text: string): Cleaned {
  const found: Substitution[] = [];

  // Paired code spans leave the string for the duration, so no rule below can reach inside one.
  const spans: string[] = [];
  let value = text.replace(INLINE_CODE, (match, double: string | undefined, single: string | undefined) => {
    const inner = double ?? single ?? '';
    found.push({ rule: 'backtick', from: match, to: inner });
    spans.push(inner);
    return `${String(spans.length - 1)}`;
  });

  value = rewriteWikiLinks(value, found);

  for (const [rule, pattern] of [['bold', BOLD], ['strike', STRIKE]] as const) {
    for (;;) {
      const next = value.replace(pattern, (match, inner: string) => {
        found.push({ rule, from: match, to: inner });
        return inner;
      });
      if (next === value) break;
      value = next;
    }
  }

  value = dropUnmatchedPairs(value, found);

  if (found.length > 0) {
    const tidy = value.replace(/[ \t]{2,}/g, ' ').trim();
    if (tidy !== value) found.push({ rule: 'whitespace', from: value, to: tidy });
    value = tidy;
  }
  value = value.replace(/(\d+)/g, (_m, index: string) => spans[Number(index)] ?? '');
  return { value, substitutions: found };
}

/** A body rendered as Markdown: only complete wiki links, only outside code. */
export function cleanMarkdown(text: string): Cleaned {
  const found: Substitution[] = [];
  const value = splitCode(text)
    .map((part, index) => (index % 2 === 1 ? part : rewriteWikiLinks(part, found)))
    .join('');
  return { value, substitutions: found };
}

export interface ReviewNote {
  readonly field: string;
  readonly reason: string;
  readonly text: string;
}

/**
 * Whether a table cell looks cut in two at an escaped pipe. Not repaired — the other half is in
 * another column, and which one is a judgement. Reported with the cell left exactly as it is.
 */
export function splitCellReason(text: string): string | null {
  if (/\\\s*$/.test(text)) return 'ends with a backslash: a cell split at an escaped pipe';
  if (/\[\[[^\]]*$/.test(text)) return 'ends inside a wiki link: a cell split at its pipe';
  let depth = 0;
  for (const char of text) {
    if (char === '(') depth += 1;
    else if (char === ')') {
      if (depth === 0) return 'starts mid-parenthesis: the tail of a cell split at an escaped pipe';
      depth -= 1;
    }
  }
  return null;
}

export interface FieldChange {
  readonly field: string;
  readonly before: string | string[];
  readonly after: string | string[];
  readonly substitutions: readonly Substitution[];
}

export interface RowPlan {
  readonly changes: FieldChange[];
  /** Fields left unchanged because a person has to decide. */
  readonly review: ReviewNote[];
}

/**
 * What cleaning a row would change: the fields whose value differs, each with its substitutions,
 * and the cells left for a person. Both empty for a clean row — which is what makes a second run a
 * no-op.
 */
export function planRow(row: Readonly<Record<string, unknown>>, fields: readonly FieldSpec[]): RowPlan {
  const changes: FieldChange[] = [];
  const review: ReviewNote[] = [];
  for (const { name, kind, cell } of fields) {
    const current = row[name];
    if (typeof current === 'string' && cell === true) {
      const reason = splitCellReason(current);
      if (reason !== null) {
        review.push({ field: name, reason, text: current });
        continue;
      }
    }
    if (kind === 'plain-list') {
      if (!Array.isArray(current)) continue;
      const items = current.filter((item): item is string => typeof item === 'string');
      const cleaned = items.map((item) => cleanPlain(item));
      const substitutions = cleaned.flatMap((c) => c.substitutions);
      if (substitutions.length === 0) continue;
      const after = cleaned.map((c) => c.value).filter((value) => value !== '');
      if (after.join('\u0000') === items.join('\u0000')) continue;
      // An alias that was nothing but residue is dropped rather than stored empty.
      changes.push({ field: name, before: items, after, substitutions });
      continue;
    }
    if (typeof current !== 'string') continue;
    const cleaned = kind === 'plain' ? cleanPlain(current) : cleanMarkdown(current);
    if (cleaned.value === current) continue;
    // A field that is nothing but residue stays as it is: an empty title is worse than a marked one.
    if (cleaned.value.trim() === '') continue;
    changes.push({ field: name, before: current, after: cleaned.value, substitutions: cleaned.substitutions });
  }
  return { changes, review };
}
