import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  EmptyState,
  FormActions,
  FormField,
  IconButton,
  Input,
  Link,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Modal,
  Page,
  PageHeader,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { ChevronDown, ChevronUp, Ellipsis, Info, Plus } from 'lucide-react';
import type { Group, GroupAccent, GroupListing, GroupWithProjects } from '@foreman/shared';
import { undoReportWords, useMutate } from '../lib/mutate';
import {
  ApiError,
  foreman,
  type Audited,
  type GroupDeleteRefusal,
  type GroupInput,
  type GuidelineRow,
} from '../lib/api';
import { useAsync } from '../lib/useAsync';
import {
  ACCENTS,
  accentLabel,
  applicableGuidelines,
  listJoin,
  moveBy,
  siteLabel,
} from '../lib/groups';
import { AccentDot, MoveToGroupDialog, useMoveToast, type MovingProject } from '../ui/groups';

/**
 * Settings → Groups (17.07 – 17.09, FRM-REQ-230): the one screen where families are made, renamed,
 * ordered and removed.
 *
 * **No drag.** Order is changed by a Move up / Move down button pair on each row, named for the
 * group ("Move Dormice up"), disabled at the ends, and focus stays on the moved row's button so a
 * keyboard user can press it again to keep going (FRM-REQ-125). The order here is the order on
 * Home and Projects; Ungrouped is a fixed last row, not a group, and cannot move.
 *
 * A group still holding projects (or named by a guideline) is not deleted: the server refuses with
 * what holds it, and the row says so, with the way out — **Move projects…** — beside the reason.
 */

/** Read and re-read without flashing a skeleton: a reorder must not unmount the button it focuses. */
export function useGroupListing() {
  const [listing, setListing] = useState<GroupListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    foreman
      .groups()
      .then((value) => {
        setListing(value);
        setError(null);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      });
  }, []);
  useEffect(refresh, [refresh]);
  return { listing, setListing, error, refresh };
}

function plural(n: number, one: string, other: string): string {
  return `${String(n)} ${n === 1 ? one : other}`;
}

type Focus = { id: string; dir: 'up' | 'down' } | null;

/**
 * Keeps focus on a moved row's button across the re-render that moves it. If the row reached an
 * end, the button it pressed is now disabled, so focus goes to the other one instead of the body.
 */
export function useReorderFocus() {
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());
  const [pending, setPending] = useState<Focus>(null);
  useLayoutEffect(() => {
    if (pending === null) return;
    const first = buttons.current.get(`${pending.id}:${pending.dir}`);
    const other = buttons.current.get(`${pending.id}:${pending.dir === 'up' ? 'down' : 'up'}`);
    const target = first !== undefined && first !== null && !first.disabled ? first : other;
    target?.focus();
    setPending(null);
  });
  const ref = (id: string, dir: 'up' | 'down') => (node: HTMLButtonElement | null) => {
    buttons.current.set(`${id}:${dir}`, node);
  };
  return { ref, focusAfter: setPending };
}

