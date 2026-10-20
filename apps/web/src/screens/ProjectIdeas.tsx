import { useCallback, useMemo, useState, type SyntheticEvent } from 'react';
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
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
  Stack,
  Textarea,
} from '@d3cloud/ui';
import type { GroupListing } from '@foreman/shared';
import { foreman, ApiError, type GuidelineRow, type ProjectIdeaRow } from '../lib/api';
import { applicableGuidelines } from '../lib/groups';
import { useAsync } from '../lib/useAsync';
import { useMode, useMoney, useReviews } from '../lib/session';
import { Pill, SegmentBar, StatCard } from '../ui/viz';
import { relativeDay, SERIES, type Tone } from '../ui/tone';
import { IdeaMatrix, MaturityBar, Stars } from '../ui/ideas';

/**
 * Project ideas — something that might become a project, before it is one
 * (FRM-REQ-159 … FRM-REQ-164, FRM-ADR-015).
 *
 * Top-level, beside Projects rather than inside one, because that is what these are: the list of
 * things that are not projects yet. A project's own ideas live at `/projects/<code>/ideas` and are
 * a different question — "what else could this grow" versus "what else could we build".
 *
 * **The code is asked for at conversion and nowhere else.** A project code is immutable and
 * embedded in every human ID the project will ever have (ADR-008), so demanding one to write down
 * "maybe a fuel tracker someday" asks a permanent question at the moment there is least
 * information to answer it. `PI-007` costs nothing.
 */

export const ALL = [
  { value: 'new', label: 'New' },
  { value: 'considering', label: 'Considering' },
  { value: 'shortlisted', label: 'Shortlisted' },
  { value: 'funded', label: 'Funded' },
  { value: 'parked', label: 'Parked' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'converted', label: 'Built' },
] as const;

export type Status = (typeof ALL)[number]['value'];

/**
 * Which statuses a deployment offers (FRM-ADR-016).
 *
 * The record is the same in both — a candidate somebody might build — and what differs is where
 * it can end up. A solo instance converts an idea into a Foreman project; a fund board funds it.
 * Showing the other mode's endings would offer a button that cannot be pressed.
 */
export const FOR_MODE: Record<'solo' | 'board', readonly Status[]> = {
  solo: ['new', 'considering', 'parked', 'rejected', 'converted'],
  board: ['new', 'considering', 'shortlisted', 'funded', 'parked', 'rejected'],
};

/** Reached by converting or funding, never by hand — so neither is on the edit form. */
export const DECIDED_ELSEWHERE: readonly Status[] = ['converted', 'funded'];

export const NEEDS_REASON: readonly string[] = ['parked', 'rejected'];

export function ideaTone(status: string): Tone {
  switch (status) {
    case 'converted':
    case 'funded':
      return 'success';
    case 'considering':
    case 'shortlisted':
      return 'accent';
    case 'parked':
      return 'warning';
    case 'rejected':
      return 'danger';
    default:
      return 'neutral';
  }
}

export const SERIES_FOR: Record<Status, string> = {
  new: SERIES.waiting,
  considering: SERIES.active,
  shortlisted: SERIES.info,
  funded: SERIES.done,
  parked: SERIES.warning,
  rejected: SERIES.blocked,
  converted: SERIES.done,
};

export const MEANING: Record<Status, string> = {
  new: 'Written down, not yet weighed',
  considering: 'Actively being thought about',
  shortlisted: 'In front of the board',
  funded: 'Approved, with money behind it',
  parked: 'Good, deliberately not now',
  rejected: 'Decided against — do not re-litigate',
  converted: 'Became a project',
};

type View = 'cards' | 'matrix';
type Sort = 'recent' | 'excitement' | 'maturity' | 'ratio';

const SORTS: { value: Sort; label: string }[] = [
  { value: 'recent', label: 'Newest first' },
  { value: 'excitement', label: 'Most wanted' },
  { value: 'maturity', label: 'Most thought through' },
  { value: 'ratio', label: 'Best impact for effort' },
];

/**
 * How the list is ordered.
 *
 * The server's order — untriaged first, then newest — stays the default, because the list exists
 * to be worked through. The others answer the three questions somebody actually brings to a list
 * of ideas: which do I want most, which could I start tomorrow, and which pays back best.
 */
