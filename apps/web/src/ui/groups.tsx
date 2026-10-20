import { useEffect, useId, useState, type ReactNode } from 'react';
import { Alert, Button, FormActions, Modal, Stack } from '@d3cloud/ui';
import { TriangleAlert } from 'lucide-react';
import type { GroupAccent, GroupListing } from '@foreman/shared';
import { foreman, type GroupWrite } from '../lib/api';
import { useUndoToast } from '../lib/undo';
import {
  accentColor,
  changes,
  describeChange,
  guidelineChange,
  listJoin,
  type GuidelineChange,
} from '../lib/groups';

/**
 * The pieces every Groups screen shares (FRM-T-17.3): the accent dot, the group chip, the radio
 * list the library does not have yet (DS-REQ-014…025 file the gap), and the Move dialog with the
 * Undo that follows it.
 */

/** A group's accent, as a dot. Decorative: the group's name is always printed beside it. */
export function AccentDot({ accent, size = 'md' }: { accent: GroupAccent; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span
      className={`fm-accent fm-accent--${size}`}
      style={{ background: accentColor(accent) }}
      aria-hidden="true"
    />
  );
}

/** A group named with its dot — on a project's overview, a guideline's card. */
export function GroupChip({ name, accent, href }: { name: string; accent: GroupAccent; href?: string }) {
  const body = (
    <>
      <AccentDot accent={accent} size="sm" />
      {name}
    </>
  );
  return href === undefined ? (
    <span className="fm-chip">{body}</span>
  ) : (
    <a className="fm-chip fm-chip--link" href={href}>
      {body}
    </a>
  );
}

export interface RadioOption {
  readonly value: string;
  readonly label: ReactNode;
  /** A muted second part on the same line: "13 projects · current". */
  readonly detail?: ReactNode;
  /** Trails the row — an accent dot. */
  readonly trailing?: ReactNode;
}

/**
 * A radio group as rows, the board's Radio (17.05). Native inputs in a fieldset, which already is
 * the radio group: arrow keys move the choice, the legend names it, and nothing is re-implemented.
 */
export function RadioList({
  legend,
  name,
  options,
  value,
  onChange,
  hideLegend = false,
}: {
  legend: string;
  name: string;
  options: readonly RadioOption[];
  value: string | null;
  onChange: (value: string) => void;
  hideLegend?: boolean;
}) {
  return (
    <fieldset className="fm-radios fm-radiolist">
      <legend className={hideLegend ? 'fm-visually-hidden' : 'fm-radios__legend'}>{legend}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className={`fm-radiolist__row${value === option.value ? ' fm-radiolist__row--on' : ''}`}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => { onChange(option.value); }}
          />
          <span className="fm-radiolist__label">{option.label}</span>
          {option.detail !== undefined && <span className="fm-muted">{option.detail}</span>}
          {option.trailing !== undefined && <span className="fm-radiolist__trailing">{option.trailing}</span>}
        </label>
      ))}
    </fieldset>
  );
}

/** The toast after a move, with Undo (17.06): every project goes back to its group and place. */
export function useMoveToast(reload: () => void) {
  const show = useUndoToast();
  return (result: GroupWrite, codes: readonly string[], targetName: string) => {
    show({
      message: `Moved ${listJoin(codes)} to ${targetName}`,
      auditEventIds: result.auditEventIds,
      undone: `Put ${listJoin(codes)} back`,
      reload,
    });
  };
}

/** The projects a move is for, by code and name. */
export interface MovingProject {
  readonly code: string;
  readonly name: string;
}

const UNGROUPED = 'ungrouped';

/** Which group holds a project now, by `GRP-n` — or null for the ungrouped. */
export function groupOf(listing: GroupListing, code: string): string | null {
  return listing.items.find((group) => group.projects.some((p) => p.code === code))?.humanId ?? null;
}

/**
 * "Move 2 projects to…" (17.05, FRM-REQ-231/232).
 *
 * A radio list of every group with its count, then No group. Before anything moves it says what
 * the move does to the guidelines — read from each group's applicable guidelines — because a
 * project leaving D3 Cloud stops being bound by D3 Cloud's rules, and finding that out afterwards
 * is the mistake this sentence prevents.
 */
