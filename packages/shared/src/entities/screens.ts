import { z } from 'zod';
import {
  ScreenComponentKind,
  ScreenProposalStatus,
  ScreenTheme,
  ScreenVerdictKind,
  ScreenVersionKind,
  ScreenViewport,
} from '../enums.js';
import { HumanId, parseHumanId } from '../ids.js';
import { Sha256 } from './blobs.js';
import { Instant, Uuid } from './common.js';

/**
 * Screens (FRM-REQ-189 … FRM-REQ-199).
 *
 * A screen is one page or state of a project's UI, with a project-prefixed ID (`BND-SCR-001`).
 * What it should look like arrives as **proposals** — PNGs exported from Figma frames, with the
 * file key, node ID and file version they came from (FRM-ADR-023: there is no canvas and no HTML
 * source). What it does look like arrives as **captures** — screenshots taken at a commit. Both
 * are versions of the screen at one viewport and theme, and both point at the blob store by SHA.
 */

/** The project whose requirements a component gap must cite (FRM-REQ-199): the design system. */
export const DESIGN_SYSTEM_PROJECT = 'DS';

/** `BND-SCR-001`. A human ID whose type segment is `SCR`. */
export const ScreenId = HumanId.refine((value) => parseHumanId(value)?.type === 'SCR', {
  message: 'expected a screen ID, e.g. BND-SCR-001',
});
export type ScreenId = z.infer<typeof ScreenId>;

/**
 * A Figma file key — the segment after `/design/` in a file's URL. Letters and digits; bounded
 * generously, because the format is Figma's and not ours to pin down further.
 */
export const FigmaFileKey = z.string().regex(/^[A-Za-z0-9]{1,128}$/, 'not a Figma file key');

/** A frame's node ID, as the API (`12:34`) or a URL (`12-34`) spells it, instance paths included. */
export const FigmaNodeId = z.string().regex(/^[A-Za-z0-9:;-]{1,200}$/, 'not a Figma node ID');

/** The file version a frame was exported at, as Figma reports it. */
export const FigmaFileVersion = z.string().min(1).max(64);

/** The full commit a capture was taken at. Forty hex characters, stored lowercase. */
export const CaptureCommitSha = z
  .string()
  .regex(/^[0-9a-fA-F]{40}$/, 'a full 40-character commit SHA')
  .transform((value) => value.toLowerCase());

/** An `@d3cloud/ui` component name: PascalCase, as it is exported. */
export const UiComponentName = z
  .string()
  .regex(/^[A-Z][A-Za-z0-9]{0,79}$/, 'an @d3cloud/ui component name, e.g. DataGrid');

// ─── Writes ────────────────────────────────────────────────────────────────

export const ScreenCreate = z.object({
  name: z.string().min(1).max(200),
  route: z.string().min(1).max(500).optional(),
  figmaFileKey: FigmaFileKey.optional(),
  figmaNodeId: FigmaNodeId.optional(),
});
export type ScreenCreate = z.infer<typeof ScreenCreate>;

/** Null clears a field; a screen's name cannot be cleared. */
export const ScreenUpdate = z.object({
  name: z.string().min(1).max(200).optional(),
  route: z.string().min(1).max(500).nullish(),
  figmaFileKey: FigmaFileKey.nullish(),
  figmaNodeId: FigmaNodeId.nullish(),
});
export type ScreenUpdate = z.infer<typeof ScreenUpdate>;

/** A proposal and its provenance, all required: a proposal with no source is a picture (FRM-REQ-192). */
export const ScreenProposalCreate = z.object({
  blobSha256: Sha256,
  viewport: ScreenViewport,
  theme: ScreenTheme,
  figmaFileKey: FigmaFileKey,
  figmaNodeId: FigmaNodeId,
  figmaFileVersion: FigmaFileVersion,
});
export type ScreenProposalCreate = z.infer<typeof ScreenProposalCreate>;

/** A capture and where it was taken (FRM-REQ-194). */
export const ScreenCaptureCreate = z.object({
  blobSha256: Sha256,
  viewport: ScreenViewport,
  theme: ScreenTheme,
  commitSha: CaptureCommitSha,
});
export type ScreenCaptureCreate = z.infer<typeof ScreenCaptureCreate>;

/**
 * A verdict on a capture (FRM-REQ-195). A drift must say what drifted — accepted or to be fixed,
 * the next reader needs to know which difference was judged, the same rule as a blocked task.
 */
