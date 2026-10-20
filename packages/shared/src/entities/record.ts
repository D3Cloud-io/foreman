import { z } from 'zod';
import { checkGuidelineScope, GuidelineScopeFields } from './groups.js';
import {
  AdrStatus,
  DocumentKind,
  GuidelineStatus,
  ProjectIdeaStatus,
  ProjectLifecycle,
  UserRole,
  RiskImpact,
  RiskLikelihood,
  IdeaStatus,
  RiskStatus,
} from '../enums.js';
import { AnyId, ProjectCode } from '../ids.js';
import { Instant, Timestamps, Uuid } from './common.js';

/**
 * The record: documents and their sections, ADRs, decisions, risks and glossary terms.
 *
 * Everything authored lives here. The spine (`spine.ts`) is what is being built; this is what was
 * decided and why — and the reason Foreman can replace a vault rather than merely index one.
 */

// ─── Section keys ──────────────────────────────────────────────────────────

/**
 * A section key: lower-case words joined by hyphens.
 *
 * **Load-bearing.** This is the fragment in `foreman://bindery/architecture#deployment`, so it must
 * be stable across edits, slug-safe and unique within its document. Renaming a heading must not
 * change the key, or every citation and every cached resource URI silently points at nothing —
 * which is why `SectionUpdate` below has no `key` field at all.
 */
export const SectionKey = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'a section key is lower-case words joined by hyphens');
export type SectionKey = z.infer<typeof SectionKey>;

/**
 * Derive a key from a heading. Used **once**, when a section is first created.
 *
 * Deliberately not re-run on rename: a key derived fresh from an edited heading would change, and a
 * changing key is the bug this whole type exists to prevent.
 */
export function sectionKeyFor(heading: string): string {
  const slug = heading
    .normalize('NFKD')
    // Strip accents, then anything that is not a word character or a space.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/[\s-]+/g, '-')
    .slice(0, 120)
    // A trailing hyphen is possible after the slice.
    .replace(/-+$/, '');
  // A heading of only punctuation or non-Latin script slugs to nothing; it still needs a key.
  return slug.length > 0 ? slug : 'section';
}

// ─── Document ──────────────────────────────────────────────────────────────

export const DocumentSection = z
  .object({
    id: Uuid,
    documentId: Uuid,
    key: SectionKey,
    heading: z.string().min(1).max(300),
    bodyMd: z.string().max(200_000),
    sortOrder: z.number().int(),
  })
  .extend(Timestamps.shape);
export type DocumentSection = z.infer<typeof DocumentSection>;

export const Document = z
  .object({
    id: Uuid,
    projectId: Uuid,
    phaseId: Uuid.nullable(),
    kind: DocumentKind,
    title: z.string().min(1).max(300),
    sourcePath: z.string().max(1000).nullable(),
  })
  .extend(Timestamps.shape);
export type Document = z.infer<typeof Document>;

export const DocumentCreate = z.object({
  kind: DocumentKind,
  title: z.string().min(1).max(300),
  phaseId: Uuid.nullish(),
  sourcePath: z.string().max(1000).optional(),
  /** Sections may be given at creation; a key is derived from each heading if none is supplied. */
  sections: z
    .array(
      z.object({
        key: SectionKey.optional(),
        heading: z.string().min(1).max(300),
        bodyMd: z.string().max(200_000).default(''),
      }),
    )
    .max(200)
    .optional(),
});
export type DocumentCreate = z.infer<typeof DocumentCreate>;

/** No `kind`: a document's kind decides its section shape, and changing it would orphan them. */
export const DocumentUpdate = DocumentCreate.omit({ kind: true, sections: true }).partial();
export type DocumentUpdate = z.infer<typeof DocumentUpdate>;

/**
 * One section's new content. **There is no `key`** — see `SectionKey`. A heading may be renamed;
 * the address it is reached by may not.
 */
export const SectionUpdate = z.object({
  heading: z.string().min(1).max(300).optional(),
  bodyMd: z.string().max(200_000),
  /** A note recorded on the revision — "why", when the diff only shows "what". */
  note: z.string().max(500).optional(),
});
export type SectionUpdate = z.infer<typeof SectionUpdate>;

export const SectionCreate = z.object({
  key: SectionKey.optional(),
  heading: z.string().min(1).max(300),
  bodyMd: z.string().max(200_000).default(''),
  /** Where to put it. Appended when absent. */
  after: SectionKey.optional(),
});
export type SectionCreate = z.infer<typeof SectionCreate>;

// ─── ADR ───────────────────────────────────────────────────────────────────

