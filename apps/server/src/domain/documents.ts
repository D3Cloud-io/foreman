import {
  extractHumanIds,
  sectionKeyFor,
  type DocumentCreate,
  type DocumentUpdate,
  type SectionCreate,
  type SectionUpdate,
} from '@foreman/shared';
import type { Db } from '../db.js';
import { record, type Actor, type TransactionClient } from './audit.js';
import { Conflict, Invalid, NotFound } from './errors.js';
import { findProject } from './projects.js';
import { syncCitations } from './references.js';

/**
 * Documents, their sections, and the revision behind every edit (T-4.1 … T-4.3).
 *
 * Two properties carry this phase:
 *
 * 1. **A section is addressable and its key never moves.** `foreman://bindery/architecture#deployment`
 *    resolves to one row, and it has to keep resolving to that row after the heading is reworded.
 *    So a rename changes `heading` and never `key` — there is no code path here that changes one.
 * 2. **Every edit leaves a revision.** Bindery has no `PATCH /documents/{id}` at all, which is why
 *    its titles and correspondents still cannot be corrected. The endpoint is the easy half; the
 *    half that makes it safe to use is that nothing it does is unrecoverable.
 */

const MAX_SECTIONS = 200;

export async function findDocument(db: Db, id: string) {
  const document = await db.document.findFirst({
    where: { id, deletedAt: null },
    include: {
      project: { select: { id: true, code: true } },
      phase: { select: { humanId: true, name: true } },
      sections: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
    },
  });
  if (document === null) throw new NotFound(`document ${id}`);
  return document;
}

/** Everything a revision snapshot holds: the document as it stood, sections included. */
function snapshotOf(document: {
  title: string;
  kind: string;
  sections: { key: string; heading: string; bodyMd: string; sortOrder: number }[];
}) {
  return {
    title: document.title,
    kind: document.kind,
    sections: document.sections.map((s) => ({
      key: s.key,
      heading: s.heading,
      bodyMd: s.bodyMd,
      sortOrder: s.sortOrder,
    })),
  };
}

/**
 * Write the next revision. The number comes from a count inside the transaction rather than from
 * the caller, so two concurrent edits cannot both claim revision 7.
 */
async function writeRevision(
  tx: TransactionClient,
  documentId: string,
  actor: Actor,
  snapshot: ReturnType<typeof snapshotOf>,
  note?: string,
): Promise<number> {
  const last = await tx.documentRevision.findFirst({
    where: { documentId },
    orderBy: { revisionNo: 'desc' },
    select: { revisionNo: true },
  });
  const revisionNo = (last?.revisionNo ?? 0) + 1;

  await tx.documentRevision.create({
    data: {
      documentId,
      revisionNo,
      snapshot,
      actor: actor.actor,
      actorKind: actor.actorKind,
      ...(note === undefined ? {} : { note }),
    },
  });
  return revisionNo;
}

/**
 * Mark the document itself as changed.
 *
 * A section write leaves the `document` row untouched, which made `If-Match` on the document
 * useless: two people could edit two sections of one document, each holding a version that never
 * went stale, and the second would overwrite nothing — but the *same* section edited twice would
 * also pass, silently. The document is what a reader holds a version of, so the document is what a
 * section write has to move.
 */
async function touchDocument(tx: TransactionClient, documentId: string): Promise<void> {
  await tx.document.update({ where: { id: documentId }, data: { updatedAt: new Date() } });
}

/**
 * After an undo reversed a change to one of a document's sections (FRM-T-18.4): the document moves
 * and the history records it, exactly as a section write does.
 *
 * The undo restores the section row alone, and a reader's version is the *document's* — so without
 * this the reversal left the ETag where the undone write had put it. A conditional read was then
 * answered 304 with the body from before the undo, and the next save, carrying that ETag, passed
 * `If-Match` and wrote the undone text straight back.
 */
