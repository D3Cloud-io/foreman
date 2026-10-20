import { SEARCHABLE_TYPES } from '@foreman/shared';
import type { Db } from '../db.js';
import type { EntityType } from '../generated/prisma/enums.js';
import { codeFilter } from './scope.js';

/**
 * Typed cross-entity search (FRM-REQ-085).
 *
 * **Typed** is the word that matters: a result says what kind of thing it is, so "BND-REQ-021"
 * resolves to a requirement and "pg_trgm" finds the ADR that chose it, the requirement that
 * mandates it and the task that installed it — each labelled. A flat list of matching strings would
 * be a worse version of grep, which the vault already had.
 */

/**
 * What search covers — the shared list, not a copy of it.
 *
 * There used to be a copy here, and it drifted: this one gained `project_idea` and the shared one
 * did not, so the API could search project ideas while the MCP shim, whose enum is generated from
 * the shared list, could not ask it to. One list, imported, cannot disagree with itself.
 */
export const SEARCHABLE = SEARCHABLE_TYPES;

export type SearchableType = (typeof SEARCHABLE)[number];

export interface SearchHit {
  readonly type: SearchableType;
  readonly humanId: string | null;
  readonly projectCode: string | null;
  readonly title: string;
  /** The matching text, trimmed to something a list can show. */
  readonly snippet: string | null;
}

export interface SearchOptions {
  readonly types?: readonly SearchableType[];
  readonly projectCode?: string;
  /**
   * The projects a scope admits (FRM-T-17.4), from `resolveScope`. Absent searches every project;
   * present, a hit from any other project — or from none, like an unconverted project idea — is
   * left out, the exact-ID answer included: a scoped search answers inside its scope or not at all.
   */
  readonly projectCodes?: readonly string[];
  readonly limit?: number;
}

const DEFAULT_LIMIT = 30;

