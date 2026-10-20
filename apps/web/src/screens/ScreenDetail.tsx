import { useCallback, useId, useRef, useState, type DragEvent, type SyntheticEvent } from 'react';
import {
  Alert,
  Button,
  Cluster,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  FilterBar,
  FormActions,
  FormField,
  Link,
  Page,
  PageHeader,
  Section,
  SegmentedControl,
  Skeleton,
  Stack,
  Textarea,
} from '@d3cloud/ui';
import type {
  ScreenDetail as ScreenRecord,
  ScreenTheme,
  ScreenVerdictKind,
  ScreenVersion,
  ScreenViewport,
} from '@foreman/shared';
import { Upload } from 'lucide-react';
import { ApiError, foreman } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { Pill } from '../ui/viz';
import { VERDICT_LABEL, VerdictPill, variantLabel, versionFor } from './Screens';

/**
 * One screen: the design beside what was built, a variant at a time (FRM-REQ-196), a PNG dropped
 * onto the design side to replace it (FRM-REQ-197), and a verdict on the build (FRM-REQ-195).
 */

/** What a proposal records as its source when it came from a drop rather than a Figma export. */
export const MANUAL_SOURCE = 'manual';

/**
 * The Figma link for a frame, or null when there is no file to link to. A URL spells a node ID
 * with a hyphen where the API uses a colon.
 */
export function figmaUrl(fileKey: string | null, nodeId: string | null): string | null {
  if (fileKey === null || fileKey === MANUAL_SOURCE) return null;
  const base = `https://www.figma.com/design/${fileKey}`;
  if (nodeId === null || nodeId === MANUAL_SOURCE) return base;
  return `${base}?node-id=${encodeURIComponent(nodeId.replace(/:/g, '-'))}`;
}

/**
 * The provenance a dropped PNG is filed under (FRM-REQ-197). The API requires a source on every
 * proposal (FRM-REQ-192), and a drop has no export behind it: the screen's own frame when it has
 * one, `manual` when it does not, and the moment of the drop standing in for the file version —
 * which also keeps a re-drop of the same image a new version rather than a duplicate.
 */
export function manualProvenance(
  screen: { figmaFileKey: string | null; figmaNodeId: string | null },
  now: Date,
): { figmaFileKey: string; figmaNodeId: string; figmaFileVersion: string } {
  return {
    figmaFileKey: screen.figmaFileKey ?? MANUAL_SOURCE,
    figmaNodeId: screen.figmaNodeId ?? MANUAL_SOURCE,
    figmaFileVersion: now.toISOString(),
  };
}

/** A PNG by its type, or by its name when the platform gave no type at all. */
export function isPng(file: { type: string; name: string }): boolean {
  return file.type === 'image/png' || (file.type === '' && /\.png$/i.test(file.name));
}

