import { useEffect, useState, type SyntheticEvent, type ReactNode } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  Checkbox,
  EmptyState,
  FormField,
  Input,
  Link,
  Select,
  Skeleton,
  Stack,
  Textarea,
} from '@d3cloud/ui';
import { Check } from 'lucide-react';
import { api, foreman, type Audited, type DecisionRow, type DriftAcceptanceRow, type DriftItem } from '../lib/api';
import { useMutate, type MutationSpec } from '../lib/mutate';
import { useAsync, type AsyncHandle } from '../lib/useAsync';
import { CATEGORIES } from './DriftView';
import { TaskStatusEditor } from './TriageBlocked';
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
 * The Drift tab of `/findings` (FRM-T-18.7, design review FRM-DA-007 amendment 3).
 *
 * Every drift item in the scope — `GET /api/drift?group=`, the same engine as each project's drift
 * view and Home's figure — grouped by category, each row naming **the action that would resolve
 * it**. Choosing a row opens that action as an editor prefilled from the record, and nothing is
 * created until the operator saves it: drift cleared by a keystroke would be drift gamed, so the one
 * field that makes the fix real (a task's "Done when", an ADR's decision) is left empty on purpose.
 *
 * **Accepting drift needs a reason**, and the reason is kept: it is recorded as a decision on the
 * project ("Accepted drift on BND-REQ-041 …", the reason as its rationale), which the history and
 * the decision register both show and Undo removes. The decision is **linked** to what it accepts —
 * `acceptsDriftSubject` and `acceptsDriftCategory` (FRM-T-18.15) — and read back by that link through
 * `GET …/decisions?acceptsDrift=1`, every page of it; the statement's wording is for people, and
 * nothing matches on it. An accepted item moves to "Accepted" with its reason; the engine still
 * counts it everywhere else, so nothing claims it is gone.
 */

export interface DriftRow extends DriftItem {
  readonly project: { readonly code: string; readonly name: string };
}

export interface AcceptedRow extends DriftRow {
  readonly decision: Pick<DecisionRow, 'humanId' | 'rationale'>;
}

export interface DriftTriage {
  readonly items: readonly DriftRow[];
  readonly accepted: readonly AcceptedRow[];
}

/** A drift item's key in the URL. One ID may drift two ways — a task citing nothing and stale. */
export function driftKey(item: Pick<DriftItem, 'category' | 'humanId'>): string {
  return `${item.category}:${item.humanId}`;
}

/** The statement an acceptance is recorded under — for people reading the decision register. */
export function acceptanceStatement(item: Pick<DriftItem, 'category' | 'humanId' | 'detail'>): string {
  return `Accepted drift on ${item.humanId} (${item.category}): ${item.detail}`.slice(0, 1000);
}

/** The body that records an acceptance: the decision, and its link to the drift it accepts. */
export function acceptanceBody(item: Pick<DriftItem, 'category' | 'humanId' | 'detail'>, reason: string) {
  return {
    statement: acceptanceStatement(item),
    value: 'Accepted for now — not drift to act on',
    // The ID in the rationale makes the decision cite the record, so the record's backlinks
    // show it was accepted and why.
    rationale: `${reason.trim()}\n\nAccepts the drift on ${item.humanId}.`,
    acceptsDriftSubject: item.humanId,
    acceptsDriftCategory: item.category,
  };
}

/**
 * Split drift into what still needs you and what a decision on the project accepted — matched by the
 * decision's link to the record and the category, never by its wording.
 */
export function splitAccepted(
  rows: readonly DriftRow[],
  decisions: ReadonlyMap<
    string,
    readonly Pick<DriftAcceptanceRow, 'humanId' | 'rationale' | 'acceptsDriftSubject' | 'acceptsDriftCategory'>[]
  >,
): DriftTriage {
  const items: DriftRow[] = [];
  const accepted: AcceptedRow[] = [];
  for (const row of rows) {
    const decision = (decisions.get(row.project.code) ?? []).find(
      (d) => d.acceptsDriftSubject === row.humanId && d.acceptsDriftCategory === row.category,
    );
    if (decision === undefined) items.push(row);
    else accepted.push({ ...row, decision: { humanId: decision.humanId, rationale: decision.rationale } });
  }
  return { items, accepted };
}

