import { useMemo, useState, type SyntheticEvent } from 'react';
import {
  Alert,
  Button,
  Card,
  Cluster,
  EmptyState,
  FormActions,
  FormField,
  Grid,
  Input,
  Modal,
  Page,
  Select,
  Skeleton,
  Stack,
  Textarea,
} from '@d3cloud/ui';
import { foreman, type DocumentRow, type IdeaRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { draftSize, useDraftGuard, useMutate } from '../lib/mutate';
import { ProjectHeader } from '../components/ProjectHeader';
import { Pill, SegmentBar, StatCard } from '../ui/viz';
import { relativeDay, SERIES, type Tone } from '../ui/tone';

/**
 * Ideas — a thing somebody might build, before it is a plan
 * (FRM-REQ-153 … FRM-REQ-158).
 *
 * **The statuses were not invented.** Four projects already carry a "Feature Ideas & Future
 * Development" document, and each sorts its entries into *Accepted*, *Parked* — "good ideas,
 * deliberately not now" — and *Rejected*, under the heading "do not re-litigate these". So the
 * screen uses those words, and links to that document rather than pretending it is not there:
 * the prose version holds the reasoning behind entries nobody has transcribed, and a records
 * screen that hides the document it replaces is how the two quietly disagree.
 *
 * **Parking or rejecting an idea requires a reason**, enforced by the server and asked for here.
 * Without it a rejected idea is indistinguishable from a forgotten one, and the list slowly
 * refills with things that were already decided.
 *
 * **Every write lands in place, with Undo** (FRM-T-18.4). A delete is soft and undoable, so it acts
 * at once and the toast offers the way back — no dialog asking whether you meant it.
 */

const STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'parked', label: 'Parked' },
  { value: 'rejected', label: 'Rejected' },
] as const;

type Status = (typeof STATUSES)[number]['value'];

/** Which statuses the server will refuse without a reason — mirrors `IDEA_NEEDS_REASON`. */
const NEEDS_REASON: readonly string[] = ['parked', 'rejected'];

function ideaTone(status: string): Tone {
  switch (status) {
    case 'accepted':
      return 'success';
    case 'parked':
      return 'warning';
    case 'rejected':
      return 'danger';
    default:
      return 'accent';
  }
}

/** The bar's colour per status. `SERIES` is keyed by what a series means, not by tone. */
const IDEA_SERIES: Record<Status, string> = {
  new: SERIES.active,
  accepted: SERIES.done,
  parked: SERIES.warning,
  rejected: SERIES.blocked,
};

/** What each status is *for*, said once on the card that counts it. */
const MEANING: Record<Status, string> = {
  new: 'Nobody has judged these yet',
  accepted: 'Worth building, not yet planned',
  parked: 'Good, deliberately not now',
  rejected: 'Decided against — do not re-litigate',
};

