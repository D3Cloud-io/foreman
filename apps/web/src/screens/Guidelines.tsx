import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Cluster,
  EmptyState,
  FormActions,
  FormField,
  Grid,
  Input,
  Link,
  Modal,
  Page,
  PageHeader,
  Section,
  SegmentedControl,
  Skeleton,
  Stack,
  Textarea,
} from '@d3cloud/ui';
import { Markdown } from '../components/Markdown';
import { Check } from 'lucide-react';
import type { GroupListing } from '@foreman/shared';
import { foreman, type GuidelineInput, type GuidelineRow, type GuidelineScope } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useAnchorId, useRowAnchor } from '../lib/useRowAnchor';
import { listJoin } from '../lib/groups';
import { draftSize, useDraftGuard, useMutate } from '../lib/mutate';
import { GroupChip } from '../ui/groups';
import { Pill } from '../ui/viz';

/**
 * Guidelines — the standing decisions for every project (FRM-REQ-186).
 *
 * Dual login everywhere, tokens not hex, no time estimates: rules that used to live as prose in a
 * CLAUDE.md, found only by a session that happened to read the right paragraph. Each is a card
 * here — the decision on its face, the reasoning and the how-to behind it — and every brief
 * carries the active ones, so they reach a session without anybody remembering to look
 * (FRM-REQ-187).
 *
 * Grouped by area, because "what are the design rules" is the question you arrive with. Retired
 * guidelines stay, behind the toggle: why something *used* to be the rule is worth keeping, and
 * a card that vanishes says nothing about whether it was ever there.
 *
 * **Every write lands in place, with Undo** (FRM-T-18.4). Delete is soft and undoable, so it acts at
 * once and the toast offers the way back; the editor asks before a draft is thrown away.
 */

type View = 'active' | 'retired';

const EMPTY: GuidelineInput = { title: '', area: '', decision: '', rationale: '', guidance: '' };

export function Guidelines() {
  // `refresh` re-reads in place: a save or an undo never drops the page back to a skeleton.
  const { state, refresh } = useAsync(() => foreman.guidelines(), []);
  // Which groups exist, for "Applies to" (FRM-REQ-235). A guideline still renders without them.
  const groups = useAsync(() => foreman.groups(), []);
  const listing = groups.state.status === 'ready' ? groups.state.value : null;
  const [view, setView] = useState<View>('active');
  const [open, setOpen] = useState<GuidelineRow | null>(null);
  const [editing, setEditing] = useState<GuidelineRow | 'new' | null>(null);

  const all = state.status === 'ready' ? state.value.items : [];
  const items = all.filter((row) => row.status === view);
  const areas = [...new Set(all.map((row) => row.area))].sort();
  const byArea = groupBy(items, (row) => row.area);

  // A jump to a retired guideline switches to the Retired view first, so the card is there to land on.
  const anchorId = useAnchorId();
  const anchored = anchorId === null ? undefined : all.find((row) => row.humanId === anchorId);
  const anchoredView = anchored?.status;
  useEffect(() => {
    if (anchoredView !== undefined && anchoredView !== view) setView(anchoredView);
    // Only a change of the anchor moves the view; picking a view by hand afterwards must stick.
  }, [anchorId, anchoredView]);
  useRowAnchor(state.status === 'ready' && items.length > 0 && (anchored === undefined || anchored.status === view));

  const saved = (row: GuidelineRow) => {
    setEditing(null);
    // Reopen what was just saved, so an edit made from the card's dialog lands back on it.
    setOpen(row);
    refresh();
  };

  return (
    <Page>
      <PageHeader
        title="Guidelines"
        description="Standing decisions for every project. Each brief carries the active ones, so every session starts with them."
        {...(state.status === 'ready'
          ? {
              count: all.filter((row) => row.status === 'active').length,
              countNoun: { one: 'active guideline', other: 'active guidelines' },
            }
          : {})}
        actions={
          <>
            <SegmentedControl
              items={[
                { value: 'active', label: 'Active' },
                { value: 'retired', label: 'Retired' },
              ]}
              value={view}
              onValueChange={(next) => { setView(next === 'retired' ? 'retired' : 'active'); }}
              size="sm"
              aria-label="Which guidelines to show"
            />
            <Button variant="primary" onClick={() => { setEditing('new'); }}>
              New guideline
            </Button>
          </>
        }
      />

      {state.status === 'loading' ? (
        <Skeleton lines={10} />
      ) : state.status === 'error' ? (
        <EmptyState kind="error" heading="The guidelines did not load">
          {state.message}
        </EmptyState>
      ) : items.length === 0 ? (
        view === 'active' ? (
          <EmptyState kind="empty" heading="No guidelines yet">
            Write down a decision that should hold in every project — a design rule, a security
            stance, a way of working — and every brief will carry it from then on.
          </EmptyState>
        ) : (
          <EmptyState kind="empty" heading="Nothing retired">
            A guideline you stop following moves here, with its reasoning intact.
          </EmptyState>
        )
      ) : (
        <Stack gap="24">
          {[...byArea.entries()].map(([area, rows]) => (
            <Section key={area} title={area} surface="plain">
              <Grid minItemWidth="md">
                {rows.map((row) => (
                  <GuidelineCard key={row.humanId} row={row} listing={listing} onOpen={() => { setOpen(row); }} />
                ))}
              </Grid>
            </Section>
          ))}
        </Stack>
      )}

      <Modal
        open={open !== null}
        onOpenChange={(next) => { if (!next) setOpen(null); }}
        size="lg"
        title={open === null ? '' : `${open.humanId} — ${open.title}`}
      >
        {open !== null && (
          <GuidelineBody
            row={open}
            listing={listing}
            onEdit={() => {
              setEditing(open);
              setOpen(null);
            }}
            onChanged={(row) => {
              setOpen(row);
              refresh();
            }}
            onDeleted={() => {
              setOpen(null);
              refresh();
            }}
            onUndone={() => {
              setOpen(null);
              refresh();
            }}
          />
        )}
      </Modal>

      <GuidelineForm
        editing={editing}
        areas={areas}
        listing={listing}
        onClose={() => { setEditing(null); }}
        onSaved={saved}
        onUndone={refresh}
      />
    </Page>
  );
}

