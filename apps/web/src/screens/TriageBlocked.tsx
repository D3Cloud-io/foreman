import { useEffect, useState, type SyntheticEvent } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  FormField,
  Link,
  Select,
  Skeleton,
  Stack,
  Textarea,
} from '@d3cloud/ui';
import type { TasksAcrossResponse } from '@foreman/shared';
import { foreman } from '../lib/api';
import { useMutate } from '../lib/mutate';
import type { AsyncHandle } from '../lib/useAsync';
import { TASK_STATUSES, statusLabel, statusMessage } from './StatusControl';
import {
  SplitView,
  TriageRow,
  effectiveSelection,
  moveSelection,
  select,
  selectionOf,
  useScrollToSelected,
  useTriageKeys,
} from './triage';

/**
 * The Blocked tab of `/findings` (FRM-T-18.7): every blocked task in the scope, each with what is
 * blocking it — `GET /api/tasks?status=blocked&group=`.
 *
 * Its action is a status editor, prefilled and saved by the operator: moving a task out of blocked
 * is a decision about the work, so it is never one keystroke. The write rolls up like any other
 * task write (ADR-018) and the toast's Undo reverses it and what it moved.
 */

/**
 * A task's status, edited in place: a select prefilled with `initial`, the blocking reason when the
 * choice is blocked (a blocked task must say why, FRM-REQ-040), and Save. Nothing is written until
 * Save is pressed.
 */
export function TaskStatusEditor({
  code,
  humanId,
  status,
  blockedReason,
  initial,
  onSaved,
  saveLabel = 'Save status',
}: {
  code: string;
  humanId: string;
  status: string;
  blockedReason: string | null;
  initial: string;
  onSaved: () => void;
  saveLabel?: string;
}) {
  const { mutate, pending } = useMutate();
  const [next, setNext] = useState(initial);
  const [reason, setReason] = useState(blockedReason ?? '');
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    setNext(initial);
    setReason(blockedReason ?? '');
    setFailure(null);
  }, [humanId, initial, blockedReason]);

  const needsReason = next === 'blocked';
  const changed = next !== status || (needsReason && reason.trim() !== (blockedReason ?? ''));
  const ready = changed && (!needsReason || reason.trim().length > 0);

  const save = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!ready || pending) return;
    setFailure(null);
    void mutate({
      subject: humanId,
      run: () => foreman.updateTask(code, humanId, { status: next, ...(needsReason ? { blockedReason: reason.trim() } : {}) }),
      message: (result) => statusMessage(result.humanId, result.status),
      refresh: onSaved,
      signals: true,
      undone: `Undone — ${humanId} is ${statusLabel(status)} again`,
      failure: 'inline',
    }).then((outcome) => {
      if (!outcome.ok) setFailure(outcome.message);
    });
  };

  return (
    <form onSubmit={save} className="fm-triage__editor" aria-label={`Status of ${humanId}`}>
      <Stack gap="12">
        {failure === null ? null : (
          <Alert tone="danger" title="That did not save" dynamic>
            {failure}
          </Alert>
        )}
        <FormField label="Status">
          <Select options={TASK_STATUSES} value={next} onValueChange={setNext} />
        </FormField>
        {needsReason ? (
          <FormField label="What is blocking it" help="Required: a blocked task says why.">
            <Textarea
              name="blockedReason"
              value={reason}
              maxLength={1000}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </FormField>
        ) : null}
        <div className="fm-triage__actions">
          <Button type="submit" variant="primary" disabled={!ready} loading={pending}>
            {saveLabel}
          </Button>
          <span className="fm-muted">Nothing changes until you save.</span>
        </div>
      </Stack>
    </form>
  );
}

export function BlockedTab({
  search,
  handle,
  phrase,
}: {
  search: string;
  handle: AsyncHandle<TasksAcrossResponse>;
  phrase: string | null;
}) {
  const items = handle.state.status === 'ready' ? handle.state.value.items : [];
  const ids = items.map((t) => t.humanId);
  const selected = selectionOf(search);
  const shown = effectiveSelection(ids, selected);
  const picked = selected !== null && ids.includes(selected);
  const task = items.find((t) => t.humanId === shown) ?? null;
  useScrollToSelected(shown);

  useTriageKeys((key) => {
    if (key !== 'next' && key !== 'previous') return false;
    select(search, moveSelection(ids, shown, key === 'next' ? 1 : -1));
    return true;
  });

  if (handle.state.status === 'loading') return <Skeleton lines={8} />;
  if (handle.state.status === 'error') {
    return (
      <EmptyState kind="error" heading="The blocked tasks did not load">
        {handle.state.message}
      </EmptyState>
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState kind="empty" heading={phrase === null ? 'Nothing is blocked' : `Nothing is blocked across ${phrase}`}>
        No task in these projects is waiting on something.
      </EmptyState>
    );
  }

  const total = handle.state.value.total;
  const list = (
    <>
      <div className="fm-triage__list-head">
        <strong>{total} blocked</strong>
        {phrase === null ? '' : ` · ${phrase}`}
        {items.length < total ? ` · showing ${String(items.length)}` : ''}
      </div>
      <ul className="fm-triage__rows" aria-label="Blocked tasks">
        {items.map((t) => (
          <TriageRow
            key={t.humanId}
            id={t.humanId}
            selected={t.humanId === shown}
            onSelect={() => {
              select(search, t.humanId);
            }}
            trailing="blocked"
          >
            <span className="fm-triage__line">
              <code className="fm-triage__id">{t.humanId}</code>
              <span className="fm-triage__project">{t.project.code}</span>
            </span>
            <span className="fm-triage__text">{t.title}</span>
            <span className="fm-triage__sub">{t.blockedReason ?? 'No reason recorded'}</span>
          </TriageRow>
        ))}
      </ul>
    </>
  );

  const index = shown === null ? -1 : ids.indexOf(shown);
  const detail =
    task === null ? null : (
      <Stack gap="16" className="fm-triage__record">
        <div className="fm-triage__meta">
          <Badge tone="danger">blocked</Badge>
          <Link href={`/tasks/${task.humanId}`}>
            <code>{task.humanId}</code>
          </Link>
          <span className="fm-muted">
            {task.project.name}
            {task.phase === null ? '' : ` · ${task.phase.humanId} ${task.phase.name}`}
          </span>
          <span className="fm-muted fm-triage__position">
            {index + 1} of {items.length}
          </span>
        </div>
        <h2 className="fm-triage__title">{task.title}</h2>
        <Card>
          <CardTitle>What is blocking it</CardTitle>
          <p>{task.blockedReason ?? 'No reason recorded.'}</p>
          <DescriptionList>
            <DescriptionItem term="Done when">{task.doneWhen ?? '—'}</DescriptionItem>
            <DescriptionItem term="Size">{task.size ?? '—'}</DescriptionItem>
          </DescriptionList>
        </Card>
        <Card>
          <CardTitle>Unblock it</CardTitle>
          <TaskStatusEditor
            key={task.humanId}
            code={task.project.code}
            humanId={task.humanId}
            status={task.status}
            blockedReason={task.blockedReason}
            initial="in_progress"
            onSaved={handle.refresh}
          />
        </Card>
      </Stack>
    );

  return (
    <SplitView
      label="Blocked tasks"
      picked={picked}
      list={list}
      detail={detail}
      onBack={() => {
        select(search, null);
      }}
    />
  );
}
