import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  Cluster,
  EmptyState,
  FormField,
  Link,
  Modal,
  Page,
  PageHeader,
  Skeleton,
  Stack,
  TabPanel,
  Tabs,
  Textarea,
} from '@d3cloud/ui';
import { Markdown } from '../components/Markdown';
import { ApiError, foreman, type DiffResult, type DocumentSection } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { draftSize, useDraftGuard, useMutate } from '../lib/mutate';
import { OpenInConstellation } from '../components/OpenInConstellation';

/**
 * S-22 — the document editor.
 *
 * One section at a time, because that is what the API writes (FRM-REQ-063): saving a section cannot
 * lose an edit somebody made to a different section of the same document, and the screen is shaped
 * to make that obvious rather than to hide it.
 *
 * A save that has been overtaken shows the diff. It never silently overwrites — the version the
 * editor loaded travels with the write, and a 412 comes back with what it lost to.
 *
 * A save lands in place with an Undo toast (FRM-T-18.4) — the page re-reads without a skeleton,
 * so the version the next save sends is the one now stored. A draft is guarded: switching to
 * another section or closing the tab asks first; Cancel is the person saying discard.
 */

export function DocumentEditor({ code, id }: { code: string; id: string }) {
  const { state, refresh } = useAsync(() => foreman.document(code, id), [code, id]);
  const [editing, setEditing] = useState<string | null>(null);
  // What the open section editor would lose, so leaving it for another can ask first.
  const [unsaved, setUnsaved] = useState(0);
  const editingHeading =
    state.status === 'ready' ? state.value.body.sections.find((s) => s.key === editing)?.heading : undefined;
  const allowLeave = useDraftGuard(editing === null ? 0 : unsaved, editingHeading);

  if (state.status === 'loading') {
    return (
      <Page>
        <Skeleton lines={12} />
      </Page>
    );
  }

  if (state.status === 'error') {
    return (
      <Page>
        <EmptyState
          kind={state.notFound ? 'no-results' : 'error'}
          heading={state.notFound ? 'No such document' : 'That document did not load'}
        >
          {state.notFound ? 'It may have been deleted.' : state.message}
        </EmptyState>
      </Page>
    );
  }

  const { body: document, etag } = state.value;

  return (
    <Page>
      <PageHeader
        title={document.title}
        description={document.kind.replace(/_/g, ' ')}
        back={<Link href={`/projects/${code}/documents`}>Documents</Link>}
        actions={
          <>
            <OpenInConstellation path={`document/${code}/${document.kind}`} />
            <RevisionHistory code={code} id={id} />
          </>
        }
      />

      {document.sections.length === 0 ? (
        <EmptyState kind="empty" heading="This document has no sections">
          A document with no sections has nothing addressable in it.
        </EmptyState>
      ) : (
        document.sections.map((section) => (
          <Card key={section.key}>
            <CardTitle>{section.heading}</CardTitle>
            <Stack gap="12">
              <div className="fm-muted">
                {/* The address, shown: it is what an MCP read uses, and what a citation points at. */}
                <code>
                  foreman://{code}/{document.kind.replace(/_/g, '-')}#{section.key}
                </code>
              </div>

              {editing === section.key ? (
                <SectionEditor
                  code={code}
                  documentId={id}
                  etag={etag}
                  section={section}
                  onDone={() => {
                    setEditing(null);
                    setUnsaved(0);
                    refresh();
                  }}
                  onUndone={refresh}
                  onCancel={() => {
                    setEditing(null);
                    setUnsaved(0);
                  }}
                  onDraft={setUnsaved}
                />
              ) : (
                <>
                  {section.bodyMd.trim() === '' ? (
                    // An unwritten section is labelled and editable, not hidden (S-22).
                    <Alert tone="warning" title="pending">
                      Nothing is written here yet.
                    </Alert>
                  ) : (
                    <Markdown>{section.bodyMd}</Markdown>
                  )}
                  <div>
                    <Button
                      onClick={() => {
                        if (editing !== null && !allowLeave()) return;
                        setUnsaved(0);
                        setEditing(section.key);
                      }}
                      aria-label={`Edit ${section.heading}`}
                    >
                      Edit
                    </Button>
                  </div>
                </>
              )}
            </Stack>
          </Card>
        ))
      )}
    </Page>
  );
}