const VERDICTS: readonly ScreenVerdictKind[] = ['matches', 'drifted_accepted', 'drifted_fix'];

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function ScreenDetail({ code, humanId }: { code: string; humanId: string }) {
  const { state } = useAsync(() => foreman.screen(code, humanId), [code, humanId]);
  // A write refreshes in place rather than through `reload`, which would drop the page back to a
  // skeleton and take focus and the chosen variant with it.
  const [fresh, setFresh] = useState<ScreenRecord | null>(null);
  const [viewport, setViewport] = useState<ScreenViewport>('desktop');
  const [theme, setTheme] = useState<ScreenTheme>('dark');

  const refresh = useCallback(async () => {
    setFresh(await foreman.screen(code, humanId));
  }, [code, humanId]);

  if (state.status === 'loading') {
    return (
      <Page>
        <Skeleton lines={8} />
      </Page>
    );
  }

  if (state.status === 'error') {
    return (
      <Page>
        {state.notFound ? (
          <EmptyState kind="no-results" heading={`${code} has no screen ${humanId}`}>
            Pick one from the <a href={`/projects/${code}/screens`}>screens list</a>.
          </EmptyState>
        ) : (
          <EmptyState kind="error" heading="The screen did not load">
            {state.message}
          </EmptyState>
        )}
      </Page>
    );
  }

  const screen = fresh ?? state.value;
  const proposal = versionFor(screen.current.proposals, viewport, theme);
  const capture = versionFor(screen.current.captures, viewport, theme);
  const variant = variantLabel(viewport, theme);

  return (
    <Page>
      <PageHeader
        title={screen.name}
        description={
          <Cluster gap="8" align="center">
            <code>{screen.humanId}</code>
            {screen.route !== null && <code>{screen.route}</code>}
          </Cluster>
        }
        back={<a href={`/projects/${code}/screens`}>Screens</a>}
      />

      <FilterBar aria-label="Which variant to compare">
        <SegmentedControl
          aria-label="Viewport"
          items={[
            { value: 'desktop', label: 'Desktop' },
            { value: 'mobile', label: 'Mobile' },
          ]}
          value={viewport}
          onValueChange={(next) => { setViewport(next === 'mobile' ? 'mobile' : 'desktop'); }}
        />
        <SegmentedControl
          aria-label="Theme"
          items={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          value={theme}
          onValueChange={(next) => { setTheme(next === 'light' ? 'light' : 'dark'); }}
        />
      </FilterBar>

      <div className="fm-compare">
        <Section title="Proposed" description={`The current ${variant} design.`}>
          <Stack gap="16">
            {proposal === null ? (
              <EmptyState kind="empty" size="inline" heading={`No ${variant} proposal yet`}>
                Drop a PNG below, or export the frame from Figma.
              </EmptyState>
            ) : (
              <>
                <img
                  className="fm-shot"
                  src={proposal.url}
                  alt={`Proposed design for ${screen.name}, ${variant}`}
                />
                <ProposalFacts proposal={proposal} />
              </>
            )}
            <DropZone
              code={code}
              screen={screen}
              viewport={viewport}
              theme={theme}
              onAdded={refresh}
            />
          </Stack>
        </Section>

        <Section title="Built" description={`The latest ${variant} capture.`}>
          {capture === null ? (
            <EmptyState kind="empty" size="inline" heading={`Nothing captured at ${variant} yet`}>
              A capture arrives from CI, taken at a commit.
            </EmptyState>
          ) : (
            <Stack gap="16">
              <img
                className="fm-shot"
                src={capture.url}
                alt={`Built screen for ${screen.name}, ${variant}`}
              />
              <CaptureFacts capture={capture} />
              <VerdictForm
                key={capture.id}
                code={code}
                humanId={screen.humanId}
                capture={capture}
                onRecorded={refresh}
              />
            </Stack>
          )}
        </Section>
      </div>

      <Components screen={screen} />
      <Links screen={screen} />
      <History screen={screen} />
    </Page>
  );
}

function ProposalFacts({ proposal }: { proposal: ScreenVersion }) {
  const link = figmaUrl(proposal.figmaFileKey, proposal.figmaNodeId);
  return (
    <DescriptionList>
      <DescriptionItem term="Source">
        {link === null ? (
          'Dropped in the console'
        ) : (
          <Link href={link} external>
            Figma frame {proposal.figmaNodeId ?? ''}
          </Link>
        )}
      </DescriptionItem>
      <DescriptionItem term="File version">{proposal.figmaFileVersion ?? '—'}</DescriptionItem>
      <DescriptionItem term="Added">
        {when(proposal.createdAt)} by {proposal.createdBy}
      </DescriptionItem>
    </DescriptionList>
  );
}

function CaptureFacts({ capture }: { capture: ScreenVersion }) {
  const latest = capture.verdicts[0] ?? null;
  return (
    <DescriptionList>
      <DescriptionItem term="Commit">
        {/* No commit page in the console to link to; the full SHA is a hover away. */}
        {capture.commitSha === null ? '—' : <code title={capture.commitSha}>{capture.commitSha.slice(0, 7)}</code>}
      </DescriptionItem>
      <DescriptionItem term="Captured">
        {when(capture.createdAt)} by {capture.createdBy}
      </DescriptionItem>
      <DescriptionItem term="Verdict">
        <Stack gap="4">
          <span>
            <VerdictPill verdict={latest?.verdict ?? null} />
          </span>
          {latest !== null && (
            <span className="fm-muted">
              {latest.reviewer}, {when(latest.createdAt)}
              {latest.note === null ? '' : ` — ${latest.note}`}
            </span>
          )}
        </Stack>
      </DescriptionItem>
    </DescriptionList>
  );
}

/**
 * A drop target that is also a button (FRM-REQ-197): dragging is the quick way and the button is
 * the way that works from a keyboard. Either ends in the same upload, so neither is second-class.
 */
function DropZone({
  code,
  screen,
  viewport,
  theme,
  onAdded,
}: {
  code: string;
  screen: ScreenRecord;
  viewport: ScreenViewport;
  theme: ScreenTheme;
  onAdded: () => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const errorId = useId();
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState('');
  const variant = variantLabel(viewport, theme);

  const add = (file: File | undefined) => {
    if (file === undefined || busy) return;
    if (!isPng(file)) {
      setDone('');
      setError(`${file.name} is not a PNG. Export the frame as PNG and drop that.`);
      return;
    }
    setBusy(true);
    setError(null);
    setDone('');
    void (async () => {
      try {
        const blob = await foreman.uploadBlob(file);
        await foreman.addProposal(code, screen.humanId, {
          blobSha256: blob.sha256,
          viewport,
          theme,
          ...manualProvenance(screen, new Date()),
        });
        await onAdded();
        setDone(`${file.name} is now the current ${variant} proposal.`);
      } catch (caught: unknown) {
        setError(caught instanceof ApiError ? caught.message : 'The upload did not go through.');
      } finally {
        setBusy(false);
        // Cleared so choosing the same file again is still a change the input reports.
        if (input.current !== null) input.current.value = '';
      }
    })();
  };

  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setOver(false);
    add(event.dataTransfer.files[0]);
  };

  return (
    <Stack gap="8">
      <button
        type="button"
        className={`fm-dropzone${over ? ' fm-dropzone--over' : ''}`}
        aria-describedby={error === null ? hintId : `${hintId} ${errorId}`}
        disabled={busy}
        onClick={() => input.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => { setOver(false); }}
        onDrop={onDrop}
      >
        <Upload aria-hidden="true" />
        <span>{busy ? 'Uploading…' : 'Drop a PNG here, or choose a file'}</span>
      </button>
      <span id={hintId} className="fm-muted">
        It becomes the current {variant} proposal; the one it replaces stays in the history.
      </span>
      <input
        ref={input}
        type="file"
        accept="image/png"
        hidden
        aria-label={`Choose a PNG for the ${variant} proposal`}
        onChange={(event) => { add(event.target.files?.[0]); }}
      />
      {error !== null && (
        <p id={errorId} className="fm-error" role="alert">
          {error}
        </p>
      )}
      {/* Present before it has anything to say, or the first message is never announced. */}
      <p className="fm-muted" role="status">
        {done}
      </p>
    </Stack>
  );
}

/**
 * A verdict on the capture (FRM-REQ-195). Nothing is pre-selected: a default would let "matches"
 * be recorded by somebody who only meant to write a note.
 */
function VerdictForm({
  code,
  humanId,
  capture,
  onRecorded,
}: {
  code: string;
  humanId: string;
  capture: ScreenVersion;
  onRecorded: () => Promise<void>;
}) {
  const legendId = useId();
  const verdictErrorId = useId();
  const [verdict, setVerdict] = useState<ScreenVerdictKind | null>(null);
  const [note, setNote] = useState('');
  const [verdictError, setVerdictError] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setDone('');
    setFormError(null);
    const missingVerdict = verdict === null ? 'Choose a verdict.' : null;
    // The same rule the API holds, said here first so it is tied to the field it is about.
    const missingNote =
      verdict !== null && verdict !== 'matches' && note.trim() === ''
        ? 'Say what drifted — a drifted verdict needs a note.'
        : null;
    setVerdictError(missingVerdict);
    setNoteError(missingNote);
    if (verdict === null || missingNote !== null) return;

    setBusy(true);
    const trimmed = note.trim();
    void (async () => {
      try {
        await foreman.recordVerdict(code, humanId, capture.id, {
          verdict,
          ...(trimmed === '' ? {} : { note: trimmed }),
        });
        await onRecorded();
        setDone(`Recorded: ${VERDICT_LABEL[verdict]}.`);
        setVerdict(null);
        setNote('');
      } catch (caught: unknown) {
        const fields = caught instanceof ApiError ? fieldErrors(caught.body) : {};
        if (fields['note'] !== undefined) setNoteError(fields['note']);
        else setFormError(caught instanceof Error ? caught.message : 'That did not go through.');
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <form onSubmit={submit} noValidate aria-labelledby={legendId}>
      <Stack gap="16">
        <h3 id={legendId} className="fm-subheading">
          Record a verdict
        </h3>
        {formError !== null && (
          <Alert tone="danger" title="The verdict was not recorded" dynamic>
            {formError}
          </Alert>
        )}
        <fieldset
          className="fm-radios"
          {...(verdictError === null ? {} : { 'aria-describedby': verdictErrorId })}
        >
          <legend className="fm-radios__legend">Verdict</legend>
          {VERDICTS.map((kind) => (
            <label key={kind} className="fm-radio">
              <input
                type="radio"
                name={`verdict-${capture.id}`}
                value={kind}
                checked={verdict === kind}
                onChange={() => {
                  setVerdict(kind);
                  setVerdictError(null);
                }}
              />
              <span>{VERDICT_LABEL[kind]}</span>
            </label>
          ))}
          {verdictError !== null && (
            <p id={verdictErrorId} className="fm-error" role="alert">
              {verdictError}
            </p>
          )}
        </fieldset>
        <FormField
          label="Note"
          optional={verdict === 'matches'}
          help="What differs, and why it is fine or what to fix."
          {...(noteError === null ? {} : { error: noteError })}
        >
          <Textarea
            name="note"
            rows={3}
            maxLength={2000}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
              if (noteError !== null) setNoteError(null);
            }}
          />
        </FormField>
        <FormActions align="start">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Recording…' : 'Record verdict'}
          </Button>
        </FormActions>
        <p className="fm-muted" role="status">
          {done}
        </p>
      </Stack>
    </form>
  );
}

/** `{ fields: [{ path, message }] }`, the shape `parseBody` refuses with, keyed by path. */
function fieldErrors(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof body !== 'object' || body === null || !('fields' in body)) return out;
  const fields: unknown = body.fields;
  if (!Array.isArray(fields)) return out;
  for (const field of fields as unknown[]) {
    if (typeof field !== 'object' || field === null) continue;
    const { path, message } = field as { path?: unknown; message?: unknown };
    if (typeof path === 'string' && typeof message === 'string') out[path] = message;
  }
  return out;
}

