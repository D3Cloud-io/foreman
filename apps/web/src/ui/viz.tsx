import type * as React from 'react';
import type { ReactNode } from 'react';
import { Badge, Card, Stack } from '@d3cloud/ui';
import type { Signal } from './status';
import { toBadgeTone, type Tone } from './tone';

/**
 * The charts the console needs, and nothing more.
 *
 * `@d3cloud/ui` has no chart component and should not grow one for this: these are four shapes
 * drawn from numbers Foreman already computes. A charting library would be ~50 KB, a second
 * theming system to keep in step with the tokens, and a Content-Security-Policy conversation.
 *
 * Three rules hold across all of them:
 *
 * - **Colour comes from system tokens**, never a literal, so light and dark follow the console
 *   instead of a second palette. The usage gate refuses a hex, which is the right refusal.
 * - **Every chart states its own numbers**, in a legend, a centre label or a caption. A chart is
 *   a faster way to read a figure, never the only way — and a screen reader gets `role="img"`
 *   with a sentence rather than a shrug.
 * - **Zero is drawn, not hidden.** An empty ring and a bar of one flat colour both say "nothing
 *   here", and a chart that vanishes when its data is zero looks like a chart that failed.
 */

export interface Segment {
  readonly label: string;
  readonly value: number;
  readonly color: string;
}

const sum = (segments: readonly Segment[]): number =>
  segments.reduce((total, segment) => total + segment.value, 0);

/**
 * A completion ring with the figure in the middle.
 *
 * The number is the point; the ring is how fast you see roughly where it is without reading. Drawn
 * as a stroked circle with `stroke-dasharray` rather than arc paths — one element per segment, no
 * trigonometry to get wrong at 0% and 100%.
 */
export function Donut({
  segments,
  label,
  caption,
  size = 104,
  legend = false,
}: {
  segments: readonly Segment[];
  /** The figure in the centre. Usually a percentage or a count. */
  label: ReactNode;
  /** The small line under it. */
  caption?: ReactNode;
  size?: number;
  /** Name every segment and its count in text beside the ring — colour is never the only signal. */
  legend?: boolean;
}) {
  const total = sum(segments);
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const described = segments
    .filter((segment) => segment.value > 0)
    .map((segment) => `${segment.label}: ${String(segment.value)}`)
    .join(', ');

  let offset = 0;

  const ring = (
    <div className="fm-donut" style={{ width: size, height: size }}>
      <svg
        viewBox="0 0 100 100"
        width={size}
        height={size}
        role="img"
        aria-label={described === '' ? 'Nothing recorded yet' : described}
      >
        {/* The track. Always drawn, so an empty chart reads as empty rather than as broken. */}
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth="10"
        />
        {total > 0 &&
          segments.map((segment) => {
            const length = (segment.value / total) * circumference;
            const dash = `${String(length)} ${String(circumference - length)}`;
            // -90deg so the first segment starts at twelve o'clock, which is where a reader
            // expects a ring to begin.
            const rotation = (offset / circumference) * 360 - 90;
            offset += length;
            if (segment.value === 0) return null;
            return (
              <circle
                key={segment.label}
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                stroke={segment.color}
                strokeWidth="10"
                strokeDasharray={dash}
                transform={`rotate(${String(rotation)} 50 50)`}
              />
            );
          })}
      </svg>
      <div className="fm-donut__centre">
        <span className="fm-donut__label">{label}</span>
        {caption !== undefined && <span className="fm-donut__caption">{caption}</span>}
      </div>
    </div>
  );

  if (!legend) return ring;
  return (
    <div className="fm-donut-with-legend">
      {ring}
      <Legend segments={segments} />
    </div>
  );
}

/**
 * A stacked bar with a legend, for a distribution across a handful of states.
 *
 * Better than a ring when the question is "what is the mix" rather than "how far along", and it
 * carries its own counts so the legend is the table you would otherwise have written.
 */
export function SegmentBar({
  segments,
  height = 8,
  showLegend = true,
}: {
  segments: readonly Segment[];
  height?: number;
  showLegend?: boolean;
}) {
  const total = sum(segments);
  const present = segments.filter((segment) => segment.value > 0);
  const described =
    present.length === 0
      ? 'Nothing recorded yet'
      : present.map((s) => `${s.label}: ${String(s.value)}`).join(', ');

  return (
    <Stack gap="8">
      <div
        className="fm-bar"
        style={{ height }}
        role="img"
        aria-label={described}
      >
        {total === 0 ? (
          <span className="fm-bar__empty" />
        ) : (
          present.map((segment) => (
            <span
              key={segment.label}
              className="fm-bar__segment"
              style={{
                width: `${String((segment.value / total) * 100)}%`,
                background: segment.color,
              }}
            />
          ))
        )}
      </div>
      {showLegend && <Legend segments={segments} />}
    </Stack>
  );
}

/**
 * The text that names every segment and its count — one entry per label, so a series passed twice
 * (Cancelled was listed twice on the old dashboard) is said once, with its counts added.
 */