export type DriftAction =
  | 'create-task'
  | 'cite-requirement'
  | 'set-status'
  | 'record-adr'
  | 'reopen-phase'
  | 'adr-status'
  | 'open-screen';

/** The action that would resolve an item, by what it is. */
export function actionFor(item: Pick<DriftItem, 'category' | 'humanId'>): DriftAction {
  switch (item.category) {
    case 'coverage-hole':
      return /-REQ-/.test(item.humanId) ? 'create-task' : 'cite-requirement';
    case 'stale-task':
      return 'set-status';
    case 'fired-tripwire':
      return 'record-adr';
    case 'failed-exit-gate':
      return 'reopen-phase';
    case 'orphan-adr':
      return 'adr-status';
    case 'screen-drift':
      return 'open-screen';
  }
}

export const ACTION_LABEL: Record<DriftAction, string> = {
  'create-task': 'Create task…',
  'cite-requirement': 'Cite a requirement…',
  'set-status': 'Set status…',
  'record-adr': 'Record ADR…',
  'reopen-phase': 'Reopen phase…',
  'adr-status': 'Set its status…',
  'open-screen': 'Open the screen',
};

/** A first line of a requirement, as a task title: its first sentence, within the 300 a title takes. */
export function titleFrom(statement: string): string {
  const first = statement.split(/(?<=[.!?])\s/)[0] ?? statement;
  return first.trim().slice(0, 300);
}

/**
 * Drift across the scope, narrowed to one project when `?project=` names one (FRM-T-18.15), and what
 * of it a decision accepted. `GET /api/drift` takes only a group, so the project is kept from its
 * answer here: the same intersection `/api/tasks` and `/api/attributions` make of the two.
 */
export function useDriftTriage(scope: string | null, project: string | null = null): AsyncHandle<DriftTriage> {
  return useAsync(async () => {
    const across = await foreman.driftAcross(scope);
    const rows: DriftRow[] = across.items
      .filter((p) => project === null || p.project === project)
      .flatMap((p) => p.items.map((item) => ({ ...item, project: { code: p.project, name: p.name } })));
    // Only the projects with drift can have accepted any; a project whose decisions do not load
    // shows its drift as still waiting rather than hiding it.
    const codes = [...new Set(rows.map((r) => r.project.code))];
    const decisions = new Map(
      await Promise.all(
        codes.map(async (code) => {
          try {
            return [code, await foreman.driftAcceptances(code)] as const;
          } catch {
            return [code, [] as DriftAcceptanceRow[]] as const;
          }
        }),
      ),
    );
    return splitAccepted(rows, decisions);
  }, [scope, project]);
}

function categoryLabel(category: DriftItem['category']): string {
  return CATEGORIES.find((c) => c.key === category)?.label ?? category;
}

/** Inline write state for an editor: the one way, and a failure shown beside the form. */
function useEditorSave() {
  const { mutate, pending } = useMutate();
  const [failure, setFailure] = useState<string | null>(null);
  const save = <R,>(spec: Omit<MutationSpec<R>, 'failure'>) => {
    setFailure(null);
    void mutate({ ...spec, failure: 'inline', signals: true }).then((outcome) => {
      if (!outcome.ok) setFailure(outcome.message);
    });
  };
  const alert =
    failure === null ? null : (
      <Alert tone="danger" title="That did not save" dynamic>
        {failure}
      </Alert>
    );
  return { save, pending, alert };
}

function SaveRow({ label, ready, pending }: { label: string; ready: boolean; pending: boolean }) {
  return (
    <div className="fm-triage__actions">
      <Button type="submit" variant="primary" disabled={!ready} loading={pending}>
        {label}
      </Button>
      <span className="fm-muted">Nothing is created until you save.</span>
    </div>
  );
}

// ─── The editors ───────────────────────────────────────────────────────────

