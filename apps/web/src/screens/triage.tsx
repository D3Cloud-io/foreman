import { useEffect, useRef, useState, type SyntheticEvent, type MouseEvent, type ReactNode } from 'react';
import { Button, FormField, Modal, Stack, Textarea, useToast } from '@d3cloud/ui';
import { ChevronLeft } from 'lucide-react';
import { replaceLocation } from '../lib/router';
import { withParams } from '../lib/scope';
import { dialogIsOpen, triageKeyFor, type TriageKey } from '../lib/shortcuts';
import { failureMessage } from '../lib/mutate';
import { undoAll } from '../lib/undo';
import { refreshSignals } from '../components/shellSignals';
import './Triage.css';

/**
 * What the four tabs of `/findings` share (FRM-T-18.7, FRM-REQ-246, design review FRM-DA-007).
 *
 * - **Where you are lives in the URL.** `?tab=` names the tab (Findings is its absence), `?sel=`
 *   the selected row, beside the scope (`?group=`) and the filters, so a reload, Back and a copied
 *   link land on the same record. Both are rewritten with `replaceLocation`: moving down a list is
 *   not a history entry.
 * - **A split view**: the list on the left, the selected record on the right. Below `lg` it is a
 *   list, then the record — a phone shows the record only once one is chosen, with a way back.
 * - **Keys act on the selected row** only outside a text field and while no dialog is open
 *   (`triageKeyFor`).
 * - **Bulk verdicts are N writes, and N undos.** Each item is its own audit event, so each can
 *   refuse on its own, and the toast says which did — a partial undo never reads as success.
 */

export const TRIAGE_TABS = ['findings', 'drift', 'review', 'blocked'] as const;
export type TriageTab = (typeof TRIAGE_TABS)[number];

export const TAB_LABEL: Record<TriageTab, string> = {
  findings: 'Findings',
  drift: 'Drift',
  review: 'Review',
  blocked: 'Blocked',
};

/** The tab a query string names. Findings is the default, and so the absence of `?tab=`. */
export function tabOf(search: string): TriageTab {
  const value = new URLSearchParams(search).get('tab') ?? '';
  return (TRIAGE_TABS as readonly string[]).includes(value) ? (value as TriageTab) : 'findings';
}

/** `/findings` on another tab: the scope kept, the selection and the tab's own filters dropped. */
export function tabHref(search: string, tab: TriageTab): string {
  return withParams(`/findings${search}`, {
    tab: tab === 'findings' ? null : tab,
    sel: null,
    // Filters belong to the Findings tab; carrying them to Drift would filter nothing visibly.
    ...(tab === 'findings' ? {} : { severity: null, lens: null, status: null, project: null }),
  });
}

/** The selected row a query string names, or null. */
export function selectionOf(search: string): string | null {
  const value = new URLSearchParams(search).get('sel')?.trim() ?? '';
  return value.length === 0 ? null : value;
}

/** Select a row: the URL says which, without a history entry. Null clears it. */
export function select(search: string, id: string | null): void {
  replaceLocation(withParams(`/findings${search}`, { sel: id }));
}

/**
 * The row `delta` away from `current` (j is +1, k is −1), held at either end. With nothing chosen
 * the first step lands on the first row — or the last, going up.
 */
export function moveSelection(ids: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  if (at === -1) return delta === 1 ? (ids[0] ?? null) : (ids[ids.length - 1] ?? null);
  const next = Math.min(ids.length - 1, Math.max(0, at + delta));
  return ids[next] ?? null;
}

/**
 * The row a pane shows: the one in the URL when it is still in the list, otherwise the first. A
 * phone shows the record only for a row the URL names (`picked`), so it opens on the list.
 */
export function effectiveSelection(ids: readonly string[], selected: string | null): string | null {
  if (selected !== null && ids.includes(selected)) return selected;
  return ids[0] ?? null;
}

/**
 * Listen for the triage keys while a tab is on screen. The handler answers whether it used the key;
 * a used key is not also typed or scrolled with.
 */
export function useTriageKeys(handler: (key: TriageKey) => boolean): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = triageKeyFor(event, { dialogOpen: dialogIsOpen(document) });
      if (key === null) return;
      if (latest.current(key)) event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);
}

