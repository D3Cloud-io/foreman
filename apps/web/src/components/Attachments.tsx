import { useId, useRef, useState, type DragEvent } from 'react';
import { Alert, Button, Cluster, Section, Skeleton, Stack } from '@d3cloud/ui';
import { ATTACHMENT_TYPES_SENTENCE, type Attachment } from '@foreman/shared';
import { Upload } from 'lucide-react';
import { ApiError, foreman } from '../lib/api';
import { useMutate } from '../lib/mutate';
import { useAsync } from '../lib/useAsync';
import { relativeDay } from '../ui/tone';
import { Markdown } from './Markdown';
import './Attachments.css';

/**
 * What is filed on an entity (FRM-ADR-026): upload, list, preview, download, delete and restore.
 *
 * Written for any entity that takes attachments — the project-idea page is the first to show it.
 * A file here is a **source** for the record above it: the design PDF, the photo of the
 * whiteboard. It is never edited here, its text is never searched, and nothing on the page counts
 * it — the canvas is still the thing that is read (FRM-REQ-257).
 *
 * Every write goes through `useMutate`, so an upload's toast offers Undo (a soft delete) and a
 * delete's brings it back; the Deleted list is where Restore lives once the toast has gone.
 */

/** The `accept` hint for the file picker. A hint only: the server decides from the bytes. */
const ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.webp,.gif,.md,.markdown,.txt,application/pdf,image/png,image/jpeg,image/webp,image/gif,text/markdown,text/plain';

export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const KIND: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'image/gif': 'GIF',
  'text/markdown': 'Markdown',
  'text/plain': 'Text',
};