function Components({ screen }: { screen: ScreenRecord }) {
  const uses = screen.components.filter((c) => c.kind === 'uses');
  const gaps = screen.components.filter((c) => c.kind === 'gap');
  return (
    <Section title="Components" description="What it is built from, and what @d3cloud/ui does not have yet.">
      <Stack gap="12">
        <h3 className="fm-subheading">Uses</h3>
        {uses.length === 0 ? (
          <span className="fm-muted">None recorded.</span>
        ) : (
          <ul className="fm-plain-list fm-plain-list--row">
            {uses.map((c) => (
              <li key={c.id}>
                <code>{c.name}</code>
              </li>
            ))}
          </ul>
        )}
        <h3 className="fm-subheading">Gaps</h3>
        {gaps.length === 0 ? (
          <span className="fm-muted">None recorded.</span>
        ) : (
          <ul className="fm-plain-list">
            {gaps.map((c) => (
              <li key={c.id}>
                <code>{c.name}</code>
                {c.requirement !== null && (
                  <>
                    {' — '}
                    <Link href={`/requirements/${c.requirement.humanId}`}>
                      {c.requirement.humanId}
                    </Link>{' '}
                    <span className="fm-muted">{c.requirement.statement}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Stack>
    </Section>
  );
}

function Links({ screen }: { screen: ScreenRecord }) {
  return (
    <Section title="Links" description="The requirements and tasks this screen serves.">
      {screen.links.length === 0 ? (
        <span className="fm-muted">Nothing is linked yet.</span>
      ) : (
        <ul className="fm-plain-list">
          {screen.links.map((link) => (
            <li key={`${link.type}:${link.humanId}`}>
              <Link href={link.type === 'task' ? `/tasks/${link.humanId}` : `/requirements/${link.humanId}`}>
                {link.humanId}
              </Link>{' '}
              {link.title} <span className="fm-muted">{link.kind}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Every version, superseded proposals included, so a replaced design is still there to compare. */
function History({ screen }: { screen: ScreenRecord }) {
  const total = screen.proposals.length + screen.captures.length;
  return (
    <Section title="Version history">
      {total === 0 ? (
        <span className="fm-muted">No versions yet.</span>
      ) : (
        <details className="fm-history">
          <summary>
            {screen.proposals.length} proposal{screen.proposals.length === 1 ? '' : 's'} and{' '}
            {screen.captures.length} capture{screen.captures.length === 1 ? '' : 's'}
          </summary>
          <h3 className="fm-subheading">Proposals</h3>
          <ul className="fm-plain-list fm-history__list">
            {screen.proposals.map((p) => (
              <li key={p.id} className="fm-history__item">
                <a href={p.url}>
                  <img
                    className="fm-screen-thumb"
                    src={p.url}
                    alt={`Proposal, ${variantLabel(p.viewport, p.theme)}, ${when(p.createdAt)}`}
                    loading="lazy"
                  />
                </a>
                <Stack gap="4">
                  <Cluster gap="8" align="center">
                    <Pill tone={p.status === 'current' ? 'accent' : 'neutral'}>{p.status ?? 'proposal'}</Pill>
                    <span>{variantLabel(p.viewport, p.theme)}</span>
                  </Cluster>
                  <span className="fm-muted">
                    {when(p.createdAt)} by {p.createdBy} · version {p.figmaFileVersion ?? '—'}
                  </span>
                </Stack>
              </li>
            ))}
          </ul>
          <h3 className="fm-subheading">Captures</h3>
          {screen.captures.length === 0 ? (
            <span className="fm-muted">None yet.</span>
          ) : (
            <ul className="fm-plain-list fm-history__list">
              {screen.captures.map((c) => (
                <li key={c.id} className="fm-history__item">
                  <a href={c.url}>
                    <img
                      className="fm-screen-thumb"
                      src={c.url}
                      alt={`Capture, ${variantLabel(c.viewport, c.theme)}, ${when(c.createdAt)}`}
                      loading="lazy"
                    />
                  </a>
                  <Stack gap="4">
                    <Cluster gap="8" align="center">
                      <span>{variantLabel(c.viewport, c.theme)}</span>
                      {c.commitSha !== null && <code title={c.commitSha}>{c.commitSha.slice(0, 7)}</code>}
                    </Cluster>
                    <span className="fm-muted">
                      {when(c.createdAt)} by {c.createdBy}
                    </span>
                    {c.verdicts.length === 0 ? (
                      <span className="fm-muted">No verdict.</span>
                    ) : (
                      <ul className="fm-plain-list">
                        {c.verdicts.map((v) => (
                          <li key={v.id}>
                            <VerdictPill verdict={v.verdict} />{' '}
                            <span className="fm-muted">
                              {v.reviewer}, {when(v.createdAt)}
                              {v.note === null ? '' : ` — ${v.note}`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Stack>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </Section>
  );
}