export async function afterSectionUndo(
  tx: TransactionClient,
  actor: Actor,
  sectionId: string,
): Promise<number | null> {
  const section = await tx.documentSection.findUnique({
    where: { id: sectionId },
    select: { documentId: true, key: true },
  });
  if (section === null) return null;

  await touchDocument(tx, section.documentId);
  const document = await tx.document.findUnique({
    where: { id: section.documentId },
    include: { sections: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } } },
  });
  if (document === null) return null;
  return writeRevision(tx, document.id, actor, snapshotOf(document), `undo of a change to ${section.key}`);
}

// ─── Documents ─────────────────────────────────────────────────────────────

export async function createDocument(db: Db, actor: Actor, code: string, input: DocumentCreate) {
  const project = await findProject(db, code);

  const sections = input.sections ?? [];
  if (sections.length > MAX_SECTIONS) throw new Invalid(`a document holds at most ${String(MAX_SECTIONS)} sections`);

  // Keys are settled before anything is written: a collision found halfway through would leave a
  // document whose addresses depend on the order its sections happened to be created in.
  const keyed = assignKeys(sections);

  return db.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        projectId: project.id,
        kind: input.kind,
        title: input.title,
        ...(input.phaseId === undefined || input.phaseId === null ? {} : { phaseId: input.phaseId }),
        ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
        sections: {
          create: keyed.map((section, index) => ({
            key: section.key,
            heading: section.heading,
            bodyMd: section.bodyMd,
            sortOrder: index,
          })),
        },
      },
      include: { sections: { orderBy: { sortOrder: 'asc' } } },
    });

    // Revision 1 is the document as created, so "restore the first version" means something.
    await writeRevision(tx, document.id, actor, snapshotOf(document), 'created');

    for (const section of document.sections) {
      await syncCitations(tx, 'document_section', section.id, section.bodyMd);
    }

    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'document',
      entityId: document.id,
      after: document,
    });
    return { ...document, auditEventIds: [event] };
  });
}

/** Settle every key up front, refusing a duplicate rather than silently disambiguating it. */
function assignKeys(
  sections: readonly { key?: string | undefined; heading: string; bodyMd: string }[],
): { key: string; heading: string; bodyMd: string }[] {
  const seen = new Set<string>();
  return sections.map((section) => {
    const key = section.key ?? sectionKeyFor(section.heading);
    if (seen.has(key)) {
      // Two headings that slug the same ("Deployment" and "deployment!") would give one section an
      // address that reaches the other. Refused: the caller chooses which one keeps it.
      throw new Conflict(
        `two sections would share the key "${key}" — give one of them an explicit key`,
      );
    }
    seen.add(key);
    return { key, heading: section.heading, bodyMd: section.bodyMd };
  });
}

export async function updateDocument(db: Db, actor: Actor, id: string, input: DocumentUpdate) {
  const before = await findDocument(db, id);

  return db.$transaction(async (tx) => {
    const document = await tx.document.update({
      where: { id },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.phaseId === undefined ? {} : { phaseId: input.phaseId }),
        ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
      },
      include: { sections: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } } },
    });

    await writeRevision(tx, id, actor, snapshotOf(document));
    const event = await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'document',
      entityId: id,
      before,
      after: document,
    });
    return { ...document, auditEventIds: [event] };
  });
}

// ─── Sections ──────────────────────────────────────────────────────────────

/**
 * Replace one section's body (T-4.2, FRM-REQ-063).
 *
 * The whole point is what it does **not** touch: every other section's row is untouched, so a
 * concurrent edit to a different section of the same document cannot be lost by this one.
 */