function CreateTaskEditor({ item, onSaved }: { item: DriftRow; onSaved: () => void }) {
  const code = item.project.code;
  const requirement = useAsync(() => foreman.entity(item.humanId), [item.humanId]);
  const phases = useAsync(() => foreman.phases(code), [code]);
  const [title, setTitle] = useState('');
  const [phaseId, setPhaseId] = useState('');
  const [doneWhen, setDoneWhen] = useState('');
  const { save, pending, alert } = useEditorSave();

  // Prefilled from the requirement once it has loaded: its first sentence, and its phase.
  useEffect(() => {
    if (requirement.state.status !== 'ready') return;
    const entity = requirement.state.value.entity;
    setTitle(titleFrom(typeof entity['statement'] === 'string' ? entity['statement'] : item.title));
    setPhaseId(typeof entity['phaseId'] === 'string' ? entity['phaseId'] : '');
  }, [requirement.state, item.title]);

  if (requirement.state.status === 'loading' || phases.state.status === 'loading') return <Skeleton lines={4} />;
  const options = [
    { value: '', label: 'No phase — the backlog' },
    ...(phases.state.status === 'ready'
      ? phases.state.value.items.map((p) => ({ value: p.id, label: `${p.humanId} ${p.name}` }))
      : []),
  ];
  const ready = title.trim().length > 0 && doneWhen.trim().length > 0;

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!ready || pending) return;
    save({
      subject: item.humanId,
      run: () =>
        api.post<Audited<{ humanId: string }>>(
          `/api/projects/${code}/tasks?${new URLSearchParams({ satisfies: item.humanId }).toString()}`,
          { title: title.trim(), doneWhen: doneWhen.trim(), ...(phaseId === '' ? {} : { phaseId }) },
        ),
      message: (result) => `${result.humanId} created for ${item.humanId}`,
      refresh: onSaved,
      undone: `Undone — the task for ${item.humanId} is deleted`,
    });
  };

  return (
    <form onSubmit={submit} className="fm-triage__editor" aria-label={`New task for ${item.humanId}`}>
      <Stack gap="12">
        {alert}
        <p className="fm-muted">
          Prefilled from the requirement. Check every field: the drift clears when a real task exists, not when this
          form opens.
        </p>
        <FormField label="Title">
          <Input
            name="title"
            value={title}
            maxLength={300}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        </FormField>
        <FormField label="Phase">
          <Select options={options} value={phaseId} onValueChange={setPhaseId} />
        </FormField>
        <FormField label="Implements">
          <Input name="implements" value={item.humanId} readOnly />
        </FormField>
        <FormField
          label="Done when"
          help="Required, and never prefilled: Foreman will not guess what has to be true for this to be done."
        >
          <Textarea
            name="doneWhen"
            value={doneWhen}
            maxLength={2000}
            onChange={(event) => {
              setDoneWhen(event.target.value);
            }}
          />
        </FormField>
        <SaveRow label="Save task" ready={ready} pending={pending} />
      </Stack>
    </form>
  );
}

function CiteRequirementEditor({ item, onSaved }: { item: DriftRow; onSaved: () => void }) {
  const code = item.project.code;
  const requirements = useAsync(() => foreman.requirements(code, { limit: 200 }), [code]);
  const [chosen, setChosen] = useState('');
  const { save, pending, alert } = useEditorSave();

  if (requirements.state.status === 'loading') return <Skeleton lines={3} />;
  const rows = requirements.state.status === 'ready' ? requirements.state.value.items : [];
  if (rows.length === 0) {
    return (
      <EmptyState kind="empty" size="inline" heading={`${code} has no requirements to cite`}>
        Write the requirement this work is for first, or accept the drift with a reason.
      </EmptyState>
    );
  }
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const requirement = rows.find((r) => r.id === chosen);
    if (requirement === undefined || pending) return;
    save({
      subject: item.humanId,
      run: () =>
        api.patch<Audited<{ humanId: string }>>(`/api/projects/${code}/tasks/${item.humanId}`, {
          requirementIds: [requirement.id],
        }),
      message: () => `${item.humanId} now satisfies ${requirement.humanId}`,
      refresh: onSaved,
    });
  };
  return (
    <form onSubmit={submit} className="fm-triage__editor" aria-label={`Cite a requirement for ${item.humanId}`}>
      <Stack gap="12">
        {alert}
        <FormField label="The requirement it satisfies">
          <Select
            placeholder="Choose a requirement"
            options={rows.map((r) => ({ value: r.id, label: `${r.humanId} — ${r.statement.slice(0, 80)}` }))}
            value={chosen}
            onValueChange={setChosen}
          />
        </FormField>
        <SaveRow label="Save" ready={chosen !== ''} pending={pending} />
      </Stack>
    </form>
  );
}

