import { z } from 'zod';
import { AttachmentId, parseAnyId, ProjectCode } from '../ids.js';
import { Instant, Uuid } from './common.js';
import { Sha256 } from './blobs.js';

/**
 * Attachments: a file filed on an entity (FRM-ADR-026, FRM-REQ-252 … FRM-REQ-258).
 *
 * An attachment is a **name on an entity pointing at a blob**. The bytes are the blob store's
 * (FRM-ADR-020): written once under their SHA-256 on the host's disk, never in PostgreSQL, copied
 * into every nightly backup set beside the dump and checked by the restore drill. So two entities
 * carrying the same PDF cost one file, and deleting one attachment never touches the bytes another
 * still names.
 *
 * What an attachment is **not** is the point of the ADR. It is a source — the design PDF, the
 * whiteboard photo, the spec a vendor sent — filed on the record it informs. It is never a page:
 * Foreman does not edit it, render it into a brief, search its text, parse it for citations, count
 * it towards a canvas's maturity or a phase's coverage, or let it exist without an entity. That
 * is what keeps "no freeform wiki or note-taking" true with files in the building.
 */

/**
 * What an attachment may be, decided from the bytes and never from the client's word: a PDF by
 * `%PDF-`, an image by its signature, and text only when it is valid UTF-8 with no NUL **and**
 * its name says `.md`, `.markdown` or `.txt` — so a script or a page renamed is refused, not
 * stored as "text".
 *
 * SVG is absent on purpose: it is an image that runs script. HTML is absent for the same reason.
 */
export const ATTACHMENT_MEDIA_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'text/markdown',
  'text/plain',
] as const;
export const AttachmentMediaType = z.enum(ATTACHMENT_MEDIA_TYPES);
export type AttachmentMediaType = z.infer<typeof AttachmentMediaType>;

/** The file name endings that let valid UTF-8 in as text, and which text type each one is. */
export const TEXT_ATTACHMENT_EXTENSIONS: Readonly<Record<string, 'text/markdown' | 'text/plain'>> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
};

/**
 * The kinds an attachment can be filed on, by the type segment of their ID (`PROJECT` for a bare
 * project code). Each is a record a source document informs. Findings, ideas, documents and
 * guidelines are absent on purpose: a finding cites code, an idea is a line, a document *is* text,
 * and a guideline is a decision short enough to read in a brief.
 */
export const ATTACHABLE_TYPES = {
  PI: 'project_idea',
  PROJECT: 'project',
  P: 'phase',
  T: 'task',
  REQ: 'requirement',
  ADR: 'adr',
} as const;
export type AttachableEntityType = (typeof ATTACHABLE_TYPES)[keyof typeof ATTACHABLE_TYPES];
export const AttachableEntityType = z.enum([
  'project_idea',
  'project',
  'phase',
  'task',
  'requirement',
  'adr',
]);

/** The type segment `ATTACHABLE_TYPES` is keyed by, for any string — or undefined. */
export function attachableTypeOf(value: string): AttachableEntityType | undefined {
  const parsed = parseAnyId(value);
  const key = parsed !== null ? parsed.type : ProjectCode.safeParse(value).success ? 'PROJECT' : '';
  return (ATTACHABLE_TYPES as Record<string, AttachableEntityType>)[key];
}

/**
 * What an attachment is filed on: `PI-015`, `BND-T-4.2`, `FRM-ADR-020`, `FRM-REQ-190`, `FRM-P-12`,
 * or a project by its bare code, `FRM`.
 */
export const AttachTarget = z
  .string()
  .max(40)
  .refine((value) => attachableTypeOf(value) !== undefined, {
    message:
      'files attach to a project idea (PI-015), a project (FRM), a phase, a task, a requirement or an ADR',
  });
export type AttachTarget = z.infer<typeof AttachTarget>;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, prefix: readonly number[] | string): boolean {
  const want = typeof prefix === 'string' ? Array.from(prefix, (c) => c.charCodeAt(0)) : prefix;
  return bytes.length >= want.length && want.every((b, i) => bytes[i] === b);
}

/** Valid UTF-8 with no NUL: what "text" means here. A binary renamed `.txt` fails both. */
function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * What an attachment's bytes are, or null when they are none of the allowed types (FRM-REQ-253).
 *
 * Binary types are recognised by their signature and nothing else — the declared type and the name
 * are ignored, so a PDF called `notes.txt` is a PDF and an HTML page called `deck.pdf` is refused.
 * Text has no signature, so it needs both: bytes that are valid UTF-8 with no NUL, and a name
 * ending `.md`, `.markdown` or `.txt`. That keeps a script or a page from arriving as "text".
 *
 * Shared, so the server decides with it and the stdio shim can refuse a local file before a byte
 * of it leaves the machine.
 */