function snippet(text: string | null, query: string, width = 160): string | null {
  if (text === null || text.length === 0) return null;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return text.slice(0, width);
  // A window around the match, rather than the first N characters, which usually miss it entirely.
  const from = Math.max(0, at - width / 3);
  const cut = text.slice(from, from + width).replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${cut}${from + width < text.length ? '…' : ''}`;
}

export async function search(db: Db, query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  return (await searchScoped(db, query, options)).hits;
}

/**
 * A search, and — when a scope left it out — the exact-ID answer from outside the scope
 * (FRM-T-17.4). A pasted `SC4SWI-CR-001` that exists in another group is not "nothing matches":
 * the caller can say where it is and offer it, rather than leave somebody searching for a record
 * the scope is hiding.
 */
export async function searchScoped(
  db: Db,
  query: string,
  options: SearchOptions = {},
): Promise<{ hits: SearchHit[]; outside: SearchHit | null }> {
  const q = query.trim();
  if (q.length === 0) return { hits: [], outside: null };

  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, 100);
  const types = options.types ?? SEARCHABLE;
  const wants = (type: SearchableType) => types.includes(type);
  const contains = { contains: q, mode: 'insensitive' as const };
  const narrowed = options.projectCode !== undefined || options.projectCodes !== undefined;
  const codes = codeFilter(options.projectCodes, options.projectCode);
  const project = narrowed ? { project: codes } : {};
  const inScope = (hit: SearchHit) =>
    options.projectCodes === undefined ||
    (hit.projectCode !== null && options.projectCodes.includes(hit.projectCode));
  const perType = Math.max(3, Math.ceil(limit / Math.max(1, types.length)));

  const hits: SearchHit[] = [];

  // An exact human ID is the single most common search — somebody pasted an ID — so it is answered
  // first and never crowded out by a text match further down.
  const exact = await exactByHumanId(db, q);
  if (exact !== null && inScope(exact)) hits.push(exact);
  const outside = exact !== null && !inScope(exact) ? exact : null;

  if (wants('requirement')) {
    const rows = await db.requirement.findMany({
      where: {
        deletedAt: null,
        ...project,
        OR: [{ statement: contains }, { humanId: contains }],
      },
      take: perType,
      include: { project: { select: { code: true } } },
    });
    for (const row of rows) {
      hits.push({
        type: 'requirement',
        humanId: row.humanId,
        projectCode: row.project.code,
        title: row.statement.slice(0, 120),
        snippet: snippet(row.statement, q),
      });
    }
  }

  if (wants('task')) {
    const rows = await db.task.findMany({
      // The body and `doneWhen` too: a task's context is where the words somebody would search
      // for actually are, and a title is a handful of them.
      where: {
        deletedAt: null,
        ...project,
        OR: [{ title: contains }, { humanId: contains }, { body: contains }, { doneWhen: contains }],
      },
      take: perType,
      include: { project: { select: { code: true } } },
    });
    const has = (text: string | null) => text !== null && text.toLowerCase().includes(q.toLowerCase());
    for (const row of rows) {
      hits.push({
        type: 'task',
        humanId: row.humanId,
        projectCode: row.project.code,
        title: row.title,
        // Where it matched, if it matched past the title; otherwise what it is done when.
        snippet: snippet(has(row.body) && !has(row.doneWhen) ? row.body : row.doneWhen ?? row.body, q),
      });
    }
  }

  if (wants('adr')) {
    const rows = await db.adr.findMany({
      where: {
        deletedAt: null,
        ...project,
        OR: [
          { title: contains },
          { humanId: contains },
          { decisionAbstract: contains },
          { decisionMd: contains },
          { contextMd: contains },
        ],
      },
      take: perType,
      include: { project: { select: { code: true } } },
    });
    for (const row of rows) {
      hits.push({
        type: 'adr',
        humanId: row.humanId,
        projectCode: row.project.code,
        title: row.title,
        snippet: snippet(row.decisionAbstract ?? row.decisionMd, q),
      });
    }
  }

  if (wants('finding')) {
    const rows = await db.finding.findMany({
      where: {
        deletedAt: null,
        ...project,
        OR: [{ title: contains }, { humanId: contains }, { observedMd: contains }],
      },
      take: perType,
      include: { project: { select: { code: true } } },
    });
    for (const row of rows) {
      hits.push({
        type: 'finding',
        humanId: row.humanId,
        projectCode: row.project.code,
        title: row.title,
        snippet: snippet(row.observedMd, q),
      });
    }
  }

  if (wants('document_section')) {
    const rows = await db.documentSection.findMany({
      where: {
        deletedAt: null,
        OR: [{ heading: contains }, { bodyMd: contains }],
        ...(narrowed ? { document: { project: codes } } : {}),
      },
      take: perType,
      include: {
        document: { select: { title: true, kind: true, project: { select: { code: true } } } },
      },
    });
    for (const row of rows) {
      hits.push({
        type: 'document_section',
        // A section has no human ID; its address is the resource URI the MCP shim serves.
        humanId: null,
        projectCode: row.document.project.code,
        title: `${row.document.title} — ${row.heading}`,
        snippet: snippet(row.bodyMd, q),
      });
    }
  }

  if (wants('term')) {
    const rows = await db.term.findMany({
      // Narrowed like the rest, except that an ecosystem-wide term (no project) belongs to every
      // scope. Unnarrowed, a project-narrowed search used to list every project's terms.
      where: {
        deletedAt: null,
        ...(narrowed ? { AND: [{ OR: [{ projectId: null }, { project: codes }] }] } : {}),
        OR: [{ term: contains }, { definition: contains }],
      },
      take: perType,
      include: { project: { select: { code: true } } },
    });
    for (const row of rows) {
      hits.push({
        type: 'term',
        humanId: null,
        projectCode: row.project?.code ?? null,
        title: row.term,
        snippet: snippet(row.definition, q),
      });
    }
  }

  if (wants('phase')) {
    const rows = await db.phase.findMany({
      where: {
        deletedAt: null,
        ...project,
        OR: [{ name: contains }, { humanId: contains }, { objective: contains }],
      },
      take: perType,
      include: { project: { select: { code: true } } },
    });
    for (const row of rows) {
      hits.push({
        type: 'phase',
        humanId: row.humanId,
        projectCode: row.project.code,
        title: `Phase ${row.number.toString()} — ${row.name}`,
        snippet: snippet(row.objective, q),
      });
    }
  }

  if (wants('decision')) {
    const rows = await db.decision.findMany({
      where: {
        deletedAt: null,
        ...project,
        OR: [{ statement: contains }, { value: contains }, { humanId: contains }],
      },
      take: perType,
      include: { project: { select: { code: true } } },
    });
    for (const row of rows) {
      hits.push({
        type: 'decision',
        humanId: row.humanId,
        projectCode: row.project.code,
        title: row.statement,
        snippet: snippet(row.value, q),
      });
    }
  }

  if (wants('risk')) {
    const rows = await db.risk.findMany({
      where: {
        deletedAt: null,
        ...project,
        OR: [{ title: contains }, { humanId: contains }, { tripwire: contains }],
      },
      take: perType,
      include: { project: { select: { code: true } } },
    });
    for (const row of rows) {
      hits.push({
        type: 'risk',
        humanId: row.humanId,
        projectCode: row.project.code,
        title: row.title,
        snippet: snippet(row.tripwire, q),
      });
    }
  }

  if (wants('idea')) {
    const rows = await db.idea.findMany({
      where: {
        deletedAt: null,
        ...project,
        OR: [{ title: contains }, { humanId: contains }, { body: contains }],
      },
      take: perType,
      include: { project: { select: { code: true } } },
    });
    for (const row of rows) {
      hits.push({
        type: 'idea',
        humanId: row.humanId,
        projectCode: row.project.code,
        title: row.title,
        // The reason, when there is one: searching for something already rejected should show
        // *why* in the result, not make you open it to find out it was decided.
        snippet: snippet(row.reason ?? row.body ?? '', q),
      });
    }
  }

  if (wants('project_idea')) {
    const rows = await db.projectIdea.findMany({
      where: {
        deletedAt: null,
        // The same project filter, doing something slightly different on purpose: a project idea
        // has no project until it becomes one, so a search scoped to BND turns up the idea BND
        // grew out of and no others. "Where did this come from" is a question worth answering.
        ...project,
        // The canvas too, and tags by exact match: an idea found only by its title is an idea
        // you have to remember the name of, which is the one thing a search is for not needing.
        OR: [
          { title: contains },
          { humanId: contains },
          { pitch: contains },
          { problem: contains },
          { audience: contains },
          { approach: contains },
          { whyNow: contains },
          { risks: contains },
          { notes: contains },
          { tags: { has: q.trim().toLowerCase() } },
        ],
      },
      take: perType,
      include: { project: { select: { code: true } } },
    });
    for (const row of rows) {
      // The snippet comes from whichever field actually matched, so the result shows why it is a
      // result — a hit on the risks section should show the risk, not the pitch.
      const needle = q.trim().toLowerCase();
      const matched = [row.reason, row.pitch, row.problem, row.audience, row.approach, row.whyNow, row.risks, row.notes]
        .find((text) => text?.toLowerCase().includes(needle));
      hits.push({
        type: 'project_idea',
        humanId: row.humanId,
        projectCode: row.project?.code ?? null,
        title: row.title,
        snippet: snippet(matched ?? row.pitch ?? '', q),
      });
    }
  }

  // De-duplicate: an exact ID hit will usually also match its own type's text search.
  const seen = new Set<string>();
  return {
    hits: hits
      .filter((hit) => {
        const key = `${hit.type}:${hit.humanId ?? hit.title}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit),
    outside,
  };
}

