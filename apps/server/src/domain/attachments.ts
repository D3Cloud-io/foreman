import { createHash, randomBytes } from 'node:crypto';
import {
  ATTACHABLE_TYPES,
  ATTACHMENT_MEDIA_TYPES,
  ATTACHMENT_TICKET_TTL_MS,
  attachableTypeOf,
  cleanAttachmentName,
  formatAttachmentId,
  sniffAttachment,
  type AttachableEntityType,
  type Attachment,
  type AttachmentMediaType,
  type AttachmentSummary,
  type AttachmentTicket,
} from '@foreman/shared';
import type { Db } from '../db.js';
import { eventIds, record, type Actor, type TransactionClient } from './audit.js';
import { openBlob, storeBlob, type BlobRead } from './blobs.js';
import { Conflict, Invalid, NotFound } from './errors.js';
import { softDelete, undo } from './undo.js';

/**
 * Attachments (FRM-ADR-026, FRM-REQ-252 … FRM-REQ-258): a file filed on an entity.
 *
 * An attachment is a **name on an entity pointing at a blob**. The blob store already keeps bytes
 * once, on the host's disk, under their SHA-256, with the nightly backup copying them beside the
 * dump and the restore drill hashing every one (FRM-ADR-020, FRM-REQ-202/203). So this module adds
 * no storage at all: it decides what may come in, which entity it lands on, and who may see it.
 *
 * It deliberately does nothing *with* the bytes. No text is extracted, nothing is indexed or
 * searched, no citation is parsed out of a Markdown file, and no brief carries one (FRM-REQ-257).
 * A file is a source filed on the record it informs, never a page that competes with it — which is
 * what keeps "no freeform wiki or note-taking" true with files in the building.
 */

// ─── What may come in ───────────────────────────────────────────────────────

/** Decided from the bytes (FRM-REQ-253); shared so the shim refuses a file before sending it. */
export { sniffAttachment };

export const ALLOWED_ATTACHMENT_TYPES = ATTACHMENT_MEDIA_TYPES;

/** A name as it is kept, or a 422 naming the field. */
export function attachmentName(raw: string): string {
  const name = cleanAttachmentName(raw);
  if (name === null) {
    throw new Invalid('the file needs a name', [{ path: 'name', message: 'empty once cleaned' }]);
  }
  return name;
}

// ─── Which entity ───────────────────────────────────────────────────────────

/** The entity an attachment is filed on, resolved: its kind, its row, and who may change it. */
export interface AttachTargetRow {
  readonly type: AttachableEntityType;
  readonly id: string;
  /** As it is written: `PI-015`, `BND-T-4.2`, or a project's code. */
  readonly humanId: string;
  /** A project idea's submitter, for the board's "your own submission" rule. Null otherwise. */
  readonly submittedById: string | null;
}

/**
 * Resolve `PI-015`, `FRM-T-4.2`, `FRM`… to a live row. A deleted entity is not found: a file is
 * not filed on something that is gone, and is not listed under it either.
 */
export async function resolveTarget(db: Db | TransactionClient, raw: string): Promise<AttachTargetRow> {
  const value = raw.trim();
  const type = attachableTypeOf(value);
  if (type === undefined) {
    throw new Invalid(
      `${value} is not something a file can be attached to: a project idea, project, phase, task, requirement or ADR`,
      [{ path: 'entity', message: 'not attachable' }],
    );
  }
  const live = { humanId: value, deletedAt: null };
  const row = await (async (): Promise<{ id: string; submittedById?: string | null } | null> => {
    switch (type) {
      case 'project_idea':
        return db.projectIdea.findFirst({ where: live, select: { id: true, submittedById: true } });
      case 'project':
        return db.project.findFirst({ where: { code: value, deletedAt: null }, select: { id: true } });
      case 'phase':
        return db.phase.findFirst({ where: live, select: { id: true } });
      case 'task':
        return db.task.findFirst({ where: live, select: { id: true } });
      case 'requirement':
        return db.requirement.findFirst({ where: live, select: { id: true } });
      case 'adr':
        return db.adr.findFirst({ where: live, select: { id: true } });
    }
  })();
  if (row === null) throw new NotFound(value);
  return { type, id: row.id, humanId: value, submittedById: row.submittedById ?? null };
}

// ─── Shapes ─────────────────────────────────────────────────────────────────

const WITH_BLOB = { blob: { select: { mediaType: true, byteSize: true } } } as const;

interface Row {
  id: string;
  humanId: string;
  name: string;
  entityType: string;
  entityHumanId: string;
  blobSha256: string;
  uploadedBy: string;
  createdAt: Date;
  deletedAt: Date | null;
  blob: { mediaType: string; byteSize: number };
}

export function shape(row: Row): Attachment {
  return {
    id: row.id,
    humanId: row.humanId,
    name: row.name,
    mediaType: row.blob.mediaType as AttachmentMediaType,
    byteSize: row.blob.byteSize,
    sha256: row.blobSha256,
    entity: { type: row.entityType as AttachableEntityType, humanId: row.entityHumanId },
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
    url: `/api/attachments/${row.humanId}`,
    contentUrl: `/api/attachments/${row.humanId}/content`,
  };
}

