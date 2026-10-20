import { useState, type SyntheticEvent } from 'react';
import {
  Alert,
  Button,
  FormActions,
  FormField,
  Input,
  Modal,
  Select,
  Stack,
  Textarea,
} from '@d3cloud/ui';
import { api, ApiError } from '../lib/api';
import { listJoin } from '../lib/groups';
import { draftSize, useDraftGuard, useMutate } from '../lib/mutate';

/**
 * Editing, from the console (T-2.10, FRM-REQ-031 … FRM-REQ-048).
 *
 * **Every control carries an accessible name.** `FormField` supplies one through context, so the
 * control needs no `id` and cannot drift from its label; anything outside a `FormField` — the
 * status select in a table cell — passes `aria-label` explicitly.
 *
 * What a form *omits* is as deliberate as what it offers. A project's code and a phase's number are
 * not fields here, because both are embedded in a human ID and a human ID is immutable: renumbering
 * would leave every citation pointing at something else (ADR-008).
 *
 * **A save lands in place, with Undo** (FRM-T-18.4): `useMutate` waits for the server, the screen
 * re-reads without a skeleton, and a toast names what changed and anything that rolled up. **A
 * draft is guarded**: closing by Escape, the scrim or the close control asks before throwing typed
 * changes away. Cancel is the person saying discard, so it does not ask again.
 */

interface Field {
  readonly name: string;
  readonly label: string;
  readonly kind: 'text' | 'textarea' | 'select';
  readonly options?: { value: string; label: string }[];
  readonly help?: string;
  readonly optional?: boolean;
}

/** One reason the exit gate refused a phase, as the 409 names it (FRM-REQ-056). */
interface GateFailure {
  readonly kind: string;
  readonly humanId: string;
  readonly detail: string;
}

export interface EditFormProps {
  /** Names the action: "Edit BND-T-0.3", never "Edit". */
  title: string;
  description?: string;
  path: string;
  fields: readonly Field[];
  initial: Record<string, string>;
  trigger: React.ReactNode;
  /** After a save lands, and after it is undone: re-read in place. */
  onSaved: () => void;
  /** What the record is called in the toast. Defaults to the title without its "Edit ". */
  subject?: string;
}

/** "Saved BND-T-9.4 — title and size": the toast's line for a form save. */
export function savedMessage(subject: string, labels: readonly string[]): string {
  if (labels.length === 0) return `Saved ${subject}`;
  return `Saved ${subject} — ${listJoin(labels.map((label) => label.toLowerCase()))}`;
}

export function EditForm({
  title,
  description,
  path,
  fields,
  initial,
  trigger,
  onSaved,
  subject = title.replace(/^Edit /, ''),
}: EditFormProps) {
  const [open, setOpen] = useState(false);
  const { mutate } = useMutate();
  const [values, setValues] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // A refused phase completion carries every reason (FRM-REQ-056). The headline alone says how
  // many things are in the way; these say which, so the person knows what to go and fix.
  const [blockers, setBlockers] = useState<GateFailure[]>([]);
  const [busy, setBusy] = useState(false);
  const allowClose = useDraftGuard(open ? draftSize(initial, values) : 0, subject);

  const set = (name: string, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    setBlockers([]);

    // Only what changed. Sending the whole form would overwrite a field somebody else edited
    // between this screen loading and this button being pressed.
    const changed: Record<string, string> = {};
    for (const field of fields) {
      const next = values[field.name] ?? '';
      if (next !== (initial[field.name] ?? '')) changed[field.name] = next;
    }

    if (Object.keys(changed).length === 0) {
      setBusy(false);
      setOpen(false);
      return;
    }

    const labels = fields.filter((field) => field.name in changed).map((field) => field.label);
    void mutate({
      subject,
      run: () => api.patch<unknown>(path, changed),
      message: () => savedMessage(subject, labels),
      failure: 'inline',
      undone: `Undone — ${subject} is as it was`,
      onUndone: onSaved,
    })
      .then((outcome) => {
        if (outcome.ok) {
          setOpen(false);
          onSaved();
          return;
        }
        const caught = outcome.error;
        if (caught instanceof ApiError) {
          const body = caught.body as
            | { fields?: { path: string; message: string }[]; gate?: { failures?: GateFailure[] } }
            | undefined;
          if (body?.fields !== undefined) {
            // Per-field, where the person can act on it, rather than one message at the top.
            setFieldErrors(
              Object.fromEntries(body.fields.map((f) => [f.path, f.message])),
            );
          }
          setBlockers(body?.gate?.failures ?? []);
          setError(caught.message);
        } else {
          setError('That did not save.');
        }
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        // Escape, the scrim, the close control: ask before a draft is lost.
        if (!next && !allowClose()) return;
        setOpen(next);
        if (next) {
          // Reopened after a failure, it starts from what is stored rather than from the attempt.
          setValues(initial);
          setError(null);
          setFieldErrors({});
          setBlockers([]);
        }
      }}
      trigger={trigger}
      title={title}
      {...(description === undefined ? {} : { description })}
    >
      <form onSubmit={submit}>
        <Stack gap="16">
          {error === null ? null : (
            <Alert tone="danger" title="That did not save" dynamic>
              {error}
              {blockers.length === 0 ? null : (
                <ul aria-label="What is in the way">
                  {blockers.map((b) => (
                    <li key={`${b.kind}:${b.humanId}`}>
                      <code>{b.humanId}</code> {b.detail}
                    </li>
                  ))}
                </ul>
              )}
            </Alert>
          )}

          {fields.map((field) => (
            <FormField
              key={field.name}
              label={field.label}
              {...(field.help === undefined ? {} : { help: field.help })}
              {...(field.optional === true ? { optional: true } : {})}
              {...(fieldErrors[field.name] === undefined
                ? {}
                : { error: fieldErrors[field.name] })}
            >
              {field.kind === 'select' ? (
                <Select
                  options={field.options ?? []}
                  value={values[field.name] ?? ''}
                  onValueChange={(next) => { set(field.name, next); }}
                />
              ) : field.kind === 'textarea' ? (
                <Textarea
                  name={field.name}
                  value={values[field.name] ?? ''}
                  rows={3}
                  onChange={(e) => { set(field.name, e.target.value); }}
                />
              ) : (
                <Input
                  name={field.name}
                  value={values[field.name] ?? ''}
                  onChange={(e) => { set(field.name, e.target.value); }}
                />
              )}
            </FormField>
          ))}

          <FormActions>
            <Button type="button" onClick={() => { setOpen(false); }}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Modal>
  );
}

export const LIFECYCLES = [
  { value: 'planned', label: 'Planned' },
  { value: 'scaffolded', label: 'Scaffolded' },
  { value: 'building', label: 'Building' },
  { value: 'deployed', label: 'Deployed' },
  { value: 'parked', label: 'Parked' },
  { value: 'scrapped', label: 'Scrapped' },
];

export const PHASE_STATUSES = [
  { value: 'planned', label: 'Planned' },
  { value: 'active', label: 'Active' },
  { value: 'complete', label: 'Complete' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'parked', label: 'Parked' },
];

export const SIZES = [
  { value: 'XS', label: 'XS' },
  { value: 'S', label: 'S' },
  { value: 'M', label: 'M' },
  { value: 'L', label: 'L' },
  { value: 'XL', label: 'XL' },
];

/** MoSCoW. `W` is gated on the way in, because it leaves every coverage count. */
export const PRIORITIES = [
  { value: 'M', label: 'Must' },
  { value: 'S', label: 'Should' },
  { value: 'C', label: 'Could' },
  { value: 'W', label: "Won't" },
];