function RecordAdrEditor({ item, onSaved }: { item: DriftRow; onSaved: () => void }) {
  const code = item.project.code;
  const [title, setTitle] = useState(`Re-plan after ${item.humanId} fired: ${item.title}`.slice(0, 300));
  const [context, setContext] = useState(`${item.detail}\n\nRaised by ${item.humanId}.`);
  const [decision, setDecision] = useState('');
  const [close, setClose] = useState(true);
  const { save, pending, alert } = useEditorSave();
  const ready = title.trim().length > 0 && decision.trim().length > 0;

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!ready || pending) return;
    save({
      subject: item.humanId,
      run: async () => {
        const adr = await api.post<Audited<{ humanId: string }>>(`/api/projects/${code}/adrs`, {
          title: title.trim(),
          status: 'proposed',
          contextMd: context.trim(),
          decisionMd: decision.trim(),
        });
        if (!close) return adr;
        // Both writes' events, the ADR's first: Undo reverses the risk, then the ADR.
        const risk = await api.patch<Audited<unknown>>(`/api/projects/${code}/risks/${item.humanId}`, { status: 'closed' });
        return { ...adr, auditEventIds: [...adr.auditEventIds, ...risk.auditEventIds] };
      },
      message: (result) => `${result.humanId} recorded${close ? ` · ${item.humanId} closed` : ''}`,
      refresh: onSaved,
    });
  };

  return (
    <form onSubmit={submit} className="fm-triage__editor" aria-label={`Record an ADR for ${item.humanId}`}>
      <Stack gap="12">
        {alert}
        <FormField label="Title">
          <Input
            name="title"
            value={title}
            maxLength={300}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        </FormField>
        <FormField label="Context">
          <Textarea
            name="context"
            value={context}
            onChange={(event) => {
              setContext(event.target.value);
            }}
          />
        </FormField>
        <FormField label="Decision" help="Required, and never prefilled: what changes now that the tripwire fired.">
          <Textarea
            name="decision"
            value={decision}
            onChange={(event) => {
              setDecision(event.target.value);
            }}
          />
        </FormField>
        <Checkbox
          label={`Close ${item.humanId} once the ADR is recorded`}
          checkIcon={<Check />}
          checked={close}
          onCheckedChange={(next) => {
            setClose(next === true);
          }}
        />
        <SaveRow label="Save ADR" ready={ready} pending={pending} />
      </Stack>
    </form>
  );
}

function StatusEditor({
  item,
  onSaved,
  path,
  options,
  initial,
  label,
}: {
  item: DriftRow;
  onSaved: () => void;
  path: string;
  options: { value: string; label: string }[];
  initial: string;
  label: string;
}) {
  const [status, setStatus] = useState(initial);
  const { save, pending, alert } = useEditorSave();
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (pending) return;
    save({
      subject: item.humanId,
      run: () => api.patch<Audited<{ humanId: string; status: string }>>(path, { status }),
      message: (result) => `${result.humanId} set to ${result.status.replace(/_/g, ' ')}`,
      refresh: onSaved,
    });
  };
  return (
    <form onSubmit={submit} className="fm-triage__editor" aria-label={`${label} of ${item.humanId}`}>
      <Stack gap="12">
        {alert}
        <FormField label={label}>
          <Select options={options} value={status} onValueChange={setStatus} />
        </FormField>
        <SaveRow label="Save status" ready pending={pending} />
      </Stack>
    </form>
  );
}

