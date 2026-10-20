import {
  parseLocation,
  type AuditCreate,
  type AuditUpdate,
  type FindingCreate,
  type FindingUpdate,
} from '@foreman/shared';
import type { Db } from '../db.js';
import type { FindingStatus, Severity } from '../generated/prisma/enums.js';
import { record, type Actor, type TransactionClient } from './audit.js';
import { NotFound } from './errors.js';
import { allocate } from './humanId.js';
import { findProject } from './projects.js';
import { codeFilter } from './scope.js';
import { syncCitations } from './references.js';

/**
 * Audits and their findings (T-6.1 … T-6.5, T-6.9).
 *
 * 127 findings stop being files four directories deep. The lifecycle they gain is small — found,
 * fixed, verified — and the only part that needs care is the last one, because a fix that *looks*
 * verified and is not is worse than one that admits it does not know.
 */

/** The human-ID prefix each audit kind's findings carry. `CR-014` is a code review's fourteenth. */
const PREFIX_FOR_KIND = {
  code_review: 'finding_code_review',
  design: 'finding_design',
  feature: 'finding_feature',
  api: 'finding_api',
} as const;

export async function createAudit(db: Db, actor: Actor, code: string, input: AuditCreate) {
  const project = await findProject(db, code);

  return db.$transaction(async (tx) => {
    const { humanId } = await allocate(tx, project, 'audit');
    const audit = await tx.audit.create({
      data: {
        projectId: project.id,
        humanId,
        kind: input.kind,
        runDate: input.runDate === undefined ? new Date() : new Date(input.runDate),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
        ...(input.rounds === undefined ? {} : { rounds: input.rounds }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.vaultPath === undefined ? {} : { vaultPath: input.vaultPath }),
      },
    });

    await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'audit',
      entityId: audit.id,
      entityHumanId: humanId,
      after: audit,
    });
    return audit;
  });
}

export async function updateAudit(db: Db, actor: Actor, humanId: string, input: AuditUpdate) {
  const before = await db.audit.findFirst({ where: { humanId, deletedAt: null } });
  if (before === null) throw new NotFound(humanId);

  return db.$transaction(async (tx) => {
    const audit = await tx.audit.update({
      where: { id: before.id },
      data: {
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
        ...(input.rounds === undefined ? {} : { rounds: input.rounds }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.runDate === undefined ? {} : { runDate: new Date(input.runDate) }),
        ...(input.vaultPath === undefined ? {} : { vaultPath: input.vaultPath }),
      },
    });
    await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'audit',
      entityId: audit.id,
      entityHumanId: humanId,
      before,
      after: audit,
    });
    return audit;
  });
}

// ─── Findings ──────────────────────────────────────────────────────────────

/** Resolve the ADR or requirement a finding contradicts, refusing an ID that names nothing. */
async function relationIds(
  tx: TransactionClient,
  projectId: string,
  input: { adr?: string | undefined; requirement?: string | undefined },
) {
  const out: { adrId?: string; requirementId?: string } = {};

  if (input.adr !== undefined) {
    const adr = await tx.adr.findFirst({
      where: { humanId: input.adr, projectId, deletedAt: null },
      select: { id: true },
    });
    if (adr === null) throw new NotFound(input.adr);
    out.adrId = adr.id;
  }
  if (input.requirement !== undefined) {
    const requirement = await tx.requirement.findFirst({
      where: { humanId: input.requirement, projectId, deletedAt: null },
      select: { id: true },
    });
    if (requirement === null) throw new NotFound(input.requirement);
    out.requirementId = requirement.id;
  }
  return out;
}

/** Replace a finding's parsed locations to match its raw string, exactly. */
async function syncLocations(
  tx: TransactionClient,
  findingId: string,
  raw: string | null,
): Promise<number> {
  await tx.findingLocation.deleteMany({ where: { findingId } });
  const parsed = parseLocation(raw);

  for (const [index, location] of parsed.entries()) {
    await tx.findingLocation.create({
      data: {
        findingId,
        path: location.path,
        lines: location.lines,
        note: location.note,
        sortOrder: index,
      },
    });
  }
  return parsed.length;
}

