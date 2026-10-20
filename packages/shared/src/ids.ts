import { z } from 'zod';

/**
 * Human IDs — `<CODE>-<TYPE>-<SEQ>` (ADR-008).
 *
 * `BND-REQ-021` resolves with no context; `REQ-021` does not. Every entity that gets cited carries
 * one, it is project-prefixed, globally unique, and **immutable once assigned** — renumbering
 * breaks every citation in every document body.
 */

/** The type segment of a human ID, per entity kind. */
export const HUMAN_ID_TYPE = {
  requirement: 'REQ',
  task: 'T',
  phase: 'P',
  adr: 'ADR',
  decision: 'D',
  risk: 'R',
  finding_code_review: 'CR',
  finding_design: 'DA',
  finding_feature: 'FR',
  finding_api: 'API',
  idea: 'IDEA',
  audit: 'AUD',
  term: 'TERM',
  // A screen of a project's UI (FRM-REQ-189): `BND-SCR-001`, from the project's counter.
  screen: 'SCR',
} as const;

export type HumanIdType = (typeof HUMAN_ID_TYPE)[keyof typeof HUMAN_ID_TYPE];

/**
 * A project code: 2–8 upper-case letters and digits, starting with a letter. `BND`, `AUTH`, `FRM`.
 * Unique, and unchangeable after creation (FRM-REQ-031) because every ID embeds it.
 */
export const ProjectCode = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,7}$/, 'a project code is 2–8 upper-case letters or digits, letter first')
  // `PI` is the project-idea prefix. A project holding that code would give `PI-REQ-001` and
  // `PI-001` two different meanings one character apart, which is a confusion nobody would
  // untangle later. Refused at the only moment it can be — a code is immutable (ADR-008).
  .refine((code) => code !== PROJECT_IDEA_PREFIX, {
    message: '`PI` is reserved: it prefixes project ideas, which belong to no project',
  })
  // `GL` likewise: it prefixes guidelines, the ecosystem's standing decisions (FRM-REQ-186).
  .refine((code) => code !== GUIDELINE_PREFIX, {
    message: '`GL` is reserved: it prefixes guidelines, which belong to no project',
  })
  // `GRP` likewise: it prefixes groups, the families projects belong to (FRM-ADR-024).
  .refine((code) => code !== GROUP_PREFIX, {
    message: '`GRP` is reserved: it prefixes groups, which belong to no project',
  });
export type ProjectCode = z.infer<typeof ProjectCode>;

/**
 * A **project idea** — something that might become a project — is the one record here that no
 * project owns, so it is the one whose ID cannot be project-prefixed (ADR-008, ADR-015).
 *
 * `PI-007`: two segments where every project-scoped ID has three, so the two can never be
 * confused by a parser or by a reader. `parseHumanId` rejects it deliberately; anything handling
 * both reaches for `parseAnyId`.
 */
export const PROJECT_IDEA_PREFIX = 'PI';

export const PROJECT_IDEA_ID_RE = /^PI-(\d+)$/;

export const ProjectIdeaId = z
  .string()
  .regex(PROJECT_IDEA_ID_RE, 'expected PI-<SEQ>, e.g. PI-007');
export type ProjectIdeaId = z.infer<typeof ProjectIdeaId>;

export function parseProjectIdeaId(value: string): number | null {
  const m = PROJECT_IDEA_ID_RE.exec(value.trim());
  return m?.[1] === undefined ? null : Number(m[1]);
}

export function formatProjectIdeaId(seq: number): string {
  return `${PROJECT_IDEA_PREFIX}-${String(seq).padStart(3, '0')}`;
}

/**
 * A **guideline** — a standing decision that applies to every project (FRM-REQ-186) — is the
 * second record no project owns, so it takes the same codeless shape: `GL-004`.
 */
export const GUIDELINE_PREFIX = 'GL';

export const GUIDELINE_ID_RE = /^GL-(\d+)$/;

export const GuidelineId = z.string().regex(GUIDELINE_ID_RE, 'expected GL-<SEQ>, e.g. GL-004');
export type GuidelineId = z.infer<typeof GuidelineId>;

export function formatGuidelineId(seq: number): string {
  return `${GUIDELINE_PREFIX}-${String(seq).padStart(3, '0')}`;
}

/**
 * A **group** — a family of projects, D3 Cloud or Dormice (FRM-ADR-024, FRM-REQ-221) — is the
 * third record no project owns, so it takes the same codeless shape: `GRP-001`.
 */