/** The textarea, its live preview, and the conflict the save may come back with. */
function SectionEditor({
  code,
  documentId,
  etag,
  section,
  onDone,
  onUndone,
  onCancel,
  onDraft,
}: {
  code: string;
  documentId: string;
  etag: string | null;
  section: DocumentSection;
  onDone: () => void;
  /** After the save's Undo: re-read in place. */
  onUndone: () => void;
  onCancel: () => void;
  /** How many characters would be lost if the editor closed now. */
  onDraft: (characters: number) => void;
}) {
  const [body, setBody] = useState(section.bodyMd);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<DocumentSection[] | null>(null);
  const { mutate, pending: busy } = useMutate();

  const unsaved = draftSize({ body: section.bodyMd, note: '' }, { body, note });
  useEffect(() => {
    onDraft(unsaved);
  }, [unsaved, onDraft]);

  const save = () => {
    setError(null);
    setConflict(null);

    void mutate({
      subject: `“${section.heading}”`,
      run: () =>
        foreman.saveSection(
          code,
          documentId,
          section.key,
          { bodyMd: body, ...(note.trim() === '' ? {} : { note: note.trim() }) },
          etag,
        ),
      message: () => `Saved “${section.heading}”`,
      undone: `Undone — “${section.heading}” is as it was`,
      onUndone,
      failure: 'inline',
    }).then((outcome) => {
      if (outcome.ok) {
        onDone();
        return;
      }
      const caught = outcome.error;
      if (caught instanceof ApiError && caught.status === 412) {
        // Never a silent overwrite: the body of the 412 carries the current document, so the
        // editor can show what it lost to without a second request.
        const current = (caught.body as { current?: { sections?: DocumentSection[] } } | undefined)
          ?.current;
        setConflict(current?.sections ?? []);
        return;
      }
      setError(outcome.message);
    });
  };

  const theirs = conflict?.find((s) => s.key === section.key);

  return (
    <Stack gap="12">
      {error === null ? null : (
        <Alert tone="danger" title="That did not save">
          {error}
        </Alert>
      )}

      {theirs === undefined ? null : (
        <Alert tone="warning" title="Somebody else changed this section">
          <Stack gap="8">
            <span>
              Your text is still in the box. Theirs is below — copy across what you want and save
              again.
            </span>
            <pre className="fm-diff">{theirs.bodyMd}</pre>
          </Stack>
        </Alert>
      )}

      <Tabs
        defaultValue="write"
        aria-label={`Editing ${section.heading}`}
        items={[
          { value: 'write', label: 'Write' },
          { value: 'preview', label: 'Preview' },
        ]}
      >
        <TabPanel value="write">
          <FormField label={`${section.heading} — markdown`}>
            <Textarea
              value={body}
              rows={16}
              onChange={(event) => { setBody(event.currentTarget.value); }}
            />
          </FormField>
        </TabPanel>
        <TabPanel value="preview">
          {/* The same renderer the read view uses, so the preview is not a second opinion. */}
          <Markdown>{body}</Markdown>
        </TabPanel>
      </Tabs>

      <FormField label="What changed, and why" help="Recorded on the revision. The diff shows what; only this can say why.">
        <Textarea value={note} rows={2} onChange={(event) => { setNote(event.currentTarget.value); }} />
      </FormField>

      <Cluster gap="8">
        <Button variant="primary" onClick={save} loading={busy}>
          Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </Cluster>
    </Stack>
  );
}

/** Every revision, and the diff between any two of them (FRM-REQ-064, FRM-REQ-065). */
function RevisionHistory({ code, id }: { code: string; id: string }) {
  const [open, setOpen] = useState(false);
  const revisions = useAsync(
    () => (open ? foreman.revisions(code, id) : Promise.resolve({ items: [], nextCursor: null, total: 0 })),
    [code, id, open],
  );
  const [pair, setPair] = useState<{ from: number; to: number } | null>(null);
  const diff = useAsync(
    () => (pair === null ? Promise.resolve(null) : foreman.diff(code, id, pair.from, pair.to)),
    [code, id, pair?.from, pair?.to],
  );

  return (
    <>
      <Button onClick={() => { setOpen(true); }}>History</Button>
      <Modal open={open} onOpenChange={setOpen} title="Revisions" size="lg">
        {revisions.state.status !== 'ready' ? (
          <Skeleton lines={6} />
        ) : revisions.state.value.items.length === 0 ? (
          <EmptyState kind="empty" size="inline" heading="No revisions" />
        ) : (
          <Stack gap="12">
            {/* The diff first: after pressing Compare, the answer should not be below a list of
                seventeen revisions where it has to be scrolled to. */}
            {diff.state.status === 'ready' && diff.state.value !== null ? (
              <Diff result={diff.state.value} />
            ) : null}

            <Stack gap="8" as="ul">
              {revisions.state.value.items.map((revision, index, all) => {
                const previous = all[index + 1];
                return (
                  <li key={revision.revisionNo}>
                    <strong>#{revision.revisionNo}</strong> — {revision.actor}{' '}
                    <span className="fm-muted">
                      {new Date(revision.createdAt).toLocaleString()}
                    </span>
                    {revision.note === null ? null : <div>{revision.note}</div>}
                    {previous === undefined ? null : (
                      <Button
                        size="sm"
                        onClick={() => {
                          setPair({ from: previous.revisionNo, to: revision.revisionNo });
                        }}
                        aria-label={`Compare revision ${String(previous.revisionNo)} with ${String(revision.revisionNo)}`}
                      >
                        Compare with #{previous.revisionNo}
                      </Button>
                    )}
                  </li>
                );
              })}
            </Stack>
          </Stack>
        )}
      </Modal>
    </>
  );
}

function Diff({ result }: { result: DiffResult }) {
  const changed = result.sections.filter((s) => s.status !== 'unchanged');

  return (
    <Card>
      <CardTitle>
        #{result.from} → #{result.to}
      </CardTitle>
      {changed.length === 0 ? (
        <EmptyState kind="empty" size="inline" heading="Nothing changed between these" />
      ) : (
        <Stack gap="12">
          {changed.map((section) => (
            <div key={section.key}>
              <strong>{section.heading}</strong>{' '}
              <Badge tone={section.status === 'removed' ? 'danger' : 'attention'}>
                {section.status}
              </Badge>
              <pre className="fm-diff">
                {section.lines.map((line, index) => (
                  <span
                    key={`${String(index)}:${line.text}`}
                    className={
                      line.kind === 'added'
                        ? 'fm-diff__added'
                        : line.kind === 'removed'
                          ? 'fm-diff__removed'
                          : undefined
                    }
                  >
                    {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '} {line.text}
                    {'\n'}
                  </span>
                ))}
              </pre>
            </div>
          ))}
        </Stack>
      )}
    </Card>
  );
}