/** Resolve an exact human ID across every entity that has one. */
async function exactByHumanId(db: Db, humanId: string): Promise<SearchHit | null> {
  const lookups: { type: SearchableType; find: () => Promise<SearchHit | null> }[] = [
    {
      type: 'requirement',
      find: async () => {
        const row = await db.requirement.findFirst({
          where: { humanId, deletedAt: null },
          include: { project: { select: { code: true } } },
        });
        return row === null
          ? null
          : {
              type: 'requirement',
              humanId: row.humanId,
              projectCode: row.project.code,
              title: row.statement.slice(0, 120),
              snippet: null,
            };
      },
    },
    {
      type: 'task',
      find: async () => {
        const row = await db.task.findFirst({
          where: { humanId, deletedAt: null },
          include: { project: { select: { code: true } } },
        });
        return row === null
          ? null
          : {
              type: 'task',
              humanId: row.humanId,
              projectCode: row.project.code,
              title: row.title,
              snippet: null,
            };
      },
    },
    {
      type: 'adr',
      find: async () => {
        const row = await db.adr.findFirst({
          where: { humanId, deletedAt: null },
          include: { project: { select: { code: true } } },
        });
        return row === null
          ? null
          : {
              type: 'adr',
              humanId: row.humanId,
              projectCode: row.project.code,
              title: row.title,
              snippet: row.decisionAbstract,
            };
      },
    },
    {
      type: 'finding',
      find: async () => {
        const row = await db.finding.findFirst({
          where: { humanId, deletedAt: null },
          include: { project: { select: { code: true } } },
        });
        return row === null
          ? null
          : {
              type: 'finding',
              humanId: row.humanId,
              projectCode: row.project.code,
              title: row.title,
              snippet: row.observedMd,
            };
      },
    },
  ];

  for (const lookup of lookups) {
    const hit = await lookup.find();
    if (hit !== null) return hit;
  }
  return null;
}

/** Backlinks: everything that cites this entity (FRM-REQ, and the reason `reference` exists). */
export async function backlinks(db: Db, type: EntityType, id: string) {
  return db.reference.findMany({
    where: { toType: type, toId: id },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}