export const GROUP_PREFIX = 'GRP';

export const GROUP_ID_RE = /^GRP-(\d+)$/;

export const GroupId = z.string().regex(GROUP_ID_RE, 'expected GRP-<SEQ>, e.g. GRP-001');
export type GroupId = z.infer<typeof GroupId>;

export function formatGroupId(seq: number): string {
  return `${GROUP_PREFIX}-${String(seq).padStart(3, '0')}`;
}

/**
 * Either kind of ID, for the places that take whatever a person typed — `/api/entities/:id`,
 * search, and the MCP verbs that address an entity by name.
 *
 * Returns the *type* both kinds agree on, so a caller can switch on one value: a project idea
 * reports type `PI` with a null code, which is exactly what distinguishes it.
 */
export function parseAnyId(
  value: string,
): { code: string | null; type: string; seq: string } | null {
  const parsed = parseHumanId(value);
  if (parsed !== null) return { code: parsed.code, type: parsed.type, seq: parsed.seq };

  const m = PROJECT_IDEA_ID_RE.exec(value.trim());
  if (m?.[1] !== undefined) return { code: null, type: PROJECT_IDEA_PREFIX, seq: m[1] };

  const g = GUIDELINE_ID_RE.exec(value.trim());
  if (g?.[1] !== undefined) return { code: null, type: GUIDELINE_PREFIX, seq: g[1] };

  const grp = GROUP_ID_RE.exec(value.trim());
  return grp?.[1] === undefined ? null : { code: null, type: GROUP_PREFIX, seq: grp[1] };
}

/**
 * Any ID Foreman issues — project-prefixed, or a project idea's.
 *
 * The MCP verbs that address an entity by name take this rather than `HumanId`, because a project
 * idea is addressable and has no project code to prefix. Everything that genuinely requires a
 * project — `phase`, `satisfies`, a citation — keeps `HumanId` and still refuses `PI-007`.
 */
export const AnyId = z
  .string()
  .refine((value) => parseAnyId(value) !== null, 'expected <CODE>-<TYPE>-<SEQ>, PI-<SEQ>, GL-<SEQ> or GRP-<SEQ>');
export type AnyId = z.infer<typeof AnyId>;

/**
 * The sequence segment. Usually zero-padded to three (`001`), but task IDs carry their phase —
 * `BND-T-0.3`, and `FRM-T-8.5` — so a dotted sequence is legal.
 */
const SEQ = String.raw`\d+(?:\.\d+)?`;

export const HUMAN_ID_RE = new RegExp(`^([A-Z][A-Z0-9]{1,7})-([A-Z]{1,4})-(${SEQ})$`);

export const HumanId = z.string().regex(HUMAN_ID_RE, 'expected <CODE>-<TYPE>-<SEQ>, e.g. BND-REQ-021');
export type HumanId = z.infer<typeof HumanId>;

export interface ParsedHumanId {
  readonly code: string;
  readonly type: string;
  readonly seq: string;
  /** Numeric value of the sequence, for ordering. `0.3` sorts before `10`. */
  readonly seqValue: number;
}

/** Parse a human ID, or return `null`. Never throws: unparsed input is a normal condition here. */
export function parseHumanId(value: string): ParsedHumanId | null {
  const m = HUMAN_ID_RE.exec(value.trim());
  if (m === null) return null;
  const [, code, type, seq] = m;
  if (code === undefined || type === undefined || seq === undefined) return null;
  return { code, type, seq, seqValue: Number(seq) };
}

/** Format a human ID. Sequences are zero-padded to three digits unless they are dotted. */
export function formatHumanId(code: string, type: string, seq: number | string): string {
  const seqText =
    typeof seq === 'number'
      ? Number.isInteger(seq)
        ? String(seq).padStart(3, '0')
        : String(seq)
      : seq;
  return `${code}-${type}-${seqText}`;
}

/**
 * Find every human ID cited in a body of markdown, ignoring fenced code blocks and inline code.
 * This is what writes `reference` rows, and what makes backlinks possible.
 */
export function extractHumanIds(markdown: string): string[] {
  const withoutCode = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  const found = new Set<string>();
  const re = new RegExp(`\\b[A-Z][A-Z0-9]{1,7}-[A-Z]{1,4}-${SEQ}\\b`, 'g');
  for (const match of withoutCode.matchAll(re)) {
    if (parseHumanId(match[0]) !== null) found.add(match[0]);
  }
  return [...found];
}