export function Groups({ search }: { search: string }) {
  const { listing, setListing, error, refresh } = useGroupListing();
  const guidelines = useAsync(() => foreman.guidelines(), []);
  const [editing, setEditing] = useState<GroupWithProjects | 'new' | null>(() =>
    new URLSearchParams(search).get('new') === '1' ? 'new' : null,
  );
  const [refusals, setRefusals] = useState<ReadonlyMap<string, GroupDeleteRefusal>>(new Map());
  const [confirming, setConfirming] = useState<GroupWithProjects | null>(null);
  const [moveFor, setMoveFor] = useState<{ group: string; projects: MovingProject[] } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusAfter } = useReorderFocus();
  const { mutate, pending } = useMutate();
  const toastMove = useMoveToast(refresh);

  const allGuidelines = guidelines.state.status === 'ready' ? guidelines.state.value.items : [];

  const header = (
    <PageHeader
      title="Groups"
      description="Families of projects. Each gets its own section on Home and Projects, and its own set of guidelines."
      {...(listing === null ? {} : { count: listing.items.length, countNoun: { one: 'group', other: 'groups' } })}
      actions={
        <Button variant="primary" icon={<Plus />} onClick={() => { setEditing('new'); }}>
          New group
        </Button>
      }
    />
  );

  if (error !== null && listing === null) {
    return (
      <Page>
        {header}
        <EmptyState kind="error" heading="The groups did not load">
          {error}
        </EmptyState>
      </Page>
    );
  }

  if (listing === null) {
    return (
      <Page>
        {header}
        <Skeleton lines={5} />
      </Page>
    );
  }

  const items = [...listing.items].sort((a, b) => a.position - b.position);

  const reorder = (index: number, delta: -1 | 1) => {
    const group = items[index];
    // One write at a time: a press while the last is with the server would move the row and then be
    // refused, so it does not move at all.
    if (group === undefined || pending) return;
    const next = moveBy(items, index, delta);
    // Moved now, confirmed by the answer: a button that waits on the network before the row moves
    // reads as a button that did nothing.
    setListing({ ...listing, items: next.map((g, position) => ({ ...g, position })) });
    focusAfter({ id: group.humanId, dir: delta < 0 ? 'up' : 'down' });
    setFailure(null);
    void mutate({
      subject: group.name,
      run: () => foreman.orderGroups(next.map((g) => g.humanId)),
      message: () => `Moved ${group.name} ${delta < 0 ? 'up' : 'down'}`,
      apply: (result) => { setListing(result); },
      undone: 'Put the order back',
      undoWords: undoReportWords('Put the order back'),
      onUndone: refresh,
      failure: 'inline',
    }).then((outcome) => {
      if (outcome.ok) return;
      if (outcome.inFlight !== true) setFailure(outcome.message);
      // Put the row back where the server has it.
      refresh();
    });
  };

  const remove = (group: GroupWithProjects) => {
    setFailure(null);
    void mutate({
      subject: group.name,
      run: () => foreman.deleteGroup(group.humanId),
      message: () => `Deleted ${group.name}`,
      apply: () => {
        setConfirming(null);
        setRefusals((current) => {
          const next = new Map(current);
          next.delete(group.humanId);
          return next;
        });
        refresh();
      },
      undone: `Put ${group.name} back`,
      undoWords: undoReportWords(`Put ${group.name} back`),
      onUndone: refresh,
      failure: 'inline',
    }).then((outcome) => {
      if (outcome.ok || outcome.inFlight === true) return;
      setConfirming(null);
      const caught = outcome.error;
      if (caught instanceof ApiError && caught.status === 409) {
        const body = caught.body as Partial<GroupDeleteRefusal> | undefined;
        setRefusals((current) =>
          new Map(current).set(group.humanId, {
            error: body?.error ?? caught.message,
            projects: body?.projects ?? [],
            guidelines: body?.guidelines ?? [],
          }),
        );
        return;
      }
      setFailure(outcome.message);
    });
  };

  const ungroupedGuidelines = applicableGuidelines(allGuidelines, null).length;

  return (
    <Page>
      {header}
      <Stack gap="16">
        <p className="fm-hint">
          <Info aria-hidden="true" className="fm-icon-sm" />
          Order here is the order on Home and Projects. Ungrouped is always last.
        </p>

        {failure !== null && (
          <Alert tone="danger" title="That did not save" dynamic>
            {failure}
          </Alert>
        )}

        <ul className="fm-glist" aria-label="Groups, in order">
          {items.map((group, index) => {
            const refusal = refusals.get(group.humanId);
            return (
              <li key={group.humanId} className="fm-glist__item">
                <div className="fm-glist__row">
                  <span className="fm-glist__reorder">
                    <IconButton
                      ref={ref(group.humanId, 'up')}
                      size="sm"
                      icon={<ChevronUp />}
                      label={`Move ${group.name} up`}
                      disabled={index === 0}
                      onClick={() => { reorder(index, -1); }}
                    />
                    <IconButton
                      ref={ref(group.humanId, 'down')}
                      size="sm"
                      icon={<ChevronDown />}
                      label={`Move ${group.name} down`}
                      disabled={index === items.length - 1}
                      onClick={() => { reorder(index, 1); }}
                    />
                  </span>
                  <AccentDot accent={group.accent} size="lg" />
                  <span className="fm-glist__text">
                    <a className="fm-glist__name" href={`/groups/${group.slug}`}>
                      {group.name}
                    </a>
                    <span className="fm-muted fm-break">
                      {[group.description, group.siteUrl === null ? 'no site' : siteLabel(group.siteUrl)]
                        .filter((part) => part !== null && part !== '')
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="fm-glist__meta">
                    <code className="fm-id-chip">{group.humanId}</code>
                    <span className="fm-muted">
                      {plural(group.counts.projects, 'project', 'projects')} ·{' '}
                      {plural(group.counts.guidelines, 'guideline', 'guidelines')}
                    </span>
                  </span>
                  <span className="fm-glist__actions">
                    <Button variant="ghost" size="sm" aria-label={`Edit ${group.name}`} onClick={() => { setEditing(group); }}>
                      Edit
                    </Button>
                    <Menu>
                      <MenuTrigger>
                        <IconButton size="sm" icon={<Ellipsis />} label={`More for ${group.name}`} />
                      </MenuTrigger>
                      <MenuContent align="end">
                        <MenuItem
                          tone="danger"
                          onSelect={() => {
                            // A group with projects in it will be refused, so ask the server
                            // straight away and show why; an empty one is confirmed first.
                            if (group.counts.projects > 0) remove(group);
                            else setConfirming(group);
                          }}
                        >
                          Delete {group.name}…
                        </MenuItem>
                      </MenuContent>
                    </Menu>
                  </span>
                </div>
                {refusal !== undefined && (
                  <div className="fm-glist__refusal">
                    <Alert
                      tone="danger"
                      dynamic
                      title={`${group.name} can’t be deleted yet`}
                      {...(refusal.projects.length > 0
                        ? {
                            actions: (
                              <Button
                                size="sm"
                                onClick={() => {
                                  setMoveFor({
                                    group: group.humanId,
                                    projects: refusal.projects.map((code) => ({
                                      code,
                                      name: group.projects.find((p) => p.code === code)?.name ?? code,
                                    })),
                                  });
                                }}
                              >
                                Move projects…
                              </Button>
                            ),
                          }
                        : {})}
                    >
                      {refusal.projects.length > 0 &&
                        `${group.name} still holds ${plural(refusal.projects.length, 'project', 'projects')} (${refusal.projects.join(', ')}). Move them first. `}
                      {refusal.guidelines.length > 0 && (
                        <>
                          {listJoin(refusal.guidelines)} {refusal.guidelines.length === 1 ? 'names' : 'name'} it — change
                          {refusal.guidelines.length === 1 ? ' its' : ' their'} Applies to in{' '}
                          <Link variant="inline" href="/guidelines">Guidelines</Link> first.
                        </>
                      )}
                    </Alert>
                  </div>
                )}
              </li>
            );
          })}
          <li className="fm-glist__item fm-glist__item--quiet">
            <div className="fm-glist__row">
              <span className="fm-glist__reorder" aria-hidden="true" />
              <span className="fm-accent fm-accent--lg fm-accent--none" aria-hidden="true" />
              <span className="fm-glist__text">
                <span className="fm-glist__name">Ungrouped</span>
                <span className="fm-muted">
                  Projects in no group. Always listed last; it cannot be moved, renamed or deleted.
                </span>
              </span>
              <span className="fm-glist__meta">
                <span className="fm-muted">
                  {plural(listing.ungrouped.counts.projects, 'project', 'projects')} ·{' '}
                  {plural(ungroupedGuidelines, 'guideline', 'guidelines')}
                </span>
              </span>
              <span className="fm-glist__actions" />
            </div>
          </li>
        </ul>
      </Stack>

      <GroupEditor
        editing={editing}
        listing={listing}
        guidelines={allGuidelines}
        onClose={() => { setEditing(null); }}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
        onUndone={refresh}
      />

      <Modal
        open={confirming !== null}
        onOpenChange={(next) => { if (!next) setConfirming(null); }}
        destructive
        title={confirming === null ? 'Delete group' : `Delete ${confirming.name}`}
        description="It holds no projects. Its section leaves Home and Projects; the audit trail keeps it, and it can be undone from there."
      >
        <FormActions>
          <Button onClick={() => { setConfirming(null); }}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => {
              if (confirming !== null) remove(confirming);
            }}
          >
            Delete group
          </Button>
        </FormActions>
      </Modal>

      <MoveToGroupDialog
        open={moveFor !== null}
        onOpenChange={(next) => { if (!next) setMoveFor(null); }}
        projects={moveFor?.projects ?? []}
        listing={listing}
        onMoved={(result, codes, targetName, origin) => {
          if (moveFor !== null) {
            const cleared = moveFor.group;
            setRefusals((current) => {
              const next = new Map(current);
              next.delete(cleared);
              return next;
            });
          }
          setMoveFor(null);
          setListing(result);
          toastMove(result, codes, targetName, origin);
        }}
      />
    </Page>
  );
}

