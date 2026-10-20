import {
  type AdrCreate,
  type AdrUpdate,
  type DecisionCreate,
  type DecisionUpdate,
  type RiskCreate,
  type RiskUpdate,
  type TermCreate,
  type TermUpdate,
} from '@foreman/shared';
import type { Db } from '../db.js';
import { record, type Actor } from './audit.js';
import { Conflict, Invalid, NotFound } from './errors.js';
import { allocate } from './humanId.js';
import { findProject } from './projects.js';
import { syncCitations } from './references.js';

/**
 * ADRs, decisions, risks and glossary terms (T-4.4, T-4.6).
 *
 * These are the records that outlive the code. An ADR is the only typed document kind in Foreman;
 * everything else authored is a generic `document` with sections (ADR-006).
 */

// ─── ADR ───────────────────────────────────────────────────────────────────

/**
 * The status lifecycle (FRM-REQ-058).
 *
 * `superseded` is deliberately **not** reachable by setting it: an ADR becomes superseded because
 * another ADR supersedes it, and that edge is what makes the chain navigable. Allowing the status
 * on its own would produce a superseded decision with nothing recorded as replacing it — which is
 * the exact state the register exists to prevent.
 */
const ADR_TRANSITIONS: Record<string, readonly string[]> = {
  proposed: ['accepted', 'rejected'],
  accepted: ['rejected'],
  // A superseded ADR is history. It is not re-opened; a new ADR is written.
  superseded: [],
  rejected: ['proposed'],
};

export async function createAdr(db: Db, actor: Actor, code: string, input: AdrCreate) {
  const project = await findProject(db, code);

  return db.$transaction(async (tx) => {
    const { humanId, seq } = await allocate(tx, project, 'adr');
    const adr = await tx.adr.create({
      data: {
        projectId: project.id,
        humanId,
        number: seq,
        title: input.title,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.decisionAbstract === undefined ? {} : { decisionAbstract: input.decisionAbstract }),
        ...(input.contextMd === undefined ? {} : { contextMd: input.contextMd }),
        ...(input.decisionMd === undefined ? {} : { decisionMd: input.decisionMd }),
        ...(input.consequencesMd === undefined ? {} : { consequencesMd: input.consequencesMd }),
        ...(input.rejectedMd === undefined ? {} : { rejectedMd: input.rejectedMd }),
        ...(input.decidedOn === undefined ? {} : { decidedOn: new Date(input.decidedOn) }),
      },
    });

    await syncCitations(tx, 'adr', adr.id, adrProse(adr));
    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'adr',
      entityId: adr.id,
      entityHumanId: humanId,
      after: adr,
    });
    return { ...adr, auditEventIds: [event] };
  });
}

/** Every prose field of an ADR, joined — what citations are read from. */
function adrProse(adr: {
  contextMd: string | null;
  decisionMd: string | null;
  consequencesMd: string | null;
  rejectedMd: string | null;
  decisionAbstract: string | null;
}): string {
  return [adr.decisionAbstract, adr.contextMd, adr.decisionMd, adr.consequencesMd, adr.rejectedMd]
    .filter((part): part is string => part !== null)
    .join('\n\n');
}

