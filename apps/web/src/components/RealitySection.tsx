import { useEffect, useRef } from 'react';
import { Alert, Badge, Card, CardTitle, EmptyState, Skeleton, Stack } from '@d3cloud/ui';
import { foreman, type Reality } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { plainText } from '../lib/text';
import { ciTone, plural } from '../ui/status';
import { dayOf, shortSha } from './RealityStrip';
import './RealitySection.css';

/**
 * What the repo says about a task, or about the tasks that satisfy a requirement (FRM-REQ-247,
 * board D-08): its commits, the CI results on them, and the deployments they are in.
 *
 * **A suggestion is shown as one.** A confirmed attribution is evidence; a proposed one is listed
 * beside it, marked "suggested · not counted yet", because an unconfirmed attribution is never truth
 * (ADR-005). A rejected one is not shown at all.
 *
 * **Absence is said, not hidden.** No commit on a done task is "done on say-so" — neutral, a
 * statement of what the ledger can and cannot show, not an accusation. No CI result is "unknown, not
 * assumed passing". Nothing here is green.
 */

export function RealitySection({
  humanId,
  kind,
  projectCode,
  doneClaimed = false,
  stamp,
}: {
  humanId: string;
  kind: 'task' | 'requirement';
  projectCode: string;
  /** The record says its work is done — so no confirmed commit is "done on say-so". */
  doneClaimed?: boolean;
  /** Changes whenever the record does (its status, its phase): read again, in place. */
  stamp: string;
}) {
  const { state, refresh } = useAsync(
    () => (kind === 'task' ? foreman.taskReality(humanId) : foreman.requirementReality(humanId)),
    [humanId, kind],
  );
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
      <CardTitle>Reality</CardTitle>
      <div className="fm-reality-section">
        {state.status === 'loading' ? (
          <Skeleton lines={3} />
        ) : state.status === 'error' ? (
          <EmptyState kind="error" size="inline" heading="The reality did not load">
            {state.message}
          </EmptyState>
        ) : (
          <RealityBody
            reality={state.value}
            kind={kind}
            projectCode={projectCode}
            doneClaimed={doneClaimed}
          />
        )}
      </div>
    </Card>
  );
}