/** The accent row: swatches with their names, as radios (17.08). */
function AccentPicker({
  value,
  onChange,
  listing,
  self,
}: {
  value: GroupAccent;
  onChange: (accent: GroupAccent) => void;
  listing: GroupListing;
  self: string | null;
}) {
  const name = useId();
  const helpId = useId();
  const inUse = listing.items
    .filter((group) => group.humanId !== self)
    .map((group) => `${accentLabel(group.accent)} (${group.name})`);
  return (
    <fieldset className="fm-radios" aria-describedby={helpId}>
      <legend className="fm-radios__legend">Accent</legend>
      <div className="fm-swatches">
        {ACCENTS.map((accent) => (
          <label key={accent.value} className="fm-swatch">
            <input
              type="radio"
              className="fm-swatch__input"
              name={name}
              value={accent.value}
              checked={value === accent.value}
              onChange={() => { onChange(accent.value); }}
            />
            <span className="fm-swatch__dot" style={{ background: accent.color }} aria-hidden="true" />
            <span className="fm-swatch__label">{accent.label}</span>
          </label>
        ))}
      </div>
      <p id={helpId} className="fm-muted">
        From the product palette — never a raw colour.
        {inUse.length > 0 ? ` In use: ${listJoin(inUse)}.` : ''}
      </p>
    </fieldset>
  );
}

