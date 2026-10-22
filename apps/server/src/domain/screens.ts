import {
  DESIGN_SYSTEM_PROJECT,
  parseHumanId,
  type Screen,
  type ScreenCaptureCreate,
  type ScreenComponent,
  type ScreenComponentCreate,
  type ScreenCreate,
  type ScreenDetail,
  type ScreenImages,
  type ScreenLink,
  type ScreenProposalCreate,
  type ScreenTheme,
  type ScreenUpdate,
  type ScreenVerdict,
  type ScreenVerdictCreate,
  type ScreenVersion,
  type ScreenViewport,
} from '@foreman/shared';
import type { Db, Prisma } from '../db.js';
import { eventIds, record, type Actor, type TransactionClient } from './audit.js';
import { openBlob } from './blobs.js';
import { Conflict, Invalid, NotFound } from './errors.js';
import { allocate } from './humanId.js';
import { findProject } from './projects.js';

/**
 * Screens (FRM-REQ-189 … FRM-REQ-199).
 *
 * A screen is one page or state of a project's UI. What it should look like arrives as
 * **proposals** exported from Figma frames (FRM-ADR-023), each with the file key, node ID and file
 * version it came from; what it does look like arrives as **captures**, each taken at a commit.
 * Both are rows of `screen_version` at one (viewport, theme), pointing at the blob store by SHA.
 *
 * Versions are append-only. A new proposal does not overwrite the last one, it supersedes it, and
 * the superseded one stays readable (FRM-REQ-193) — a verdict recorded against an older design has
 * to be checkable against the design it was recorded against.
 */

/** The image types a version may point at. JSON is a legal blob, but not a picture of a screen. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * The order variants are shown and chosen in: desktop before mobile, dark before light. The
 * console is dark-first, so the dark desktop frame is the one a reader recognises.
 */
const VARIANTS: readonly { viewport: ScreenViewport; theme: ScreenTheme }[] = [
  { viewport: 'desktop', theme: 'dark' },
  { viewport: 'desktop', theme: 'light' },
  { viewport: 'mobile', theme: 'dark' },
  { viewport: 'mobile', theme: 'light' },
];

/** What `foreman_get` attaches at most: one proposal and one capture (FRM-REQ-198). */
const MAX_IMAGES = 2;

const VERSION_INCLUDE = {
  verdicts: { orderBy: { createdAt: 'desc' } },
} satisfies Prisma.ScreenVersionInclude;

const SCREEN_INCLUDE = {
  versions: { orderBy: { createdAt: 'desc' }, include: VERSION_INCLUDE },
  components: {
    orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    include: { requirement: { select: { humanId: true, statement: true } } },
  },
} satisfies Prisma.ScreenInclude;

interface VerdictRow {
  id: string;
  versionId: string;
  verdict: ScreenVerdict['verdict'];
  reviewer: string;
  note: string | null;
  createdAt: Date;
}

interface VersionRow {
  id: string;
  kind: ScreenVersion['kind'];
  blobSha256: string;
  viewport: ScreenViewport;
  theme: ScreenTheme;
  status: ScreenVersion['status'];
  figmaFileKey: string | null;
  figmaNodeId: string | null;
  figmaFileVersion: string | null;
  commitSha: string | null;
  createdBy: string;
  createdAt: Date;
  verdicts?: VerdictRow[];
}

interface ComponentRow {
  id: string;
  name: string;
  kind: ScreenComponent['kind'];
  createdAt: Date;
  requirement: { humanId: string; statement: string } | null;
}

interface ScreenRow {
  id: string;
  projectId: string;
  humanId: string;
  name: string;
  route: string | null;
  figmaFileKey: string | null;
  figmaNodeId: string | null;
  createdAt: Date;
  updatedAt: Date;
  versions: VersionRow[];
  components: ComponentRow[];
}

