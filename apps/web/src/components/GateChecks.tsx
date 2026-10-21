import { useEffect, useRef } from 'react';
import { Badge, Card, CardTitle, EmptyState, Skeleton, Stack } from '@d3cloud/ui';
import { foreman, type GateFailure, type GateResult } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import './GateChecks.css';

/**
 * A phase as a gate check (FRM-REQ-247, FRM-DA-008, board D-08): the server's exit gate, listed as
 * the checks a phase must pass to be complete.
 *
 * **Verbatim.** `GET /api/projects/:code/phases/:humanId/gate` runs `exitGate()` — the one gate the
 * rollup, a hand-completed phase and the drift engine all ask. It answers with the failures only:
 * a kind, the record at fault and a `detail`. This component prints each failure's kind and detail
 * unedited under the check it belongs to, and derives nothing: whether a check is met is "the
 * server named no failure of its kind". The seven checks and their sentences are the gate's seven
 * failure kinds in the order the gate runs them.
 *
 * A met check is "met", neutral — never green (D-016); a failed one names what stands in the way.
 */

interface Check {
  readonly kind: GateFailure['kind'];
  readonly title: string;
}

/** The gate's checks, in the order `exitGate()` runs them. */
export const GATE_CHECKS: readonly Check[] = [
  { kind: 'no-exit-demo', title: 'An exit demo is recorded' },
  { kind: 'uncovered-must', title: 'Every Must in the phase has a task' },
  { kind: 'no-acceptance-test', title: 'Every Must has an acceptance test' },
  { kind: 'unfinished-task', title: 'Every task is done or cancelled' },
  { kind: 'open-critical', title: 'No critical or high finding open' },
  { kind: 'screen-unreviewed', title: "Every linked screen's latest capture is reviewed" },
  { kind: 'screen-drifted', title: 'No linked screen is marked drifted-fix' },
];

/** Where a failing record lives, so each line is a way in rather than an instruction to look. */
export function failureHref(code: string, failure: GateFailure): string {
  switch (failure.kind) {
    case 'no-exit-demo':
      return `/projects/${code}/phases/${failure.humanId}`;
    case 'uncovered-must':
    case 'no-acceptance-test':
      return `/requirements/${failure.humanId}`;
    case 'unfinished-task':
      return `/tasks/${failure.humanId}`;
    case 'open-critical':
      return `/findings/${failure.humanId}`;
    case 'screen-unreviewed':
    case 'screen-drifted':
      return `/projects/${code}/screens/${failure.humanId}`;
  }
}

/** How many of the gate's checks pass: the kinds the server named no failure of. */
export function checksMet(result: Pick<GateResult, 'failures'>): number {
  const failing = new Set(result.failures.map((failure) => failure.kind));
  return GATE_CHECKS.filter((check) => !failing.has(check.kind)).length;
}

export function GateChecks({
  code,
  phaseHumanId,
  exitDemo,
  stamp,
}: {
  code: string;
  phaseHumanId: string;
  /** The phase's recorded exit demo, shown beside the check it satisfies. */
  exitDemo: string | null;
  /** Changes when a task or the phase does: the gate is asked again, in place. */
  stamp: string;
}) {
  const { state, refresh } = useAsync(() => foreman.gate(code, phaseHumanId), [code, phaseHumanId]);
  // Asked again when a task or the phase moved — in place, so the list keeps its place on screen.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    refresh();
  }, [stamp, refresh]);

  return (
    <Card>
      <CardTitle>Exit gate</CardTitle>
      {state.status === 'loading' ? (
        <Skeleton lines={5} />
      ) : state.status === 'error' ? (
        <EmptyState kind="error" size="inline" heading="The gate did not load">
          {state.message}
        </EmptyState>
      ) : (
        <GateList code={code} result={state.value} exitDemo={exitDemo} />
      )}
    </Card>
  );
}

export function GateList({
  code,
  result,
  exitDemo,
}: {
  code: string;
  result: GateResult;
  exitDemo: string | null;
}) {
  const met = checksMet(result);
  const standing = result.failures.length;
  return (
    <Stack gap="12">
      <p className="fm-gate__summary">
        <strong>
          {met} of {GATE_CHECKS.length} checks pass
        </strong>
        {' · '}
        {standing === 0
          ? 'nothing stands in the way'
          : `${String(standing)} ${standing === 1 ? 'thing stands' : 'things stand'} in the way`}
      </p>
      <ol className="fm-gate" aria-label="Required checks">
        {GATE_CHECKS.map((check) => {
          const failures = result.failures.filter((failure) => failure.kind === check.kind);
          return (
            <li key={check.kind} className="fm-gate__check" data-kind={check.kind}>
              <div className="fm-gate__head">
                <span className="fm-gate__title">{check.title}</span>
                <Badge tone={failures.length === 0 ? 'neutral' : 'danger'} size="sm">
                  {failures.length === 0 ? 'met' : 'not met'}
                </Badge>
                <code className="fm-item__id">{check.kind}</code>
              </div>
              {failures.length === 0 ? (
                check.kind === 'no-exit-demo' && exitDemo !== null ? (
                  <p className="fm-gate__met">{exitDemo}</p>
                ) : null
              ) : (
                <ul className="fm-gate__failures">
                  {failures.map((failure) => (
                    <li key={`${failure.humanId}:${failure.detail}`} className="fm-gate__failure">
                      <a href={failureHref(code, failure)}>
                        <code>{failure.humanId}</code>
                      </a>
                      <span className="fm-gate__detail">{failure.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </Stack>
  );
}
