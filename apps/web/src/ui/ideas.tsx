import type { ProjectIdeaRow } from '../lib/api';
import { plural } from './status';

/**
 * The pieces an idea is read by at a glance (FRM-ADR-017): how far it has been thought through,
 * how much it is wanted, and where it sits against every other idea.
 */

/**
 * How much of the thinking is written down, as pips rather than a percentage.
 *
 * Six pips for six sections, because "3 of 6" is a sentence a person can act on — it names how
 * many sections are still blank — and "50%" is a number that sounds like a grade.
 */
export function MaturityBar({ maturity }: { maturity: { filled: number; total: number } }) {
  const label = `${String(maturity.filled)} of ${String(maturity.total)} written`;
  return (
    <div className="fm-maturity" role="img" aria-label={`Thought through: ${label}`}>
      <span className="fm-maturity__pips" aria-hidden="true">
        {Array.from({ length: maturity.total }, (_, i) => (
          <span
            key={i}
            className={i < maturity.filled ? 'fm-maturity__pip fm-maturity__pip--on' : 'fm-maturity__pip'}
          />
        ))}
      </span>
      <span className="fm-muted" aria-hidden="true">
        {label}
      </span>
    </div>
  );
}

/** Excitement, read-only. The number is in the accessible name; the glyphs are for the eye. */
export function Stars({ value }: { value: number }) {
  return (
    <span className="fm-stars" role="img" aria-label={`Excitement ${String(value)} of 5`}>
      <span aria-hidden="true">
        {'★'.repeat(value)}
        <span className="fm-stars__off">{'★'.repeat(5 - value)}</span>
      </span>
    </span>
  );
}

/**
 * Excitement, editable: five toggle buttons, and pressing the current value clears it.
 *
 * Clearing matters. "I have not decided how I feel about this" is a real answer, different from
 * one star, and a control that can only move between one and five cannot say it.
 */
export function StarsControl({
  value,
  onChange,
  disabled = false,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="fm-stars fm-stars--control" role="group" aria-label="Excitement">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={disabled}
          className={value !== null && n <= value ? 'fm-star fm-star--on' : 'fm-star'}
          aria-label={`${String(n)} of 5`}
          aria-pressed={value === n}
          onClick={() => { onChange(value === n ? null : n); }}
        >
          ★
        </button>
      ))}
    </div>
  );
}

// ─── The impact × effort matrix ──────────────────────────────────────────────

/**
 * A dot's radius from excitement: the other half of "what first". Impact and effort say what an
 * idea is worth; how much you want it says whether you will actually start it. Unrated is the
 * smallest, never zero — an idea you have no feeling about is still on the chart.
 */
const radius = (excitement: number | null) => 5 + (excitement ?? 0) * 1.4;

