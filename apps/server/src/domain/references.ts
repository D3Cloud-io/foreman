import { extractHumanIds, parseHumanId } from '@foreman/shared';
import type { Db } from '../db.js';
import type { EntityType } from '../generated/prisma/enums.js';
import type { TransactionClient } from './audit.js';

/**
 * Citations, parsed from prose (T-4.7, FRM-REQ-067).
 *
 * Whenever a body of markdown is written, the human IDs in it become `reference` rows, and the
 * inverse of those rows is the backlinks panel: open `BND-ADR-004` and see every requirement, task,
 * finding and section that cites it.
 *
 * Two decisions worth stating:
 *
 * - **Citations are re-synced, not appended.** A mention removed from the prose stops being a
 *   backlink, or the panel slowly fills with links to text that no longer says anything.
 * - **A citation of something that does not exist is dropped, not stored.** `BND-REQ-999` in a
 *   sentence is a typo, and a backlink graph full of typos is one nobody trusts. The prose keeps the
 *   text either way — nothing is rewritten.
 */

/** The type segment of a human ID, to the entity it names. */
const BY_TYPE: Record<string, EntityType> = {
  REQ: 'requirement',
  T: 'task',
  P: 'phase',
  ADR: 'adr',
  D: 'decision',
  R: 'risk',
  CR: 'finding',
  DA: 'finding',
  FR: 'finding',
  API: 'finding',
  AUD: 'audit',
  // A screen is citable from prose like any other entity with a project-prefixed ID (FRM-REQ-189).
  SCR: 'screen',
};

/** Resolve a human ID to its row, or null when nothing of that name exists. */
async function resolve(
  tx: TransactionClient,
  humanId: string,
): Promise<{ type: EntityType; id: string } | null> {
  const parsed = parseHumanId(humanId);
  if (parsed === null) return null;
  const type = BY_TYPE[parsed.type];
  if (type === undefined) return null;

  const where = { humanId, deletedAt: null };
  switch (type) {
    case 'requirement': {
      const row = await tx.requirement.findFirst({ where, select: { id: true } });
      return row === null ? null : { type, id: row.id };
    }
    case 'task': {
      const row = await tx.task.findFirst({ where, select: { id: true } });
      return row === null ? null : { type, id: row.id };
    }
    case 'phase': {
      const row = await tx.phase.findFirst({ where, select: { id: true } });
      return row === null ? null : { type, id: row.id };
    }
    case 'adr': {
      const row = await tx.adr.findFirst({ where, select: { id: true } });
      return row === null ? null : { type, id: row.id };
    }
    case 'decision': {
      const row = await tx.decision.findFirst({ where, select: { id: true } });
      return row === null ? null : { type, id: row.id };
    }
    case 'risk': {
      const row = await tx.risk.findFirst({ where, select: { id: true } });
      return row === null ? null : { type, id: row.id };
    }
    case 'finding': {
      const row = await tx.finding.findFirst({ where, select: { id: true } });
      return row === null ? null : { type, id: row.id };
    }
    case 'audit': {
      const row = await tx.audit.findFirst({ where, select: { id: true } });
      return row === null ? null : { type, id: row.id };
    }
    case 'screen': {
      const row = await tx.screen.findFirst({ where, select: { id: true } });
      return row === null ? null : { type, id: row.id };
    }
    default:
      return null;
  }
}

export interface CitationSync {
  /** Citations now recorded — the IDs that resolved to something. */
  readonly cited: readonly string[];
  /** Mentioned but resolving to nothing. Reported, never stored, and never rewritten in the prose. */
  readonly unresolved: readonly string[];
}

/**
 * Make the `cites` references from this entity match the human IDs in this markdown, exactly.
 *
 * Runs inside the caller's transaction: a body and the citations drawn from it are one change, and
 * a failure between them would leave the graph describing prose that was never saved.
 */
export async function syncCitations(
  tx: TransactionClient,
  fromType: EntityType,
  fromId: string,
  markdown: string,
): Promise<CitationSync> {
  const mentioned = extractHumanIds(markdown);

  const resolved = new Map<string, { type: EntityType; id: string }>();
  const unresolved: string[] = [];
  for (const humanId of mentioned) {
    const target = await resolve(tx, humanId);
    if (target === null) unresolved.push(humanId);
    // A body that cites itself is not a citation, it is a sentence about itself.
    else if (!(target.type === fromType && target.id === fromId)) resolved.set(humanId, target);
  }

  const wanted = [...resolved.entries()];
  const existing = await tx.reference.findMany({
    where: { fromType, fromId, kind: 'cites' },
  });

  // Gone from the prose: gone from the graph.
  const stale = existing.filter(
    (row) => !wanted.some(([, t]) => t.type === row.toType && t.id === row.toId),
  );
  if (stale.length > 0) {
    await tx.reference.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
  }

  for (const [citedAs, target] of wanted) {
    await tx.reference.upsert({
      where: {
        fromType_fromId_toType_toId_kind: {
          fromType,
          fromId,
          toType: target.type,
          toId: target.id,
          kind: 'cites',
        },
      },
      // `citedAs` is refreshed so the graph keeps the text as it was actually written.
      create: { fromType, fromId, toType: target.type, toId: target.id, kind: 'cites', citedAs },
      update: { citedAs },
    });
  }

  return { cited: [...resolved.keys()], unresolved };
}

/** Drop every citation from an entity — used when its body is deleted rather than edited. */
export async function clearCitations(
  tx: TransactionClient,
  fromType: EntityType,
  fromId: string,
): Promise<void> {
  await tx.reference.deleteMany({ where: { fromType, fromId, kind: 'cites' } });
}

/** Human IDs mentioned in a body that resolve to nothing. The drift signal behind a dead citation. */
export async function danglingCitations(db: Db, projectId: string): Promise<
  { section: string; document: string; citedAs: string }[]
> {
  const sections = await db.documentSection.findMany({
    where: { deletedAt: null, document: { projectId, deletedAt: null } },
    include: { document: { select: { title: true } } },
  });

  const out: { section: string; document: string; citedAs: string }[] = [];
  for (const section of sections) {
    for (const humanId of extractHumanIds(section.bodyMd)) {
      const target = await resolve(db, humanId);
      if (target === null) {
        out.push({ section: section.key, document: section.document.title, citedAs: humanId });
      }
    }
  }
  return out;
}
