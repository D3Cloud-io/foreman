/**
 * The substitution rules behind `clean-markup` (FRM-T-18.11, FRM-REQ-250), kept apart from the CLI
 * so they can be tested without a database — and so importing them runs nothing.
 *
 * Two kinds of field, and a different rule for each:
 *
 * - **plain** — a title, a term, a tripwire: text the console prints with `{value}`. Every marker is
 *   residue there, so `**x**` becomes `x`, backticks go, and a vault wiki link becomes its label.
 * - **markdown** — a body the console renders as Markdown. `**x**` and backticks are *meaning*
 *   there and are left alone; only a complete `[[wiki link]]`, which no Markdown renderer
 *   understands and so prints literally, is rewritten — and never inside a code span or fence,
 *   where `[[` is code. A stray `]]` in a body is left: it may be `a[b[0]]`, and a report that
 *   cannot tell is better than a rewrite that guesses.
 */

export type FieldKind = 'plain' | 'markdown' | 'plain-list';

export interface FieldSpec {
  readonly name: string;
  readonly kind: FieldKind;
}

export type Rule = 'wiki-link' | 'bold' | 'backtick' | 'stray-brackets' | 'whitespace';

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
  const name = (note === '' ? heading : (note.split('/').pop() ?? note)).replace(/\.md$/i, '').trim();
  return name;
}

const WIKI_LINK = /!?\[\[([^[\]\n]+)\]\]/g;

function rewriteWikiLinks(text: string, found: Substitution[]): string {
  return text.replace(WIKI_LINK, (match, inner: string) => {
    const to = wikiLinkText(inner);
    // A link with nothing to show is removed rather than replaced with nothing-shaped text.
    found.push({ rule: 'wiki-link', from: match, to });
    return to;
  });
}

/** Split into prose (even indexes) and code (odd indexes): fences first, then inline spans. */
function splitCode(text: string): string[] {
  return text.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)/);
}

/** A plain-text field: every marker is residue. */
export function cleanPlain(text: string): Cleaned {
  const found: Substitution[] = [];
  let value = rewriteWikiLinks(text, found);

  // `**x**` pairs, repeatedly (a pair can wrap another), then any `**` left over — a title cut off
  // mid-bold keeps its opening marker and nothing to close it.
  for (;;) {
    const next = value.replace(/\*\*([^*\n]+?)\*\*/g, (match, inner: string) => {
      found.push({ rule: 'bold', from: match, to: inner });
      return inner;
    });
    if (next === value) break;
    value = next;
  }
  value = value.replace(/\*\*/g, () => {
    found.push({ rule: 'bold', from: '**', to: '' });
    return '';
  });

  // Stray brackets are removed outside code spans only: `x[i[0]]` in backticks is code.
  value = splitCode(value)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(/\[\[|\]\]/g, (match) => {
            found.push({ rule: 'stray-brackets', from: match, to: '' });
            return '';
          }),
    )
    .join('');

  value = value.replace(/`+/g, (match) => {
    found.push({ rule: 'backtick', from: match, to: '' });
    return '';
  });

  if (found.length > 0) {
    const tidy = value.replace(/[ \t]{2,}/g, ' ').trim();
    if (tidy !== value) found.push({ rule: 'whitespace', from: value, to: tidy });
    value = tidy;
  }
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

export interface FieldChange {
  readonly field: string;
  readonly before: string | string[];
  readonly after: string | string[];
  readonly substitutions: readonly Substitution[];
}

/**
 * What cleaning a row would change: the fields whose value differs, each with its substitutions.
 * `null` when nothing does — which is what makes a second run a no-op.
 */
export function planRow(row: Readonly<Record<string, unknown>>, fields: readonly FieldSpec[]): FieldChange[] | null {
  const changes: FieldChange[] = [];
  for (const { name, kind } of fields) {
    const current = row[name];
    if (kind === 'plain-list') {
      if (!Array.isArray(current)) continue;
      const items = current.filter((item): item is string => typeof item === 'string');
      const cleaned = items.map((item) => cleanPlain(item));
      const substitutions = cleaned.flatMap((c) => c.substitutions);
      if (substitutions.length === 0) continue;
      // An alias that was nothing but residue is dropped rather than stored empty.
      changes.push({
        field: name,
        before: items,
        after: cleaned.map((c) => c.value).filter((value) => value !== ''),
        substitutions,
      });
      continue;
    }
    if (typeof current !== 'string') continue;
    const cleaned = kind === 'plain' ? cleanPlain(current) : cleanMarkdown(current);
    if (cleaned.value === current) continue;
    // A field that is nothing but residue stays as it is: an empty title is worse than a marked one.
    if (cleaned.value.trim() === '') continue;
    changes.push({ field: name, before: current, after: cleaned.value, substitutions: cleaned.substitutions });
  }
  return changes.length === 0 ? null : changes;
}