export async function createFinding(db: Db, actor: Actor, code: string, input: FindingCreate) {
  const project = await findProject(db, code);

  // The ID prefix follows the audit that produced it: `CR-` for a code review, `DA-` for a design
  // audit. Findings from different audits of one project share no sequence.
  const audit =
    input.auditId === undefined || input.auditId === null
      ? null
      : await db.audit.findUnique({ where: { id: input.auditId }, select: { id: true, kind: true } });

  return db.$transaction(async (tx) => {
    const { humanId } = await allocate(tx, project, PREFIX_FOR_KIND[audit?.kind ?? 'code_review']);
    const relations = await relationIds(tx, project.id, input);

    const finding = await tx.finding.create({
      data: {
        projectId: project.id,
        humanId,
        title: input.title,
        severity: input.severity,
        lenses: input.lenses ?? [],
        // `unverified` rather than null: a verdict's absence is a state, and 123 of 127 real
        // findings say so out loud.
        verified: input.verified ?? 'unverified',
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.foundRound === undefined ? {} : { foundRound: input.foundRound }),
        ...(input.fixedRound === undefined ? {} : { fixedRound: input.fixedRound }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.location === undefined ? {} : { locationRaw: input.location }),
        ...(input.observedMd === undefined ? {} : { observedMd: input.observedMd }),
        ...(input.recommendationMd === undefined ? {} : { recommendationMd: input.recommendationMd }),
        ...(input.phaseId === undefined || input.phaseId === null ? {} : { phaseId: input.phaseId }),
        ...(audit === null ? {} : { auditId: audit.id }),
        ...relations,
      },
    });

    await syncLocations(tx, finding.id, input.location ?? null);
    await syncCitations(
      tx,
      'finding',
      finding.id,
      `${input.observedMd ?? ''}\n${input.recommendationMd ?? ''}`,
    );

    await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'finding',
      entityId: finding.id,
      entityHumanId: humanId,
      after: finding,
    });
    return finding;
  });
}

export async function updateFinding(db: Db, actor: Actor, humanId: string, input: FindingUpdate) {
  const before = await db.finding.findFirst({ where: { humanId, deletedAt: null } });
  if (before === null) throw new NotFound(humanId);

  return db.$transaction(async (tx) => {
    const relations = await relationIds(tx, before.projectId, input);

    const finding = await tx.finding.update({
      where: { id: before.id },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.severity === undefined ? {} : { severity: input.severity }),
        ...(input.lenses === undefined ? {} : { lenses: input.lenses }),
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
        ...(input.verified === undefined ? {} : { verified: input.verified }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.foundRound === undefined ? {} : { foundRound: input.foundRound }),
        ...(input.fixedRound === undefined ? {} : { fixedRound: input.fixedRound }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.location === undefined ? {} : { locationRaw: input.location }),
        ...(input.observedMd === undefined ? {} : { observedMd: input.observedMd }),
        ...(input.recommendationMd === undefined ? {} : { recommendationMd: input.recommendationMd }),
        ...(input.fixedCommitSha === undefined ? {} : { fixedCommitSha: input.fixedCommitSha }),
        ...relations,
      },
    });

    if (input.location !== undefined) await syncLocations(tx, finding.id, input.location);
    if (input.observedMd !== undefined || input.recommendationMd !== undefined) {
      await syncCitations(
        tx,
        'finding',
        finding.id,
        `${finding.observedMd ?? ''}\n${finding.recommendationMd ?? ''}`,
      );
    }

    await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'finding',
      entityId: finding.id,
      entityHumanId: humanId,
      before,
      after: finding,
    });
    return finding;
  });
}

// ─── The fix verdict (T-6.4, T-6.5) ────────────────────────────────────────

export type FixVerdict = 'green' | 'red' | 'running' | 'unverified' | 'none';

export interface FixState {
  readonly sha: string | null;
  readonly verdict: FixVerdict;
  /** Why the verdict is what it is, in words a person can act on. */
  readonly detail: string;
  readonly ingested: boolean;
  readonly checks: { name: string; conclusion: string | null }[];
}

/**
 * Was CI green on the commit that fixed this? (FRM-REQ-118, FRM-REQ-119)
 *
 * **An un-ingested fix commit is `unverified`, never green.** This is the requirement the phase
 * plan singles out, and the reason is worth stating: the only thing worse than not knowing whether
 * a fix was tested is believing it was. A SHA Foreman has never seen tells you nothing, and the
 * honest rendering of nothing is "unverified" — not the absence of a red mark.
 */