function verdictOf(row: VerdictRow): ScreenVerdict {
  return {
    id: row.id,
    versionId: row.versionId,
    verdict: row.verdict,
    reviewer: row.reviewer,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

function versionOf(row: VersionRow): ScreenVersion {
  return {
    id: row.id,
    kind: row.kind,
    blobSha256: row.blobSha256,
    url: `/api/blobs/${row.blobSha256}`,
    viewport: row.viewport,
    theme: row.theme,
    status: row.status,
    figmaFileKey: row.figmaFileKey,
    figmaNodeId: row.figmaNodeId,
    figmaFileVersion: row.figmaFileVersion,
    commitSha: row.commitSha,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    verdicts: (row.verdicts ?? []).map(verdictOf),
  };
}

function componentOf(row: ComponentRow): ScreenComponent {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    requirement: row.requirement,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * What stands now: per variant, the current proposal and the newest capture. `versions` arrives
 * newest first, so the first capture seen for a variant is its latest.
 */
function currentOf(versions: readonly VersionRow[]): { proposals: VersionRow[]; captures: VersionRow[] } {
  const proposals: VersionRow[] = [];
  const captures: VersionRow[] = [];
  for (const variant of VARIANTS) {
    const same = (v: VersionRow) => v.viewport === variant.viewport && v.theme === variant.theme;
    const proposal = versions.find((v) => v.kind === 'proposal' && v.status === 'current' && same(v));
    const capture = versions.find((v) => v.kind === 'capture' && same(v));
    if (proposal !== undefined) proposals.push(proposal);
    if (capture !== undefined) captures.push(capture);
  }
  return { proposals, captures };
}

function screenOf(row: ScreenRow): Screen {
  const current = currentOf(row.versions);
  return {
    id: row.id,
    humanId: row.humanId,
    name: row.name,
    route: row.route,
    figmaFileKey: row.figmaFileKey,
    figmaNodeId: row.figmaNodeId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    current: {
      proposals: current.proposals.map(versionOf),
      captures: current.captures.map(versionOf),
    },
    components: row.components.map(componentOf),
  };
}

/** The bare row, as the audit trail records it — what `POST /undo` compares and restores. */
function bare(row: {
  id: string;
  projectId: string;
  humanId: string;
  seq: number;
  name: string;
  route: string | null;
  figmaFileKey: string | null;
  figmaNodeId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}) {
  return {
    id: row.id,
    projectId: row.projectId,
    humanId: row.humanId,
    seq: row.seq,
    name: row.name,
    route: row.route,
    figmaFileKey: row.figmaFileKey,
    figmaNodeId: row.figmaNodeId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * The requirements and tasks a screen serves (FRM-REQ-189), from the `reference` rows
 * `foreman_link` writes — and the DS requirements its gaps cite, which are references too.
 */
async function linksOf(db: Db, screenId: string): Promise<ScreenLink[]> {
  // `foreman_link` keeps whichever direction it was given, so `FRM-T-5 relates FRM-SCR-001` lands
  // as task→screen. Both directions are the screen's links; the gate and drift read both too.
  const rows = await db.reference.findMany({
    where: {
      OR: [
        { fromType: 'screen', fromId: screenId, toType: { in: ['requirement', 'task'] } },
        { toType: 'screen', toId: screenId, fromType: { in: ['requirement', 'task'] }, kind: 'relates' },
      ],
    },
    orderBy: { createdAt: 'asc' },
  });
  const ends = rows.map((r) =>
    r.fromType === 'screen'
      ? { type: r.toType, id: r.toId, kind: r.kind }
      : { type: r.fromType, id: r.fromId, kind: r.kind },
  );
  const requirementIds = ends.filter((e) => e.type === 'requirement').map((e) => e.id);
  const taskIds = ends.filter((e) => e.type === 'task').map((e) => e.id);
  const [requirements, tasks] = await Promise.all([
    db.requirement.findMany({
      where: { id: { in: requirementIds }, deletedAt: null },
      select: { id: true, humanId: true, statement: true },
    }),
    db.task.findMany({
      where: { id: { in: taskIds }, deletedAt: null },
      select: { id: true, humanId: true, title: true },
    }),
  ]);
  const titles = new Map<string, { humanId: string; title: string }>([
    ...requirements.map((r) => [r.id, { humanId: r.humanId, title: r.statement.slice(0, 120) }] as const),
    ...tasks.map((t) => [t.id, { humanId: t.humanId, title: t.title }] as const),
  ]);
  const links: ScreenLink[] = [];
  const seen = new Set<string>();
  for (const end of ends) {
    const target = titles.get(end.id);
    // A deleted target is not something the screen still serves.
    if (target === undefined) continue;
    // The same pair linked once each way is one link to a reader.
    const key = `${end.type}:${end.id}:${end.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ type: end.type, humanId: target.humanId, title: target.title, kind: end.kind });
  }
  return links;
}

async function detailOf(db: Db, row: ScreenRow): Promise<ScreenDetail> {
  return {
    ...screenOf(row),
    proposals: row.versions.filter((v) => v.kind === 'proposal').map(versionOf),
    captures: row.versions.filter((v) => v.kind === 'capture').map(versionOf),
    links: await linksOf(db, row.id),
  };
}

/** A screen by human ID, in full — what `foreman_get` and `/api/entities/:id` return. */
export async function screenByHumanId(
  db: Db,
  humanId: string,
): Promise<{ id: string; entity: ScreenDetail & { projectId: string } } | null> {
  const row = await db.screen.findFirst({ where: { humanId, deletedAt: null }, include: SCREEN_INCLUDE });
  if (row === null) return null;
  // `projectId` rides along because `foreman_link` checks it, as it does on every entity.
  return { id: row.id, entity: { ...(await detailOf(db, row)), projectId: row.projectId } };
}

/** The screen, checked to belong to the project in the path: another project's ID is a 404. */
async function screenIn(db: Db, code: string, humanId: string) {
  const project = await findProject(db, code);
  const screen = await db.screen.findFirst({ where: { humanId, projectId: project.id, deletedAt: null } });
  if (screen === null) throw new NotFound(humanId);
  return { project, screen };
}

export async function listScreens(db: Db, code: string): Promise<Screen[]> {
  const project = await findProject(db, code);
  const rows = await db.screen.findMany({
    where: { projectId: project.id, deletedAt: null },
    orderBy: { seq: 'asc' },
    include: SCREEN_INCLUDE,
  });
  return rows.map(screenOf);
}

export async function getScreen(db: Db, code: string, humanId: string): Promise<ScreenDetail> {
  const { screen } = await screenIn(db, code, humanId);
  const row = await db.screen.findUniqueOrThrow({ where: { id: screen.id }, include: SCREEN_INCLUDE });
  return detailOf(db, row);
}

export async function createScreen(
  db: Db,
  actor: Actor,
  code: string,
  input: ScreenCreate,
): Promise<ScreenDetail & { auditEventIds: string[] }> {
  const project = await findProject(db, code);
  const created = await db.$transaction(async (tx) => {
    const { humanId, seq } = await allocate(tx, project, 'screen');
    const row = await tx.screen.create({
      data: {
        projectId: project.id,
        humanId,
        seq,
        name: input.name,
        route: input.route ?? null,
        figmaFileKey: input.figmaFileKey ?? null,
        figmaNodeId: input.figmaNodeId ?? null,
      },
    });
    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'screen',
      entityId: row.id,
      entityHumanId: humanId,
      after: bare(row),
    });
    return { row, event };
  });
  return { ...(await getScreen(db, code, created.row.humanId)), auditEventIds: [created.event] };
}

export async function updateScreen(
  db: Db,
  actor: Actor,
  code: string,
  humanId: string,
  input: ScreenUpdate,
): Promise<ScreenDetail & { auditEventIds: string[] }> {
  const { screen: before } = await screenIn(db, code, humanId);
  const event = await db.$transaction(async (tx) => {
    const after = await tx.screen.update({
      where: { id: before.id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.route === undefined ? {} : { route: input.route }),
        ...(input.figmaFileKey === undefined ? {} : { figmaFileKey: input.figmaFileKey }),
        ...(input.figmaNodeId === undefined ? {} : { figmaNodeId: input.figmaNodeId }),
      },
    });
    return record(tx, {
      ...actor,
      action: 'update',
      entityType: 'screen',
      entityId: before.id,
      entityHumanId: humanId,
      before: bare(before),
      after: bare(after),
    });
  });
  return { ...(await getScreen(db, code, humanId)), auditEventIds: [event] };
}

/**
 * The blob a version points at must exist and be an image. Checked before the write so the
 * refusal names the fix: upload it first, to `POST /api/blobs`.
 */
async function assertImage(db: Db, sha256: string): Promise<void> {
  const blob = await db.blob.findUnique({ where: { sha256 } });
  if (blob === null) {
    throw new Invalid(`no blob ${sha256}: upload the image to POST /api/blobs first`, [
      { path: 'blobSha256', message: 'not a stored blob' },
    ]);
  }
  if (!IMAGE_TYPES.has(blob.mediaType)) {
    throw new Invalid(`blob ${sha256} is ${blob.mediaType}, not an image`, [
      { path: 'blobSha256', message: 'a screen version is a PNG, JPEG or WebP' },
    ]);
  }
}

/** Hold the screen row for the rest of the transaction, so two writes to one line queue. */
async function lockScreen(tx: TransactionClient, screenId: string): Promise<void> {
  await tx.$queryRaw`select 1 from screen where id = ${screenId}::uuid for update`;
}

export interface Added<T> {
  readonly value: T;
  /** False when an identical one was already there, and nothing was written. */
  readonly created: boolean;
  /** The audit events the write made, its own first (FRM-REQ-243); empty when nothing was written. */
  readonly auditEventIds: string[];
}

/**
 * Add a proposal (FRM-REQ-192) and supersede the one it replaces (FRM-REQ-193).
 *
 * Only the current proposal for the **same viewport and theme** is superseded: a new mobile frame
 * says nothing about the desktop one. And the same image at the same Figma file version again is
 * not a new proposal — it answers with the current one and writes nothing, which is what lets the
 * Figma import run on every sync without growing a history of identical pictures.
 */
export async function addProposal(
  db: Db,
  actor: Actor,
  code: string,
  humanId: string,
  input: ScreenProposalCreate,
): Promise<Added<ScreenVersion>> {
  const { screen } = await screenIn(db, code, humanId);
  await assertImage(db, input.blobSha256);

  return db.$transaction(async (tx) => {
    // Locked first, so two proposals for one line cannot both find the same `current` and leave
    // two of them current.
    await lockScreen(tx, screen.id);
    const current = await tx.screenVersion.findFirst({
      where: {
        screenId: screen.id,
        kind: 'proposal',
        status: 'current',
        viewport: input.viewport,
        theme: input.theme,
      },
      include: VERSION_INCLUDE,
    });
    if (
      current !== null &&
      current.blobSha256 === input.blobSha256 &&
      current.figmaFileVersion === input.figmaFileVersion &&
      // Provenance is the point of a proposal (FRM-REQ-192): the same image at the same version
      // from a different frame or file is a different claim, and answering 200 would drop it.
      current.figmaFileKey === input.figmaFileKey &&
      current.figmaNodeId === input.figmaNodeId
    ) {
      return { value: versionOf(current), created: false, auditEventIds: [] };
    }

    let supersededEvent: string | null = null;
    if (current !== null) {
      const superseded = await tx.screenVersion.update({
        where: { id: current.id },
        data: { status: 'superseded' },
      });
      supersededEvent = await record(tx, {
        ...actor,
        action: 'update',
        entityType: 'screen_version',
        entityId: current.id,
        entityHumanId: humanId,
        before: versionOf(current),
        after: versionOf(superseded),
      });
    }

    const row = await tx.screenVersion.create({
      data: {
        screenId: screen.id,
        kind: 'proposal',
        blobSha256: input.blobSha256,
        viewport: input.viewport,
        theme: input.theme,
        status: 'current',
        figmaFileKey: input.figmaFileKey,
        figmaNodeId: input.figmaNodeId,
        figmaFileVersion: input.figmaFileVersion,
        createdBy: actor.actor,
      },
    });
    const value = versionOf(row);
    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'screen_version',
      entityId: row.id,
      entityHumanId: humanId,
      after: { ...value, supersedes: current?.id ?? null },
    });
    // The new proposal's event first, then the one that retired the old.
    return { value, created: true, auditEventIds: eventIds(event, supersededEvent) };
  });
}

/**
 * Add a capture (FRM-REQ-194): the screen as built, at one commit, viewport and theme. The same
 * image at the same commit and variant again is the same capture — a re-run CI job — and writes
 * nothing.
 */
export async function addCapture(
  db: Db,
  actor: Actor,
  code: string,
  humanId: string,
  input: ScreenCaptureCreate,
): Promise<Added<ScreenVersion>> {
  const { screen } = await screenIn(db, code, humanId);
  await assertImage(db, input.blobSha256);

  return db.$transaction(async (tx) => {
    await lockScreen(tx, screen.id);
    const same = await tx.screenVersion.findFirst({
      where: {
        screenId: screen.id,
        kind: 'capture',
        viewport: input.viewport,
        theme: input.theme,
        commitSha: input.commitSha,
        blobSha256: input.blobSha256,
      },
      include: VERSION_INCLUDE,
    });
    if (same !== null) return { value: versionOf(same), created: false, auditEventIds: [] };

    const row = await tx.screenVersion.create({
      data: {
        screenId: screen.id,
        kind: 'capture',
        blobSha256: input.blobSha256,
        viewport: input.viewport,
        theme: input.theme,
        commitSha: input.commitSha,
        createdBy: actor.actor,
      },
    });
    const value = versionOf(row);
    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'screen_version',
      entityId: row.id,
      entityHumanId: humanId,
      after: value,
    });
    return { value, created: true, auditEventIds: [event] };
  });
}

/**
 * Record a verdict on a capture (FRM-REQ-195). The reviewer is whoever is acting — a verdict is a
 * judgement somebody made, and the audit trail and the row name the same somebody.
 */
export async function addVerdict(
  db: Db,
  actor: Actor,
  code: string,
  humanId: string,
  versionId: string,
  input: ScreenVerdictCreate,
): Promise<ScreenVerdict & { auditEventIds: string[] }> {
  const { screen } = await screenIn(db, code, humanId);
  const version = await db.screenVersion.findFirst({ where: { id: versionId, screenId: screen.id } });
  if (version === null) throw new NotFound(`capture ${versionId} of ${humanId}`);
  if (version.kind !== 'capture') {
    throw new Invalid(`${versionId} is a proposal; a verdict judges a capture against it`, [
      { path: 'versionId', message: 'not a capture' },
    ]);
  }

  return db.$transaction(async (tx) => {
    const row = await tx.screenVerdict.create({
      data: {
        versionId,
        verdict: input.verdict,
        reviewer: actor.actor,
        note: input.note ?? null,
      },
    });
    const value = verdictOf(row);
    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'screen_verdict',
      entityId: row.id,
      entityHumanId: humanId,
      after: value,
    });
    return { ...value, auditEventIds: [event] };
  });
}

/**
 * Record a component the screen uses, or a gap it needs (FRM-REQ-199).
 *
 * A gap cites a **DS** requirement and nothing else: a gap is a hole in `@d3cloud/ui`, and the
 * design system is where the work to fill it is planned. The citation is also a `reference` row,
 * so the DS requirement's backlinks list every screen waiting on it.
 */
export async function addComponent(
  db: Db,
  actor: Actor,
  code: string,
  humanId: string,
  input: ScreenComponentCreate,
): Promise<Added<ScreenComponent>> {
  const { screen } = await screenIn(db, code, humanId);

  let requirement: { id: string; humanId: string; statement: string } | null = null;
  if (input.requirement !== undefined) {
    if (parseHumanId(input.requirement)?.code !== DESIGN_SYSTEM_PROJECT) {
      throw new Invalid(
        `a gap cites a ${DESIGN_SYSTEM_PROJECT} requirement — the design system is where it gets ` +
          `filled — and ${input.requirement} is not one`,
        [{ path: 'requirement', message: `expected ${DESIGN_SYSTEM_PROJECT}-REQ-<SEQ>` }],
      );
    }
    requirement = await db.requirement.findFirst({
      where: {
        humanId: input.requirement,
        deletedAt: null,
        project: { code: DESIGN_SYSTEM_PROJECT, deletedAt: null },
      },
      select: { id: true, humanId: true, statement: true },
    });
    if (requirement === null) {
      throw new Invalid(`${input.requirement} does not exist`, [
        { path: 'requirement', message: 'no such requirement' },
      ]);
    }
  }

  const include = { requirement: { select: { humanId: true, statement: true } } } as const;
  const existing = await db.screenComponent.findUnique({
    where: { screenId_name_kind: { screenId: screen.id, name: input.name, kind: input.kind } },
    include,
  });
  if (existing !== null) {
    if (existing.requirement?.humanId === requirement?.humanId) {
      return { value: componentOf(existing), created: false, auditEventIds: [] };
    }
    throw new Conflict(
      `${humanId} already records ${input.name} as a ${input.kind}` +
        (existing.requirement === null ? '' : `, citing ${existing.requirement.humanId}`),
    );
  }

  return db.$transaction(async (tx) => {
    const row = await tx.screenComponent.create({
      data: {
        screenId: screen.id,
        name: input.name,
        kind: input.kind,
        requirementId: requirement?.id ?? null,
      },
      include,
    });
    if (requirement !== null) {
      await tx.reference.upsert({
        where: {
          fromType_fromId_toType_toId_kind: {
            fromType: 'screen',
            fromId: screen.id,
            toType: 'requirement',
            toId: requirement.id,
            kind: 'cites',
          },
        },
        create: {
          fromType: 'screen',
          fromId: screen.id,
          toType: 'requirement',
          toId: requirement.id,
          kind: 'cites',
          citedAs: requirement.humanId,
        },
        update: {},
      });
    }
    const value = componentOf(row);
    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'screen_component',
      entityId: row.id,
      entityHumanId: humanId,
      after: value,
    });
    return { value, created: true, auditEventIds: [event] };
  });
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The images `foreman_get` attaches to a screen (FRM-REQ-198): its current proposal and its latest
 * capture, the dark desktop variant first, two at most. Base64 in JSON, so the stdio shim and the
 * remote `/mcp` read them through the same API client as everything else.
 *
 * A version whose file has gone missing from the blob store is left out rather than failing the
 * whole read: the entity is still worth returning without its picture.
 */
export async function screenImages(
  db: Db,
  blobDir: string,
  code: string,
  humanId: string,
): Promise<ScreenImages> {
  const { screen } = await screenIn(db, code, humanId);
  const versions = await db.screenVersion.findMany({
    where: { screenId: screen.id },
    orderBy: { createdAt: 'desc' },
  });
  const current = currentOf(versions);
  const chosen = [current.proposals[0], current.captures[0]]
    .filter((v): v is (typeof versions)[number] => v !== undefined)
    .slice(0, MAX_IMAGES);

  const images: ScreenImages['images'] = [];
  for (const version of chosen) {
    try {
      const blob = await openBlob(db, blobDir, version.blobSha256);
      const bytes = await readAll(blob.stream);
      images.push({
        kind: version.kind,
        versionId: version.id,
        viewport: version.viewport,
        theme: version.theme,
        sha256: version.blobSha256,
        mimeType: blob.mediaType,
        data: bytes.toString('base64'),
      });
    } catch (error) {
      if (!(error instanceof NotFound)) throw error;
    }
  }
  return { images };
}