export const Adr = z
  .object({
    id: Uuid,
    projectId: Uuid,
    humanId: z.string(),
    number: z.number().int(),
    title: z.string().min(1).max(300),
    status: AdrStatus,
    decisionAbstract: z.string().max(2000).nullable(),
    contextMd: z.string().max(100_000).nullable(),
    decisionMd: z.string().max(100_000).nullable(),
    consequencesMd: z.string().max(100_000).nullable(),
    rejectedMd: z.string().max(100_000).nullable(),
    decidedOn: z.string().nullable(),
  })
  .extend(Timestamps.shape);
export type Adr = z.infer<typeof Adr>;

export const AdrCreate = z.object({
  title: z.string().min(1).max(300),
  status: AdrStatus.optional(),
  decisionAbstract: z.string().max(2000).optional(),
  contextMd: z.string().max(100_000).optional(),
  decisionMd: z.string().max(100_000).optional(),
  consequencesMd: z.string().max(100_000).optional(),
  /** What was considered and turned down. The half of an ADR that is usually lost. */
  rejectedMd: z.string().max(100_000).optional(),
  decidedOn: z.iso.date().optional(),
});
export type AdrCreate = z.infer<typeof AdrCreate>;

/** No `number`: it is part of the human ID, and immutable (ADR-008). */
export const AdrUpdate = AdrCreate.partial();
export type AdrUpdate = z.infer<typeof AdrUpdate>;

// ─── Decision ──────────────────────────────────────────────────────────────

/** A locked discovery decision — `D-13`. Smaller than an ADR: a question, its answer, and why. */
export const DecisionCreate = z.object({
  statement: z.string().min(1).max(1000),
  value: z.string().min(1).max(2000),
  rationale: z.string().max(4000).optional(),
  /** When it stopped being up for debate. Null means it is still open. */
  lockedAt: Instant.optional(),
});
export type DecisionCreate = z.infer<typeof DecisionCreate>;

export const DecisionUpdate = DecisionCreate.partial();
export type DecisionUpdate = z.infer<typeof DecisionUpdate>;

// ─── Risk ──────────────────────────────────────────────────────────────────

export const RiskCreate = z.object({
  title: z.string().min(1).max(300),
  likelihood: RiskLikelihood.optional(),
  impact: RiskImpact.optional(),
  mitigation: z.string().max(4000).optional(),
  /**
   * The named condition that forces a re-plan.
   *
   * Required on creation, unlike the column, which is nullable for the importer's sake: a risk with
   * no tripwire is a worry, and a worry is something you re-read and feel bad about rather than
   * something that ever fires.
   */
  tripwire: z.string().min(1).max(1000),
  phaseId: Uuid.nullish(),
});
export type RiskCreate = z.infer<typeof RiskCreate>;

export const RiskUpdate = RiskCreate.partial().extend({
  status: RiskStatus.optional(),
});
export type RiskUpdate = z.infer<typeof RiskUpdate>;

// ─── Ideas ─────────────────────────────────────────────────────────────────

/**
 * A thing somebody might build, before it is a plan.
 *
 * **Deliberately thin.** Foreman's anti-features name "no freeform wiki or note-taking" as the
 * guardrail that stops it decaying back into the vault, and an ideas list is exactly where that
 * decay begins. One title, one short body, one status, one reason — no sections, no revisions, no
 * nesting. An idea that needs a document is a project.
 *
 * `body` is capped at 2000 rather than the 4000 a document section gets, for the same reason: the
 * existing idea documents phrase each as one line of *what it buys*, and a field with room for an
 * essay gets one.
 */
export const IdeaCreate = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(2000).optional(),
});
export type IdeaCreate = z.infer<typeof IdeaCreate>;

export const IdeaUpdate = IdeaCreate.partial().extend({
  status: IdeaStatus.optional(),
  /**
   * Why it was parked or rejected. Required for both, checked against the merged state so a patch
   * that sets only the status is refused rather than silently leaving the old reason — the same
   * rule, and the same failure, as a task moving to `blocked`.
   */
  reason: z.string().max(1000).nullish(),
});
export type IdeaUpdate = z.infer<typeof IdeaUpdate>;

// ─── Project idea ──────────────────────────────────────────────────────────

/**
 * A **project idea** — something that might become a project (FRM-ADR-015).
 *
 * `pitch` earns more room than an idea's `body` because it has somewhere to go: converting copies
 * it into the project's `pitch`, so this is the one field in the ideas feature where writing a
 * paragraph is the point rather than a warning sign.
 */