/** What the audit trail keeps: the row as stored, so undo has every column to put back. */
function snapshot(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'blob'));
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/** Every attachment on one entity: live ones oldest first, then — when asked — the deleted. */
export async function attachmentsOn(
  db: Db,
  target: AttachTargetRow,
  options: { deleted?: boolean } = {},
): Promise<Attachment[]> {
  const rows = await db.attachment.findMany({
    where: {
      entityType: target.type,
      entityId: target.id,
      ...(options.deleted === true ? {} : { deletedAt: null }),
    },
    include: WITH_BLOB,
    orderBy: [{ seq: 'asc' }],
  });
  const live = rows.filter((r) => r.deletedAt === null);
  const gone = rows
    .filter((r) => r.deletedAt !== null)
    .sort((a, b) => (b.deletedAt?.getTime() ?? 0) - (a.deletedAt?.getTime() ?? 0));
  return [...live, ...gone].map(shape);
}

/** The line an entity read carries per live attachment (`foreman_get PI-015`). */
export async function attachmentSummaries(
  db: Db,
  type: AttachableEntityType,
  entityId: string,
): Promise<AttachmentSummary[]> {
  const rows = await db.attachment.findMany({
    where: { entityType: type, entityId, deletedAt: null },
    include: WITH_BLOB,
    orderBy: { seq: 'asc' },
  });
  return rows.map((row) => {
    const full = shape(row);
    return {
      humanId: full.humanId,
      name: full.name,
      mediaType: full.mediaType,
      byteSize: full.byteSize,
      createdAt: full.createdAt,
    };
  });
}

/** One live attachment, or NotFound. A deleted one is found only by `{ deleted: true }`. */
export async function findAttachment(
  db: Db | TransactionClient,
  humanId: string,
  options: { deleted?: boolean } = {},
): Promise<Attachment> {
  const row = await db.attachment.findFirst({
    where: { humanId, ...(options.deleted === true ? {} : { deletedAt: null }) },
    include: WITH_BLOB,
  });
  if (row === null) throw new NotFound(humanId);
  return shape(row);
}

/** Its bytes, from the blob store. A deleted attachment's bytes are not served. */
export async function openAttachment(
  db: Db,
  blobDir: string,
  humanId: string,
): Promise<{ attachment: Attachment; blob: BlobRead }> {
  const attachment = await findAttachment(db, humanId);
  const blob = await openBlob(db, blobDir, attachment.sha256);
  return { attachment, blob };
}

/** Who may change the attachments of the entity a stored attachment is filed on. */
export async function targetOf(db: Db, attachment: Attachment): Promise<AttachTargetRow> {
  return resolveTarget(db, attachment.entity.humanId);
}

// ─── Writes ─────────────────────────────────────────────────────────────────

async function nextSeq(tx: TransactionClient): Promise<number> {
  const rows = await tx.$queryRaw<{ seq: number }[]>`select nextval('attachment_seq')::int as seq`;
  const seq = rows[0]?.seq;
  if (seq === undefined) throw new Error('attachment_seq did not yield a value');
  return seq;
}

export interface AttachInput {
  readonly bytes: Buffer;
  readonly name: string;
  readonly mediaType: AttachmentMediaType;
}

export interface AttachResult {
  readonly attachment: Attachment;
  /** The attachment's own event — the one Undo reverses. The blob's, if new, is not undoable. */
  readonly auditEventIds: string[];
}

/**
 * File a file on an entity (FRM-REQ-252). The bytes go to the blob store first — once, under their
 * hash, before any row names them — then the attachment row and its audit event in one transaction.
 *
 * `within` lets the upload-link path claim its ticket in that same transaction, so a link that two
 * uploads race for files exactly one attachment.
 */
export async function attach(
  db: Db,
  actor: Actor,
  blobDir: string,
  target: AttachTargetRow,
  input: AttachInput,
  within?: (tx: TransactionClient, attachmentId: string) => Promise<void>,
): Promise<AttachResult> {
  const stored = await storeBlob(db, actor, blobDir, { bytes: input.bytes, mediaType: input.mediaType });

  return db.$transaction(async (tx) => {
    const seq = await nextSeq(tx);
    const created = await tx.attachment.create({
      data: {
        humanId: formatAttachmentId(seq),
        seq,
        entityType: target.type,
        entityId: target.id,
        entityHumanId: target.humanId,
        name: input.name,
        blobSha256: stored.blob.sha256,
        uploadedBy: actor.actor,
      },
      include: WITH_BLOB,
    });
    if (within !== undefined) await within(tx, created.id);
    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'attachment',
      entityId: created.id,
      entityHumanId: created.humanId,
      after: snapshot(created),
    });
    return { attachment: shape(created), auditEventIds: eventIds(event) };
  });
}