/** Where a guideline applies, as the card and the dialog say it: every project, or its groups. */
function Scope({ row, listing }: { row: GuidelineRow; listing: GroupListing | null }) {
  if (row.appliesTo === 'all') return <Pill tone="neutral">All projects</Pill>;
  return (
    <Cluster gap="6" align="center">
      {row.groups.map((id) => {
        const group = listing?.items.find((candidate) => candidate.humanId === id);
        return group === undefined ? (
          <Pill key={id} tone="neutral">{id}</Pill>
        ) : (
          <GroupChip key={id} name={group.name} accent={group.accent} />
        );
      })}
    </Cluster>
  );
}

function GuidelineCard({
  row,
  listing,
  onOpen,
}: {
  row: GuidelineRow;
  listing: GroupListing | null;
  onOpen: () => void;
}) {
  return (
    <Card
      id={row.humanId}
      padding="md"
      interactive
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <Stack gap="8">
        <Cluster gap="8" align="center" justify="between">
          <code className="fm-card__code">{row.humanId}</code>
          {row.status === 'retired' && <Pill tone="neutral">retired</Pill>}
        </Cluster>
        <span className="fm-card__title">{row.title}</span>
        <span className="fm-guideline__decision">{row.decision}</span>
        <Scope row={row} listing={listing} />
      </Stack>
    </Card>
  );
}

function GuidelineBody({
  row,
  listing,
  onEdit,
  onChanged,
  onDeleted,
  onUndone,
}: {
  row: GuidelineRow;
  listing: GroupListing | null;
  onEdit: () => void;
  onChanged: (row: GuidelineRow) => void;
  onDeleted: () => void;
  /** After an undo from the toast: the card may be back, or back as it was. */
  onUndone: () => void;
}) {
  const { mutate, pending: busy } = useMutate();
  const [error, setError] = useState<string | null>(null);

  const retired = row.status === 'retired';

  const remove = () => {
    setError(null);
    // Soft, and undoable from the toast — so it acts at once rather than asking (FRM-T-18.4).
    void mutate({
      subject: row.humanId,
      run: () => foreman.deleteGuideline(row.humanId),
      message: () => `${row.humanId} deleted`,
      apply: onDeleted,
      undone: `Undone — ${row.humanId} is back`,
      onUndone,
      failure: 'inline',
    }).then((outcome) => {
      if (!outcome.ok && outcome.inFlight !== true) setError(outcome.message);
    });
  };

  const toggleRetired = () => {
    setError(null);
    void mutate({
      subject: row.humanId,
      run: () => foreman.updateGuideline(row.humanId, { status: retired ? 'active' : 'retired' }),
      message: (saved) => `${saved.humanId} ${saved.status === 'retired' ? 'retired' : 'reinstated'}`,
      apply: onChanged,
      undone: `Undone — ${row.humanId} is ${row.status} again`,
      onUndone,
      failure: 'inline',
    }).then((outcome) => {
      if (!outcome.ok && outcome.inFlight !== true) setError(outcome.message);
    });
  };

  return (
    <Stack gap="16">
      <Cluster gap="8" align="center">
        <Pill tone="neutral">{row.area}</Pill>
        {retired && <Pill tone="warning">retired — no longer in any brief</Pill>}
      </Cluster>

      <Cluster gap="8" align="center">
        <span className="fm-part__label">Applies to</span>
        <Scope row={row} listing={listing} />
      </Cluster>

      <div className="fm-callout">
        <span className="fm-callout__label">The decision</span>
        {row.decision}
      </div>

      {row.rationale !== null && <Part label="Why" body={row.rationale} />}
      {row.guidance !== null && <Part label="How to apply it" body={row.guidance} />}

      {error !== null && <Alert tone="danger" title="That did not save">{error}</Alert>}

      <FormActions>
        <Button
          variant="danger-ghost"
          disabled={busy}
          onClick={remove}
        >
          Delete
        </Button>
        <Button
          disabled={busy}
          onClick={toggleRetired}
        >
          {retired ? 'Reinstate' : 'Retire'}
        </Button>
        <Button variant="primary" disabled={busy} onClick={onEdit}>
          Edit
        </Button>
      </FormActions>
    </Stack>
  );
}