/**
 * The canvas: the named sections a project idea grows into (FRM-ADR-017).
 *
 * **Named and prompted, not a blank page.** Foreman's anti-features include "no freeform wiki or
 * note-taking" — the guardrail that stops it decaying back into the vault it replaced. A blank
 * page per idea would be exactly that, one idea at a time. A handful of sections that each ask a
 * specific question is the opposite: the structure is what makes an idea comparable to the next
 * one, and what lets converting it hand the project a brief rather than a dump.
 *
 * Declared here, once, because four things read it and must agree: the console renders the
 * sections in this order with these prompts, the API validates the keys, the MCP shim offers them
 * as `section`, and converting writes them as the new project's discovery document.
 */
export const IDEA_SECTIONS = [
  {
    key: 'problem',
    heading: 'The problem',
    prompt: 'What is broken, and for whom? What do they do about it today?',
  },
  {
    key: 'audience',
    heading: 'Who it is for',
    prompt: 'The one person this is for first. Not "everyone".',
  },
  {
    key: 'approach',
    heading: 'How it might work',
    prompt: 'The rough shape — a sketch, a flow, a Mermaid diagram. Not a plan.',
  },
  {
    key: 'whyNow',
    heading: 'Why now',
    prompt: 'What changed that makes this worth doing now, rather than never?',
  },
  {
    key: 'risks',
    heading: 'What would kill it',
    prompt: 'The reasons it might not work, written before you are attached to it.',
  },
  {
    key: 'notes',
    heading: 'Scratchpad',
    prompt: 'Anything that does not fit above. Half-thoughts, fragments, things to look up.',
  },
] as const;

export type IdeaSectionKey = (typeof IDEA_SECTIONS)[number]['key'];
export const IdeaSectionKey = z.enum(
  IDEA_SECTIONS.map((s) => s.key) as [IdeaSectionKey, ...IdeaSectionKey[]],
);

/**
 * The canvas's lists, writable as plain text over MCP: one item per line.
 *
 * Lines rather than JSON because a model writes a list of open questions as a list, and a tool
 * schema that demanded `[{ id, text, done }]` for each would cost its definition in every turn to
 * save a parse that is ten lines long. `parseIdeaList` is the one parser; the shim and anything
 * else that takes lines as text call it.
 */
export const IDEA_LIST_KEYS = ['tags', 'questions', 'nextSteps', 'links', 'related'] as const;
export type IdeaListKey = (typeof IDEA_LIST_KEYS)[number];

/** Any canvas field `foreman_update` can write by name: a section, or a list. */
export const IdeaFieldKey = z.enum([
  ...IdeaSectionKey.options,
  ...IDEA_LIST_KEYS,
]);
export type IdeaFieldKey = z.infer<typeof IdeaFieldKey>;

/** A short, stable id for a list item. Not shown anywhere; it only has to be unique in its list. */
export function listItemId(index: number, text: string): string {
  let hash = 0;
  for (const ch of `${String(index)}:${text}`) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash.toString(36).padStart(7, '0').slice(0, 8);
}

/**
 * Lines of text into one of the canvas's lists.
 *
 * Forgiving about the ways a list is written by hand — bullets, numbers, Markdown checkboxes,
 * commas for tags, `[label](url)` or `label | url` or a bare URL for links — because the input is
 * a person's or a model's list, and refusing `- ` in front of a question is refusing the most
 * common way to write one. A `[x]` marks a checklist item done.
 */
export function parseIdeaList(key: IdeaListKey, text: string) {
  const lines = text
    .split(key === 'tags' || key === 'related' ? /[\n,]/ : /\n/)
    .map((line) => line.trim().replace(/^(?:[-*+•]|\d+[.)])\s+/, '').trim())
    .filter((line) => line.length > 0);

  switch (key) {
    case 'tags':
      return lines.map((t) => t.toLowerCase().replace(/\s+/g, '-'));
    case 'related':
      return lines.map((r) => r.toUpperCase());
    case 'links':
      return lines.map((line, i) => {
        const md = /^\[([^\]]+)\]\((\S+)\)$/.exec(line);
        const piped = /^(.+?)\s*\|\s*(\S+)$/.exec(line);
        const [label, url] = md !== null ? [md[1], md[2]] : piped !== null ? [piped[1], piped[2]] : [line, line];
        return { id: listItemId(i, line), label: label ?? line, url: url ?? line };
      });
    default: {
      return lines.map((line, i) => {
        const box = /^\[([ xX])\]\s*(.*)$/.exec(line);
        const text = box === null ? line : (box[2] ?? '');
        return { id: listItemId(i, text), text, done: box !== null && box[1] !== ' ' };
      });
    }
  }
}

