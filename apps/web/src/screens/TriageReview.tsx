import { useState } from 'react';
import {
  ActionBar,
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  Checkbox,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  Link,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { Check, X } from 'lucide-react';
import type { ProposedAttribution } from '@foreman/shared';
import { foreman } from '../lib/api';
import { useMutate } from '../lib/mutate';
import { useAsync, type AsyncHandle } from '../lib/useAsync';
import { relativeDay } from '../ui/tone';
import {
  KeyHint,
  SplitView,
  TriageRow,
  effectiveSelection,
  moveSelection,
  select,
  selectionOf,
  useScrollToSelected,
  useTriageKeys,
} from './triage';
import { formatDateTime } from '../lib/text';

/**
 * The Review tab of `/findings` (FRM-T-18.7): every attribution an agent or the ingest pass proposed
 * and nobody has ruled on, across the scope, newest first — `GET /api/attributions`.
 *
 * Confirm (y) or Reject (n), and the next proposal is selected — auto-advance, on by default and
 * shown as a setting, so the operator always knows why the selection moved. A ruled-on row stays in
 * the list for this visit, dimmed, saying what was decided.
 *
 * **No Undo here.** The server does not yet reverse a commit's attribution (FRM-T-18.14 will), so
 * the toast offers none rather than an Undo that would only be refused.
 */

export type Ruling = 'confirmed' | 'rejected';

export interface ReviewItem extends ProposedAttribution {
  /** Ruled on during this visit. */
  readonly decided?: Ruling;
}

export interface ReviewQueue extends AsyncHandle<{ items: ReviewItem[]; total: number }> {
  /** Still waiting: the server's whole count, less what was ruled on during this visit. */
  readonly waiting: number;
  readonly decide: (key: string, ruling: Ruling) => void;
}

/** A proposal's key in the URL: a commit may be proposed for more than one task. */
export function reviewKey(item: Pick<ProposedAttribution, 'commit' | 'task'>): string {
  return `${item.commit.sha.slice(0, 12)}~${item.task.humanId}`;
}

/** The next proposal still waiting after `key`, wrapping to the first; null when none is left. */
export function nextWaiting(items: readonly ReviewItem[], key: string): string | null {
  const at = items.findIndex((item) => reviewKey(item) === key);
  const order = [...items.slice(at + 1), ...items.slice(0, Math.max(0, at))];
  const next = order.find((item) => item.decided === undefined);
  return next === undefined ? null : reviewKey(next);
}

export const SOURCE_LABEL: Record<string, string> = {
  declared: 'declared by an agent',
  message: 'cited in the commit message',
  file_overlap: 'files overlap — a hint only',
};

/** The commit's checks, in words. Nothing reported is said as such, never as passing. */
export function checksWords(checks: ProposedAttribution['commit']['checks']): string {
  if (checks.length === 0) return 'No CI reported';
  if (checks.some((c) => c.conclusion === 'failure' || c.conclusion === 'timed_out')) return 'CI failing';
  if (checks.some((c) => c.conclusion === null)) return 'CI running';
  return checks.every((c) => c.conclusion === 'success' || c.conclusion === 'skipped' || c.conclusion === 'neutral')
    ? 'CI passing'
    : `CI ${checks.map((c) => `${c.name}: ${c.conclusion ?? 'running'}`).join(', ')}`;
}

/** The queue across the scope, narrowed to one project when `?project=` names one (FRM-T-18.15). */
export function useReviewQueue(scope: string | null, project: string | null = null): ReviewQueue {
  const handle = useAsync(async () => {
    const page = await foreman.attributionsAcross(scope, project);
    return { items: [...page.items] as ReviewItem[], total: page.total };
  }, [scope, project]);
  const decided = handle.state.status === 'ready' ? handle.state.value.items.filter((i) => i.decided !== undefined).length : 0;
  return {
    ...handle,
    waiting: handle.state.status === 'ready' ? Math.max(0, handle.state.value.total - decided) : 0,
    decide: (key, ruling) => {
      handle.update((value) => ({
        ...value,
        items: value.items.map((item) => (reviewKey(item) === key ? { ...item, decided: ruling } : item)),
      }));
    },
  };
}

export function ReviewTab({ search, queue, phrase }: { search: string; queue: ReviewQueue; phrase: string | null }) {
  const items = queue.state.status === 'ready' ? queue.state.value.items : [];
  const keys = items.map(reviewKey);
  const selected = selectionOf(search);
  const shown = effectiveSelection(keys, selected);
  const picked = selected !== null && keys.includes(selected);
  const item = items.find((i) => reviewKey(i) === shown) ?? null;
  useScrollToSelected(shown);

  const [advance, setAdvance] = useState(true);
  const { mutate, pending } = useMutate();

  const rule = (ruling: Ruling) => {
    if (item === null || item.decided !== undefined || pending) return;
    const key = reviewKey(item);
    const sha = item.commit.sha;
    const task = item.task.humanId;
    const call = ruling === 'confirmed' ? foreman.confirmAttribution : foreman.rejectAttribution;
    void mutate({
      subject: `${sha.slice(0, 7)} → ${task}`,
      run: () => call(item.project.code, sha, task),
      message: () => `${ruling === 'confirmed' ? 'Confirmed' : 'Rejected'} ${sha.slice(0, 7)} → ${task}${advance ? ' · moved to the next' : ''}`,
      apply: () => {
        queue.decide(key, ruling);
        if (advance) {
          const next = nextWaiting(items, key);
          if (next !== null) select(search, next);
        }
      },
      // The sidebar's "waiting for review" changed with this answer.
      signals: true,
      // Undo puts the proposal back (FRM-T-18.14); the queue is read again, in place, to list it. The
      // write itself does not re-read: a ruled row stays, marked, so the reviewer keeps their place.
      undone: `${sha.slice(0, 7)} → ${task} is waiting for review again`,
      onUndone: () => { queue.refresh(); },
    });
  };

  useTriageKeys((key) => {
    switch (key) {
      case 'next':
      case 'previous':
        select(search, moveSelection(keys, shown, key === 'next' ? 1 : -1));
        return true;
      case 'confirm':
        rule('confirmed');
        return true;
      case 'reject':
        rule('rejected');
        return true;
      default:
        return false;
    }
  });

  if (queue.state.status === 'loading') return <Skeleton lines={8} />;
  if (queue.state.status === 'error') {
    return (
      <EmptyState kind="error" heading="The review queue did not load">
        {queue.state.message}
      </EmptyState>
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState kind="empty" heading={phrase === null ? 'Nothing waiting for review' : `Nothing waiting for review across ${phrase}`}>
        Every proposed attribution has been confirmed or rejected.
      </EmptyState>
    );
  }

  const ruled = items.filter((i) => i.decided === 'confirmed').length;
  const list = (
    <>
      <div className="fm-triage__list-head" aria-live="polite">
        <strong>{queue.waiting} waiting</strong> · attributions proposed and not yet ruled on
        {ruled > 0 ? ` · ${String(ruled)} confirmed this visit` : ''}
      </div>
      <ul className="fm-triage__rows" aria-label="Proposed attributions">
        {items.map((i) => {
          const key = reviewKey(i);
          return (
            <TriageRow
              key={key}
              id={key}
              selected={key === shown}
              dim={i.decided !== undefined}
              onSelect={() => {
                select(search, key);
              }}
              trailing={i.decided === undefined ? 'waiting' : `${i.decided} just now`}
            >
              <span className="fm-triage__line">
                <code className="fm-triage__id">{i.commit.sha.slice(0, 7)}</code>
                <span className="fm-triage__project">
                  {i.project.code} → {i.task.humanId}
                </span>
              </span>
              <span className="fm-triage__text">{i.commit.message.split('\n')[0]}</span>
              <span className="fm-triage__sub">{SOURCE_LABEL[i.source] ?? i.source}</span>
            </TriageRow>
          );
        })}
      </ul>
    </>
  );

  const index = shown === null ? -1 : keys.indexOf(shown);
  const detail =
    item === null ? null : (
      <Stack gap="16" className="fm-triage__record">
        <div className="fm-triage__meta">
          <Badge tone={item.decided === undefined ? 'attention' : 'neutral'}>
            {item.decided === undefined ? 'proposed attribution' : item.decided}
          </Badge>
          <span className="fm-muted">
            {item.project.name} · {SOURCE_LABEL[item.source] ?? item.source} · proposed {relativeDay(item.proposedAt)}
          </span>
          <span className="fm-muted fm-triage__position">
            {index + 1} of {items.length}
          </span>
        </div>
        <h2 className="fm-triage__title">
          <code>{item.commit.sha.slice(0, 7)}</code> → {item.task.humanId}
        </h2>
        <div className="fm-triage__verdicts" role="group" aria-label="Rule on the attribution">
          <Button
            size="sm"
            variant="primary"
            icon={<Check />}
            disabled={item.decided !== undefined}
            loading={pending}
            onClick={() => {
              rule('confirmed');
            }}
          >
            Confirm <KeyHint k="y" />
          </Button>
          <Button
            size="sm"
            icon={<X />}
            disabled={item.decided !== undefined}
            loading={pending}
            onClick={() => {
              rule('rejected');
            }}
          >
            Reject <KeyHint k="n" />
          </Button>
        </div>
        <Checkbox
          label="Move to the next after a verdict"
          checkIcon={<Check />}
          checked={advance}
          onCheckedChange={(next) => {
            setAdvance(next === true);
          }}
        />
        <ActionBar aria-label="Rule on the attribution" className="fm-triage__actionbar">
          <ActionBar.Item
            icon={<Check />}
            label="Confirm"
            tone="accent"
            disabled={pending || item.decided !== undefined}
            onClick={() => {
              rule('confirmed');
            }}
          />
          <ActionBar.Item
            icon={<X />}
            label="Reject"
            disabled={pending || item.decided !== undefined}
            onClick={() => {
              rule('rejected');
            }}
          />
        </ActionBar>

        {item.commit.orphaned ? (
          <Alert tone="warning" title="This commit is no longer on the remote">
            A force push removed it. Confirming still records what it was for.
          </Alert>
        ) : null}

        <Card>
          <CardTitle>The commit</CardTitle>
          <Stack gap="8">
            <strong>{item.commit.message.split('\n')[0]}</strong>
            {item.commit.message.split('\n').slice(1).join('\n').trim() === '' ? null : (
              <pre className="fm-triage__message">{item.commit.message.split('\n').slice(1).join('\n').trim()}</pre>
            )}
            <DescriptionList>
              <DescriptionItem term="Repository">{item.commit.repo}</DescriptionItem>
              <DescriptionItem term="Author">
                {item.commit.author} · {formatDateTime(item.commit.committedAt)}
              </DescriptionItem>
              <DescriptionItem term="CI">{checksWords(item.commit.checks)}</DescriptionItem>
            </DescriptionList>
          </Stack>
        </Card>

        <Card>
          <CardTitle>The task it claims</CardTitle>
          <DescriptionList>
            <DescriptionItem term="Task">
              <Link href={`/tasks/${item.task.humanId}`}>{item.task.humanId}</Link> {item.task.title}
            </DescriptionItem>
            <DescriptionItem term="Status">{item.task.status.replace(/_/g, ' ')}</DescriptionItem>
            <DescriptionItem term="Phase">
              {item.task.phase === null ? '—' : `${item.task.phase.humanId} ${item.task.phase.name}`}
            </DescriptionItem>
            <DescriptionItem term="Done when">{item.task.doneWhen ?? '—'}</DescriptionItem>
          </DescriptionList>
        </Card>

        <Card>
          <CardTitle>Files touched</CardTitle>
          {item.commit.files.length === 0 ? (
            <EmptyState kind="empty" size="inline" heading="No files recorded" />
          ) : (
            <Stack gap="4" as="ul">
              {item.commit.files.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </Stack>
          )}
        </Card>

        <Card>
          <CardTitle>What confirming does</CardTitle>
          <p>
            Records you as having confirmed it — an attribution is declared, never inferred (ADR-005). {item.task.humanId}{' '}
            gains the commit, and every count that reads confirmed work counts it. Rejecting leaves the commit
            unattributed to this task, and it is not proposed again.
          </p>
          <p className="fm-muted">A ruling can be undone from the toast that follows it.</p>
        </Card>
      </Stack>
    );

  return (
    <SplitView
      label="Proposed attributions"
      picked={picked}
      list={list}
      detail={detail}
      onBack={() => {
        select(search, null);
      }}
    />
  );
}
