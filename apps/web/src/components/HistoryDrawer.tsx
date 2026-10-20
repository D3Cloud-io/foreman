import { useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  Modal,
  ModalClose,
  SegmentedControl,
  Skeleton,
  Stack,
  useToast,
} from '@d3cloud/ui';
import type { AuditEventEntry } from '@foreman/shared';
import { foreman } from '../lib/api';
import { failureMessage } from '../lib/mutate';
import { useAsync } from '../lib/useAsync';
import './HistoryDrawer.css';

/**
 * One record's history, beside it (FRM-REQ-243, board D-04): every audit event on it, newest
 * first — who made the change (you in the console, an agent's token over MCP, the server rolling
 * something up), what changed, and an Undo on each one the server says it can reverse.
 *
 * Where an undo would be refused, the reason is on the event before anyone presses anything: the
 * server dry-runs the newest ten, and the rest are checked one at a time on request.
 *
 * A side sheet built on `Modal`, because `@d3cloud/ui` 1.7 has no Drawer (DS-REQ-030): the focus
 * trap, Escape, scroll lock, the labelled dialog and focus back on History all come with it.
 */

type Who = 'all' | 'people' | 'agents' | 'system';

/** Who an actor kind is, in the filter's words. */
export function whoOf(kind: AuditEventEntry['actor']['kind']): Exclude<Who, 'all'> {
  if (kind === 'user') return 'people';
  if (kind === 'mcp') return 'agents';
  return 'system';
}

/** Where a change came from, said next to who made it. */
export function channelOf(kind: AuditEventEntry['actor']['kind']): string {
  switch (kind) {
    case 'user':
      return 'console';
    case 'mcp':
      return 'MCP';
    case 'importer':
      return 'importer';
    case 'webhook':
      return 'GitHub';
    default:
      return 'server';
  }
}

/** The line an event's Undo state reads as, when there is no button to press. */
export function verdictLine(event: Pick<AuditEventEntry, 'undoable' | 'reason' | 'action'>): string | null {
  if (event.undoable === true) return null;
  if (event.undoable === null) return event.reason ?? 'Not checked yet.';
  if (event.action === 'undo') return 'This is an undo. Undo the change it reversed instead.';
  return `Cannot be undone here: ${event.reason ?? 'the server would refuse it'}`;
}

export interface HistoryDrawerProps {
  /** The record, by human ID — `BND-T-9.4`, `PI-007`. */
  entity: string;
  /** After an undo from here: re-read the page in place. */
  onUndone?: () => void;
}

export function HistoryDrawer({ entity, onUndone }: HistoryDrawerProps) {
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState<Who>('all');
  const history = useAsync(
    () => (open ? foreman.auditEvents(entity) : Promise.resolve(null)),
    [entity, open],
  );

  const items = history.state.status === 'ready' && history.state.value !== null ? history.state.value.items : [];
  const shown = who === 'all' ? items : items.filter((event) => whoOf(event.actor.kind) === who);

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      trigger={<Button>History</Button>}
      title={`History of ${entity}`}
      description={
        history.state.status === 'ready' && history.state.value !== null
          ? `${String(items.length)} ${items.length === 1 ? 'event' : 'events'}, newest first.`
          : 'Every change to it, newest first.'
      }
      closeLabel="Close history"
      className="fm-history"
      footer={
        <ModalClose>
          <Button>Close</Button>
        </ModalClose>
      }
    >
      <Stack gap="12">
        <SegmentedControl
          aria-label="Whose changes"
          size="sm"
          items={[
            { value: 'all', label: 'All' },
            { value: 'people', label: 'People' },
            { value: 'agents', label: 'Agents' },
            { value: 'system', label: 'System' },
          ]}
          value={who}
          onValueChange={(next) => {
            setWho(next === 'people' || next === 'agents' || next === 'system' ? next : 'all');
          }}
        />

        {history.state.status === 'loading' || (history.state.status === 'ready' && history.state.value === null) ? (
          <Skeleton lines={6} />
        ) : history.state.status === 'error' ? (
          <EmptyState kind="error" size="inline" heading="The history did not load">
            {history.state.message}
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState kind="empty" size="inline" heading={items.length === 0 ? 'No changes recorded' : 'None from them'}>
            {items.length === 0
              ? 'Nothing has changed it since it was written.'
              : 'Choose All to see every change.'}
          </EmptyState>
        ) : (
          <ol className="fm-history__list" aria-label={`Changes to ${entity}`}>
            {shown.map((event) => (
              <HistoryEvent
                key={event.id}
                event={event}
                onUndone={() => {
                  history.refresh();
                  onUndone?.();
                }}
              />
            ))}
          </ol>
        )}
      </Stack>
    </Modal>
  );
}

function HistoryEvent({ event, onUndone }: { event: AuditEventEntry; onUndone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // An event beyond the newest ten is not checked until asked; the answer replaces the guess.
  const [checked, setChecked] = useState<Pick<AuditEventEntry, 'undoable' | 'reason'> | null>(null);
  const undoable = checked?.undoable ?? event.undoable;
  const reason = checked === null ? event.reason : checked.reason;
  const verdict = verdictLine({
    undoable,
    action: event.action,
    ...(reason === undefined ? {} : { reason }),
  });

  const undo = () => {
    setBusy(true);
    setRefusal(null);
    foreman
      .undo(event.id)
      .then(() => {
        toast.show({ message: `Undone — ${event.summary}` });
        onUndone();
      })
      .catch((caught: unknown) => {
        // The server's words, as it wrote them: it knows why, and a paraphrase would guess.
        const message = failureMessage(caught);
        setRefusal(message);
        toast.show({ message: `Undo refused: ${message}`, duration: 0 });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const check = () => {
    setBusy(true);
    foreman
      .auditEventUndoable(event.id)
      .then((answer) => {
        setChecked(answer.undoable ? { undoable: true } : { undoable: false, reason: answer.reason });
      })
      .catch((caught: unknown) => {
        setRefusal(failureMessage(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const at = new Date(event.at);

  return (
    <li className="fm-history__event">
      <div className="fm-history__who">
        <span className="fm-history__actor">{event.actor.label}</span>
        <span>{channelOf(event.actor.kind)}</span>
        <Badge tone="neutral">{event.action}</Badge>
        <time className="fm-history__when" dateTime={event.at}>
          {at.toLocaleString()}
        </time>
      </div>
      <p className="fm-history__summary">{event.summary}</p>
      {verdict === null ? null : <p className="fm-history__verdict">{verdict}</p>}
      {refusal === null ? null : (
        <p className="fm-history__refusal" role="status">
          Undo refused: {refusal}
        </p>
      )}
      {undoable === true || undoable === null ? (
        <div className="fm-history__actions">
          {undoable === true ? (
            <Button
              size="sm"
              loading={busy}
              onClick={undo}
              aria-label={`Undo: ${event.summary}`}
            >
              Undo
            </Button>
          ) : (
            <Button size="sm" loading={busy} onClick={check} aria-label={`Check whether “${event.summary}” can be undone`}>
              Check
            </Button>
          )}
        </div>
      ) : null}
    </li>
  );
}