export function Attachments({ entity, editable }: { entity: string; editable: boolean }) {
  const { state, refresh } = useAsync(() => foreman.attachments(entity, { deleted: true }), [entity]);
  const { mutate, pending: busy } = useMutate();
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState('');
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);

  const all = state.status === 'ready' ? state.value.items : [];
  const live = all.filter((a) => a.deletedAt === null);
  const deleted = all.filter((a) => a.deletedAt !== null);
  const maxBytes = state.status === 'ready' ? state.value.maxBytes : null;
  const shown = live.find((a) => a.humanId === previewing) ?? null;

  const add = (file: File | undefined) => {
    if (file === undefined || busy) return;
    setDone('');
    if (maxBytes !== null && file.size > maxBytes) {
      setError(`${file.name} is ${bytesLabel(file.size)}; the most Foreman takes is ${bytesLabel(maxBytes)}.`);
      return;
    }
    setError(null);
    void mutate({
      subject: entity,
      run: () => foreman.attach(entity, file),
      message: (a) => `Attached ${a.name} to ${entity}`,
      undone: `Undone — ${file.name} is no longer attached`,
      refresh,
      failure: 'inline',
    })
      .then((outcome) => {
        if (outcome.ok) {
          setDone(`${outcome.value.name} is attached.`);
          setPreviewing(outcome.value.humanId);
        } else if (outcome.inFlight !== true) {
          setError(
            outcome.error instanceof ApiError && outcome.error.status === 415
              ? `${file.name} is not a file Foreman keeps: ${ATTACHMENT_TYPES_SENTENCE}.`
              : outcome.message,
          );
        }
      })
      .finally(() => {
        // Cleared so choosing the same file again is still a change the input reports.
        if (input.current !== null) input.current.value = '';
      });
  };

  const remove = (a: Attachment) => {
    if (previewing === a.humanId) setPreviewing(null);
    void mutate({
      subject: a.humanId,
      run: () => foreman.deleteAttachment(a.humanId),
      message: () => `${a.name} deleted`,
      undone: `Undone — ${a.name} is back`,
      refresh,
    });
  };

  const restore = (a: Attachment) => {
    void mutate({
      subject: a.humanId,
      run: () => foreman.restoreAttachment(a.humanId),
      message: () => `${a.name} restored`,
      refresh,
    });
  };

  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setOver(false);
    add(event.dataTransfer.files[0]);
  };

  return (
    <Section title="Attachments">
      <Stack gap="12">
        {state.status === 'loading' && <Skeleton lines={2} />}
        {state.status === 'error' && (
          <Alert tone="danger" title="Attachments did not load" dynamic>
            {state.message}
          </Alert>
        )}
        {state.status === 'ready' && live.length === 0 && (
          <p className="fm-section__prompt">
            Nothing attached. A design PDF, a sketch or a spec you were sent belongs here — the canvas
            above is still where the thinking goes.
          </p>
        )}

        {live.length > 0 && (
          <ul className="fm-attachments" aria-label={`Files attached to ${entity}`}>
            {live.map((a) => (
              <li key={a.humanId} className="fm-attachments__row">
                <span className="fm-attachments__name">
                  <strong>{a.name}</strong>
                  <span className="fm-muted">
                    {KIND[a.mediaType] ?? a.mediaType} · {bytesLabel(a.byteSize)} · {a.humanId} · added{' '}
                    {relativeDay(a.createdAt)}
                  </span>
                </span>
                <Cluster gap="8" align="center">
                  <Button
                    size="sm"
                    aria-pressed={previewing === a.humanId}
                    aria-label={`${previewing === a.humanId ? 'Hide' : 'Preview'} ${a.name}`}
                    onClick={() => {
                      setPreviewing(previewing === a.humanId ? null : a.humanId);
                    }}
                  >
                    {previewing === a.humanId ? 'Hide' : 'Preview'}
                  </Button>
                  <a className="fm-attachments__link" href={`${a.contentUrl}?download=1`} download={a.name} aria-label={`Download ${a.name}`}>
                    Download
                  </a>
                  {editable && (
                    <Button size="sm" aria-label={`Delete ${a.name}`} disabled={busy} onClick={() => { remove(a); }}>
                      Delete
                    </Button>
                  )}
                </Cluster>
              </li>
            ))}
          </ul>
        )}

        {shown !== null && <Preview attachment={shown} />}

        {editable && (
          <Stack gap="8">
            <button
              type="button"
              className={`fm-dropzone${over ? ' fm-dropzone--over' : ''}`}
              aria-describedby={hintId}
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
              <span>{busy ? 'Uploading…' : 'Drop a file here, or choose one'}</span>
            </button>
            <span id={hintId} className="fm-muted">
              PDF, PNG, JPEG, WebP, GIF, Markdown or text
              {maxBytes === null ? '' : `, up to ${bytesLabel(maxBytes)}`}. Deleting one can be undone.
            </span>
            <input
              ref={input}
              type="file"
              accept={ACCEPT}
              hidden
              aria-label={`Attach a file to ${entity}`}
              onChange={(event) => { add(event.target.files?.[0]); }}
            />
            {error !== null && (
              <p className="fm-error" role="alert">
                {error}
              </p>
            )}
            {/* Present before it has anything to say, or the first message is never announced. */}
            <p className="fm-muted" role="status">
              {done}
            </p>
          </Stack>
        )}

        {deleted.length > 0 && (
          <Stack gap="8">
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={showDeleted}
              onClick={() => { setShowDeleted(!showDeleted); }}
            >
              {showDeleted ? 'Hide deleted' : `Deleted (${String(deleted.length)})`}
            </Button>
            {showDeleted && (
              <ul className="fm-attachments" aria-label={`Deleted files on ${entity}`}>
                {deleted.map((a) => (
                  <li key={a.humanId} className="fm-attachments__row fm-attachments__row--deleted">
                    <span className="fm-attachments__name">
                      <span>{a.name}</span>
                      <span className="fm-muted">
                        {KIND[a.mediaType] ?? a.mediaType} · deleted {relativeDay(a.deletedAt)}
                      </span>
                    </span>
                    {editable && (
                      <Button size="sm" aria-label={`Restore ${a.name}`} disabled={busy} onClick={() => { restore(a); }}>
                        Restore
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Stack>
        )}
      </Stack>
    </Section>
  );
}

/**
 * One file shown in place. A PDF in the browser's own viewer, an image as an image, Markdown
 * rendered the way the canvas renders it, and text as text. The bytes come from the same
 * authenticated URL the download uses, so a preview is never a second way in.
 */
function Preview({ attachment }: { attachment: Attachment }) {
  const label = `Preview of ${attachment.name}`;
  if (attachment.mediaType === 'application/pdf') {
    return <iframe className="fm-attachments__frame" title={label} src={attachment.contentUrl} />;
  }
  if (attachment.mediaType.startsWith('image/')) {
    return (
      <figure className="fm-attachments__figure" aria-label={label}>
        <img src={attachment.contentUrl} alt={attachment.name} />
      </figure>
    );
  }
  return <TextPreview attachment={attachment} label={label} />;
}

function TextPreview({ attachment, label }: { attachment: Attachment; label: string }) {
  const { state } = useAsync(async () => {
    const res = await fetch(attachment.contentUrl, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`Foreman answered ${String(res.status)}`);
    return res.text();
  }, [attachment.contentUrl]);
  if (state.status === 'loading') return <Skeleton lines={4} />;
  if (state.status === 'error') {
    return (
      <Alert tone="danger" title={`${attachment.name} did not load`} dynamic>
        {state.message}
      </Alert>
    );
  }
  return (
    <div className="fm-attachments__text" role="document" aria-label={label}>
      {attachment.mediaType === 'text/markdown' ? <Markdown>{state.value}</Markdown> : <pre>{state.value}</pre>}
    </div>
  );
}