/** What the server said about each field of a group, by field. */
interface FieldErrors {
  name?: string | undefined;
  description?: string | undefined;
  siteUrl?: string | undefined;
}

const BLANK: GroupInput = { name: '', description: '', siteUrl: '', accent: 'neutral' };

function isHttps(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** "New group" / "Edit D3 Cloud" (17.08). Exported for the group's own page. */
export function GroupEditor({
  editing,
  listing,
  guidelines,
  onClose,
  onSaved,
  onUndone,
}: {
  editing: GroupWithProjects | 'new' | null;
  listing: GroupListing;
  guidelines: readonly GuidelineRow[];
  onClose: () => void;
  onSaved: (saved: Audited<Group>, created: boolean) => void;
  /** Re-read the screen after the toast's Undo. */
  onUndone?: () => void;
}) {
  return (
    <Modal
      open={editing !== null}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={editing === null || editing === 'new' ? 'New group' : `Edit ${editing.name}`}
      description="A family of projects with its own section on Home and its own guidelines."
    >
      {editing !== null && (
        <EditorBody
          key={editing === 'new' ? 'new' : editing.humanId}
          editing={editing}
          listing={listing}
          guidelines={guidelines}
          onClose={onClose}
          onSaved={onSaved}
          {...(onUndone === undefined ? {} : { onUndone })}
        />
      )}
    </Modal>
  );
}

function EditorBody({
  editing,
  listing,
  guidelines,
  onClose,
  onSaved,
  onUndone,
}: {
  editing: GroupWithProjects | 'new';
  listing: GroupListing;
  guidelines: readonly GuidelineRow[];
  onClose: () => void;
  onSaved: (saved: Audited<Group>, created: boolean) => void;
  onUndone?: (() => void) | undefined;
}) {
  const [draft, setDraft] = useState<GroupInput>(
    editing === 'new'
      ? BLANK
      : {
          name: editing.name,
          description: editing.description ?? '',
          siteUrl: editing.siteUrl ?? '',
          accent: editing.accent,
        },
  );
  const { mutate, pending: busy } = useMutate();
  const [error, setError] = useState<string | null>(null);
  // What the server said about each field on a 400 or a 409, shown beside the field it is about.
  const [serverFields, setServerFields] = useState<FieldErrors>({});
  const serverNameError = serverFields.name ?? null;
  const self = editing === 'new' ? null : editing.humanId;

  const clash = listing.items.find(
    (group) => group.humanId !== self && group.name.trim().toLowerCase() === draft.name.trim().toLowerCase(),
  );
  const nameError =
    clash !== undefined
      ? `${clash.name} already exists (${clash.humanId}). Names are unique, ignoring case.`
      : serverNameError;
  const siteError =
    draft.siteUrl.trim() !== '' && !isHttps(draft.siteUrl.trim())
      ? 'A site is an absolute https:// address.'
      : (serverFields.siteUrl ?? null);
  const descriptionError = serverFields.description ?? null;
  const valid = draft.name.trim().length > 0 && nameError === null && siteError === null;

  const applying = applicableGuidelines(guidelines, self);
  const all = applying.filter((row) => row.appliesTo === 'all').map((row) => row.humanId);
  const own = applying.filter((row) => row.appliesTo === 'groups').map((row) => row.humanId);

  const submit = () => {
    setError(null);
    setServerFields({});
    const created = editing === 'new';
    void mutate({
      subject: created ? 'the new group' : editing.name,
      run: () => (created ? foreman.createGroup(draft) : foreman.updateGroup(editing.humanId, draft)),
      message: (saved) => (created ? `Created ${saved.name}` : `Saved ${saved.name}`),
      undone: created ? `Removed ${draft.name}` : `Put ${editing.name} back as it was`,
      undoWords: undoReportWords(created ? `Removed ${draft.name}` : `Put ${editing.name} back as it was`),
      ...(onUndone === undefined ? {} : { onUndone }),
      failure: 'inline',
    }).then((outcome) => {
      if (outcome.ok) {
        onSaved(outcome.value, created);
        return;
      }
      if (outcome.inFlight === true) return;
      const caught = outcome.error;
      if (caught instanceof ApiError && caught.status === 409) {
        setServerFields({ name: `${caught.message}. Names are unique, ignoring case.` });
        return;
      }
      // A 400 names each field and what is wrong with it — `Ungrouped` and `All` are reserved,
      // a site must be https. Said beside the field, not as "the request body is not valid".
      if (caught instanceof ApiError && caught.status === 400) {
        const fields = (caught.body as { fields?: { path: string; message: string }[] } | undefined)?.fields ?? [];
        const byField: FieldErrors = {};
        const other: string[] = [];
        for (const field of fields) {
          if (field.path === 'name' || field.path === 'description' || field.path === 'siteUrl') {
            byField[field.path] = byField[field.path] === undefined ? field.message : `${byField[field.path] ?? ''} ${field.message}`;
          } else {
            other.push(field.path === '' ? field.message : `${field.path}: ${field.message}`);
          }
        }
        setServerFields(byField);
        if (other.length > 0 || Object.keys(byField).length === 0) {
          setError(other.length > 0 ? other.join(' ') : caught.message);
        }
        return;
      }
      setError(outcome.message);
    });
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !busy) submit();
      }}
    >
      <Stack gap="16">
        <FormField label="Name" {...(nameError === null ? {} : { error: nameError })}>
          <Input
            value={draft.name}
            maxLength={80}
            onChange={(event) => {
              setServerFields({ ...serverFields, name: undefined });
              setDraft({ ...draft, name: event.target.value });
            }}
          />
        </FormField>
        <FormField
          label="Description"
          help="One line. Shown under the name on Home."
          {...(descriptionError === null ? {} : { error: descriptionError })}
        >
          <Input
            value={draft.description}
            maxLength={200}
            onChange={(event) => {
              setServerFields({ ...serverFields, description: undefined });
              setDraft({ ...draft, description: event.target.value.replace(/[\r\n]/g, ' ') });
            }}
          />
        </FormField>
        <FormField label="Site URL" optional {...(siteError === null ? {} : { error: siteError })}>
          <Input
            type="url"
            inputMode="url"
            value={draft.siteUrl}
            placeholder="https://dormice.ai"
            onChange={(event) => {
              setServerFields({ ...serverFields, siteUrl: undefined });
              setDraft({ ...draft, siteUrl: event.target.value });
            }}
          />
        </FormField>
        <AccentPicker
          value={draft.accent}
          onChange={(accent) => { setDraft({ ...draft, accent }); }}
          listing={listing}
          self={self}
        />
        <div className="fm-callout">
          <span className="fm-callout__label">Guidelines that apply</span>
          <span>
            {all.length === 0 ? 'No all-project guideline yet.' : `Every all-project guideline: ${listJoin(all)}.`}{' '}
            {own.length > 0
              ? `And its own: ${listJoin(own)}.`
              : 'Group-only guidelines are chosen on the guideline itself.'}
          </span>
          <Link href="/guidelines">Open Guidelines</Link>
        </div>

        {error !== null && (
          <Alert tone="danger" title="It was not saved" dynamic>
            {error}
          </Alert>
        )}

        <FormActions>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !valid}>
            {busy ? 'Saving…' : editing === 'new' ? 'Create group' : 'Save'}
          </Button>
        </FormActions>
      </Stack>
    </form>
  );
}