function GuidelineForm({
  editing,
  areas,
  listing,
  onClose,
  onSaved,
  onUndone,
}: {
  editing: GuidelineRow | 'new' | null;
  areas: readonly string[];
  listing: GroupListing | null;
  onClose: () => void;
  onSaved: (row: GuidelineRow) => void;
  onUndone: () => void;
}) {
  // How much the open form would lose — reported up by the form, so Escape and the scrim can ask.
  const [draft, setDraft] = useState(0);
  const allowClose = useDraftGuard(
    editing === null ? 0 : draft,
    editing === 'new' || editing === null ? 'the new guideline' : editing.humanId,
  );
  return (
    <Modal
      open={editing !== null}
      onOpenChange={(next) => {
        if (!next && allowClose()) {
          setDraft(0);
          onClose();
        }
      }}
      size="lg"
      title={editing === 'new' || editing === null ? 'New guideline' : `Edit ${editing.humanId}`}
      description="The decision is what every brief carries — keep it to a line or two. The reasoning and the how-to are read when someone needs them."
    >
      {editing !== null && (
        // Keyed so opening a different card starts from its values, not the last one's.
        <FormBody
          key={editing === 'new' ? 'new' : editing.humanId}
          editing={editing}
          areas={areas}
          listing={listing}
          onClose={() => {
            setDraft(0);
            onClose();
          }}
          onSaved={(row) => {
            setDraft(0);
            onSaved(row);
          }}
          onUndone={onUndone}
          onDraft={setDraft}
        />
      )}
    </Modal>
  );
}