/** A key cap beside a verdict. Hidden from assistive technology and on touch: the label says it. */
export function KeyHint({ k }: { k: string }) {
  return (
    <kbd className="d3-kbd fm-triage__kbd" aria-hidden="true">
      {k}
    </kbd>
  );
}

/**
 * The list and the record. `picked` is whether the URL names a row: below `lg` the list shows until
 * one is, then the record does, with a way back to the list.
 */
export function SplitView({
  label,
  picked,
  list,
  detail,
  onBack,
}: {
  label: string;
  picked: boolean;
  list: ReactNode;
  detail: ReactNode;
  onBack: () => void;
}) {
  return (
    <div className="fm-triage__split" data-picked={picked ? 'true' : 'false'}>
      <section className="fm-triage__list" aria-label={label}>
        {list}
      </section>
      <section className="fm-triage__detail" aria-label={`${label}: the selected record`}>
        <div className="fm-triage__back">
          <Button variant="ghost" icon={<ChevronLeft />} onClick={onBack}>
            Back to the list
          </Button>
        </div>
        {detail}
      </section>
    </div>
  );
}

/** A row of a triage list: a button that selects it, and says when it is the selected one. */
export function TriageRow({
  id,
  selected,
  dim,
  onSelect,
  leading,
  children,
  trailing,
}: {
  id: string;
  selected: boolean;
  dim?: boolean;
  /** Called with the click, so a shift-click can add to a selection instead. */
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
  leading?: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <li className={`fm-triage__row${selected ? ' fm-triage__row--selected' : ''}${dim === true ? ' fm-triage__row--dim' : ''}`}>
      {leading === undefined ? null : <span className="fm-triage__lead">{leading}</span>}
      <button
        type="button"
        className="fm-triage__pick"
        data-id={id}
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
      >
        <span className="fm-triage__body">{children}</span>
        {trailing === undefined ? null : <span className="fm-triage__state">{trailing}</span>}
      </button>
    </li>
  );
}