export async function updateSection(
  db: Db,
  actor: Actor,
  documentId: string,
  key: string,
  input: SectionUpdate,
) {
  const document = await findDocument(db, documentId);
  const before = document.sections.find((s) => s.key === key);
  if (before === undefined) throw new NotFound(`section ${key} of document ${documentId}`);

  return db.$transaction(async (tx) => {
    const section = await tx.documentSection.update({
      where: { id: before.id },
      // `key` is absent from `SectionUpdate` entirely: a rename must not move the address.
      data: {
        bodyMd: input.bodyMd,
        ...(input.heading === undefined ? {} : { heading: input.heading }),
      },
    });

    const after = {
      ...document,
      sections: document.sections.map((s) => (s.id === section.id ? section : s)),
    };
    await touchDocument(tx, documentId);
    const revisionNo = await writeRevision(tx, documentId, actor, snapshotOf(after), input.note);

    // Citations are re-read on every write, so a removed mention stops being a backlink.
    await syncCitations(tx, 'document_section', section.id, section.bodyMd);

    const event = await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'document_section',
      entityId: section.id,
      entityHumanId: `${document.project.code}/${document.kind}#${key}`,
      before,
      after: section,
    });

    return { ...section, revisionNo, auditEventIds: [event] };
  });
}

export async function addSection(db: Db, actor: Actor, documentId: string, input: SectionCreate) {
  const document = await findDocument(db, documentId);
  if (document.sections.length >= MAX_SECTIONS) {
    throw new Invalid(`a document holds at most ${String(MAX_SECTIONS)} sections`);
  }

  const key = input.key ?? sectionKeyFor(input.heading);
  if (document.sections.some((s) => s.key === key)) {
    throw new Conflict(`section ${key} already exists in this document`);
  }

  // Inserted after a named section, or appended. Sort order is renumbered densely so a long
  // document does not drift into fractional ordering nobody can reason about.
  const order = document.sections.map((s) => s.key);
  const at = input.after === undefined ? order.length : order.indexOf(input.after) + 1;
  if (input.after !== undefined && at === 0) throw new NotFound(`section ${input.after}`);

  return db.$transaction(async (tx) => {
    const section = await tx.documentSection.create({
      data: { documentId, key, heading: input.heading, bodyMd: input.bodyMd, sortOrder: at },
    });

    // Everything at or after the insertion point shifts down by one.
    for (const [index, existing] of document.sections.entries()) {
      const target = index < at ? index : index + 1;
      if (existing.sortOrder !== target) {
        await tx.documentSection.update({ where: { id: existing.id }, data: { sortOrder: target } });
      }
    }

    const fresh = await tx.documentSection.findMany({
      where: { documentId, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
    });
    await touchDocument(tx, documentId);
    await writeRevision(tx, documentId, actor, snapshotOf({ ...document, sections: fresh }));
    await syncCitations(tx, 'document_section', section.id, section.bodyMd);

    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'document_section',
      entityId: section.id,
      entityHumanId: `${document.project.code}/${document.kind}#${key}`,
      after: section,
    });
    return { ...section, auditEventIds: [event] };
  });
}

// ─── Revisions and diff ────────────────────────────────────────────────────

export async function revisionsOf(db: Db, documentId: string) {
  await findDocument(db, documentId);
  return db.documentRevision.findMany({
    where: { documentId },
    orderBy: { revisionNo: 'desc' },
    select: { revisionNo: true, actor: true, actorKind: true, note: true, createdAt: true },
  });
}

export interface DiffLine {
  readonly kind: 'added' | 'removed' | 'same';
  readonly text: string;
}

export interface SectionDiff {
  readonly key: string;
  readonly heading: string;
  readonly status: 'added' | 'removed' | 'changed' | 'unchanged';
  readonly lines: readonly DiffLine[];
}

/**
 * A line diff between two revisions (T-4.3, FRM-REQ-065).
 *
 * Longest common subsequence over lines — the same shape `diff` produces, and small enough to keep
 * here rather than take a dependency for. Documents are sections of prose, not million-line files.
 */