export function Ideas({ code }: { code: string }) {
  const [filter, setFilter] = useState<Status | null>(null);
  // `refresh` re-reads in place, so a write never drops the grid back to a skeleton.
  const { state, refresh } = useAsync(() => foreman.ideas(code), [code]);
  // The prose document this screen succeeds, if the project has one. Its absence is normal — five
  // of the nine projects never wrote one — so a failure here must not take the screen with it.
  const { state: docs } = useAsync(
    () => foreman.documents(code).catch(() => ({ items: [] as DocumentRow[] })),
    [code],
  );
  const prose =
    docs.status === 'ready' ? docs.value.items.find((d) => d.kind === 'feature_ideas') : undefined;

  const items = state.status === 'ready' ? state.value.items : [];
  const counts = useMemo(() => {
    const by: Record<string, number> = { new: 0, accepted: 0, parked: 0, rejected: 0 };
    for (const item of items) by[item.status] = (by[item.status] ?? 0) + 1;
    return by;
  }, [items]);

  const shown = filter === null ? items : items.filter((item) => item.status === filter);

  return (
    <Page>
      <ProjectHeader
        code={code}
        section="ideas"
        description="Things somebody might build. An idea is not a commitment; a requirement is."
        count={items.length}
        countNoun={{ one: 'idea', other: 'ideas' }}
        actions={<IdeaForm code={code} onSaved={refresh} />}
      />

      {state.status === 'loading' ? (
        <Skeleton lines={8} />
      ) : state.status === 'error' ? (
        <EmptyState kind="error" heading="The ideas did not load">
          {state.message}
        </EmptyState>
      ) : (
        <Stack gap="24">
          <Grid minItemWidth="sm">
            {STATUSES.map((status) => (
              <StatCard
                key={status.value}
                label={status.label}
                value={counts[status.value] ?? 0}
                detail={MEANING[status.value]}
                tone={ideaTone(status.value)}
                selected={filter === status.value}
                onClick={() => {
                  // A second press clears it. A filter you can only set is a filter that traps you.
                  setFilter((current) => (current === status.value ? null : status.value));
                }}
              />
            ))}
          </Grid>

          {items.length > 0 && (
            <SegmentBar
              segments={STATUSES.map((status) => ({
                label: status.label,
                value: counts[status.value] ?? 0,
                color: IDEA_SERIES[status.value],
              }))}
            />
          )}

          {prose !== undefined && (
            <Alert tone="info" title="This project also has an ideas document">
              <Cluster gap="8" align="center">
                <span>
                  Written before ideas were records. It holds the reasoning behind entries nobody
                  has transcribed yet.
                </span>
                <a href={`/projects/${code}/documents/${prose.id}`}>{prose.title}</a>
              </Cluster>
            </Alert>
          )}

          {shown.length === 0 ? (
            <EmptyState
              kind="empty"
              heading={filter === null ? 'No ideas yet' : `Nothing is ${filter}`}
            >
              {filter === null
                ? 'Add one from here, or from a coding session with foreman_create.'
                : 'Press the card again to see them all.'}
            </EmptyState>
          ) : (
            <Grid minItemWidth="md">
              {shown.map((idea) => (
                <IdeaCard key={idea.id} code={code} idea={idea} onChanged={refresh} />
              ))}
            </Grid>
          )}
        </Stack>
      )}
    </Page>
  );
}

function IdeaCard({
  code,
  idea,
  onChanged,
}: {
  code: string;
  idea: IdeaRow;
  onChanged: () => void;
}) {
  return (
    // Named, because the card holds its own Edit and Delete. In a grid of them those buttons are
    // six identical "Edit"s in a row to anyone not looking at the screen; the group's name is what
    // says which idea each pair belongs to.
    <Card padding="md" role="group" aria-label={`${idea.humanId}: ${idea.title}`}>
      <Stack gap="12">
        <Cluster gap="8" align="center" justify="between">
          <span className="fm-item__id">{idea.humanId}</span>
          <Pill tone={ideaTone(idea.status)}>{idea.status}</Pill>
        </Cluster>

        <strong className="fm-item__title">{idea.title}</strong>
        {idea.body !== null && idea.body.length > 0 && (
          <p className="fm-item__body">{idea.body}</p>
        )}

        {idea.reason !== null && idea.reason.length > 0 && (
          // The reason is the point of a parked or rejected idea, so it is on the card and not
          // one click away. Somebody about to re-raise this should not have to open anything.
          <p className="fm-item__reason">
            <span className="fm-muted">Because </span>
            {idea.reason}
          </p>
        )}

        <Cluster gap="8" align="center" justify="between">
          <span className="fm-muted">
            {idea.decidedAt === null
              ? `Added ${relativeDay(idea.createdAt)}`
              : `Decided ${relativeDay(idea.decidedAt)}`}
          </span>
          <Cluster gap="8" align="center">
            <IdeaForm code={code} idea={idea} onSaved={onChanged} />
            <DeleteIdea code={code} idea={idea} onDeleted={onChanged} />
          </Cluster>
        </Cluster>
      </Stack>
    </Card>
  );
}

/**
 * Create and edit in one form, because they differ by one field.
 *
 * `status` is absent when creating: every idea starts as `new`, and offering "rejected" on a form
 * whose purpose is writing something down invites recording a decision that was never made.
 */