/** Keep the selected row in view as j and k move it. */
export function useScrollToSelected(id: string | null): void {
  useEffect(() => {
    if (id === null) return;
    const row = document.querySelector(`.fm-triage__pick[data-id="${CSS.escape(id)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [id]);
}

/**
 * Ask for a reason before a verdict that needs one — Won't fix. The button stays disabled until
 * there is one, and nothing is written until it is pressed.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  confirm,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  label: string;
  confirm: string;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const ready = reason.trim().length > 0;
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!ready) return;
    onOpenChange(false);
    onSubmit(reason.trim());
  };
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <form onSubmit={submit}>
        <Stack gap="16">
          <FormField label={label}>
            <Textarea
              name="reason"
              value={reason}
              maxLength={1000}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </FormField>
          <div className="fm-triage__actions">
            <Button type="submit" variant="primary" disabled={!ready}>
              {confirm}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </Stack>
      </form>
    </Modal>
  );
}

// ─── Bulk verdicts ─────────────────────────────────────────────────────────

/** One item of a bulk write: what it is called, and what the server answered. */
export type BulkResult =
  | { readonly id: string; readonly ok: true; readonly auditEventIds: readonly string[] }
  | { readonly id: string; readonly ok: false; readonly message: string };

/** One item of a bulk undo. */
export interface BulkUndo {
  readonly id: string;
  readonly undone: boolean;
  /** The server's own words, when it refused. */
  readonly message?: string;
}

function names(ids: readonly string[]): string {
  if (ids.length <= 1) return ids.join('');
  return `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1] ?? ''}`;
}

/**
 * What a bulk write says: "Acknowledged 3 findings", or — when some refused — how many went and
 * each refusal in the server's words: "Acknowledged 2 of 3 — DS-DA-009 refused: …".
 */
export function bulkLine(verb: string, noun: { one: string; other: string }, results: readonly BulkResult[]): string {
  const done = results.filter((r) => r.ok).length;
  const refused = results.filter((r): r is Extract<BulkResult, { ok: false }> => !r.ok);
  if (refused.length === 0) return `${verb} ${String(done)} ${done === 1 ? noun.one : noun.other}`;
  const why = refused.map((r) => `${r.id} refused: ${r.message}`).join('; ');
  if (done === 0) return `Nothing changed — ${why}`;
  return `${verb} ${String(done)} of ${String(results.length)} — ${why}`;
}

/**
 * What a bulk undo says. All of it: the success line. Part of it: how many, and each item that was
 * not undone with the server's reason — "Undid 2 of 3 — MUR-AP-003 was not undone: it has changed
 * since". It never reads as success when anything refused.
 */
export function bulkUndoLine(reports: readonly BulkUndo[], allBack: string): string {
  const back = reports.filter((r) => r.undone).map((r) => r.id);
  const not = reports.filter((r) => !r.undone);
  if (not.length === 0) return allBack;
  const why = not.map((r) => `${r.id} was not undone: ${r.message ?? 'refused'}`).join('; ');
  if (back.length === 0) return `Not undone — ${why}`;
  return `Undid ${String(back.length)} of ${String(reports.length)} — ${names(back)} ${back.length === 1 ? 'is' : 'are'} back; ${why}`;
}

/** Run a write per item, one after another, each tried even when one before it refused. */
export async function runBulk(
  ids: readonly string[],
  write: (id: string) => Promise<{ auditEventIds?: readonly string[] }>,
): Promise<BulkResult[]> {
  const results: BulkResult[] = [];
  for (const id of ids) {
    try {
      const answer = await write(id);
      results.push({ id, ok: true, auditEventIds: answer.auditEventIds ?? [] });
    } catch (caught) {
      results.push({ id, ok: false, message: failureMessage(caught) });
    }
  }
  return results;
}

/** Undo every item that went, each on its own — an item that changed since refuses alone. */
export async function undoBulk(results: readonly BulkResult[]): Promise<BulkUndo[]> {
  const reports: BulkUndo[] = [];
  for (const result of results) {
    if (!result.ok || result.auditEventIds.length === 0) continue;
    const report = await undoAll(result.auditEventIds);
    reports.push(
      report.refused.length === 0
        ? { id: result.id, undone: true }
        : { id: result.id, undone: false, message: report.refused.map((r) => r.message).join('; ') },
    );
  }
  return reports;
}

/**
 * A bulk verdict, start to finish: the writes, a toast naming what went and what refused, and an
 * Undo that reverses each item on its own and reports each refusal.
 */
export function useBulk(): {
  run: (spec: {
    ids: readonly string[];
    verb: string;
    noun: { one: string; other: string };
    write: (id: string) => Promise<{ auditEventIds?: readonly string[] }>;
    refresh: () => void;
    undone: string;
  }) => Promise<BulkResult[]>;
  pending: boolean;
} {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const run = async (spec: {
    ids: readonly string[];
    verb: string;
    noun: { one: string; other: string };
    write: (id: string) => Promise<{ auditEventIds?: readonly string[] }>;
    refresh: () => void;
    undone: string;
  }) => {
    setPending(true);
    try {
      const results = await runBulk(spec.ids, spec.write);
      spec.refresh();
      refreshSignals();
      const anyWent = results.some((r) => r.ok && r.auditEventIds.length > 0);
      const refused = results.some((r) => !r.ok);
      toast.show({
        message: bulkLine(spec.verb, spec.noun, results),
        ...(refused ? { duration: 0 } : {}),
        ...(anyWent
          ? {
              action: {
                label: 'Undo',
                onAction: () => {
                  void undoBulk(results).then((reports) => {
                    toast.show({
                      message: bulkUndoLine(reports, spec.undone),
                      ...(reports.some((r) => !r.undone) ? { duration: 0 } : {}),
                    });
                    spec.refresh();
                    refreshSignals();
                  });
                },
              },
            }
          : {}),
      });
      return results;
    } finally {
      setPending(false);
    }
  };
  return { run, pending };
}

/** "3 projects · SHP, MUR, DS" — what a selection spans. */
export function spanOf(codes: readonly string[]): string {
  const unique = [...new Set(codes)];
  return `${String(unique.length)} ${unique.length === 1 ? 'project' : 'projects'} · ${unique.join(', ')}`;
}