/**
 * The sections that say an idea has been *thought through*, as opposed to written down.
 *
 * The pitch and the five questions. The scratchpad is deliberately not one: a full scratchpad is
 * evidence of activity, not of an idea being understood, and counting it would let the maturity
 * figure be gamed by pasting.
 */
export const MATURITY_FIELDS = ['pitch', 'problem', 'audience', 'approach', 'whyNow', 'risks'] as const;

/** A canvas section's body. Room for a diagram and some prose; not room for a spec. */
const Section = z.string().max(20_000);

/** One line of a checklist — an open question, or a next step. */
export const IdeaChecklistItem = z.object({
  /** Client-generated so an edit can name the item it changes without a round trip. */
  id: z.string().min(1).max(40),
  text: z.string().min(1).max(500),
  done: z.boolean().default(false),
});
export type IdeaChecklistItem = z.infer<typeof IdeaChecklistItem>;

export const IdeaLink = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(200),
  url: z.url().max(2000),
});
export type IdeaLink = z.infer<typeof IdeaLink>;

/**
 * A tag: lower-case words joined by hyphens.
 *
 * Normalised on the way in rather than validated strictly, because the failure worth preventing
 * is `Hardware`, `hardware` and `hardware ` being three tags that each hold a third of the ideas.
 */
const Tag = z
  .string()
  .trim()
  .toLowerCase()
  .transform((t) => t.replace(/\s+/g, '-'))
  .pipe(z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9-]*$/, 'letters, digits and hyphens'));

export const ProjectIdeaCreate = z.object({
  title: z.string().min(1).max(300),
  pitch: z.string().max(4000).optional(),
  problem: Section.optional(),
  audience: Section.optional(),
  approach: Section.optional(),
  whyNow: Section.optional(),
  risks: Section.optional(),
  notes: Section.optional(),
  /**
   * How much you *want* to do this, 1–5 — separate from how good it is. The two disagree more
   * often than anybody admits, and an idea list sorted only by merit is a list of things you will
   * never start.
   */
  excitement: z.number().int().min(1).max(5).nullish(),
  tags: z.array(Tag).max(12).optional(),
  questions: z.array(IdeaChecklistItem).max(50).optional(),
  nextSteps: z.array(IdeaChecklistItem).max(50).optional(),
  links: z.array(IdeaLink).max(30).optional(),
  /**
   * Other ideas or projects this one builds on, competes with, or would replace.
   *
   * A project code on its own is allowed as well as a human ID, because "this would replace BND"
   * names a project, not any one thing inside it — and relating an idea to an existing project is
   * the most common reason to relate it at all.
   */
  related: z.array(z.union([AnyId, ProjectCode])).max(20).optional(),
});
export type ProjectIdeaCreate = z.infer<typeof ProjectIdeaCreate>;

/**
 * No `converted` here, and that is the whole reason this is not `ProjectIdeaStatus.optional()`.
 *
 * `converted` means a project exists. Letting a PATCH set it would produce an idea claiming to
 * have become something, with nothing to point at — a lie the screen would then render as a
 * dead link. It is reachable by converting, and by nothing else.
 */
export const ProjectIdeaUpdate = ProjectIdeaCreate.partial().extend({
  status: ProjectIdeaStatus.exclude(['converted']).optional(),
  reason: z.string().max(1000).nullish(),
});
export type ProjectIdeaUpdate = z.infer<typeof ProjectIdeaUpdate>;

/**
 * Converting an idea into a project.
 *
 * The code is asked for **here** rather than when the idea is written down, which is the point of
 * separating the two: a code is immutable and embedded in every ID the project will ever have
 * (ADR-008), so demanding one for "maybe someday" is asking a permanent question at the moment
 * there is least information to answer it. By the time somebody converts, they know.
 */
/**
 * Deciding to fund a submission (FRM-ADR-016).
 *
 * The amount is in **minor units** — cents, pence — because money in a float loses a penny
 * eventually and money in a decimal has to be serialised by something that agrees with you about
 * decimals. An integer of cents is the one representation with no opinion in it.
 */
export const ProjectIdeaFund = z.object({
  amountCents: z.number().int().nonnegative().max(1_000_000_00),
  /** Why this, and why this much. Required — a funding decision with no rationale is a rumour. */
  reason: z.string().min(1).max(2000),
});
export type ProjectIdeaFund = z.infer<typeof ProjectIdeaFund>;

/**
 * One reviewer's read on one submission.
 *
 * Impact and effort, not a single number: a fund board's real question is what it gets for what
 * it costs, and one score collapses the two into an average nobody can argue with.
 */