function FormBody({
  editing,
  areas,
  listing,
  onClose,
  onSaved,
  onUndone,
  onDraft,
}: {
  editing: GuidelineRow | 'new';
  areas: readonly string[];
  listing: GroupListing | null;
  onClose: () => void;
  onSaved: (row: GuidelineRow) => void;
  onUndone: () => void;
  /** How many characters would be lost if the form closed now. */
  onDraft: (characters: number) => void;
}) {
  const stored: GuidelineInput =
    editing === 'new'
      ? EMPTY
      : {
          title: editing.title,
          area: editing.area,
          decision: editing.decision,
          rationale: editing.rationale ?? '',
          guidance: editing.guidance ?? '',
        };
  const [draft, setDraft] = useState<GuidelineInput>(stored);
  const { mutate } = useMutate();
  // Told upward after each render, so the dialog around this form knows what Escape would lose.
  const unsaved = draftSize({ ...stored }, { ...draft });
  useEffect(() => {
    onDraft(unsaved);
  }, [unsaved, onDraft]);
  const [appliesTo, setAppliesTo] = useState<GuidelineScope>(editing === 'new' ? 'all' : editing.appliesTo);
  const [chosen, setChosen] = useState<readonly string[]>(editing === 'new' ? [] : editing.groups);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof GuidelineInput) => (value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const groups = listing?.items ?? [];
  // In group order, whatever order they were ticked in: the order the API answers with.
  const chosenInOrder = groups.map((group) => group.humanId).filter((id) => chosen.includes(id));
  const valid =
    draft.title.trim().length > 0 &&
    draft.area.trim().length > 0 &&
    draft.decision.trim().length > 0 &&
    (appliesTo === 'all' || chosenInOrder.length > 0);
  const reach = groups.filter((group) => chosenInOrder.includes(group.humanId));
  const reachCount = reach.reduce((sum, group) => sum + group.counts.projects, 0);
  const subject = editing === 'new' ? 'It' : editing.humanId;

  const submit = () => {
    setBusy(true);
    setError(null);
    const body = {
      ...draft,
      title: draft.title.trim(),
      area: draft.area.trim(),
      ...(appliesTo === 'all'
        ? { appliesTo: 'all' as const }
        : { appliesTo: 'groups' as const, groups: chosenInOrder }),
    };
    void mutate({
      subject: editing === 'new' ? 'the new guideline' : editing.humanId,
      run: () =>
        editing === 'new' ? foreman.createGuideline(body) : foreman.updateGuideline(editing.humanId, body),
      message: (saved) => (editing === 'new' ? `${saved.humanId} added` : `Saved ${saved.humanId}`),
      onUndone,
      failure: 'inline',
    })
      .then((outcome) => {
        if (outcome.ok) onSaved(outcome.value);
        else if (outcome.inFlight !== true) setError(outcome.message);
      })
      .finally(() => { setBusy(false); });
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !busy) submit();
      }}
    >
      <Stack gap="16">
        <FormField label="Title" help="What it is about, in a few words.">
          <Input
            value={draft.title}
            maxLength={200}
            onChange={(event) => { set('title')(event.target.value); }}
            placeholder="Every app gets both logins"
          />
        </FormField>

        <FormField
          label="Area"
          help={
            areas.length === 0
              ? 'Groups cards on the page — Design, Security, Process.'
              : `Groups cards on the page. In use: ${areas.join(', ')}.`
          }
        >
          <Input
            value={draft.area}
            maxLength={40}
            list="fm-guideline-areas"
            onChange={(event) => { set('area')(event.target.value); }}
            placeholder="Architecture"
          />
        </FormField>
        <datalist id="fm-guideline-areas">
          {areas.map((area) => (
            <option key={area} value={area} />
          ))}
        </datalist>

        <FormField label="The decision" help="The rule itself. This line goes into every brief.">
          <Textarea
            rows={2}
            maxLength={400}
            value={draft.decision}
            onChange={(event) => { set('decision')(event.target.value); }}
          />
        </FormField>

        <FormField label="Why" help="Markdown. What it protects, and what went wrong without it.">
          <Textarea
            rows={5}
            value={draft.rationale}
            onChange={(event) => { set('rationale')(event.target.value); }}
          />
        </FormField>

        <FormField
          label="How to apply it"
          help="Markdown. The specifics — checklists, do and don't, the exceptions."
        >
          <Textarea
            rows={7}
            value={draft.guidance}
            onChange={(event) => { set('guidance')(event.target.value); }}
          />
        </FormField>

        <FormField as="group" label="Applies to">
          <Stack gap="8">
            <SegmentedControl
              aria-label="Applies to"
              size="sm"
              items={[
                { value: 'all', label: 'All projects' },
                { value: 'groups', label: 'Chosen groups' },
              ]}
              value={appliesTo}
              onValueChange={(next) => { setAppliesTo(next === 'groups' ? 'groups' : 'all'); }}
            />
            {appliesTo === 'groups' &&
              (groups.length === 0 ? (
                <span className="fm-muted">
                  There are no groups yet. Make one on the <Link variant="inline" href="/groups">Groups</Link> screen first.
                </span>
              ) : (
                <Stack gap="6">
                  {groups.map((group) => (
                    <Cluster key={group.humanId} gap="8" align="center">
                      <Checkbox
                        label={group.name}
                        checkIcon={<Check />}
                        checked={chosen.includes(group.humanId)}
                        onCheckedChange={(next) => {
                          setChosen((current) =>
                            next === true
                              ? [...current.filter((id) => id !== group.humanId), group.humanId]
                              : current.filter((id) => id !== group.humanId),
                          );
                        }}
                      />
                      <span className="fm-muted">
                        {group.counts.projects} {group.counts.projects === 1 ? 'project' : 'projects'}
                      </span>
                    </Cluster>
                  ))}
                </Stack>
              ))}
            <span className="fm-muted">
              {appliesTo === 'all'
                ? 'Every project, in every group and none.'
                : reach.length === 0
                  ? 'Choose at least one group — a guideline for no group applies to nothing.'
                  : `${subject} will apply to the ${String(reachCount)} ${reachCount === 1 ? 'project' : 'projects'} in ${listJoin(reach.map((g) => g.name))}. Projects in no group get only all-project guidelines.`}
            </span>
          </Stack>
        </FormField>

        {error !== null && <Alert tone="danger" title="It was not saved">{error}</Alert>}

        <FormActions>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !valid}>
            {busy ? 'Saving…' : editing === 'new' ? 'Add guideline' : 'Save guideline'}
          </Button>
        </FormActions>
      </Stack>
    </form>
  );
}

function Part({ label, body }: { label: string; body: string }) {
  return (
    <Stack gap="4">
      <span className="fm-part__label">{label}</span>
      <Markdown>{body}</Markdown>
    </Stack>
  );
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list === undefined) out.set(k, [row]);
    else list.push(row);
  }
  return out;
}