export function sniffAttachment(bytes: Uint8Array, name: string): AttachmentMediaType | null {
  if (startsWith(bytes, '%PDF-')) return 'application/pdf';
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, 'GIF87a') || startsWith(bytes, 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && startsWith(bytes, 'RIFF') && startsWith(bytes.subarray(8), 'WEBP')) {
    return 'image/webp';
  }
  const text = TEXT_ATTACHMENT_EXTENSIONS[attachmentExtension(name)];
  if (text !== undefined && isText(bytes)) return text;
  return null;
}

/** The sentence every refusal of a type uses, so the console, the API and the shim agree. */
export const ATTACHMENT_TYPES_SENTENCE =
  'attach a PDF, a PNG, JPEG, WebP or GIF image, or a .md or .txt file';

/** The longest file name kept. Longer ones are shortened before the extension, not refused. */
export const ATTACHMENT_NAME_MAX = 200;

/**
 * A file name as it is kept: the last path segment only, control characters removed, whitespace
 * collapsed, and shortened before its extension when it is too long. Null when nothing is left.
 *
 * Shared, so the console shows the name the server will store, and the shim derives a name from a
 * path exactly the way the server would have.
 */
export function cleanAttachmentName(raw: string): string | null {
  const last = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = last.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return null;
  if (cleaned.length <= ATTACHMENT_NAME_MAX) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : '';
  return `${cleaned.slice(0, ATTACHMENT_NAME_MAX - ext.length - 1).trimEnd()}…${ext}`;
}

/** The extension of a cleaned name, lower-cased, without its dot. */
export function attachmentExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** One attachment, as every surface returns it. */
export const Attachment = z.object({
  id: Uuid,
  humanId: AttachmentId,
  name: z.string(),
  mediaType: AttachmentMediaType,
  byteSize: z.number().int().nonnegative(),
  sha256: Sha256,
  /** What it is filed on: its kind and its ID as written (a project's is its code). */
  entity: z.object({ type: AttachableEntityType, humanId: z.string() }),
  /** The actor who attached it, as the audit trail names them. */
  uploadedBy: z.string(),
  createdAt: Instant,
  /** Non-null while deleted. Deleted attachments are listed only when asked for. */
  deletedAt: Instant.nullable(),
  /** Its metadata: `/api/attachments/ATT-012`. */
  url: z.string(),
  /** Its bytes, inline: `/api/attachments/ATT-012/content`. Add `?download=1` to save it. */
  contentUrl: z.string(),
});
export type Attachment = z.infer<typeof Attachment>;

/** The line an entity read carries for each live attachment: enough to choose one to fetch. */
export const AttachmentSummary = Attachment.pick({
  humanId: true,
  name: true,
  mediaType: true,
  byteSize: true,
  createdAt: true,
});
export type AttachmentSummary = z.infer<typeof AttachmentSummary>;

/** `GET /api/attachments?entity=PI-015[&deleted=true]`. */
export const AttachmentListQuery = z.object({
  entity: AttachTarget,
  /** Also list the deleted ones, newest deletion first after the live — where Restore lives. */
  deleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
export type AttachmentListQuery = z.infer<typeof AttachmentListQuery>;

/** `POST /api/attachments?entity=PI-015` — the file itself is the multipart `file` part. */
export const AttachmentUploadQuery = z.object({ entity: AttachTarget });
export type AttachmentUploadQuery = z.infer<typeof AttachmentUploadQuery>;

/**
 * `POST /api/attachments/tickets` — a one-use upload link, for a session that can run a command on
 * the machine holding the file but cannot hand Foreman the bytes itself (the remote `/mcp`, where
 * the MCP server runs in Foreman and the file is on somebody's laptop).
 *
 * The bytes still travel as one HTTP body, never as base64 through a tool argument (FRM-ADR-020).
 */
export const AttachmentTicketCreate = z.strictObject({
  entity: AttachTarget,
  /** The name to file it under, usually the local file's own. */
  name: z.string().min(1).max(1024),
});
export type AttachmentTicketCreate = z.infer<typeof AttachmentTicketCreate>;

export const AttachmentTicket = z.object({
  /** `PUT` the file's bytes here, with no other credential. One use, then it is spent. */
  uploadUrl: z.string(),
  expiresAt: Instant,
  /** The name the file will be filed under. */
  name: z.string(),
  entity: z.string(),
  maxBytes: z.number().int().positive(),
});
export type AttachmentTicket = z.infer<typeof AttachmentTicket>;

/** How long an upload link lives. Long enough to run one command; short enough not to matter lost. */
export const ATTACHMENT_TICKET_TTL_MS = 15 * 60 * 1000;

/** What `foreman_get` inlines at most, per attachment. Anything larger is linked, not sent. */
export const ATTACHMENT_INLINE_MAX_BYTES = 4 * 1024 * 1024;