export async function updateAdr(db: Db, actor: Actor, humanId: string, input: AdrUpdate) {
  const before = await db.adr.findFirst({ where: { humanId, deletedAt: null } });
  if (before === null) throw new NotFound(humanId);

  if (input.status !== undefined && input.status !== before.status) {
    const allowed = ADR_TRANSITIONS[before.status] ?? [];
    if (!allowed.includes(input.status)) {
      throw new Invalid(
        input.status === 'superseded'
          ? `${humanId} becomes superseded by linking the ADR that replaces it, not by setting the ` +
            'status — otherwise nothing records what replaced it'
          : `${humanId} is ${before.status} and cannot become ${input.status}`,
      );
    }
  }

  return db.$transaction(async (tx) => {
    const adr = await tx.adr.update({
      where: { id: before.id },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.decisionAbstract === undefined ? {} : { decisionAbstract: input.decisionAbstract }),
        ...(input.contextMd === undefined ? {} : { contextMd: input.contextMd }),
        ...(input.decisionMd === undefined ? {} : { decisionMd: input.decisionMd }),
        ...(input.consequencesMd === undefined ? {} : { consequencesMd: input.consequencesMd }),
        ...(input.rejectedMd === undefined ? {} : { rejectedMd: input.rejectedMd }),
        ...(input.decidedOn === undefined ? {} : { decidedOn: new Date(input.decidedOn) }),
      },
    });

    await syncCitations(tx, 'adr', adr.id, adrProse(adr));
    const event = await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'adr',
      entityId: adr.id,
      entityHumanId: humanId,
      before,
      after: adr,
    });
    return { ...adr, auditEventIds: [event] };
  });
}

export interface AdrGraphNode {
  readonly humanId: string;
  readonly title: string;
  readonly status: string;
}

export interface AdrGraph {
  readonly nodes: readonly AdrGraphNode[];
  readonly edges: readonly { from: string; to: string; kind: string }[];
  /** A cycle, if the chain has one. Rendering a cycle silently is how one goes unnoticed. */
  readonly cycle: readonly string[] | null;
}

/**
 * The supersedes/extends graph for a project's ADRs (T-4.5, FRM-REQ-059).
 *
 * Whole-project rather than per-ADR: a supersedes chain is only legible with the whole chain
 * present, and there are tens of ADRs in a project, not thousands.
 */
export async function adrGraph(db: Db, code: string): Promise<AdrGraph> {
  const project = await findProject(db, code);
  const adrs = await db.adr.findMany({
    where: { projectId: project.id, deletedAt: null },
    orderBy: { number: 'asc' },
    include: {
      relations: { select: { kind: true, relatedAdr: { select: { humanId: true } } } },
    },
  });

  const nodes = adrs.map((adr) => ({ humanId: adr.humanId, title: adr.title, status: adr.status }));
  const edges = adrs.flatMap((adr) =>
    adr.relations
      // `superseded_by` is the inverse of an edge already drawn; showing both draws every
      // supersession twice, pointing both ways, which reads as a cycle that is not there.
      .filter((relation) => relation.kind !== 'superseded_by')
      .map((relation) => ({
        from: adr.humanId,
        to: relation.relatedAdr.humanId,
        kind: relation.kind,
      })),
  );

  return { nodes, edges, cycle: findCycle(nodes.map((n) => n.humanId), edges) };
}

/** Depth-first search for a cycle, returning the loop itself rather than merely that one exists. */
function findCycle(
  nodes: readonly string[],
  edges: readonly { from: string; to: string }[],
): string[] | null {
  const out = new Map<string, string[]>();
  for (const edge of edges) out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);

  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const walk = (node: string): string[] | null => {
    const seen = state.get(node);
    if (seen === 'done') return null;
    if (seen === 'visiting') return [...stack.slice(stack.indexOf(node)), node];

    state.set(node, 'visiting');
    stack.push(node);
    for (const next of out.get(node) ?? []) {
      const cycle = walk(next);
      if (cycle !== null) return cycle;
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  };

  for (const node of nodes) {
    const cycle = walk(node);
    if (cycle !== null) return cycle;
  }
  return null;
}

// ─── Decision ──────────────────────────────────────────────────────────────

export async function createDecision(db: Db, actor: Actor, code: string, input: DecisionCreate) {
  const project = await findProject(db, code);

  return db.$transaction(async (tx) => {
    const { humanId } = await allocate(tx, project, 'decision');
    const decision = await tx.decision.create({
      data: {
        projectId: project.id,
        humanId,
        statement: input.statement,
        value: input.value,
        ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
        ...(input.lockedAt === undefined ? {} : { lockedAt: new Date(input.lockedAt) }),
      },
    });

    await syncCitations(tx, 'decision', decision.id, input.rationale ?? '');
    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'decision',
      entityId: decision.id,
      entityHumanId: humanId,
      after: decision,
    });
    return { ...decision, auditEventIds: [event] };
  });
}

