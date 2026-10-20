import {
  Alert,
  Badge,
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
import { Markdown } from '../components/Markdown';
import { foreman, type FindingDetail as Detail } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { OpenInConstellation } from '../components/OpenInConstellation';
import { HistoryDrawer } from '../components/HistoryDrawer';

/**
 * S-16 — one finding: where it is, what was observed, whether the fix held, and where else it
 * might live.
 *
 * Two things this screen refuses to do. It never renders an unverified fix as green
 * (FRM-REQ-119), and it never presents a recurrence candidate as a conclusion — Foreman proposes
 * by overlap and says so; the judging is done by whoever has the other repository open.
 */

const SEVERITY_TONE: Record<string, 'danger' | 'attention' | 'neutral'> = {
  critical: 'danger',
  high: 'danger',
  medium: 'attention',
  low: 'neutral',
};

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

export function FindingDetail({ humanId }: { humanId: string }) {
  const { state, refresh } = useAsync(() => foreman.finding(humanId), [humanId]);
  const recurrences = useAsync(() => foreman.recurrences(humanId), [humanId]);

  if (state.status === 'loading') {
    return (
      <Page>
        <Skeleton lines={10} />
      </Page>
    );
  }

  if (state.status === 'error') {
    return (
      <Page>
        <EmptyState
          kind={state.notFound ? 'no-results' : 'error'}
          heading={state.notFound ? `Nothing here is called ${humanId}` : 'That finding did not load'}
        >
          {state.notFound ? 'Check the ID, or find it in the inbox.' : state.message}
        </EmptyState>
      </Page>
    );
  }

  const finding = state.value;

  return (
    <Page>
      <PageHeader
        title={finding.title}
        description={`${finding.humanId} · ${finding.project.code}`}
        actions={
          <>
            <Badge tone={SEVERITY_TONE[finding.severity] ?? 'neutral'}>{finding.severity}</Badge>
            <Badge tone={finding.status === 'open' ? 'attention' : 'neutral'}>
              {finding.status}
            </Badge>
            <OpenInConstellation path={`item/${finding.humanId}`} />
            <HistoryDrawer entity={finding.humanId} onUndone={refresh} />
          </>
        }
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
    </Page>
  );
}
