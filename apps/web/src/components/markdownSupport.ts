/**
 * The parts of the Markdown renderer that need no DOM and no Mermaid, so they can be tested in
 * Node (FRM-T-18.11, FRM-REQ-250).
 */

/**
 * Wrap every table in a horizontal scroll container.
 *
 * A wide table on a phone otherwise overflows its card and drags the whole page sideways. The
 * wrapper is focusable (`tabindex="0"`) because a scrollable region a keyboard cannot reach is a
 * region it cannot read, and named (`role="region"` + `aria-label`) because an unnamed focus stop is
 * announced as nothing. The label is the table's own column headings.
 *
 * Applied to HTML that has already been sanitised, so what it adds is not subject to the sanitiser.
 */
export function wrapTables(html: string): string {
  return html.replace(/<table\b[\s\S]*?<\/table>/g, (table) => {
    const headings = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)]
      .map((match) => (match[1] ?? '').replace(/<[^>]*>/g, '').trim())
      .filter((text) => text !== '');
    const label = headings.length === 0 ? 'Table' : `Table: ${headings.join(', ')}`;
    const safe = label.replace(/"/g, '&quot;');
    return (
      `<div class="fm-table-scroll" role="region" tabindex="0" aria-label="${safe}" ` +
      `style="overflow-x:auto;max-width:100%">${table}</div>`
    );
  });
}

/** The console tokens a diagram is drawn from, by Mermaid theme variable. */
const TOKENS = {
  background: '--color-bg',
  mainBkg: '--color-accent-muted',
  primaryColor: '--color-accent-muted',
  primaryTextColor: '--color-fg',
  primaryBorderColor: '--color-accent',
  nodeBorder: '--color-accent',
  nodeTextColor: '--color-fg',
  secondaryColor: '--color-surface-hover',
  secondaryTextColor: '--color-fg',
  secondaryBorderColor: '--color-border-field',
  tertiaryColor: '--color-surface',
  tertiaryTextColor: '--color-fg',
  tertiaryBorderColor: '--color-border-field',
  lineColor: '--color-fg-muted',
  textColor: '--color-fg',
  titleColor: '--color-fg',
  clusterBkg: '--color-surface',
  clusterBorder: '--color-border-field',
  edgeLabelBackground: '--color-surface',
  noteBkgColor: '--color-warning-muted',
  noteTextColor: '--color-fg',
  noteBorderColor: '--color-warning',
  actorBkg: '--color-accent-muted',
  actorBorder: '--color-accent',
  actorTextColor: '--color-fg',
  actorLineColor: '--color-border-field',
  signalColor: '--color-fg',
  signalTextColor: '--color-fg',
  labelBoxBkgColor: '--color-surface',
  labelBoxBorderColor: '--color-border-field',
  labelTextColor: '--color-fg',
  loopTextColor: '--color-fg',
  activationBkgColor: '--color-surface-hover',
  activationBorderColor: '--color-border-field',
  sequenceNumberColor: '--color-accent-contrast',
  errorBkgColor: '--color-danger-muted',
  errorTextColor: '--color-danger',
} as const;

export type MermaidThemeVariables = Record<keyof typeof TOKENS, string> & {
  darkMode: boolean;
  fontFamily: string;
};

/**
 * Mermaid's theme variables, read from the console's own tokens.
 *
 * Mermaid's built-in `default` theme draws edges in a fixed dark grey on whatever fill the diagram's author chose,
 * which on a navy plate is 1.26:1. A diagram follows the console instead: `theme: 'base'` with every
 * colour taken from the `--color-*` values the page resolves *now*, so light and dark are each the
 * console's own palette and a token change reaches the diagrams without touching this file.
 *
 * `read` is `getComputedStyle(document.documentElement).getPropertyValue` in the browser. A token
 * the page does not define reads as empty and is left out, so Mermaid falls back to its base value
 * for that one rather than being handed an empty colour.
 */
export function mermaidThemeVariables(
  read: (token: string) => string,
  dark: boolean,
): Partial<MermaidThemeVariables> {
  const variables: Partial<MermaidThemeVariables> = { darkMode: dark, fontFamily: 'inherit' };
  for (const [variable, token] of Object.entries(TOKENS)) {
    const value = read(token).trim();
    if (value !== '') (variables as Record<string, unknown>)[variable] = value;
  }
  return variables;
}
