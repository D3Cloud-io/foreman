import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActionBar,
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  Cluster,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  Link,
  Page,
  PageHeader,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { Ban, CircleCheck, Eye, RotateCcw } from 'lucide-react';
import { Markdown } from '../components/Markdown';
import { api, foreman, type Audited, type FindingDetail as Detail } from '../lib/api';
import { statusWords, useMutate } from '../lib/mutate';
import { useAsync } from '../lib/useAsync';
import { OpenInConstellation } from '../components/OpenInConstellation';
import { HistoryDrawer } from '../components/HistoryDrawer';
import { findingStatusTone, severityTone } from '../ui/status';
import { KeyHint, ReasonDialog } from './triage';

/**
 * S-16 — one finding: where it is, what was observed, whether the fix held, and where else it
 * might live.
 *
 * Two things this screen refuses to do. It never renders an unverified fix as green
 * (FRM-REQ-119), and it never presents a recurrence candidate as a conclusion — Foreman proposes
 * by overlap and says so; the judging is done by whoever has the other repository open.
 */

// ─── Verdicts (FRM-T-18.7, FRM-REQ-246) ────────────────────────────────────

/**
 * The four verdicts a finding takes, each one `PATCH …/findings/:humanId` and so one audit event
 * the toast can undo. Acknowledging is the operator saying the finding is real — `verified` becomes
 * `confirmed` — which is the one judgement a reviewing agent cannot make about its own finding.
 */
export type FindingVerdict = 'acknowledge' | 'fixed' | 'reopen' | 'wont-fix';

export interface VerdictTarget {
  readonly humanId: string;
  /** The project's code: the write goes through the project the finding belongs to. */
  readonly project: string;
  readonly status: string;
  readonly verified: string | null;
}

export const VERDICTS: readonly {
  readonly kind: FindingVerdict;
  readonly label: string;
  readonly key: string;
  readonly done: string;
}[] = [
  { kind: 'acknowledge', label: 'Acknowledge', key: 'a', done: 'acknowledged' },
  { kind: 'fixed', label: 'Mark fixed', key: 'f', done: 'marked fixed' },
  { kind: 'reopen', label: 'Reopen', key: 'r', done: 'reopened' },
  { kind: 'wont-fix', label: 'Won’t fix…', key: 'w', done: 'marked won’t fix' },
];

/** Whether a verdict would change anything. One that would not is not offered. */
export function verdictApplies(kind: FindingVerdict, finding: Pick<VerdictTarget, 'status' | 'verified'>): boolean {
  switch (kind) {
    case 'acknowledge':
      return finding.verified !== 'confirmed';
    case 'fixed':
      return finding.status !== 'fixed';
    case 'reopen':
      return finding.status !== 'open';
    case 'wont-fix':
      return finding.status !== 'wont_fix';
  }
}

/** Whether the verdict is the finding's current state — the pressed button. */
export function verdictPressed(kind: FindingVerdict, finding: Pick<VerdictTarget, 'status' | 'verified'>): boolean {
  switch (kind) {
    case 'acknowledge':
      return finding.verified === 'confirmed';
    case 'fixed':
      return finding.status === 'fixed';
    case 'reopen':
      return false;
    case 'wont-fix':
      return finding.status === 'wont_fix';
  }
}

/**
 * Where a Won't fix keeps its reason: with the recommendation it declines, so the reason is on the
 * record itself — read on this page, in the finding's history, and undone with the verdict.
 */
export function withWontFixReason(recommendation: string | null, reason: string): string {
  const line = `**Won’t fix** — ${reason.trim()}`;
  const before = recommendation?.trimEnd() ?? '';
  return before.length === 0 ? line : `${before}\n\n${line}`;
}

/** The PATCH body a verdict sends. */
export function verdictBody(
  kind: FindingVerdict,
  recommendation: string | null = null,
  reason = '',
): { verified?: 'confirmed'; status?: string; recommendationMd?: string } {
  switch (kind) {
    case 'acknowledge':
      return { verified: 'confirmed' };
    case 'fixed':
      return { status: 'fixed' };
    case 'reopen':
      return { status: 'open' };
    case 'wont-fix':
      return { status: 'wont_fix', recommendationMd: withWontFixReason(recommendation, reason) };
  }
}

/** The write itself. Won't fix reads the recommendation first, so the reason is added to it. */
export async function writeVerdict(
  target: Pick<VerdictTarget, 'humanId' | 'project'>,
  kind: FindingVerdict,
  reason = '',
): Promise<Audited<{ status: string; verified: string | null }>> {
  const recommendation = kind === 'wont-fix' ? (await foreman.finding(target.humanId)).recommendationMd : null;
  return api.patch<Audited<{ status: string; verified: string | null }>>(
    `/api/projects/${target.project}/findings/${target.humanId}`,
    verdictBody(kind, recommendation, reason),
  );
}