function ResolveEditor({ item, onSaved }: { item: DriftRow; onSaved: () => void }) {
  const code = item.project.code;
  switch (actionFor(item)) {
    case 'create-task':
      return <CreateTaskEditor item={item} onSaved={onSaved} />;
    case 'cite-requirement':
      return <CiteRequirementEditor item={item} onSaved={onSaved} />;
    case 'set-status':
      return (
        <TaskStatusEditor
          code={code}
          humanId={item.humanId}
          status="in_progress"
          blockedReason={null}
          initial="todo"
          onSaved={onSaved}
        />
      );
    case 'record-adr':
      return <RecordAdrEditor item={item} onSaved={onSaved} />;
    case 'reopen-phase':
      return (
        <StatusEditor
          item={item}
          onSaved={onSaved}
          path={`/api/projects/${code}/phases/${item.humanId}`}
          label="Phase status"
          initial="active"
          options={[
            { value: 'active', label: 'Active — reopened' },
            { value: 'planned', label: 'Planned' },
            { value: 'parked', label: 'Parked' },
          ]}
        />
      );
    case 'adr-status':
      return (
        <StatusEditor
          item={item}
          onSaved={onSaved}
          path={`/api/projects/${code}/adrs/${item.humanId}`}
          label="ADR status"
          initial="superseded"
          options={[
            { value: 'superseded', label: 'Superseded' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'proposed', label: 'Proposed' },
          ]}
        />
      );
    case 'open-screen':
      return (
        <p>
          The fix is a capture, taken on the screen&rsquo;s own page:{' '}
          <Link variant="inline" href={`/projects/${code}/screens/${item.humanId}`}>
            open {item.humanId}
          </Link>
          .
        </p>
      );
  }
}

/** Accept the drift, with a reason — recorded as a decision on the project. */
function AcceptDrift({ item, onSaved }: { item: DriftRow; onSaved: () => void }) {
  const [reason, setReason] = useState('');
  const { save, pending, alert } = useEditorSave();
  useEffect(() => {
    setReason('');
  }, [item.humanId, item.category]);
  // An acceptance is linked to a record by its ID; drift naming none has nothing to link to.
  const ready = reason.trim().length > 0 && item.humanId !== '';
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!ready || pending) return;
    save({
      subject: item.humanId,
      run: () =>
        api.post<Audited<DecisionRow>>(`/api/projects/${item.project.code}/decisions`, acceptanceBody(item, reason)),
      message: (result) => `Accepted drift on ${item.humanId} — recorded as ${result.humanId}`,
      refresh: onSaved,
      undone: `Undone — ${item.humanId} is drift again`,
    });
  };
  return (
    <form onSubmit={submit} className="fm-triage__editor" aria-label={`Accept the drift on ${item.humanId}`}>
      <Stack gap="12">
        {alert}
        <FormField
          label="Why this can stay as it is, for now"
          help="Required. Kept as a decision on the project, citing the record — the history and the decision register both show it."
        >
          <Textarea
            name="acceptReason"
            value={reason}
            maxLength={4000}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        </FormField>
        <div className="fm-triage__actions">
          <Button type="submit" disabled={!ready} loading={pending}>
            Accept drift
          </Button>
        </div>
      </Stack>
    </form>
  );
}

// ─── The tab ───────────────────────────────────────────────────────────────