export function MoveToGroupDialog({
  open,
  onOpenChange,
  projects,
  listing,
  onMoved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: readonly MovingProject[];
  listing: GroupListing;
  onMoved: (result: GroupWrite, codes: string[], targetName: string) => void;
}) {
  const name = useId();
  const [target, setTarget] = useState<string | null>(null);
  const [guidelines, setGuidelines] = useState<Map<string, string[]> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const codes = projects.map((p) => p.code);
  const sources = new Set(codes.map((code) => groupOf(listing, code) ?? UNGROUPED));

  useEffect(() => {
    if (!open) return;
    setTarget(null);
    setError(null);
    setGuidelines(null);
    let live = true;
    // Each group's applicable guidelines, from its own detail: the server is the one place that
    // decides what applies, so the consequence is read rather than re-derived.
    void Promise.all(listing.items.map((group) => foreman.group(group.humanId)))
      .then((details) => {
        if (!live) return;
        const map = new Map<string, string[]>();
        for (const detail of details) map.set(detail.humanId, detail.guidelines.map((g) => g.humanId));
        // The ungrouped get the all-project guidelines, which every group's detail also lists.
        map.set(
          UNGROUPED,
          (details[0]?.guidelines ?? []).filter((g) => g.appliesTo === 'all').map((g) => g.humanId),
        );
        setGuidelines(map);
      })
      .catch(() => {
        if (live) setGuidelines(new Map());
      });
    return () => {
      live = false;
    };
    // Re-read each time it opens: guidelines may have been edited since the last move.
  }, [open, listing]);

  const options = [
    ...listing.items.map((group) => ({
      value: group.humanId,
      label: group.name,
      detail: `${String(group.counts.projects)} ${group.counts.projects === 1 ? 'project' : 'projects'}${
        sources.size === 1 && sources.has(group.humanId) ? ' · current' : ''
      }`,
      trailing: <AccentDot accent={group.accent} />,
    })),
    {
      value: UNGROUPED,
      label: 'No group (Ungrouped)',
      detail: `${String(listing.ungrouped.counts.projects)} ${listing.ungrouped.counts.projects === 1 ? 'project' : 'projects'}${
        sources.size === 1 && sources.has(UNGROUPED) ? ' · current' : ''
      }`,
    },
  ];

  const targetName =
    target === null
      ? ''
      : target === UNGROUPED
        ? 'Ungrouped'
        : (listing.items.find((group) => group.humanId === target)?.name ?? target);
  const alreadyThere = target !== null && sources.size === 1 && sources.has(target);

  let change: GuidelineChange | null = null;
  if (target !== null && guidelines !== null && guidelines.size > 0) {
    change = guidelineChange(
      [...sources].map((source) => guidelines.get(source) ?? []),
      guidelines.get(target) ?? [],
    );
  }

  const submit = () => {
    if (target === null) return;
    setBusy(true);
    setError(null);
    foreman
      .moveToGroup(target === UNGROUPED ? null : target, codes)
      .then((result) => {
        onOpenChange(false);
        onMoved(result, codes, targetName);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => { setBusy(false); });
  };

  const title =
    projects.length === 1 ? `Move ${projects[0]?.code ?? ''} to…` : `Move ${String(projects.length)} projects to…`;
  const verb = projects.length === 1 ? 'Move' : `Move ${String(projects.length)} projects`;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={`${listJoin(projects.map((p) => `${p.code} ${p.name}`))}. A project is in one group at most.`}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && target !== null && !alreadyThere) submit();
        }}
      >
        <Stack gap="16">
          <RadioList
            legend="Group"
            hideLegend
            name={name}
            options={options}
            value={target}
            onChange={setTarget}
          />

          {target !== null && alreadyThere && (
            <p className="fm-muted">
              {projects.length === 1 ? 'It is' : 'They are all'} in {targetName} already.
            </p>
          )}

          {change !== null && !alreadyThere && (
            changes(change) ? (
              <Alert tone="warning" title="Guidelines that apply will change" icon={<TriangleAlert />}>
                {describeChange(change, codes)}
              </Alert>
            ) : (
              <Alert tone="info" title="The same guidelines apply">
                {describeChange(change, codes)}
              </Alert>
            )
          )}

          {error !== null && (
            <Alert tone="danger" title="Nothing moved" dynamic>
              {error}
            </Alert>
          )}

          <FormActions>
            <Button type="button" onClick={() => { onOpenChange(false); }}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || target === null || alreadyThere}>
              {busy ? 'Moving…' : verb}
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Modal>
  );
}
