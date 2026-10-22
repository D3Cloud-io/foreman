import {
  formatProjectIdeaId,
  IDEA_SECTIONS,
  MATURITY_FIELDS,
  PROJECT_IDEA_NEEDS_REASON,
  type IdeaChecklistItem,
  type IdeaLink,
  type ProjectIdeaConvert,
  type ProjectIdeaCreate,
  type ProjectIdeaStatus,
  type ProjectIdeaUpdate,
} from '@foreman/shared';
import type { Db } from '../db.js';
import { logger } from '../logger.js';
import { summarise } from './board.js';
import { record, type Actor, type TransactionClient } from './audit.js';
import { createDocument } from './documents.js';
import { Conflict, Invalid, NotFound } from './errors.js';
import { createProject } from './projects.js';

/**
 * Project ideas — something that might become a project, before it is one
 * (FRM-REQ-159 … FRM-REQ-164, FRM-ADR-015).
 *
 * The one record in Foreman that belongs to no project. Everything else here is filed under a
 * code, and a project idea is precisely the thing that does not have one yet — which is the whole
 * reason it is a separate table rather than an `Idea` with a nullable parent. A nullable parent
 * would have made every query, every ID, and every route in the ideas feature answer "it depends".
 *
 * **The code is asked for at conversion, not at capture.** A project code is immutable and
 * embedded in every human ID the project will ever have (ADR-008). Demanding one to write down
 * "maybe a fuel tracker someday" asks a permanent question at the moment there is least
 * information to answer it, and the answer is then wrong forever. `PI-007` costs nothing and
 * carries no decision.
 */

const SELECT = {
  id: true,
  humanId: true,
  seq: true,
  title: true,
  pitch: true,
  status: true,
  reason: true,
  decidedAt: true,
  convertedAt: true,
  createdAt: true,
  updatedAt: true,
  fundedAmountCents: true,
  project: { select: { code: true, name: true, lifecycle: true } },
  submittedBy: { select: { id: true, displayName: true } },
  _count: { select: { comments: { where: { deletedAt: null, internal: false } } } },
} as const;

/** Everything the canvas holds (FRM-ADR-017). Read on the detail page; summarised on the list. */
const CANVAS = {
  problem: true,
  audience: true,
  approach: true,
  whyNow: true,
  risks: true,
  notes: true,
  excitement: true,
  tags: true,
  questions: true,
  nextSteps: true,
  links: true,
  related: true,
} as const;

const DETAIL = { ...SELECT, ...CANVAS } as const;

const filled = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;

/**
 * How much of the thinking is written down: the pitch and the five canvas questions.
 *
 * A count, not a score, and shown as one. It says nothing about whether the idea is *good* — that
 * is what excitement and the impact/effort rating are for. It says whether anybody could pick this
 * up and understand it without asking you, which is the thing converting depends on.
 */
export function maturity(row: Record<string, unknown>): { filled: number; total: number } {
  return {
    filled: MATURITY_FIELDS.filter((field) => filled(row[field])).length,
    total: MATURITY_FIELDS.length,
  };
}

/** The canvas fields present in an input, as a Prisma `data` fragment. Absent means unchanged. */
function canvasData(input: ProjectIdeaCreate | ProjectIdeaUpdate) {
  const data: Record<string, unknown> = {};
  for (const key of ['problem', 'audience', 'approach', 'whyNow', 'risks', 'notes'] as const) {
    // An empty string clears a section: the console sends one when somebody deletes the text,
    // and storing '' would count as "written" to anything that checked for null.
    if (input[key] !== undefined) data[key] = input[key].trim().length === 0 ? null : input[key];
  }
  if (input.excitement !== undefined) data['excitement'] = input.excitement;
  // Tags are de-duplicated after normalising: `Hardware` and `hardware` are the same tag, and
  // storing both would split the ideas under it into two piles nobody would think to merge.
  if (input.tags !== undefined) data['tags'] = [...new Set(input.tags)];
  if (input.questions !== undefined) data['questions'] = input.questions;
  if (input.nextSteps !== undefined) data['nextSteps'] = input.nextSteps;
  if (input.links !== undefined) data['links'] = input.links;
  if (input.related !== undefined) data['related'] = [...new Set(input.related)];
  return data;
}