export async function diffRevisions(
  db: Db,
  documentId: string,
  from: number,
  to: number,
): Promise<{ from: number; to: number; sections: SectionDiff[] }> {
  const [a, b] = await Promise.all([revision(db, documentId, from), revision(db, documentId, to)]);

  const keys = [...new Set([...a.sections.map((s) => s.key), ...b.sections.map((s) => s.key)])];
  const sections = keys.map((key): SectionDiff => {
    const before = a.sections.find((s) => s.key === key);
    const after = b.sections.find((s) => s.key === key);

    if (before === undefined && after !== undefined) {
      return {
        key,
        heading: after.heading,
        status: 'added',
        lines: lines(after.bodyMd).map((text) => ({ kind: 'added' as const, text })),
      };
    }
    if (after === undefined && before !== undefined) {
      return {
        key,
        heading: before.heading,
        status: 'removed',
        lines: lines(before.bodyMd).map((text) => ({ kind: 'removed' as const, text })),
      };
    }
    if (before === undefined || after === undefined) {
      return { key, heading: key, status: 'unchanged', lines: [] };
    }

    const changed = before.bodyMd !== after.bodyMd || before.heading !== after.heading;
    return {
      key,
      heading: after.heading,
      status: changed ? 'changed' : 'unchanged',
      lines: changed ? diffLines(lines(before.bodyMd), lines(after.bodyMd)) : [],
    };
  });

  return { from, to, sections };
}

async function revision(db: Db, documentId: string, revisionNo: number) {
  const row = await db.documentRevision.findUnique({
    where: { documentId_revisionNo: { documentId, revisionNo } },
  });
  if (row === null) throw new NotFound(`revision ${String(revisionNo)} of document ${documentId}`);

  // A snapshot is JSON written by an earlier version of this code, or by the importer. Read
  // defensively: a diff that throws on a malformed old revision makes the history unreadable from
  // that point backwards, which is the opposite of what keeping revisions is for.
  const snapshot = row.snapshot as unknown;
  const sections =
    typeof snapshot === 'object' && snapshot !== null && Array.isArray((snapshot as { sections?: unknown }).sections)
      ? ((snapshot as { sections: unknown[] }).sections
          .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
          .map((s) => ({
            key: typeof s['key'] === 'string' ? s['key'] : '',
            heading: typeof s['heading'] === 'string' ? s['heading'] : '',
            bodyMd: typeof s['bodyMd'] === 'string' ? s['bodyMd'] : '',
          }))
          .filter((s) => s.key !== ''))
      : [];

  return {
    title:
      typeof snapshot === 'object' && snapshot !== null && typeof (snapshot as { title?: unknown }).title === 'string'
        ? (snapshot as { title: string }).title
        : '',
    sections,
  };
}

const lines = (text: string): string[] => text.split('\n');

/** Longest common subsequence, then walked back into added/removed/same lines. */
export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  const rows = before.length;
  const cols = after.length;

  // table[i][j] = length of the LCS of before[i..] and after[j..].
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      const row = table[i];
      const next = table[i + 1];
      if (row === undefined || next === undefined) continue;
      row[j] =
        before[i] === after[j]
          ? (next[j + 1] ?? 0) + 1
          : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      out.push({ kind: 'same', text: before[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      out.push({ kind: 'removed', text: before[i] ?? '' });
      i += 1;
    } else {
      out.push({ kind: 'added', text: after[j] ?? '' });
      j += 1;
    }
  }
  while (i < rows) {
    out.push({ kind: 'removed', text: before[i] ?? '' });
    i += 1;
  }
  while (j < cols) {
    out.push({ kind: 'added', text: after[j] ?? '' });
    j += 1;
  }
  return out;
}

/** Every human ID a document's sections cite. Used by the importer and by the backlinks panel. */
export function citedBy(document: { sections: { bodyMd: string }[] }): string[] {
  return [...new Set(document.sections.flatMap((s) => extractHumanIds(s.bodyMd)))];
}