export function RealityBody({
  reality,
  kind,
  projectCode,
  doneClaimed,
}: {
  reality: Reality;
  kind: 'task' | 'requirement';
  projectCode: string;
  doneClaimed: boolean;
}) {
  const confirmed = reality.commits.filter((commit) => commit.confirmed);
  const waiting = reality.commits.filter((commit) => !commit.confirmed);
  const subject = kind === 'task' ? 'this task' : 'the tasks that satisfy this';

  // CI per commit: only the commits that count, since a result on a suggestion proves nothing about
  // the work. The newest result of each name on a commit.
  const confirmedShas = new Set(confirmed.map((commit) => commit.sha));
  const checks = reality.checks.filter((check) => confirmedShas.has(check.commitSha));
  const deployed = confirmed.filter((commit) => commit.shippedIn !== null);

  return (
    <Stack gap="16">
      {reality.drift.map((item) => (
        <Alert key={`${item.category}:${item.detail}`} tone="warning" title={driftTitle(item.category)}>
          {item.detail}
        </Alert>
      ))}

      <section aria-label="Commits">
        <h3 className="fm-reality-section__heading">
          Commits · {confirmed.length} confirmed
          {waiting.length > 0 ? `, ${String(waiting.length)} waiting` : ''}
        </h3>
        {reality.commits.length === 0 ? (
          <p className="fm-muted">
            {doneClaimed
              ? `None — done on say-so. No commit is attributed to ${subject}.`
              : `None yet. No commit is attributed to ${subject}.`}
          </p>
        ) : (
          <>
            {confirmed.length === 0 && doneClaimed ? (
              <p className="fm-muted">
                None confirmed — done on say-so. {plural(waiting.length, 'suggestion is', 'suggestions are')} waiting.
              </p>
            ) : null}
            <ul className="fm-reality-section__list">
              {reality.commits.map((commit) => (
                <li key={`${commit.sha}:${commit.task}`} className="fm-reality-section__row">
                  <code className="fm-item__id">{commit.sha.slice(0, 7)}</code>
                  <span className="fm-item__title">{plainText(commit.message)}</span>
                  <span className="fm-reality-section__meta">
                    <Badge tone="neutral" size="sm">
                      {commit.confirmed ? 'confirmed' : 'suggested · not counted yet'}
                    </Badge>
                    <span className="fm-muted">
                      {sourceWords(commit.source)}
                      {kind === 'requirement' ? ` · ${commit.task}` : ''} · {dayOf(commit.committedAt)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            {waiting.length > 0 ? (
              <p className="fm-muted">
                Suggestions are made from file paths and are not evidence until confirmed.{' '}
                <a href={`/projects/${projectCode}/activity`}>Review them in Activity</a>.
              </p>
            ) : null}
          </>
        )}
      </section>

      <section aria-label="CI">
        <h3 className="fm-reality-section__heading">CI</h3>
        {confirmed.length === 0 ? (
          <p className="fm-muted">Nothing to report on: no confirmed commit.</p>
        ) : checks.length === 0 ? (
          <p className="fm-muted">
            Never reported. No workflow run for {plural(confirmedShas.size, 'this commit', 'these commits')} has
            posted to Foreman, so whether {confirmedShas.size === 1 ? 'it' : 'they'} passed is unknown — not
            assumed.
          </p>
        ) : (
          <ul className="fm-reality-section__list">
            {checks.map((check) => (
              <li key={`${check.commitSha}:${check.name}`} className="fm-reality-section__row">
                <code className="fm-item__id">{check.commitSha.slice(0, 7)}</code>
                <span className="fm-item__title">{check.name}</span>
                <span className="fm-reality-section__meta">
                  <Badge tone={ciTone(check.conclusion, false)} size="sm">
                    {(check.conclusion ?? 'pending').replace(/_/g, ' ')}
                  </Badge>
                  {check.completedAt === null ? null : (
                    <span className="fm-muted">{dayOf(check.completedAt)}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Deployed">
        <h3 className="fm-reality-section__heading">Deployed</h3>
        {reality.deployments.length === 0 ? (
          <p className="fm-muted">
            {confirmed.length === 0
              ? 'Not deployed, as far as Foreman can tell: no confirmed commit to find in one.'
              : 'Not deployed. No deployment includes these commits.'}
          </p>
        ) : (
          <>
            <ul className="fm-reality-section__list">
              {reality.deployments.map((deployment) => (
                <li key={deployment.id} className="fm-reality-section__row">
                  <code className="fm-item__id">{shortSha(deployment.imageSha)}</code>
                  <span className="fm-item__title">
                    {deployment.environment} · {deployment.via === 'declared' ? 'named by the deploy' : 'contains the commits'}
                  </span>
                  <span className="fm-reality-section__meta">
                    <span className="fm-muted">{dayOf(deployment.deployedAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
            {confirmed.length > deployed.length ? (
              <p className="fm-muted">
                {plural(confirmed.length - deployed.length, 'confirmed commit is', 'confirmed commits are')} on main,
                not yet deployed.
              </p>
            ) : null}
          </>
        )}
      </section>
    </Stack>
  );
}

function sourceWords(source: string): string {
  switch (source) {
    case 'declared':
      return 'declared';
    case 'message':
      return 'ID in message';
    case 'file_overlap':
      return 'path match';
    default:
      return source.replace(/_/g, ' ');
  }
}

function driftTitle(category: Reality['drift'][number]['category']): string {
  switch (category) {
    case 'stale-task':
      return 'Stale task — drift';
    case 'coverage-hole':
      return 'Coverage hole — drift';
    default:
      return 'Drift';
  }
}