export const IdeaScoreInput = z.object({
  impact: z.number().int().min(1).max(5),
  effort: z.number().int().min(1).max(5),
  note: z.string().max(1000).optional(),
});
export type IdeaScoreInput = z.infer<typeof IdeaScoreInput>;

/** Rewording a thought you wrote. Only ever your own — nobody edits somebody else's words. */
export const IdeaCommentUpdate = z.object({
  body: z.string().min(1).max(4000),
});
export type IdeaCommentUpdate = z.infer<typeof IdeaCommentUpdate>;

export const IdeaCommentCreate = z.object({
  body: z.string().min(1).max(4000),
  /**
   * Visible to reviewers only. This is the field that makes discussion usable for a board rather
   * than performative: without somewhere to deliberate, the board deliberates somewhere else and
   * what lands here is a press release.
   */
  internal: z.boolean().default(false),
});
export type IdeaCommentCreate = z.infer<typeof IdeaCommentCreate>;

export const ProjectIdeaConvert = z.object({
  code: ProjectCode,
  /** Defaults to the idea's title, which is usually already the name. */
  name: z.string().min(1).max(200).optional(),
  lifecycle: ProjectLifecycle.optional(),
});
export type ProjectIdeaConvert = z.infer<typeof ProjectIdeaConvert>;

// ─── Members ───────────────────────────────────────────────────────────────

export const InviteCreate = z.object({
  email: z.email().max(320),
  displayName: z.string().min(1).max(200),
  role: UserRole,
});
export type InviteCreate = z.infer<typeof InviteCreate>;

export const InviteAccept = z.object({
  token: z.string().min(20).max(200),
  /**
   * Long rather than clever. A length floor is the only password rule that survives contact with
   * people, and the alternative — one of each character class — reliably produces `Password1!`.
   */
  password: z.string().min(12).max(200),
});
export type InviteAccept = z.infer<typeof InviteAccept>;

export const MemberUpdate = z.object({
  role: UserRole.optional(),
  suspended: z.boolean().optional(),
});
export type MemberUpdate = z.infer<typeof MemberUpdate>;

// ─── Glossary ──────────────────────────────────────────────────────────────

export const TermCreate = z.object({
  term: z.string().min(1).max(120),
  definition: z.string().min(1).max(4000),
  aliases: z.array(z.string().min(1).max(120)).max(20).optional(),
  /**
   * Absent means the term belongs to the whole ecosystem and appears in every project's glossary
   * (FRM-REQ-071). "Tripwire" and "human ID" mean the same thing in every project here.
   */
  ecosystem: z.boolean().optional(),
});
export type TermCreate = z.infer<typeof TermCreate>;

export const TermUpdate = TermCreate.partial();
export type TermUpdate = z.infer<typeof TermUpdate>;

// ── Guidelines (FRM-REQ-186) ─────────────────────────────────────────────────

/**
 * A standing decision for every project: what was decided, why, and how to apply it.
 *
 * Four named fields rather than one body, for the same reason a project idea has a canvas
 * (FRM-ADR-017): the structure is what keeps this from becoming the freeform wiki Foreman rules
 * out. `decision` is the line a brief carries, so it is short by construction — the reasoning and
 * the detail live in the fields a session reads only when it needs them.
 */
const GuidelineFields = z.object({
  title: z.string().trim().min(1).max(200),
  /** A grouping on the page — "Design", "Security", "Process". Free text, so no migration adds one. */
  area: z.string().trim().min(1).max(40),
  decision: z.string().trim().min(1).max(400),
  rationale: z.string().max(20_000).optional(),
  guidance: z.string().max(20_000).optional(),
});

/**
 * `appliesTo` and `groups` say where it applies (FRM-REQ-235, FRM-ADR-024): `'all'`, the default,
 * or `'groups'` with the `GRP-` IDs of at least one live group.
 */
export const GuidelineCreate = GuidelineFields.extend(GuidelineScopeFields).superRefine(
  checkGuidelineScope,
);
export type GuidelineCreate = z.infer<typeof GuidelineCreate>;

export const GuidelineUpdate = GuidelineFields.partial()
  .extend({ status: GuidelineStatus.optional(), ...GuidelineScopeFields })
  .superRefine(checkGuidelineScope);
export type GuidelineUpdate = z.infer<typeof GuidelineUpdate>;

/** What a brief and the portfolio carry: enough to act on, and short enough to always include. */
export interface GuidelineSummary {
  readonly humanId: string;
  readonly title: string;
  readonly decision: string;
}