export function DriftTab({
  search,
  handle,
  phrase,
}: {
  search: string;
  handle: AsyncHandle<DriftTriage>;
  phrase: string | null;
}) {
  const value = handle.state.status === 'ready' ? handle.state.value : { items: [], accepted: [] };
  const groups = CATEGORIES.map((c) => ({ ...c, rows: value.items.filter((i) => i.category === c.key) })).filter(
    (g) => g.rows.length > 0,
  );
  const ordered: DriftRow[] = [...groups.flatMap((g) => g.rows), ...value.accepted];
  const ids = ordered.map(driftKey);
  const selected = selectionOf(search);
  const shown = effectiveSelection(ids, selected);
  const picked = selected !== null && ids.includes(selected);
  const item = ordered.find((r) => driftKey(r) === shown) ?? null;
  const accepted = value.accepted.find((r) => driftKey(r) === shown) ?? null;
  useScrollToSelected(shown);

  useTriageKeys((key) => {
    if (key !== 'next' && key !== 'previous') return false;
    select(search, moveSelection(ids, shown, key === 'next' ? 1 : -1));
    return true;
  });

  if (handle.state.status === 'loading') return <Skeleton lines={8} />;
  if (handle.state.status === 'error') {
    return (
      <EmptyState kind="error" heading="Drift did not load">
        {handle.state.message}
      </EmptyState>
    );
  }
  if (ordered.length === 0) {
    return (
      <EmptyState kind="empty" heading={phrase === null ? 'Nothing has drifted' : `Nothing has drifted across ${phrase}`}>
        The plan and what is true agree, everywhere the engine can check.
      </EmptyState>
    );
  }

  const row = (r: DriftRow, dim: boolean): ReactNode => (
    <TriageRow
      key={driftKey(r)}
      id={driftKey(r)}
      selected={driftKey(r) === shown}
      dim={dim}
      onSelect={() => {
        select(search, driftKey(r));
      }}
      trailing={dim ? 'accepted' : <span className="fm-triage__action">{ACTION_LABEL[actionFor(r)]}</span>}
    >
      <span className="fm-triage__line">
        <code className="fm-triage__id">{r.humanId === '' ? '—' : r.humanId}</code>
        <span className="fm-triage__project">{r.project.code}</span>
      </span>
      <span className="fm-triage__text">{r.detail}</span>
      <span className="fm-triage__sub">{r.title}</span>
    </TriageRow>
  );

  const list = (
    <>
      <div className="fm-triage__list-head">
        <strong>{value.items.length} drifted</strong>
        {phrase === null ? '' : ` · ${phrase}`} · plan against what is true
        {value.accepted.length > 0 ? ` · ${String(value.accepted.length)} accepted` : ''}
      </div>
      {groups.map((g) => (
        <section key={g.key} aria-label={`${g.label}, ${String(g.rows.length)}`}>
          <h3 className="fm-triage__group">
            {g.label} · {g.rows.length}
          </h3>
          <ul className="fm-triage__rows">{g.rows.map((r) => row(r, false))}</ul>
        </section>
      ))}
      {value.accepted.length === 0 ? null : (
        <section aria-label={`Accepted, ${String(value.accepted.length)}`}>
          <h3 className="fm-triage__group">Accepted · {value.accepted.length}</h3>
          <ul className="fm-triage__rows">{value.accepted.map((r) => row(r, true))}</ul>
        </section>
      )}
    </>
  );

  const index = shown === null ? -1 : ids.indexOf(shown);
  const detail =
    item === null ? null : (
      <Stack gap="16" className="fm-triage__record" key={driftKey(item)}>
        <div className="fm-triage__meta">
          <Badge tone={accepted === null ? 'warning' : 'neutral'}>
            {accepted === null ? categoryLabel(item.category).toLowerCase() : 'accepted'}
          </Badge>
          <code>{item.humanId === '' ? '—' : item.humanId}</code>
          <span className="fm-muted">{item.project.name}</span>
          <span className="fm-muted fm-triage__position">
            {index + 1} of {ordered.length}
          </span>
        </div>
        <h2 className="fm-triage__title">{item.detail}</h2>
        <p className="fm-muted">{item.title}</p>
        {accepted !== null ? (
          <Card>
            <CardTitle>Accepted, by {accepted.decision.humanId}</CardTitle>
            <p>{accepted.decision.rationale ?? 'No reason recorded.'}</p>
            <p className="fm-muted">
              The drift engine still counts it: accepting it is a decision, not a fix. Undo the decision from its
              history to bring it back here.
            </p>
          </Card>
        ) : (
          <>
            <Card>
              <CardTitle>{ACTION_LABEL[actionFor(item)].replace('…', '')}</CardTitle>
              <ResolveEditor item={item} onSaved={handle.refresh} />
            </Card>
            <Card>
              <CardTitle>Or accept this drift</CardTitle>
              <AcceptDrift item={item} onSaved={handle.refresh} />
            </Card>
          </>
        )}
      </Stack>
    );

  return (
    <SplitView
      label="Drift"
      picked={picked}
      list={list}
      detail={detail}
      onBack={() => {
        select(search, null);
      }}
    />
  );
}