function sorted(items: readonly ProjectIdeaRow[], sort: Sort): ProjectIdeaRow[] {
  const list = [...items];
  const ratio = (i: ProjectIdeaRow) => i.score?.ratio ?? -1;
  switch (sort) {
    case 'excitement':
      return list.sort((a, b) => (b.excitement ?? 0) - (a.excitement ?? 0));
    case 'maturity':
      return list.sort((a, b) => b.maturity.filled - a.maturity.filled);
    case 'ratio':
      return list.sort((a, b) => ratio(b) - ratio(a));
    default:
      return list;
  }
}

export function ProjectIdeas() {
  const mode = useMode();
  const board = mode === 'board';
  const reviews = useReviews();
  const [nonce, setNonce] = useState(0);
  const [filter, setFilter] = useState<Status | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [view, setView] = useState<View>('cards');
  const [sort, setSort] = useState<Sort>('recent');
  const refresh = useCallback(() => { setNonce((n) => n + 1); }, []);

  const statuses = useMemo(
    () => ALL.filter((s) => FOR_MODE[mode].includes(s.value)),
    [mode],
  );

  const { state } = useAsync(() => foreman.projectIdeas(), [nonce]);
  const items = useMemo(() => (state.status === 'ready' ? state.value.items : []), [state]);

  const counts = useMemo(() => {
    const by: Record<string, number> = {};
    for (const status of ALL) by[status.value] = 0;
    for (const item of items) by[item.status] = (by[item.status] ?? 0) + 1;
    return by;
  }, [items]);

  // Every tag in use, most used first: the tags worth offering as filters are the ones that
  // actually group something.
  const tags = useMemo(() => {
    const seen = new Map<string, number>();
    for (const item of items) for (const t of item.tags) seen.set(t, (seen.get(t) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [items]);

  const shown = sorted(
    items.filter(
      (item) =>
        (filter === null || item.status === filter) && (tag === null || item.tags.includes(tag)),
    ),
    sort,
  );

  return (
    <Page>
      <PageHeader
        title={board ? 'Submissions' : 'Project ideas'}
        description={
          board
            ? 'Anyone can submit. The board scores, discusses and decides — and says why.'
            : 'Things that might become projects. Open one to think it through.'
        }
        count={items.length}
        countNoun={board ? { one: 'submission', other: 'submissions' } : { one: 'idea', other: 'ideas' }}
        actions={<ProjectIdeaForm onSaved={refresh} />}
      />

      {state.status === 'loading' ? (
        <Skeleton lines={8} />
      ) : state.status === 'error' ? (
        <EmptyState kind="error" heading="The project ideas did not load">
          {state.message}
        </EmptyState>
      ) : (
        <Stack gap="24">
          <Grid minItemWidth="sm">
            {statuses.map((status) => (
              <StatCard
                key={status.value}
                label={status.label}
                value={counts[status.value] ?? 0}
                detail={MEANING[status.value]}
                tone={ideaTone(status.value)}
                selected={filter === status.value}
                onClick={() => {
                  setFilter((current) => (current === status.value ? null : status.value));
                }}
              />
            ))}
          </Grid>

          {items.length > 0 && (
            <SegmentBar
              segments={statuses.map((status) => ({
                label: status.label,
                value: counts[status.value] ?? 0,
                color: SERIES_FOR[status.value],
              }))}
            />
          )}

          {items.length > 0 && (
            <Cluster gap="12" align="center" justify="between">
              <Cluster gap="8" align="center">
                {tags.length > 0 && <span className="fm-muted">Tags</span>}
                {tags.map((t) => (
                  // Buttons, not links: a tag filters this list, it does not go anywhere.
                  <button
                    key={t}
                    type="button"
                    className={tag === t ? 'fm-tag fm-tag--on' : 'fm-tag'}
                    aria-pressed={tag === t}
                    onClick={() => { setTag((current) => (current === t ? null : t)); }}
                  >
                    {t}
                  </button>
                ))}
              </Cluster>
              <Cluster gap="8" align="center">
                {view === 'cards' && (
                  <div className="fm-sort">
                  <Select
                    aria-label="Sort ideas"
                    options={SORTS.filter((o) => o.value !== 'ratio' || reviews)}
                    value={sort}
                    onValueChange={(v) => { setSort(v as Sort); }}
                  />
                  </div>
                )}
                <SegmentedControl
                  aria-label="View"
                  items={[
                    { value: 'cards', label: 'Cards' },
                    // The matrix plots scores, so it is offered only to people who can see them.
                    ...(reviews ? [{ value: 'matrix', label: 'Impact × effort' }] : []),
                  ]}
                  value={view}
                  onValueChange={(v) => { setView(v as View); }}
                />
              </Cluster>
            </Cluster>
          )}

          {shown.length === 0 ? (
            <EmptyState
              kind="empty"
              heading={
                filter === null && tag === null
                  ? board
                    ? 'Nothing has been submitted yet'
                    : 'No project ideas yet'
                  : 'Nothing matches'
              }
            >
              {filter === null && tag === null
                ? board
                  ? 'Anyone signed in can submit one from here.'
                  : 'Write one down from here, or from a session with foreman_create.'
                : 'Press the card or the tag again to see them all.'}
            </EmptyState>
          ) : view === 'matrix' ? (
            <IdeaMatrix items={shown} tone={SERIES_FOR} labels={ALL} />
          ) : (
            <Grid minItemWidth="md">
              {shown.map((idea) => (
                <ProjectIdeaCard key={idea.id} idea={idea} />
              ))}
            </Grid>
          )}
        </Stack>
      )}
    </Page>
  );
}

/**
 * One idea, as a summary that opens its page.
 *
 * **Wholly clickable, and so it holds no actions.** The design system's rule is that a card is
 * either one control or a container of controls, never both — a button inside a link is
 * unreachable in some screen-reader modes and swallows clicks meant for the card. Deciding,
 * scoring and converting all moved to the idea's page, where there is room to do them properly.
 */
function ProjectIdeaCard({ idea }: { idea: ProjectIdeaRow }) {
  const board = useMode() === 'board';
  const money = useMoney();

  return (
    <Card padding="md" href={`/project-ideas/${idea.humanId}`} interactive>
      <Stack gap="12">
        <Cluster gap="8" align="center" justify="between">
          <span className="fm-item__id">{idea.humanId}</span>
          <Cluster gap="8" align="center">
            {/* Only a reviewer sees this, because the API only sends it to one (FRM-REQ-168). */}
            {idea.score !== null && idea.score.count > 0 && (
              <span className="fm-item__score">
                {idea.score.impact}↑ / {idea.score.effort}↓
              </span>
            )}
            <Pill tone={ideaTone(idea.status)}>
              {ALL.find((s) => s.value === idea.status)?.label ?? idea.status}
            </Pill>
          </Cluster>
        </Cluster>

        <strong className="fm-item__title">{idea.title}</strong>
        {idea.pitch !== null && idea.pitch.length > 0 && (
          <p className="fm-item__body">{idea.pitch}</p>
        )}

        {idea.status === 'funded' && idea.fundedAmountCents !== null && (
          <p className="fm-item__reason">
            <span className="fm-muted">Funded </span>
            <strong>{money(idea.fundedAmountCents)}</strong>
          </p>
        )}

        {idea.tags.length > 0 && (
          <Cluster gap="4">
            {idea.tags.map((t) => (
              <span key={t} className="fm-tag fm-tag--static">
                {t}
              </span>
            ))}
          </Cluster>
        )}

        {/* The idea at a glance: how far it has been thought through, how much it is wanted, and
            what is still open. Each is the question a list of ideas is scanned to answer. */}
        <MaturityBar maturity={idea.maturity} />

        <Cluster gap="12" align="center" justify="between">
          <span className="fm-muted">
            {board && idea.submittedBy !== null ? `${idea.submittedBy.displayName} · ` : ''}
            {idea.status === 'converted'
              ? `Built ${relativeDay(idea.convertedAt)}`
              : idea.decidedAt === null
                ? `Added ${relativeDay(idea.createdAt)}`
                : `Decided ${relativeDay(idea.decidedAt)}`}
          </span>
          <Cluster gap="8" align="center">
            {idea.excitement !== null && <Stars value={idea.excitement} />}
            {(idea.openQuestions ?? 0) > 0 && (
              <span className="fm-muted">{idea.openQuestions} open ?</span>
            )}
            {idea._count.comments > 0 && (
              <span className="fm-muted">
                {idea._count.comments} {idea._count.comments === 1 ? 'thought' : 'thoughts'}
              </span>
            )}
          </Cluster>
        </Cluster>
      </Stack>
    </Card>
  );
}

export function ProjectIdeaForm({ idea, onSaved }: { idea?: ProjectIdeaRow; onSaved: () => void }) {
  const mode = useMode();
  const reviews = useReviews();
  const editing = idea !== undefined;
  // Deciding is the board's. A submitter gets the wording fields and no status control at all,
  // rather than one that is refused on submit.
  const canDecide = editing && reviews;
  const options = ALL.filter(
    (s) => FOR_MODE[mode].includes(s.value) && !DECIDED_ELSEWHERE.includes(s.value),
  );
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(idea?.title ?? '');
  const [pitch, setPitch] = useState(idea?.pitch ?? '');
  const [status, setStatus] = useState<string>(idea?.status ?? 'new');
  const [reason, setReason] = useState(idea?.reason ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const needsReason = canDecide && NEEDS_REASON.includes(status);

  const reset = () => {
    setTitle(idea?.title ?? '');
    setPitch(idea?.pitch ?? '');
    setStatus(idea?.status ?? 'new');
    setReason(idea?.reason ?? '');
    setError(null);
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (needsReason && reason.trim().length === 0) {
      setError(`A project idea that is ${status} has to say why.`);
      return;
    }
    setBusy(true);
    setError(null);

    const request = editing
      ? foreman.updateProjectIdea(idea.humanId, {
          title,
          pitch,
          // Sent only when this person may set it. A field the server would refuse is a field the
          // form should not have offered.
          ...(canDecide ? { status } : {}),
          ...(canDecide && reason.trim().length > 0 ? { reason } : {}),
        })
      : foreman.createProjectIdea({
          title,
          ...(pitch.trim().length === 0 ? {} : { pitch }),
        });

    void request
      .then((saved) => {
        setOpen(false);
        onSaved();
        // A new idea opens on its own page. Writing one down is the moment somebody is thinking
        // about it, and landing back on the list would ask them to go and find it again.
        if (!editing) window.location.assign(`/project-ideas/${saved.humanId}`);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'That did not save.');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
      trigger={
        <Button {...(editing ? {} : { variant: 'primary' as const })}>
          {editing ? 'Edit' : mode === 'board' ? 'New submission' : 'New project idea'}
        </Button>
      }
      title={editing ? `Edit ${idea.humanId}` : mode === 'board' ? 'New submission' : 'New project idea'}
      description={
        editing
          ? undefined
          : mode === 'board'
            ? 'What it is and who it helps. The board scores it, and tells you either way.'
            : 'No code yet — that is decided when it becomes a project, and it is permanent.'
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

          <FormField
            label="Pitch"
            optional
            help="What it is and who it is for. This becomes the project's pitch when it converts."
          >
            <Textarea
              name="pitch"
              rows={5}
              value={pitch}
              maxLength={4000}
              onChange={(e) => { setPitch(e.target.value); }}
            />
          </FormField>

          {canDecide && (
            <FormField label="Status">
              <Select
                options={options.map((s) => ({ value: s.value, label: s.label }))}
                value={status}
                onValueChange={setStatus}
              />
            </FormField>
          )}

          {needsReason && (
            <FormField
              label="Why"
              help={`Required. This is what stops ${idea.humanId} being raised again in six months.`}
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
 * The moment an idea becomes a project, and the only place a code is asked for.
 *
 * The form says the code is permanent, because it is: it is embedded in every requirement, task,
 * ADR and citation the project will ever have, and there is no rename (ADR-008).
 */
const NO_GROUP = 'ungrouped';

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/**
 * The group a conversion defaults to: the scope in the address (`?group=dormice`, FRM-T-17.4 puts
 * it there), else none. A guess at a family is worse than asking, so there is no other default.
 */
function scopeGroup(listing: GroupListing): string {
  const scope = new URLSearchParams(window.location.search).get('group');
  return listing.items.find((group) => group.slug === scope || group.humanId === scope)?.humanId ?? NO_GROUP;
}

export function ConvertIdea({ idea, onConverted }: { idea: ProjectIdeaRow; onConverted: () => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState(idea.title);
  const [group, setGroup] = useState(NO_GROUP);
  const [listing, setListing] = useState<GroupListing | null>(null);
  const [guidelines, setGuidelines] = useState<readonly GuidelineRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const projectCode = code.toUpperCase();
    // The convert endpoint takes no group (it creates the project from the idea's fields alone),
    // so the group is set on the new project straight after, with the same write Projects uses.
    void foreman
      .convertProjectIdea(idea.humanId, { code: projectCode, name })
      .then(async (result) => {
        if (group !== NO_GROUP) {
          try {
            await foreman.setProjectGroup(result.project.code, group);
          } catch {
            // The project exists; only its family did not stick. Its overview offers Move to group.
          }
        }
        return result;
      })
      .then((result) => {
        setOpen(false);
        onConverted();
        // Straight to the thing that now exists. Converting and then having to go and find it is
        // the sort of small friction that makes a feature feel unfinished.
        window.location.assign(`/projects/${result.project.code}`);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'That did not convert.');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setCode('');
          setName(idea.title);
          setError(null);
          setGroup(NO_GROUP);
          // Read when it opens: which families exist, and what each would bind the project to.
          void Promise.all([foreman.groups(), foreman.guidelines()])
            .then(([groups, rules]) => {
              setListing(groups);
              setGuidelines(rules.items);
              setGroup(scopeGroup(groups));
            })
            .catch(() => {
              setListing(null);
            });
        }
      }}
      trigger={<Button variant="primary">Convert</Button>}
      title={`Make ${idea.humanId} a project`}
      description="Its canvas becomes the project's discovery document. The idea stays, as the record of where this began."
    >
      <form onSubmit={submit}>
        <Stack gap="16">
          {error !== null && (
            <Alert tone="danger" title="That did not convert" dynamic>
              {error}
            </Alert>
          )}

          <FormField
            label="Code"
            help="2–8 letters or digits. Permanent: every ID in the project embeds it, and there is no rename."
          >
            <Input
              name="code"
              value={code}
              maxLength={8}
              autoCapitalize="characters"
              onChange={(e) => { setCode(e.target.value.toUpperCase()); }}
            />
          </FormField>

          <FormField label="Name">
            <Input
              name="name"
              value={name}
              maxLength={200}
              onChange={(e) => { setName(e.target.value); }}
            />
          </FormField>

          {listing !== null && listing.items.length > 0 && (
            <FormField label="Joins group" help={joinsHelp(listing, guidelines, group, code)}>
              <Select
                value={group}
                onValueChange={setGroup}
                options={[
                  ...listing.items.map((item) => ({ value: item.humanId, label: item.name })),
                  { value: NO_GROUP, label: 'No group (Ungrouped)' },
                ]}
              />
            </FormField>
          )}

          <FormActions>
            <Button type="button" onClick={() => { setOpen(false); }}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={busy || code.trim().length < 2 || name.trim().length === 0}
            >
              {busy ? 'Converting…' : 'Convert to project'}
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Modal>
  );
}

function joinsHelp(
  listing: GroupListing,
  guidelines: readonly GuidelineRow[],
  group: string,
  code: string,
): string {
  const target = listing.items.find((item) => item.humanId === group);
  const count = applicableGuidelines(guidelines, target?.humanId ?? null).length;
  const word = NUMBER_WORDS[count] ?? String(count);
  const subject = code.trim().length >= 2 ? `${code.toUpperCase()}’s` : 'its';
  const where = target === undefined ? 'every project' : target.name;
  if (count === 0) return `Defaults to the scope you were viewing. No guideline applies to ${where} yet.`;
  const rules = `${word} ${count === 1 ? 'guideline' : 'guidelines'} that ${count === 1 ? 'applies' : 'apply'} to ${where}`;
  return `Defaults to the scope you were viewing. The ${rules} ${count === 1 ? 'goes' : 'go'} into ${subject} first brief.`;
}

export function DeleteProjectIdea({
  idea,
  onDeleted,
}: {
  idea: ProjectIdeaRow;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = () => {
    setBusy(true);
    setError(null);
    void foreman
      .deleteProjectIdea(idea.humanId)
      .then(() => {
        setOpen(false);
        onDeleted();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'That did not delete.');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      trigger={<Button>Delete</Button>}
      title={`Delete ${idea.humanId}?`}
      description="Hidden, not destroyed — the audit event can undo it, and the number is never reused."
    >
      <Stack gap="16">
        {error !== null && (
          <Alert tone="danger" title="That did not delete" dynamic>
            {error}
          </Alert>
        )}
        <p>
          If this was considered and turned down, mark it <strong>rejected</strong> with a reason
          instead — that is what stops it coming back.
        </p>
        <FormActions>
          <Button type="button" onClick={() => { setOpen(false); }}>
            Cancel
          </Button>
          <Button type="button" variant="danger" disabled={busy} onClick={remove}>
            {busy ? 'Deleting…' : 'Delete'}
          </Button>
        </FormActions>
      </Stack>
    </Modal>
  );
}