/** Soft delete (FRM-REQ-254): the row and the bytes stay; Undo or `restore` brings it back. */
export async function deleteAttachment(
  db: Db,
  actor: Actor,
  humanId: string,
): Promise<{ auditEventIds: string[] }> {
  const { auditEventIds } = await softDelete(db, actor, 'attachment', humanId);
  return { auditEventIds };
}

/**
 * Bring a deleted attachment back without knowing which event deleted it — the console's Deleted
 * list, long after the toast has gone. It is the undo of the newest delete, through `undo` itself,
 * so it is refused exactly when that undo would be (FRM-REQ-254).
 */
export async function restoreAttachment(db: Db, actor: Actor, humanId: string) {
  const row = await db.attachment.findFirst({ where: { humanId } });
  if (row === null) throw new NotFound(humanId);
  if (row.deletedAt === null) throw new Conflict(`${humanId} is not deleted`);
  // The entity it is filed on must still be there: restoring a file onto a deleted idea would
  // put it back somewhere nobody can see it.
  await resolveTarget(db, row.entityHumanId);
  const deletion = await db.auditEvent.findFirst({
    where: { entityType: 'attachment', entityId: row.id, action: 'delete', undoneAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (deletion === null) throw new Conflict(`${humanId} has no deletion left to undo`);
  const result = await undo(db, actor, deletion.id);
  return { attachment: await findAttachment(db, humanId), auditEventIds: result.auditEventIds };
}

// ─── Upload links (FRM-REQ-256) ─────────────────────────────────────────────

const TICKET_PREFIX = 'frmup_';
const hashTicket = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * A one-use upload link for one name on one entity, for a session that can run a command where the
 * file is but cannot send the bytes itself — the remote `/mcp`, whose MCP server runs here.
 *
 * The secret is 32 random bytes and only its hash is kept. Minting one is audited like any other
 * credential: it is a write, made by the actor the upload will be recorded as.
 */
export async function createTicket(
  db: Db,
  actor: Actor,
  baseUrl: string,
  maxBytes: number,
  target: AttachTargetRow,
  rawName: string,
): Promise<AttachmentTicket & { auditEventIds: string[] }> {
  const name = attachmentName(rawName);
  const token = `${TICKET_PREFIX}${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + ATTACHMENT_TICKET_TTL_MS);
  const event = await db.$transaction(async (tx) => {
    const ticket = await tx.attachmentTicket.create({
      data: {
        tokenHash: hashTicket(token),
        entityType: target.type,
        entityId: target.id,
        entityHumanId: target.humanId,
        name,
        actor: actor.actor,
        actorKind: actor.actorKind,
        expiresAt,
      },
    });
    return record(tx, {
      ...actor,
      action: 'create',
      entityType: 'attachment_ticket',
      entityId: ticket.id,
      // No human ID: a link is not a change to the entity, so it stays out of that entity's
      // History. The entity is named in `after`; the attachment it files gets its own ATT- event.
      // Never the token: the audit trail is read by people the link was not for.
      after: { entity: target.humanId, name, expiresAt: expiresAt.toISOString() },
    });
  });
  return {
    uploadUrl: `${baseUrl.replace(/\/$/, '')}/uploads/${token}`,
    expiresAt: expiresAt.toISOString(),
    name,
    entity: target.humanId,
    maxBytes,
    auditEventIds: [event],
  };
}

export class TicketGone extends Error {
  constructor() {
    super('this upload link has expired or been used; ask for a new one');
    this.name = 'TicketGone';
  }
}

/** The live ticket a token names, without spending it. Gone when unknown, used or expired. */
export async function ticketFor(db: Db, token: string) {
  if (!token.startsWith(TICKET_PREFIX)) throw new TicketGone();
  const ticket = await db.attachmentTicket.findUnique({ where: { tokenHash: hashTicket(token) } });
  if (ticket === null || ticket.usedAt !== null || ticket.expiresAt.getTime() <= Date.now()) {
    throw new TicketGone();
  }
  return ticket;
}

/**
 * Upload through a link: file the bytes as the ticket's actor, and spend the ticket in the same
 * transaction as the row. Of two uploads racing for one link, exactly one files an attachment.
 */
export async function attachWithTicket(
  db: Db,
  blobDir: string,
  token: string,
  bytes: Buffer,
): Promise<AttachResult | { refused: 'type' }> {
  const ticket = await ticketFor(db, token);
  const mediaType = sniffAttachment(bytes, ticket.name);
  if (mediaType === null) return { refused: 'type' };
  const target = await resolveTarget(db, ticket.entityHumanId);
  const actor: Actor = { actor: ticket.actor, actorKind: ticket.actorKind };
  return attach(db, actor, blobDir, target, { bytes, name: ticket.name, mediaType }, async (tx, attachmentId) => {
    const claimed = await tx.attachmentTicket.updateMany({
      where: { id: ticket.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date(), attachmentId },
    });
    if (claimed.count === 0) throw new TicketGone();
  });
}

export { ATTACHABLE_TYPES };