export const ScreenVerdictCreate = z
  .object({
    verdict: ScreenVerdictKind,
    note: z.string().min(1).max(2000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.verdict !== 'matches' && (value.note === undefined || value.note.trim() === '')) {
      ctx.addIssue({
        code: 'custom',
        path: ['note'],
        message: `a ${value.verdict} verdict must say what drifted`,
      });
    }
  });
export type ScreenVerdictCreate = z.infer<typeof ScreenVerdictCreate>;

/**
 * A component the screen uses, or a gap it needs filled. A gap cites the DS requirement that would
 * fill it (FRM-REQ-199); a use cites nothing. Whether the requirement is the DS project's is
 * checked by the server, which can see it.
 */
export const ScreenComponentCreate = z
  .object({
    name: UiComponentName,
    kind: ScreenComponentKind,
    requirement: HumanId.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'gap' && value.requirement === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['requirement'],
        message: 'a gap cites the DS requirement that would fill it, e.g. DS-REQ-012',
      });
    }
    if (value.kind === 'uses' && value.requirement !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['requirement'],
        message: 'a component in use cites no requirement — only a gap does',
      });
    }
  });
export type ScreenComponentCreate = z.infer<typeof ScreenComponentCreate>;

// ─── Reads ─────────────────────────────────────────────────────────────────

export const ScreenVerdict = z.object({
  id: Uuid,
  versionId: Uuid,
  verdict: ScreenVerdictKind,
  reviewer: z.string(),
  note: z.string().nullable(),
  createdAt: Instant,
});
export type ScreenVerdict = z.infer<typeof ScreenVerdict>;

export const ScreenVersion = z.object({
  id: Uuid,
  kind: ScreenVersionKind,
  blobSha256: Sha256,
  /** Where to read the image: `/api/blobs/<sha256>`. */
  url: z.string(),
  viewport: ScreenViewport,
  theme: ScreenTheme,
  /** Proposals only; null on a capture. */
  status: ScreenProposalStatus.nullable(),
  figmaFileKey: z.string().nullable(),
  figmaNodeId: z.string().nullable(),
  figmaFileVersion: z.string().nullable(),
  /** Captures only. */
  commitSha: z.string().nullable(),
  createdBy: z.string(),
  createdAt: Instant,
  /** Newest first. Always empty on a proposal: only a capture is judged. */
  verdicts: z.array(ScreenVerdict),
});
export type ScreenVersion = z.infer<typeof ScreenVersion>;

export const ScreenComponent = z.object({
  id: Uuid,
  name: z.string(),
  kind: ScreenComponentKind,
  /** The DS requirement a gap cites; null on a use. */
  requirement: z.object({ humanId: HumanId, statement: z.string() }).nullable(),
  createdAt: Instant,
});
export type ScreenComponent = z.infer<typeof ScreenComponent>;

/** What a screen links to through `foreman_link`: the requirements and tasks it serves. */
export const ScreenLink = z.object({
  type: z.string(),
  humanId: z.string(),
  title: z.string(),
  kind: z.string(),
});
export type ScreenLink = z.infer<typeof ScreenLink>;

export const Screen = z.object({
  id: Uuid,
  humanId: ScreenId,
  name: z.string(),
  route: z.string().nullable(),
  figmaFileKey: z.string().nullable(),
  figmaNodeId: z.string().nullable(),
  createdAt: Instant,
  updatedAt: Instant,
  /**
   * What stands now: the current proposal and the latest capture for each (viewport, theme) that
   * has one, desktop before mobile and dark before light.
   */
  current: z.object({
    proposals: z.array(ScreenVersion),
    captures: z.array(ScreenVersion),
  }),
  components: z.array(ScreenComponent),
});
export type Screen = z.infer<typeof Screen>;

/** One screen in full: every version, superseded proposals included (FRM-REQ-193), and its links. */
export const ScreenDetail = Screen.extend({
  /** Newest first. */
  proposals: z.array(ScreenVersion),
  /** Newest first, each with its verdicts. */
  captures: z.array(ScreenVersion),
  links: z.array(ScreenLink),
});
export type ScreenDetail = z.infer<typeof ScreenDetail>;

/**
 * The images `foreman_get` attaches to a screen (FRM-REQ-198): the current proposal and the latest
 * capture, base64 in JSON so the stdio shim and the remote `/mcp` read them through the same client.
 */
export const ScreenImages = z.object({
  images: z.array(
    z.object({
      kind: ScreenVersionKind,
      versionId: Uuid,
      viewport: ScreenViewport,
      theme: ScreenTheme,
      sha256: Sha256,
      mimeType: z.string(),
      /** The bytes, base64. */
      data: z.string(),
    }),
  ),
});
export type ScreenImages = z.infer<typeof ScreenImages>;