export async function fixStateFor(
  db: Db,
  finding: { fixedCommitSha: string | null; projectId: string },
): Promise<FixState> {
  const sha = finding.fixedCommitSha;
  if (sha === null || sha === '') {
    return { sha: null, verdict: 'none', detail: 'No fix commit recorded.', ingested: false, checks: [] };
  }

  // Short SHAs are what people record — `142237a` — so the match is by prefix.
  const commit = await db.commit.findFirst({
    where: { sha: { startsWith: sha }, repo: { projectId: finding.projectId, deletedAt: null } },
    select: { sha: true },
  });

  if (commit === null) {
    return {
      sha,
      verdict: 'unverified',
      detail: `${sha} has not been ingested, so nothing is known about CI on it.`,
      ingested: false,
      checks: [],
    };
  }

  const checks = await db.checkRun.findMany({
    where: { commitSha: commit.sha, repo: { projectId: finding.projectId, deletedAt: null } },
    orderBy: { completedAt: 'desc' },
    select: { name: true, conclusion: true },
  });

  if (checks.length === 0) {
    return {
      sha: commit.sha,
      // Ingested, but no checks ran against it. Still not green.
      verdict: 'unverified',
      detail: 'The commit is ingested, but no check run has been recorded against it.',
      ingested: true,
      checks: [],
    };
  }

  const pending = checks.filter((c) => c.conclusion === null);
  const failed = checks.filter(
    (c) => c.conclusion !== null && !['success', 'skipped', 'neutral'].includes(c.conclusion),
  );

  if (failed.length > 0) {
    return {
      sha: commit.sha,
      verdict: 'red',
      detail: `${failed.map((c) => c.name).join(', ')} did not pass on the fix commit.`,
      ingested: true,
      checks,
    };
  }
  if (pending.length > 0) {
    return {
      sha: commit.sha,
      verdict: 'running',
      detail: `${String(pending.length)} check${pending.length === 1 ? '' : 's'} still running.`,
      ingested: true,
      checks,
    };
  }

  return {
    sha: commit.sha,
    verdict: 'green',
    detail: `${String(checks.length)} check${checks.length === 1 ? '' : 's'} passed on the fix commit.`,
    ingested: true,
    checks,
  };
}

// ─── The cross-project inbox (T-6.6) ───────────────────────────────────────

/** Severity, in the order a person triages. The rank is what "ranked by severity" means. */
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export interface InboxQuery {
  readonly project?: string | undefined;
  readonly severity?: Severity | undefined;
  readonly status?: FindingStatus | undefined;
  readonly lens?: string | undefined;
  readonly limit?: number | undefined;
  /** The projects a scope admits (FRM-T-17.4), from `resolveScope`; absent for every project. */
  readonly codes?: readonly string[] | undefined;
}

/**
 * Every open finding, every project, ranked (FRM-REQ-120).
 *
 * The screen that justifies the phase: 127 findings live in four directory levels across two
 * vaults, and "what is the worst thing outstanding anywhere" was not a question anybody could ask.
 */
export async function inbox(db: Db, query: InboxQuery = {}) {
  const where = {
    deletedAt: null,
    // Open by default. An inbox showing everything ever found is an archive.
    status: query.status ?? 'open',
    ...(query.severity === undefined ? {} : { severity: query.severity }),
    ...(query.lens === undefined ? {} : { lenses: { has: query.lens } }),
    project: { deletedAt: null, ...codeFilter(query.codes, query.project) },
  } as const;

  // The count and the page share one `where`, so `total` is the size of the set the page is cut
  // from (FRM-REQ-242), not the number of rows that survived `take`.
  const [findings, total] = await Promise.all([
    db.finding.findMany({
      where,
      include: {
        project: { select: { code: true, name: true } },
        audit: { select: { humanId: true, kind: true, runDate: true } },
        locations: { orderBy: { sortOrder: 'asc' }, select: { path: true, lines: true } },
      },
      take: query.limit ?? 50,
    }),
    db.finding.count({ where }),
  ]);

  const items = findings
    .map((finding) => ({
      humanId: finding.humanId,
      project: finding.project.code,
      title: finding.title,
      severity: finding.severity,
      lenses: finding.lenses,
      status: finding.status,
      verified: finding.verified,
      effort: finding.effort,
      foundIn: finding.audit === null ? null : finding.audit.humanId,
      locations: finding.locations,
      fixedCommitSha: finding.fixedCommitSha,
    }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        a.project.localeCompare(b.project) ||
        a.humanId.localeCompare(b.humanId),
    );
  return { items, total };
}