export function Legend({ segments }: { segments: readonly Segment[] }) {
  const merged = new Map<string, Segment>();
  for (const segment of segments) {
    const seen = merged.get(segment.label);
    merged.set(
      segment.label,
      seen === undefined ? segment : { ...seen, value: seen.value + segment.value },
    );
  }
  return (
    <ul className="fm-legend">
      {[...merged.values()].map((segment) => (
        <li key={segment.label} className="fm-legend__item">
          <span className="fm-legend__swatch" style={{ background: segment.color }} aria-hidden="true" />
          {segment.label}
          <span className="fm-legend__value">{segment.value}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Activity over time, as a row of bars.
 *
 * Deliberately unlabelled on the x axis: the shape is the message — steady, spiky, or stopped —
 * and dates under fourteen bars are noise. The `aria-label` carries the total and the span.
 */
export function ActivityBars({
  values,
  label,
  height = 36,
}: {
  values: readonly number[];
  label: string;
  height?: number;
}) {
  const peak = Math.max(1, ...values);

  return (
    <div className="fm-spark" style={{ height }} role="img" aria-label={label}>
      {values.map((value, index) => (
        <span
          key={index}
          className="fm-spark__bar"
          style={{
            height: `${String(Math.max(value === 0 ? 2 : 8, (value / peak) * 100))}%`,
            background: value === 0 ? 'var(--color-border)' : 'var(--color-accent)',
          }}
        />
      ))}
    </div>
  );
}

/**
 * A labelled horizontal bar, for comparing projects against each other.
 *
 * The value sits at the end of the row rather than inside the bar, so a bar too short to hold its
 * own number still reads — which is every row with a small value, i.e. the interesting ones.
 */
export function BarRow({
  label,
  value,
  max,
  color = 'var(--color-accent)',
  href,
}: {
  label: ReactNode;
  value: number;
  max: number;
  color?: string;
  href?: string;
}) {
  const width = max <= 0 ? 0 : (value / max) * 100;
  const body = (
    <>
      <span className="fm-barrow__label">{label}</span>
      <span className="fm-barrow__track">
        <span className="fm-barrow__fill" style={{ width: `${String(width)}%`, background: color }} />
      </span>
      <span className="fm-barrow__value">{value}</span>
    </>
  );

  return href === undefined ? (
    <div className="fm-barrow">{body}</div>
  ) : (
    <a className="fm-barrow fm-barrow--link" href={href}>
      {body}
    </a>
  );
}

/**
 * One number, said loudly, and honestly (FRM-REQ-241).
 *
 * `signal` is the three-state reading from `status.ts`: its badge carries the word (needs you, clean,
 * not measurable yet) and decides how the figure is inked — danger or warning only when it needs you,
 * muted when it is not measurable yet, plain ink when clean. There is no green. `tone` is the older
 * hand-set tint, kept for screens that have not adopted `signal`; success and accent are plain ink.
 *
 * Below `md` (FRM-REQ-249) a card is one line — the label, then the figure and its badge — so four of
 * them do not fill a phone's first screen. The detail, chart and action are kept for a screen reader
 * and drawn again from `md`: nothing is removed from the DOM, and the semantics do not change.
 *
 * A `href` makes the whole card the target, because a statistic you cannot click is a statistic you
 * have to go and find; `action` names where it goes ("Open these 3 findings").
 */
export function StatCard({
  label,
  value,
  detail,
  tone = 'neutral',
  signal,
  action,
  href,
  onClick,
  selected = false,
  chart,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: Tone;
  signal?: Signal;
  /** The filtered list the card opens, in words. Shown only when the card has an `href`. */
  action?: string;
  href?: string;
  /** Makes the card a button — a figure that is also the control that filters to it. */
  onClick?: () => void;
  selected?: boolean;
  /** An optional visual under the figure — a bar, a sparkline. */
  chart?: ReactNode;
}) {
  const behaviour =
    href !== undefined
      ? { href, interactive: true as const }
      : onClick !== undefined
        ? {
            interactive: true as const,
            selected,
            onClick,
            role: 'button',
            tabIndex: 0,
            'aria-pressed': selected,
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick();
              }
            },
          }
        : {};

  const valueTone =
    signal === undefined
      ? toBadgeTone(tone)
      : signal.state === 'not-measurable'
        ? 'muted'
        : signal.state === 'needs-you'
          ? signal.tone
          : 'neutral';

  return (
    <Card padding="md" className="fm-stat" {...behaviour}>
      <Stack gap="4" className="fm-stat__body">
        <span className="fm-stat__label">{label}</span>
        <span className="fm-stat__row">
          <span className={`fm-stat__value fm-stat__value--${valueTone}`}>{value}</span>
          {signal !== undefined && (
            <Badge tone={signal.tone} size="sm" className="fm-badge">
              {signal.label}
            </Badge>
          )}
        </span>
        {detail !== undefined && <span className="fm-stat__detail">{detail}</span>}
        {chart !== undefined && <div className="fm-stat__chart">{chart}</div>}
        {href !== undefined && action !== undefined && (
          <span className="fm-stat__action">{action} ›</span>
        )}
      </Stack>
    </Card>
  );
}

/**
 * A status badge for screens that have not moved to `Badge` and `status.ts` yet.
 *
 * It is `@d3cloud/ui`'s `Badge` now (D-016, D-086): neutral, attention, warning or danger, never
 * green. The legacy `success` and `accent` tones are still accepted so those screens compile, and
 * both render neutral — a healthy or merely active thing does not need you. New code uses `Badge`
 * directly with a tone from `status.ts`.
 *
 * The word is always present. The colour is how fast you read it, never how you know what it says.
 */
export function Pill({
  tone = 'neutral',
  children,
  dot = false,
}: {
  tone?: Tone;
  children: ReactNode;
  /** A leading dot, for a badge sitting in running text. */
  dot?: boolean;
}) {
  return (
    <Badge tone={toBadgeTone(tone)} size="sm" className="fm-badge">
      {dot && <span className="fm-pill__dot" aria-hidden="true" />}
      {children}
    </Badge>
  );
}