/**
 * The next `PI-` number, from a Postgres sequence.
 *
 * Not from a counter column, because there is no project row to hold one and no project row to
 * lock. `nextval` is atomic under concurrency and — the property that matters for a human ID —
 * **never hands back a number it has already given**, even when the transaction that took it
 * rolls back. A gap in the sequence is correct; a reused number would make every citation of the
 * old `PI-007` point at a different idea.
 */
async function nextSeq(tx: TransactionClient): Promise<number> {
  const rows = await tx.$queryRaw<{ seq: number }[]>`
    select nextval('project_idea_seq')::int as seq
  `;
  const seq = rows[0]?.seq;
  if (seq === undefined) throw new Error('project_idea_seq did not yield a value');
  return seq;
}

/**
 * Every project idea, with the board's view of each attached when the caller is on the board.
 *
 * `canReview` decides whether score summaries come back at all, and it is applied here rather
 * than by the caller: a summary that reaches the client and is hidden by the console has still
 * been delivered to the submitter whose idea it scores (FRM-REQ-168).
 */
export async function allProjectIdeas(
  db: Db,
  options: { status?: ProjectIdeaStatus; canReview?: boolean } = {},
) {
  const rows = await db.projectIdea.findMany({
    where: { deletedAt: null, ...(options.status === undefined ? {} : { status: options.status }) },
    // Untriaged first — the list exists to be worked through — then newest. The enum is ordered
    // so open work sorts above decided work, which is why this is one `orderBy` and not a case.
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    select: {
      ...SELECT,
      problem: true,
      audience: true,
      approach: true,
      whyNow: true,
      risks: true,
      excitement: true,
      tags: true,
      questions: true,
      scores: { select: { impact: true, effort: true } },
    },
  });

  // The raw scores are dropped here and the summary is attached only for a reviewer, so a
  // submitter's response carries neither. Computing and discarding is deliberate: one query, and
  // the decision about who sees it lives in one line rather than in two divergent queries.
  //
  // The section bodies are dropped too. The list needs to know *whether* each is written, not
  // what it says, and a board of forty ideas each carrying six essays is a payload for nothing.
  return rows.map(({ scores, problem, audience, approach, whyNow, risks, questions, ...rest }) => ({
    ...rest,
    maturity: maturity({ pitch: rest.pitch, problem, audience, approach, whyNow, risks }),
    openQuestions: (questions as IdeaChecklistItem[]).filter((q) => !q.done).length,
    score: options.canReview === true ? summarise(scores) : null,
  }));
}

export async function findProjectIdea(db: Db, humanId: string) {
  const idea = await db.projectIdea.findFirst({
    where: { humanId, deletedAt: null },
    select: DETAIL,
  });
  if (idea === null) throw new NotFound(humanId);
  return { ...idea, maturity: maturity(idea) };
}

export async function createProjectIdea(
  db: Db,
  actor: Actor,
  input: ProjectIdeaCreate,
  submittedById?: string | null,
) {
  return db.$transaction(async (tx) => {
    const seq = await nextSeq(tx);
    const idea = await tx.projectIdea.create({
      data: {
        humanId: formatProjectIdeaId(seq),
        seq,
        title: input.title,
        ...(input.pitch === undefined ? {} : { pitch: input.pitch }),
        ...canvasData(input),
        // Null when a token wrote it: a token is not a person, and inventing an author would put
        // a name on the board next to something nobody there actually said.
        ...(submittedById === null || submittedById === undefined
          ? {}
          : { submittedById }),
      },
      select: SELECT,
    });

    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'project_idea',
      entityId: idea.id,
      entityHumanId: idea.humanId,
      after: idea,
    });
    return { ...idea, auditEventIds: [event] };
  });
}