const W = 640;
const H = 420;
const M = { left: 56, right: 16, top: 16, bottom: 52 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

/** A 1–5 score to a pixel, centred in its fifth of the axis so a 1 is not drawn on the frame. */
const x = (effort: number) => M.left + ((effort - 0.5) / 5) * PW;
const y = (impact: number) => M.top + PH - ((impact - 0.5) / 5) * PH;

/**
 * Every rated idea, placed by impact against effort (FRM-REQ-177).
 *
 * The one chart the ideas list earns: its whole question is *which of these first*, and the
 * answer is a position, not a number in a column. Top-left is where to start.
 *
 * **Scores are integers, so ideas collide.** Five ideas rated 4 impact, 2 effort would draw as one
 * dot, which is the chart lying about how many ideas are there. Ideas sharing a point are fanned
 * out in a small ring around it, always in the same order, so the picture is stable between
 * visits and the count is visible.
 *
 * Colour is status, from the console's own tokens; the legend names every status present, so
 * colour is never the only way to tell them apart. Each dot is a link to its idea, with the idea's
 * name as its accessible name and hover title.
 */
export function IdeaMatrix({
  items,
  tone,
  labels,
}: {
  items: readonly ProjectIdeaRow[];
  tone: Record<string, string>;
  labels: readonly { value: string; label: string }[];
}) {
  const rated = items.filter(
    (i): i is ProjectIdeaRow & { score: { impact: number; effort: number } } =>
      i.score !== null && i.score.impact !== null && i.score.effort !== null,
  );
  const unrated = items.length - rated.length;

  // Group by the exact point, to one decimal — a board's mean can be 4.5.
  const groups = new Map<string, typeof rated>();
  for (const idea of rated) {
    const key = `${idea.score.impact.toFixed(1)}:${idea.score.effort.toFixed(1)}`;
    groups.set(key, [...(groups.get(key) ?? []), idea]);
  }

  const dots = [...groups.values()].flatMap((group) =>
    group.map((idea, i) => {
      // Far enough apart that the largest dots in a ring still do not overlap.
      const spread = group.length === 1 ? 0 : 18;
      const angle = (2 * Math.PI * i) / group.length - Math.PI / 2;
      return {
        idea,
        cx: x(idea.score.effort) + spread * Math.cos(angle),
        cy: y(idea.score.impact) + spread * Math.sin(angle),
        // A lone idea is labelled directly; a cluster is not, because six IDs around one point
        // are unreadable. The hover title and the list below carry them instead.
        label: group.length === 1,
      };
    }),
  );

  const present = labels.filter((l) => rated.some((i) => i.status === l.value));
  const nameOf = (status: string) => labels.find((l) => l.value === status)?.label ?? status;

  return (
    <div className="fm-matrix">
      {rated.length === 0 ? (
        <p className="fm-muted">
          Nothing is rated yet. Open an idea and give it an impact and an effort, and it appears
          here.
        </p>
      ) : (
        <div className="fm-matrix__scroll">
          <svg
            viewBox={`0 0 ${String(W)} ${String(H)}`}
            className="fm-matrix__svg"
            role="group"
            aria-label={`${plural(rated.length, 'idea', 'ideas')} by impact and effort`}
          >
            {/* The quadrants, named for what to do with an idea that lands in them. Divided at
                2.5, not 3: a 3 is "high" on both axes everywhere else on the page, and a divider
                drawn through the 3s left those ideas straddling a line the page had already
                decided which side of. */}
            <line x1={x(2.5)} x2={x(2.5)} y1={M.top} y2={M.top + PH} className="fm-matrix__mid" />
            <line x1={M.left} x2={M.left + PW} y1={y(2.5)} y2={y(2.5)} className="fm-matrix__mid" />
            <text x={M.left + 8} y={M.top + 16} className="fm-matrix__quadrant">
              Quick wins
            </text>
            <text x={M.left + PW - 8} y={M.top + 16} textAnchor="end" className="fm-matrix__quadrant">
              Big bets
            </text>
            <text x={M.left + 8} y={M.top + PH - 8} className="fm-matrix__quadrant">
              Fill-ins
            </text>
            <text
              x={M.left + PW - 8}
              y={M.top + PH - 8}
              textAnchor="end"
              className="fm-matrix__quadrant"
            >
              Money pits
            </text>

            {/* Axes: recessive, and in text tokens, never a series colour. */}
            <rect x={M.left} y={M.top} width={PW} height={PH} className="fm-matrix__frame" />
            {[1, 2, 3, 4, 5].map((v) => (
              <g key={v}>
                <text x={x(v)} y={M.top + PH + 18} textAnchor="middle" className="fm-matrix__tick">
                  {v}
                </text>
                <text x={M.left - 10} y={y(v) + 4} textAnchor="end" className="fm-matrix__tick">
                  {v}
                </text>
              </g>
            ))}
            <text x={M.left + PW / 2} y={H - 8} textAnchor="middle" className="fm-matrix__axis">
              Effort →
            </text>
            <text
              transform={`translate(16 ${String(M.top + PH / 2)}) rotate(-90)`}
              textAnchor="middle"
              className="fm-matrix__axis"
            >
              Impact →
            </text>

            {dots.map(({ idea, cx, cy, label }) => (
              <a
                key={idea.id}
                href={`/project-ideas/${idea.humanId}`}
                aria-label={`${idea.humanId}: ${idea.title}. Impact ${String(idea.score.impact)}, effort ${String(idea.score.effort)}, ${nameOf(idea.status)}`}
                className="fm-matrix__dot"
              >
                <title>
                  {`${idea.humanId} — ${idea.title}\nImpact ${String(idea.score.impact)} · Effort ${String(idea.score.effort)} · ${nameOf(idea.status)}`}
                </title>
                {/* The hit target is bigger than the mark: a 14px dot is a hard thing to hover. */}
                <circle cx={cx} cy={cy} r={14} className="fm-matrix__hit" />
                <circle
                  cx={cx}
                  cy={cy}
                  r={radius(idea.excitement)}
                  style={{ fill: tone[idea.status] ?? 'var(--color-fg-muted)' }}
                  className="fm-matrix__mark"
                />
                {label && (
                  <text x={cx + radius(idea.excitement) + 5} y={cy + 4} className="fm-matrix__label">
                    {idea.humanId}
                  </text>
                )}
              </a>
            ))}
          </svg>
        </div>
      )}

      {present.length > 0 && (
        <ul className="fm-legend" aria-label="Status">
          {present.map((l) => (
            <li key={l.value} className="fm-legend__item">
              <span
                className="fm-legend__swatch"
                style={{ background: tone[l.value] ?? 'var(--color-fg-muted)' }}
                aria-hidden="true"
              />
              {l.label}
            </li>
          ))}
        </ul>
      )}
      <p className="fm-muted">Larger dots are ideas you want more.</p>
      {unrated > 0 && (
        <p className="fm-muted">
          {unrated} {unrated === 1 ? 'idea is' : 'ideas are'} not rated yet, and so not on the
          chart.
        </p>
      )}
    </div>
  );
}