export async function updateDecision(
  db: Db,
  actor: Actor,
  humanId: string,
  input: DecisionUpdate,
) {
  const before = await db.decision.findFirst({ where: { humanId, deletedAt: null } });
  if (before === null) throw new NotFound(humanId);

  return db.$transaction(async (tx) => {
    const decision = await tx.decision.update({
      where: { id: before.id },
      data: {
        ...(input.statement === undefined ? {} : { statement: input.statement }),
        ...(input.value === undefined ? {} : { value: input.value }),
        ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
        ...(input.lockedAt === undefined ? {} : { lockedAt: new Date(input.lockedAt) }),
      },
    });

    await syncCitations(tx, 'decision', decision.id, decision.rationale ?? '');
    const event = await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'decision',
      entityId: decision.id,
      entityHumanId: humanId,
      before,
      after: decision,
    });
    return { ...decision, auditEventIds: [event] };
  });
}

// ─── Risk ──────────────────────────────────────────────────────────────────

export async function createRisk(db: Db, actor: Actor, code: string, input: RiskCreate) {
  const project = await findProject(db, code);

  return db.$transaction(async (tx) => {
    const { humanId } = await allocate(tx, project, 'risk');
    const risk = await tx.risk.create({
      data: {
        projectId: project.id,
        humanId,
        title: input.title,
        tripwire: input.tripwire,
        ...(input.likelihood === undefined ? {} : { likelihood: input.likelihood }),
        ...(input.impact === undefined ? {} : { impact: input.impact }),
        ...(input.mitigation === undefined ? {} : { mitigation: input.mitigation }),
        ...(input.phaseId === undefined || input.phaseId === null ? {} : { phaseId: input.phaseId }),
      },
    });

    await syncCitations(tx, 'risk', risk.id, `${input.mitigation ?? ''}\n${input.tripwire}`);
    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'risk',
      entityId: risk.id,
      entityHumanId: humanId,
      after: risk,
    });
    return { ...risk, auditEventIds: [event] };
  });
}

export async function updateRisk(db: Db, actor: Actor, humanId: string, input: RiskUpdate) {
  const before = await db.risk.findFirst({ where: { humanId, deletedAt: null } });
  if (before === null) throw new NotFound(humanId);

  // A tripwire that has fired is a fact with a date. Recorded here rather than left to the caller,
  // because "when did we find out" is the question asked afterwards (FRM-REQ-070).
  const firing = input.status === 'fired' && before.status !== 'fired';

  return db.$transaction(async (tx) => {
    const risk = await tx.risk.update({
      where: { id: before.id },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.likelihood === undefined ? {} : { likelihood: input.likelihood }),
        ...(input.impact === undefined ? {} : { impact: input.impact }),
        ...(input.mitigation === undefined ? {} : { mitigation: input.mitigation }),
        ...(input.tripwire === undefined ? {} : { tripwire: input.tripwire }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.phaseId === undefined ? {} : { phaseId: input.phaseId }),
        ...(firing ? { firedAt: new Date() } : {}),
      },
    });

    const event = await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'risk',
      entityId: risk.id,
      entityHumanId: humanId,
      before,
      after: risk,
    });
    return { ...risk, auditEventIds: [event] };
  });
}

// ─── Glossary ──────────────────────────────────────────────────────────────

export async function createTerm(db: Db, actor: Actor, code: string, input: TermCreate) {
  const project = await findProject(db, code);
  // An ecosystem term belongs to no project, and appears in every project's glossary.
  const projectId = input.ecosystem === true ? null : project.id;

  const clash = await db.term.findFirst({
    where: { projectId, term: input.term, deletedAt: null },
  });
  if (clash !== null) {
    throw new Conflict(
      `"${input.term}" is already defined ${projectId === null ? 'for the ecosystem' : `in ${code}`}`,
    );
  }

  return db.$transaction(async (tx) => {
    const term = await tx.term.create({
      data: {
        projectId,
        term: input.term,
        definition: input.definition,
        ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
      },
    });

    await syncCitations(tx, 'term', term.id, input.definition);
    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'term',
      entityId: term.id,
      entityHumanId: term.term,
      after: term,
    });
    return { ...term, auditEventIds: [event] };
  });
}