function IdeaForm({
  code,
  idea,
  onSaved,
}: {
  code: string;
  idea?: IdeaRow;
  onSaved: () => void;
}) {
  const editing = idea !== undefined;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(idea?.title ?? '');
  const [body, setBody] = useState(idea?.body ?? '');
  const [status, setStatus] = useState<string>(idea?.status ?? 'new');
  const [reason, setReason] = useState(idea?.reason ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { mutate } = useMutate();

  const needsReason = editing && NEEDS_REASON.includes(status);
  const allowClose = useDraftGuard(
    open
      ? draftSize(
          { title: idea?.title ?? '', body: idea?.body ?? '', status: idea?.status ?? 'new', reason: idea?.reason ?? '' },
          { title, body, status, reason },
        )
      : 0,
    editing ? idea.humanId : 'the new idea',
  );

  const reset = () => {
    setTitle(idea?.title ?? '');
    setBody(idea?.body ?? '');
    setStatus(idea?.status ?? 'new');
    setReason(idea?.reason ?? '');
    setError(null);
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    // Checked here as well as on the server, so the answer arrives before the round trip rather
    // than as a rejected save.
    if (needsReason && reason.trim().length === 0) {
      setError(`An idea that is ${status} has to say why.`);
      return;
    }
    setBusy(true);
    setError(null);

    void mutate({
      subject: editing ? idea.humanId : 'the new idea',
      run: () =>
        editing
          ? foreman.updateIdea(code, idea.humanId, {
              title,
              body,
              status,
              ...(reason.trim().length === 0 ? {} : { reason }),
            })
          : foreman.createIdea(code, { title, ...(body.trim().length === 0 ? {} : { body }) }),
      message: (saved) =>
        !editing
          ? `${saved.humanId} added`
          : saved.status !== idea.status
            ? `${saved.humanId} marked ${saved.status}`
            : `Saved ${saved.humanId}`,
      refresh: onSaved,
      failure: 'inline',
    })
      .then((outcome) => {
        if (outcome.ok) setOpen(false);
        else if (outcome.inFlight !== true) setError(outcome.message);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        // Escape or the scrim with a draft asks first; Cancel is the person saying discard.
        if (!next && !allowClose()) return;
        setOpen(next);
        if (next) reset();
      }}
      trigger={
        <Button {...(editing ? {} : { variant: 'primary' as const })}>
          {editing ? 'Edit' : 'New idea'}
        </Button>
      }
      title={editing ? `Edit ${idea.humanId}` : 'New idea'}
      description={
        editing ? undefined : 'A line is enough. An idea that has to be written up is a plan.'
      }
    >
      <form onSubmit={submit}>
        <Stack gap="16">
          {error !== null && (
            <Alert tone="danger" title="That did not save" dynamic>
              {error}
            </Alert>
          )}

          <FormField label="Title">
            <Input
              name="title"
              value={title}
              maxLength={300}
              onChange={(e) => { setTitle(e.target.value); }}
            />
          </FormField>

          <FormField label="What is it" optional help="In basic terms — enough to recognise it later.">
            <Textarea
              name="body"
              rows={4}
              value={body}
              maxLength={2000}
              onChange={(e) => { setBody(e.target.value); }}
            />
          </FormField>

          {editing && (
            <FormField label="Status">
              <Select
                options={STATUSES.map((s) => ({ value: s.value, label: s.label }))}
                value={status}
                onValueChange={setStatus}
              />
            </FormField>
          )}

          {needsReason && (
            <FormField
              label="Why"
              help={`Required. Six months from now this is what stops ${idea.humanId} being argued again.`}
            >
              <Textarea
                name="reason"
                rows={2}
                value={reason}
                maxLength={1000}
                onChange={(e) => { setReason(e.target.value); }}
              />
            </FormField>
          )}

          <FormActions>
            <Button type="button" onClick={() => { setOpen(false); }}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || title.trim().length === 0}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Modal>
  );
}

/**
 * Delete, at once. It is a soft delete the server can undo, so the toast offers Undo instead of a
 * dialog asking first (FRM-T-18.4, the destructive ladder). Turning an idea down is still Edit →
 * Rejected with a reason; Delete is for one written down by mistake.
 */
function DeleteIdea({
  code,
  idea,
  onDeleted,
}: {
  code: string;
  idea: IdeaRow;
  onDeleted: () => void;
}) {
  const { mutate, pending } = useMutate();

  return (
    <Button
      loading={pending}
      aria-label={`Delete ${idea.humanId}`}
      onClick={() => {
        if (pending) return;
        void mutate({
          subject: idea.humanId,
          run: () => foreman.deleteIdea(code, idea.humanId),
          message: () => `${idea.humanId} deleted`,
          undone: `Undone — ${idea.humanId} is back`,
          refresh: onDeleted,
        });
      }}
    >
      Delete
    </Button>
  );
}