/** One verdict, the one way: pessimistic, a toast naming it, Undo that reverses it. */
export function useFindingVerdict(): {
  act: (target: VerdictTarget, kind: FindingVerdict, options: { reason?: string; refresh: () => void }) => void;
  pending: boolean;
} {
  const { mutate, pending } = useMutate();
  const act = (target: VerdictTarget, kind: FindingVerdict, options: { reason?: string; refresh: () => void }) => {
    if (pending || !verdictApplies(kind, target)) return;
    const verdict = VERDICTS.find((v) => v.kind === kind);
    void mutate({
      subject: target.humanId,
      run: () => writeVerdict(target, kind, options.reason ?? ''),
      message: () => `${target.humanId} ${verdict?.done ?? statusWords(kind)}`,
      refresh: options.refresh,
      // The sidebar's open-criticals count may have moved.
      signals: true,
      undone:
        kind === 'acknowledge'
          ? `Undone — ${target.humanId} is ${target.verified ?? 'unverified'} again`
          : `Undone — ${target.humanId} is ${statusWords(target.status)} again`,
    });
  };
  return { act, pending };
}

const VERDICT_ICON: Record<FindingVerdict, ReactNode> = {
  acknowledge: <Eye />,
  fixed: <CircleCheck />,
  reopen: <RotateCcw />,
  'wont-fix': <Ban />,
};

/**
 * The verdict controls: buttons with their keys beside the record on a wide screen, and the
 * `@d3cloud/ui` ActionBar — four 44px targets at the foot of the screen — on a phone. `onVerdict`
 * is called with Won't fix too; the caller asks for the reason.
 */
export function FindingVerdicts({
  finding,
  pending,
  onVerdict,
}: {
  finding: VerdictTarget;
  pending: boolean;
  onVerdict: (kind: FindingVerdict) => void;
}) {
  return (
    <>
      <div className="fm-triage__verdicts" role="group" aria-label={`Verdicts on ${finding.humanId}`}>
        {VERDICTS.map((verdict) => (
          <Button
            key={verdict.kind}
            size="sm"
            variant={verdict.kind === 'fixed' && finding.status === 'open' ? 'primary' : 'secondary'}
            {...(verdict.kind === 'fixed' && finding.status === 'open' ? {} : { pressed: verdictPressed(verdict.kind, finding) })}
            disabled={!verdictApplies(verdict.kind, finding)}
            loading={pending}
            onClick={() => {
              onVerdict(verdict.kind);
            }}
          >
            {verdict.label} <KeyHint k={verdict.key} />
          </Button>
        ))}
      </div>
      <ActionBar aria-label={`Verdicts on ${finding.humanId}`} className="fm-triage__actionbar">
        {VERDICTS.map((verdict) => (
          <ActionBar.Item
            key={verdict.kind}
            icon={VERDICT_ICON[verdict.kind]}
            label={verdict.label}
            disabled={pending || !verdictApplies(verdict.kind, finding)}
            {...(verdictPressed(verdict.kind, finding) ? { 'aria-pressed': true } : {})}
            onClick={() => {
              onVerdict(verdict.kind);
            }}
          />
        ))}
      </ActionBar>
    </>
  );
}

/** The fix verdict, in the words a person needs. `unverified` is never dressed as anything else. */
function FixVerdict({ fix }: { fix: Detail['fix'] }) {
  if (fix.verdict === 'none') {
    return (
      <EmptyState kind="empty" size="inline" heading="No fix commit recorded">
        Nothing says which commit dealt with this.
      </EmptyState>
    );
  }

  // No green (D-016): a passing fix is a plain `info` note, its heading says it passed. `warning`
  // covers unverified and running — both mean "not known to have passed", and neither may look like
  // the first.
  const tone = fix.verdict === 'green' ? 'info' : fix.verdict === 'red' ? 'danger' : 'warning';
  const heading =
    fix.verdict === 'green'
      ? 'CI was green on the fix'
      : fix.verdict === 'red'
        ? 'CI failed on the fix'
        : fix.verdict === 'running'
          ? 'CI is still running on the fix'
          : 'The fix is unverified';

  return (
    <Alert tone={tone} title={heading}>
      <Stack gap="8">
        <span>{fix.detail}</span>
        <span className="fm-muted">
          <code>{fix.sha?.slice(0, 12)}</code>
          {fix.ingested ? '' : ' — not ingested'}
        </span>
        {fix.checks.length === 0 ? null : (
          <span className="fm-muted">
            {fix.checks.map((c) => `${c.name}: ${c.conclusion ?? 'running'}`).join(' · ')}
          </span>
        )}
      </Stack>
    </Alert>
  );
}

