/**
 * Chart series, the legacy tone shim and the date helper. What a *status* is — its tone and its
 * label — is decided in `status.ts`, the one place (FRM-REQ-241).
 *
 * **Colour is never the only signal.** Every badge carries its word, every chart segment has a
 * legend, and the charts label their own totals (WCAG 1.4.1).
 */

/**
 * Status tones live in `status.ts` (FRM-REQ-241). They are re-exported here under their old names so
 * a screen that has not adopted `status.ts` yet keeps compiling; each now returns a `Badge` tone —
 * neutral, attention, warning or danger — and none is green.
 */
import type { BadgeTone } from './status';
export {
  ciTone,
  findingStatusTone,
  lifecycleTone,
  phaseStatusTone,
  severityTone,
  taskStatusTone,
  type BadgeTone,
} from './status';
/**
 * The legacy five-tone vocabulary (neutral, success, accent, warning, danger), kept only so screens
 * outside FRM-T-18.2 that still say `tone="success"` compile. `toBadgeTone` maps it onto Badge's
 * tones: success and accent become neutral. New code uses `BadgeTone` from `status.ts`.
 *
 * Legacy: use `BadgeTone` from `./status`.
 */
export type Tone = 'neutral' | 'success' | 'accent' | 'warning' | 'danger' | 'attention';

/** Maps any tone the console has ever named onto the tones `Badge` offers (D-016, D-086). */
export function toBadgeTone(tone: Tone): BadgeTone {
  switch (tone) {
    case 'danger':
    case 'warning':
    case 'attention':
      return tone;
    default:
      // success and accent were hue spent on healthy or merely active things; neither needs you.
      return 'neutral';
  }
}

/**
 * The chart palette, as CSS custom properties. Tokens only — the usage gate refuses a hex.
 *
 * Series are **data, not status**: they are kept distinct so a segment can be told from its
 * neighbour, and every segment is also named in text (legend, caption, aria-label), so colour is
 * never how you know. Done work is drawn in the product accent — progress is the thing a ring
 * exists to show, and grey ink made a finished phase look like an empty one (FRM-T-18.16) — but
 * never in the success token, which is status and would make done work a celebration (D-016).
 * Work not started is the track colour, so it reads as empty; `quiet` (cancelled) is darker than
 * the track, which a cancelled segment used to disappear into.
 */
export const SERIES = {
  done: 'var(--color-accent)',
  active: 'var(--color-info)',
  // Not started reads as empty — the track's own colour — so a 0% ring looks empty, not full.
  waiting: 'var(--color-border)',
  blocked: 'var(--color-danger)',
  warning: 'var(--color-warning)',
  info: 'var(--color-info)',
  quiet: 'var(--color-border-field)',
} as const;

/** Human-readable age. `null` is an em dash, never "just now". */
export function relativeDay(iso: string | null): string {
  if (iso === null) return '—';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${String(days)}d ago`;
  if (days < 365) return `${String(Math.floor(days / 30))}mo ago`;
  return `${String(Math.floor(days / 365))}y ago`;
}
