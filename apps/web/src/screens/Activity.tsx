import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  Cluster,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  FilterBar,
  FormField,
  Link,
  Page,
  Select,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { foreman, type CommitRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { ProjectHeader } from '../components/ProjectHeader';
import { refreshSignals } from '../components/shellSignals';

/**
 * S-24 — what actually happened: commits, their attribution proposals, CI and what is deployed.
 *
 * The filter defaults to **Waiting to be reviewed**, because the screen's job is to empty a queue
 * rather than to display a river. The other half of its job is R-02: even with three signals a real
 * share of commits stay unattributed, and a coverage gap nobody can see is one nobody closes — so
 * "Nothing proposed" is a filter here, not a hidden statistic.
 */

const SOURCE_LABEL: Record<string, string> = {
  declared: 'declared by Claude',
  message: 'cited in the message',
  file_overlap: 'files overlap — a hint only',
};

export function Activity({ code }: { code: string }) {
  const [filter, setFilter] = useState<'proposed' | 'none' | 'confirmed' | 'any'>('proposed');
  const commits = useAsync(() => foreman.commits(code, filter), [code, filter]);
  const ci = useAsync(() => foreman.ci(code), [code]);
  const cadence = useAsync(() => foreman.cadence(code), [code]);
  const deployments = useAsync(() => foreman.deployments(code), [code]);
  const [busy, setBusy] = useState<string | null>(null);

  const act = (sha: string, task: string, confirm: boolean) => {
    setBusy(`${sha}:${task}`);
    const call = confirm ? foreman.confirmAttribution : foreman.rejectAttribution;
    void call(code, sha, task)
      .then(() => {
        commits.reload();
        // The sidebar's "Activity, N waiting for review" changed with this answer.
        refreshSignals();
      })
      .finally(() => { setBusy(null); });
  };

  return (
    <Page>
      <ProjectHeader
        code={code}
        section="activity"
        description="Commits, what they were for, and what is running."
      />

      <Cluster gap="16">
        <Card>
          <CardTitle>State</CardTitle>
          <DescriptionList>
            <DescriptionItem term="CI">
              {ci.state.status !== 'ready' ? (
                '—'
              ) : ci.state.value.unknown ? (
                // Grey, never green. A project with nothing ingested is not passing.
                <Badge tone="neutral">unknown</Badge>
              ) : (
                <Badge tone={ci.state.value.conclusion === 'success' ? 'neutral' : 'danger'}>
                  {ci.state.value.conclusion ?? 'unknown'}
                </Badge>
              )}
            </DescriptionItem>
            <DescriptionItem term="Last commit">
              {cadence.state.status !== 'ready' || cadence.state.value.lastCommitAt === null
                ? 'nothing ingested'
                : `${String(cadence.state.value.dormantDays ?? 0)} days ago`}
            </DescriptionItem>
            <DescriptionItem term="Commits" numeric>
              {cadence.state.status !== 'ready'
                ? '—'
                : `${String(cadence.state.value.commitsLast7)} this week · ${String(cadence.state.value.commitsLast30)} this month`}
            </DescriptionItem>
          </DescriptionList>

          {cadence.state.status === 'ready' &&
          cadence.state.value.dormantDays !== null &&
          cadence.state.value.dormantDays > 30 ? (
            // A dormant project is visibly dormant (FRM-REQ-113). Across nineteen projects, the
            // ones that stopped are the ones worth noticing.
            <Alert tone="warning" title="Nothing has landed here in a month">
              {cadence.state.value.dormantDays} days since the last commit.
            </Alert>
          ) : null}
        </Card>

        <Card>
          <CardTitle>Deployed</CardTitle>
          {deployments.state.status !== 'ready' ? (
            <Skeleton lines={3} />
          ) : deployments.state.value.items.length === 0 ? (
            <EmptyState kind="empty" size="inline" heading="No deployment recorded">
              Nothing has reported what it is running.
            </EmptyState>
          ) : (
            <DescriptionList>
              <DescriptionItem term="Environment">
                {deployments.state.value.items[0]?.environment}
              </DescriptionItem>
              <DescriptionItem term="Image">
                <code>{deployments.state.value.items[0]?.imageSha.slice(0, 19)}</code>
              </DescriptionItem>
              <DescriptionItem term="Schema">
                {/* Both, together: the interesting failures are when they disagree. */}
                <code>{deployments.state.value.items[0]?.schemaRevision ?? 'not reported'}</code>
              </DescriptionItem>
              <DescriptionItem term="When">
                {new Date(deployments.state.value.items[0]?.deployedAt ?? '').toLocaleString()}
              </DescriptionItem>
            </DescriptionList>
          )}
        </Card>
      </Cluster>

      <FilterBar
        aria-label="Filter the commits"
        trailing={
          commits.state.status === 'ready' ? (
            <span className="fm-muted">{commits.state.value.total} commits</span>
          ) : null
        }
      >
        <FormField label="Showing">
          <Select
            value={filter}
            onValueChange={(value) => { setFilter(value as typeof filter); }}
            options={[
              { value: 'proposed', label: 'Waiting to be reviewed' },
              { value: 'none', label: 'Nothing proposed' },
              { value: 'confirmed', label: 'Settled' },
              { value: 'any', label: 'Everything' },
            ]}
          />
        </FormField>
      </FilterBar>

      {commits.state.status === 'loading' ? (
        <Skeleton lines={10} />
      ) : commits.state.status === 'error' ? (
        <EmptyState kind="error" heading="The commits did not load">
          {commits.state.message}
        </EmptyState>
      ) : commits.state.value.items.length === 0 ? (
        <EmptyState
          kind={filter === 'proposed' ? 'empty' : 'no-results'}
          heading={filter === 'proposed' ? 'Nothing waiting' : 'No commits match'}
        >
          {filter === 'proposed'
            ? 'Every proposal has been confirmed or rejected.'
            : filter === 'none'
              ? 'Every commit here is accounted for — which is rarer than it sounds.'
              : 'Nothing has been ingested for this project yet.'}
        </EmptyState>
      ) : (
        <Stack gap="12" as="ul" aria-label={`Commits, ${filter}`}>
          {commits.state.value.items.map((commit) => (
            <Commit
              key={commit.sha}
              commit={commit}
              busy={busy}
              onAct={(task, confirm) => { act(commit.sha, task, confirm); }}
            />
          ))}
        </Stack>
      )}
    </Page>
  );
}

function Commit({
  commit,
  busy,
  onAct,
}: {
  commit: CommitRow;
  busy: string | null;
  onAct: (task: string, confirm: boolean) => void;
}) {
  const subject = commit.message.split('\n')[0] ?? '';
  const open = commit.attributions.filter((a) => !a.confirmed && a.rejectedAt === null);

  return (
    <li>
      <Card>
        <Stack gap="8">
          <div>
            <code>{commit.sha.slice(0, 12)}</code> {subject}
            {commit.orphanedAt === null ? null : (
              // Marked, never deleted: something may already cite this SHA.
              <>
                {' '}
                <Badge tone="attention">orphaned by a force push</Badge>
              </>
            )}
          </div>
          <div className="fm-muted">
            {commit.author} · {new Date(commit.committedAt).toLocaleDateString()} ·{' '}
            {commit.repo.fullName}
          </div>

          {commit.attributions.length === 0 ? (
            <span className="fm-muted">
              Nothing proposed — no task cited, and no declared files overlap.
            </span>
          ) : (
            <Stack gap="8" as="ul">
              {commit.attributions.map((attribution) => (
                <li key={attribution.task.humanId}>
                  <Cluster gap="8">
                    <Link href={`/tasks/${attribution.task.humanId}`}>
                      {attribution.task.humanId}
                    </Link>
                    <span>{attribution.task.title}</span>
                    <Badge tone={attribution.confirmed ? 'neutral' : 'attention'}>
                      {attribution.confirmed
                        ? 'confirmed'
                        : attribution.rejectedAt !== null
                          ? 'rejected'
                          : 'proposed'}
                    </Badge>
                    {/* Why it was proposed, in words: confirming a guess you cannot see the
                        reasoning for is just clicking. */}
                    <span className="fm-muted">
                      {SOURCE_LABEL[attribution.source] ?? attribution.source}
                    </span>
                  </Cluster>

                  {attribution.confirmed || attribution.rejectedAt !== null ? null : (
                    <Cluster gap="8">
                      <Button
                        size="sm"
                        variant="primary"
                        loading={busy === `${commit.sha}:${attribution.task.humanId}`}
                        onClick={() => { onAct(attribution.task.humanId, true); }}
                        aria-label={`Confirm ${commit.sha.slice(0, 7)} was work on ${attribution.task.humanId}`}
                      >
                        Confirm
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => { onAct(attribution.task.humanId, false); }}
                        aria-label={`Reject ${attribution.task.humanId} for ${commit.sha.slice(0, 7)}`}
                      >
                        Reject
                      </Button>
                    </Cluster>
                  )}
                </li>
              ))}
            </Stack>
          )}

          {open.length === 0 ? null : (
            <span className="fm-muted">
              {commit.files.length} file{commit.files.length === 1 ? '' : 's'} changed
            </span>
          )}
        </Stack>
      </Card>
    </li>
  );
}