export async function updateProjectIdea(
  db: Db,
  actor: Actor,
  humanId: string,
  input: ProjectIdeaUpdate,
) {
  const before = await db.projectIdea.findFirst({ where: { humanId, deletedAt: null } });
  if (before === null) throw new NotFound(humanId);

  // A converted idea is a historical record of how a project started. Editing its title or
  // reopening it would leave the project it names pointing at something that no longer says it.
  if (before.status === 'converted') {
    throw new Conflict(
      `${humanId} became a project and cannot be changed — edit the project instead`,
    );
  }

  // Against the merged state, not the patch: a request that sets only the status would otherwise
  // pass while leaving the previous reason — or none — attached to a new decision.
  const status = input.status ?? before.status;
  const reason = input.reason === undefined ? before.reason : input.reason;
  if (
    PROJECT_IDEA_NEEDS_REASON.includes(status) &&
    (reason === null || reason.trim().length === 0)
  ) {
    throw new Invalid(`a project idea that is ${status} must say why`, [
      { path: 'reason', message: `required when the status is ${status}` },
    ]);
  }

  return db.$transaction(async (tx) => {
    const idea = await tx.projectIdea.update({
      where: { id: before.id },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.pitch === undefined ? {} : { pitch: input.pitch }),
        ...canvasData(input),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.reason === undefined ? {} : { reason: input.reason ?? null }),
        ...(input.status === undefined
          ? {}
          : { decidedAt: input.status === 'new' ? null : (before.decidedAt ?? new Date()) }),
        // Back to `new` un-decides it, and retires the reason it carried — "deliberately not now"
        // must not linger on an idea nobody has judged.
        ...(input.status === 'new' && input.reason === undefined ? { reason: null } : {}),
      },
      select: DETAIL,
    });

    const event = await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'project_idea',
      entityId: idea.id,
      entityHumanId: humanId,
      before,
      after: idea,
    });
    // The same shape as a read, maturity included: the console replaces its copy with this, and a
    // response missing a field the page renders is a page that breaks on its first save.
    return { ...idea, maturity: maturity(idea), auditEventIds: [event] };
  });
}

/**
 * Turn an idea into a project (FRM-REQ-162).
 *
 * The idea is **kept**, not consumed. It becomes the record of where the project came from and
 * what it was for before anybody had built any of it — which is the one piece of a project's
 * history that is otherwise never written down anywhere.
 */
export async function convertProjectIdea(
  db: Db,
  actor: Actor,
  humanId: string,
  input: ProjectIdeaConvert,
) {
  const before = await db.projectIdea.findFirst({ where: { humanId, deletedAt: null } });
  if (before === null) throw new NotFound(humanId);
  if (before.status === 'converted') {
    throw new Conflict(`${humanId} has already been converted`);
  }

  // Created first, and outside the update: `createProject` refuses a code already in use, and a
  // refusal has to leave the idea exactly as it was rather than half-converted.
  const { auditEventIds: projectEvents, ...project } = await createProject(db, actor, {
    code: input.code,
    name: input.name ?? before.title,
    ...(before.pitch === null ? {} : { pitch: before.pitch }),
    ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
  });

  const idea = await db.$transaction(async (tx) => {
    const converted = await tx.projectIdea.update({
      where: { id: before.id },
      data: {
        status: 'converted',
        projectId: project.id,
        convertedAt: new Date(),
        decidedAt: before.decidedAt ?? new Date(),
      },
      select: SELECT,
    });

    const event = await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'project_idea',
      entityId: converted.id,
      entityHumanId: humanId,
      before,
      after: converted,
    });
    return { converted, event };
  });

  const written = await writeBrief(db, actor, project.code, before, humanId);
  const { auditEventIds: briefEvents, ...brief } = written ?? { auditEventIds: [] as string[] };
  // The idea's own event first, then the project it made and the brief written into it. They are
  // three changes, so undoing the conversion is undoing each — the console names them together.
  return {
    idea: idea.converted,
    project,
    brief: written === null ? null : brief,
    auditEventIds: [idea.event, ...projectEvents, ...briefEvents],
  };
}