export async function updateTerm(db: Db, actor: Actor, id: string, input: TermUpdate) {
  const before = await db.term.findFirst({ where: { id, deletedAt: null } });
  if (before === null) throw new NotFound(`term ${id}`);

  return db.$transaction(async (tx) => {
    const term = await tx.term.update({
      where: { id },
      data: {
        ...(input.term === undefined ? {} : { term: input.term }),
        ...(input.definition === undefined ? {} : { definition: input.definition }),
        ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
        // `ecosystem` moves a term between scopes, which is a legal correction: a term defined in
        // one project that turns out to mean the same everywhere should not have to be retyped.
        ...(input.ecosystem === undefined
          ? {}
          : input.ecosystem
            ? { projectId: null }
            : {}),
      },
    });

    await syncCitations(tx, 'term', term.id, term.definition);
    const event = await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'term',
      entityId: term.id,
      entityHumanId: term.term,
      before,
      after: term,
    });
    return { ...term, auditEventIds: [event] };
  });
}

/**
 * The glossary as one project sees it: its own terms plus every ecosystem term (FRM-REQ-071).
 *
 * A project term shadows an ecosystem term of the same name — the local meaning is the one in force
 * where it was written down.
 */
export async function glossaryFor(db: Db, code: string) {
  const project = await findProject(db, code);
  const terms = await db.term.findMany({
    where: { deletedAt: null, OR: [{ projectId: project.id }, { projectId: null }] },
    orderBy: { term: 'asc' },
  });

  const byName = new Map<string, (typeof terms)[number] & { scope: 'project' | 'ecosystem' }>();
  for (const term of terms) {
    const scope = term.projectId === null ? ('ecosystem' as const) : ('project' as const);
    const existing = byName.get(term.term.toLowerCase());
    if (existing === undefined || scope === 'project') {
      byName.set(term.term.toLowerCase(), { ...term, scope });
    }
  }

  return [...byName.values()].sort((a, b) => a.term.localeCompare(b.term));
}

/**
 * Where a glossary term appears in a body of prose (T-4.8, FRM-REQ-072).
 *
 * A term is matched on a word boundary, case-insensitively, and by its aliases as well — "human ID"
 * and "humanId" are the same word to a reader and should be the same word here. Code spans and
 * fences are skipped: `term` in backticks is an identifier, not the glossary entry.
 *
 * Returned as a list rather than as rewritten markdown. Rewriting prose to inject links means the
 * stored text and the rendered text differ, and the next edit is made against whichever one the
 * author happened to be looking at.
 */
export interface TermOccurrence {
  readonly term: string;
  readonly definition: string;
  readonly scope: 'project' | 'ecosystem';
  readonly matched: string;
  readonly count: number;
}

export async function termOccurrences(
  db: Db,
  code: string,
  markdown: string,
): Promise<TermOccurrence[]> {
  const glossary = await glossaryFor(db, code);
  const prose = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');

  const found: TermOccurrence[] = [];
  for (const entry of glossary) {
    for (const candidate of [entry.term, ...entry.aliases]) {
      const matches = prose.match(
        new RegExp(`\\b${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
      );
      if (matches !== null && matches.length > 0) {
        found.push({
          term: entry.term,
          definition: entry.definition,
          scope: entry.scope,
          matched: candidate,
          count: matches.length,
        });
        // One occurrence record per term, not per alias: the reader wants the definition once.
        break;
      }
    }
  }
  return found.sort((a, b) => a.term.localeCompare(b.term));
}
