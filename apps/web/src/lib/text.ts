/**
 * Plain text out of a string that may carry markdown.
 *
 * Titles imported from the vault are markdown source — `**Golden corpus + OCR accuracy report**`,
 * `~~Cloud replication~~ · **Promoted to [[Phase 13]]**`. Rendering that verbatim in a one-line row
 * shows the asterisks, and rendering it *as* markdown in a table cell brings block elements into a
 * row that is one line tall.
 *
 * So: strip the syntax for compact contexts, and leave the stored value alone. The document body
 * is still rendered as markdown where it belongs — this is only for a title in a list.
 *
 * Deliberately small. A full parse would pull a library in to make a heading shorter, and the
 * cases that actually occur in the corpus are these five.
 */
export function plainText(input: string): string {
  return input
    // `[[Vault/Path|Label]]` and `[[Label]]` — the label is what a reader wants.
    .replace(/\[\[([^\]|]*\|)?([^\]]+)\]\]/g, '$2')
    // `[label](href)`
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Emphasis, strong, strikethrough and code, in any nesting.
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)\*(\S)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

const DATE: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };
const DATE_TIME: Intl.DateTimeFormatOptions = { ...DATE, hour: 'numeric', minute: '2-digit' };

/**
 * The one date format on every screen (FRM-DA-012): the operator's locale, one explicit shape —
 * `Aug 30, 2026` in en-US. A bare `toLocaleDateString()` is a different shape per browser; a sliced
 * ISO string is a shape no one reads aloud.
 *
 * A date with no time (`2026-08-30`) is a calendar day, not an instant, so it is read in UTC and
 * never slides to the day before in a western time zone. Anything unparseable is a dash, not a throw.
 */
export function formatDate(iso: string): string {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, day ? { ...DATE, timeZone: 'UTC' } : DATE).format(at);
}

/** `formatDate` with the time of day, for an instant that is an event rather than a day. */
export function formatDateTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, DATE_TIME).format(at);
}

/** The time of day alone, in the operator's locale: `2:02 PM`. For "first call at …", not for a record. */
export function formatTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at);
}

/** How long ago, in whole days and in words: `today`, `1 day ago`, `12 days ago`. */
export function daysAgo(days: number): string {
  return days <= 0 ? 'today' : `${days} ${days === 1 ? 'day' : 'days'} ago`;
}