/**
 * One finding's record — the cards below its heading — loaded by ID. The standalone page and the
 * triage split view both draw this, so a finding reads the same wherever it is ruled on.
 *
 * `refreshKey` changing re-reads it in place (after a verdict made from the list's keys); `onChanged`
 * is told when a verdict made here, or its undo, lands.
 */
export function FindingRecord({
  humanId,
  refreshKey = 0,
  embedded = false,
  onChanged,
  position,
}: {
  humanId: string;
  refreshKey?: number;
  embedded?: boolean;
  onChanged?: () => void;
  /** "1 of 9", for the split view's heading. */
  position?: string;
}) {
  const { state, refresh } = useAsync(() => foreman.finding(humanId), [humanId]);
  const recurrences = useAsync(() => foreman.recurrences(humanId), [humanId]);
  const verdict = useFindingVerdict();
  const [asking, setAsking] = useState(false);

  // A verdict made from the list (a key) re-reads the record in place, never back to a skeleton.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    refresh();
  }, [refreshKey, refresh]);

  const changed = () => {
    refresh();
    onChanged?.();
  };

  if (state.status === 'loading') {
    return embedded ? <Skeleton lines={10} /> : (
      <Page>
        <Skeleton lines={10} />
      </Page>
    );
  }

  if (state.status === 'error') {
    const empty = (
      <EmptyState
        kind={state.notFound ? 'no-results' : 'error'}
        heading={state.notFound ? `Nothing here is called ${humanId}` : 'That finding did not load'}
      >
        {state.notFound ? 'Check the ID, or find it in the inbox.' : state.message}
      </EmptyState>
    );
    return embedded ? empty : <Page>{empty}</Page>;
  }

  const finding = state.value;
  const target: VerdictTarget = {
    humanId: finding.humanId,
    project: finding.project.code,
    status: finding.status,
    verified: finding.verified,
  };
  const onVerdict = (kind: FindingVerdict) => {
    if (kind === 'wont-fix') {
      setAsking(true);
      return;
    }
    verdict.act(target, kind, { refresh: changed });
  };

  const badges = (
    <>
      <Badge tone={severityTone(finding.severity)}>{finding.severity}</Badge>
      <Badge tone={findingStatusTone(finding.status)}>{statusWords(finding.status)}</Badge>
    </>
  );

  const record = (
    <>
      <FindingVerdicts finding={target} pending={verdict.pending} onVerdict={onVerdict} />
      <ReasonDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Won’t fix ${finding.humanId}`}
        description="Say why. The reason is kept with the recommendation it declines, and the verdict can be undone."
        label="Why it will not be fixed"
        confirm="Mark won’t fix"
        onSubmit={(reason) => {
          verdict.act(target, 'wont-fix', { reason, refresh: changed });
        }}
      />

      {finding.verified === 'confirmed' ? null : (
        // The corpus's commonest state, and the one a blank field would quietly flatter.
        <Alert tone="warning" title="Not independently verified">
          This finding carries the reviewing specialist&rsquo;s evidence. Nobody has traced it end
          to end, so treat the severity as a claim rather than a confirmed verdict.
        </Alert>
      )}

      <Card>
        <CardTitle>Where</CardTitle>
        {finding.locations.length === 0 ? (
          <EmptyState kind="empty" size="inline" heading="Not pinned to a file" />
        ) : (
          <Stack gap="8" as="ul">
            {finding.locations.map((location) => (
              <li key={location.path}>
                <code>
                  {location.path}
                  {location.lines === null ? '' : `:${location.lines}`}
                </code>
                {location.note === null ? null : (
                  <span className="fm-muted"> — {location.note}</span>
                )}
              </li>
            ))}
          </Stack>
        )}
        {finding.locationRaw === null ? null : (
          // The authored text, kept beside the parse: it says things no parse holds.
          <div className="fm-muted">as written: {finding.locationRaw}</div>
        )}
      </Card>

      <Card>
        <CardTitle>What was observed</CardTitle>
        {finding.observedMd === null ? (
          <EmptyState kind="empty" size="inline" heading="Nothing recorded" />
        ) : (
          <Markdown>{finding.observedMd}</Markdown>
        )}
      </Card>

      {finding.recommendationMd === null ? null : (
        <Card>
          <CardTitle>Recommendation</CardTitle>
          <Markdown>{finding.recommendationMd}</Markdown>
        </Card>
      )}

      <Card>
        <CardTitle>The fix</CardTitle>
        <FixVerdict fix={finding.fix} />
      </Card>

      <Card>
        <CardTitle>Context</CardTitle>
        <DescriptionList>
          <DescriptionItem term="Found by">
            {finding.lenses.length === 0 ? '—' : finding.lenses.join(', ')}
            {finding.foundRound === null ? '' : ` · round ${String(finding.foundRound)}`}
          </DescriptionItem>
          <DescriptionItem term="Confidence">{finding.confidence ?? '—'}</DescriptionItem>
          <DescriptionItem term="Effort">{finding.effort ?? '—'}</DescriptionItem>
          <DescriptionItem term="Audit">
            {finding.audit === null ? (
              '—'
            ) : (
              <Link href={`/projects/${finding.project.code}/audits`}>
                {finding.audit.humanId} · {finding.audit.kind.replace(/_/g, ' ')}
              </Link>
            )}
          </DescriptionItem>
          {finding.adr === null ? null : (
            <DescriptionItem term="Contradicts">
              <Link href={`/projects/${finding.project.code}/adrs`}>{finding.adr.humanId}</Link> —{' '}
              {finding.adr.title}
            </DescriptionItem>
          )}
          {finding.requirement === null ? null : (
            <DescriptionItem term="Violates">
              <Link href={`/requirements/${finding.requirement.humanId}`}>
                {finding.requirement.humanId}
              </Link>
            </DescriptionItem>
          )}
        </DescriptionList>
      </Card>

      <Card>
        <CardTitle>Might this be true elsewhere?</CardTitle>
        {recurrences.state.status !== 'ready' ? (
          <Skeleton lines={3} />
        ) : recurrences.state.value.candidates.length === 0 ? (
          <EmptyState kind="empty" size="inline" heading="No similar finding in another project">
            Nothing else in the portfolio looks like this one.
          </EmptyState>
        ) : (
          <Stack gap="12">
            <Stack gap="8" as="ul">
              {recurrences.state.value.candidates.map((candidate) => (
                <li key={candidate.humanId}>
                  <Cluster gap="8">
                    <Badge tone="neutral">{candidate.project}</Badge>
                    <Link href={`/findings/${candidate.humanId}`}>{candidate.humanId}</Link>
                    <span>{candidate.title}</span>
                  </Cluster>
                  {/* The evidence, not just the score: a number nobody can check is a number
                      nobody trusts. */}
                  <div className="fm-muted">
                    {[
                      candidate.because.lenses.length > 0
                        ? `same lens: ${candidate.because.lenses.join(', ')}`
                        : null,
                      candidate.because.words.length > 0
                        ? `shared words: ${candidate.because.words.slice(0, 6).join(', ')}`
                        : null,
                      candidate.because.pathShapes.length > 0
                        ? `same area: ${candidate.because.pathShapes.join(', ')}`
                        : null,
                    ]
                      .filter((part) => part !== null)
                      .join(' · ')}
                  </div>
                </li>
              ))}
            </Stack>
            <span className="fm-muted">
              {/* Said on the screen, not only in the payload: whoever reads this is being handed
                  something to judge, and should know nothing judged it first. */}
              Proposed by {recurrences.state.value.method}. Foreman does not decide whether these
              are the same problem — open the other project and look.
            </span>
          </Stack>
        )}
      </Card>
    </>
  );

  if (embedded) {
    return (
      <Stack gap="16" className="fm-triage__record">
        <div className="fm-triage__meta">
          {badges}
          <Link href={`/findings/${finding.humanId}`}>
            <code>{finding.humanId}</code>
          </Link>
          <span className="fm-muted">
            {finding.project.name}
            {finding.lenses.length === 0 ? '' : ` · ${finding.lenses.join(', ')}`}
          </span>
          {position === undefined ? null : <span className="fm-muted fm-triage__position">{position}</span>}
        </div>
        <h2 className="fm-triage__title">{finding.title}</h2>
        <Cluster gap="8">
          <HistoryDrawer entity={finding.humanId} onUndone={changed} />
        </Cluster>
        {record}
      </Stack>
    );
  }

  return (
    <Page>
      <PageHeader
        title={finding.title}
        description={`${finding.humanId} · ${finding.project.code}`}
        actions={
          <>
            {badges}
            <OpenInConstellation path={`item/${finding.humanId}`} />
            <HistoryDrawer entity={finding.humanId} onUndone={changed} />
          </>
        }
      />
      {record}
    </Page>
  );
}

export function FindingDetail({ humanId }: { humanId: string }) {
  return <FindingRecord humanId={humanId} />;
}
