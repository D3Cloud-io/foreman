import { useEffect, useState } from 'react';
import { Select, Spinner } from '@d3cloud/ui';
import { foreman, type StatusWrite, type TaskRow } from '../lib/api';
import { statusWords, useMutate } from '../lib/mutate';
// The pending control's styles live with the rest of the undo flow's.
import '../components/HistoryDrawer.css';

/**
 * Changing a task's status — **by control, never by dragging** (FRM-REQ-135).
 *
 * Drag-and-drop is a recorded anti-feature, and not for taste: a drag is invisible to a keyboard,
 * awkward on a phone, and impossible to undo halfway. A select says what the options are, works
 * everywhere, and reads its current value aloud.
 *
 * The same control appears on the list and on the board, so the board is a *view* rather than the
 * only place state can be changed.
 *
 * **Pessimistic, in place** (FRM-T-18.4). While the server has it, the control shows the status
 * asked for, dimmed, beside a spinner — and stays focusable, so the keyboard is where it was. Only
 * the server's answer changes the row; the toast names it and anything that rolled up, with Undo.
 */

export const TASK_STATUSES = [
  { value: 'todo', label: 'To do' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
];

/** A status in the words the select uses, lower-cased for a sentence: "to do", "in progress". */
export function statusLabel(status: string): string {
  return (TASK_STATUSES.find((option) => option.value === status)?.label ?? statusWords(status)).toLowerCase();
}

/** "BND-T-9.4 marked done" — the toast's first clause. */
export function statusMessage(humanId: string, status: string): string {
  return `${humanId} marked ${statusLabel(status)}`;
}

export interface StatusControlProps {
  task: Pick<TaskRow, 'humanId' | 'status' | 'blockedReason'>;
  code: string;
  /**
   * The write landed (with the server's answer, to apply in place), or an undo of it did (no
   * argument). Either way the screen re-reads quietly — never back to a skeleton.
   */
  onChanged: (result?: StatusWrite) => void;
}

export function StatusControl({ task, code, onChanged }: StatusControlProps) {
  const { mutate, pending } = useMutate();
  const [asked, setAsked] = useState<string | null>(null);
  // What the server answered, held until the screen's re-read brings it back as the prop — so the
  // control never flicks back to the old status between the answer and the refresh.
  const [held, setHeld] = useState<string | null>(null);
  useEffect(() => {
    setHeld(null);
  }, [task.status]);

  const change = (status: string) => {
    // Not disabled while pending: a disabled control drops focus. A second choice simply waits.
    if (pending || status === task.status) return;

    // Blocked without a reason is refused by the server, and asking here is kinder than showing
    // that refusal — the reason is the whole value of recording that something is stuck.
    let reason: string | null = null;
    if (status === 'blocked') {
      reason = window.prompt('What is blocking it?', task.blockedReason ?? '');
      if (reason === null || reason.trim().length === 0) return;
    }

    setAsked(status);
    void mutate({
      subject: task.humanId,
      run: () =>
        foreman.updateTask(code, task.humanId, {
          status,
          ...(reason === null ? {} : { blockedReason: reason }),
        }),
      message: (result) => statusMessage(result.humanId, result.status),
      apply: (result) => {
        if (result.status !== task.status) setHeld(result.status);
        onChanged(result);
      },
      undone: `Undone — ${task.humanId} is ${statusLabel(task.status)} again`,
      onUndone: () => {
        setHeld(null);
        onChanged();
      },
    }).finally(() => {
      setAsked(null);
    });
  };

  const shown = asked ?? held ?? task.status;

  return (
    <span className={pending ? 'fm-status-control fm-status-control--pending' : 'fm-status-control'} aria-busy={pending}>
      <Select
        options={TASK_STATUSES}
        value={shown}
        onValueChange={change}
        size="sm"
        aria-label={`Status of ${task.humanId}`}
      />
      {pending ? <Spinner size="sm" label={`Saving the status of ${task.humanId}`} /> : null}
    </span>
  );
}