/**
 * The idea's canvas, handed to the new project as its discovery document (FRM-REQ-176).
 *
 * This is what makes growing an idea worth doing. Without it the thinking stays on a frozen record
 * beside the project rather than inside it, and the first planning session starts from a title.
 * With it, `/plan-project` opens on a problem statement, an audience, a sketch and a list of the
 * questions that were already known to be open.
 *
 * **Best effort, on purpose.** The project and the conversion are already committed by the time
 * this runs, and a brief that fails to write must not report the conversion as failed — the idea
 * keeps every word regardless, so nothing is lost, only not yet copied. It says so in the log and
 * returns null, and the console says so to the person.
 */
async function writeBrief(
  db: Db,
  actor: Actor,
  code: string,
  idea: {
    title: string;
    pitch: string | null;
    problem: string | null;
    audience: string | null;
    approach: string | null;
    whyNow: string | null;
    risks: string | null;
    notes: string | null;
    questions: unknown;
    nextSteps: unknown;
    links: unknown;
    related: string[];
    id: string;
  },
  humanId: string,
) {
  const sections: { heading: string; bodyMd: string }[] = [];
  if (filled(idea.pitch)) sections.push({ heading: 'Pitch', bodyMd: idea.pitch ?? '' });

  for (const section of IDEA_SECTIONS) {
    const body = idea[section.key];
    if (filled(body)) sections.push({ heading: section.heading, bodyMd: body ?? '' });
  }

  const checklist = (items: unknown) =>
    (items as IdeaChecklistItem[]).map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`).join('\n');
  if ((idea.questions as IdeaChecklistItem[]).length > 0) {
    sections.push({ heading: 'Open questions', bodyMd: checklist(idea.questions) });
  }
  if ((idea.nextSteps as IdeaChecklistItem[]).length > 0) {
    sections.push({ heading: 'Next steps', bodyMd: checklist(idea.nextSteps) });
  }
  if ((idea.links as IdeaLink[]).length > 0) {
    sections.push({
      heading: 'Links',
      bodyMd: (idea.links as IdeaLink[]).map((l) => `- [${l.label}](${l.url})`).join('\n'),
    });
  }
  if (idea.related.length > 0) {
    // Written as bare human IDs so the citation parser turns every project-scoped one into a
    // backlink — the related project learns this one exists without anybody linking it by hand.
    sections.push({ heading: 'Related', bodyMd: idea.related.map((r) => `- ${r}`).join('\n') });
  }

  // The thoughts log, oldest first — the order the idea was actually thought through in.
  // Public ones only: a board-only note was written for the board, not for the project's record.
  const thoughts = await db.ideaComment.findMany({
    where: { projectIdeaId: idea.id, deletedAt: null, internal: false },
    orderBy: { createdAt: 'asc' },
    select: { body: true, createdAt: true, user: { select: { displayName: true } } },
  });
  if (thoughts.length > 0) {
    sections.push({
      heading: 'Thoughts',
      bodyMd: thoughts
        .map((t) => `**${t.createdAt.toISOString().slice(0, 10)} · ${t.user.displayName}**\n\n${t.body}`)
        .join('\n\n---\n\n'),
    });
  }

  try {
    return await createDocument(db, actor, code, {
      kind: 'discovery',
      title: `Idea brief — ${idea.title}`,
      sourcePath: `foreman://project-ideas/${humanId}`,
      // An idea with nothing on its canvas still gets the document, with one line saying where it
      // came from: an empty brief is more honest than a missing one, which reads as a failure.
      sections:
        sections.length > 0
          ? sections
          : [{ heading: 'Origin', bodyMd: `Converted from ${humanId} before its canvas was started.` }],
    });
  } catch (error) {
    logger.error(
      { idea: humanId, project: code, err: error instanceof Error ? error.message : String(error) },
      'the idea brief was not written; the idea still holds its canvas',
    );
    return null;
  }
}
