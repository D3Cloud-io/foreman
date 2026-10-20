import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import {
  lintEars,
  parseChecklist,
  parseFrontmatter,
  parseMoscow,
  parsePhaseHeading,
  parsePhaseMeta,
  parseSections,
  parseTables,
  rewriteCitations,
  type Substitution,
} from '@foreman/shared';
import type { Db } from '../db.js';
import { settleInserted } from '../domain/groups.js';
import type { ImportStatus } from '../generated/prisma/enums.js';
import { classify, documentKindFor, type FileKind } from './classify.js';
import {
  taskFrom,
  writeAdr,
  writeDocument,
  writeFinding,
  writePhase,
  writeRisk,
  writeTask,
  writeTerm,
  type WriteContext,
} from './write.js';

/**
 * The importer (T-8.3 … T-8.8).
 *
 * **The importer never silently drops a file.** Every source file appears in the reconciliation
 * report as mapped, partial or unmapped, with a reason, and the report's totals equal the input
 * count exactly — asserted by a test, because silence is the failure mode (FRM-REQ-148). This is
 * never-regress test #2, and the reason this phase exists on its own: R-03 names it the likeliest
 * abandonment point, so its product is a *visible report* rather than a database full of rows
 * somebody has to go and check.
 *
 * It is also **idempotent** (FRM-REQ-150) and has a **dry run that writes nothing**
 * (FRM-REQ-149). Both are properties of the design rather than flags on top of it: every write
 * below is an upsert on a natural key, and a dry run simply never opens a transaction.
 */

export interface ImportOptions {
  /** The vault root. Every path in the report is relative to it. */
  readonly path: string;
  /** Nothing is written. The report is produced exactly as it would be otherwise. */
  readonly dryRun: boolean;
  /** Import only these project folders. Absent means every folder that looks like a project. */
  readonly only?: readonly string[] | undefined;
}

export interface FileOutcome {
  readonly path: string;
  readonly status: ImportStatus;
  readonly kind: FileKind;
  /** Why it is partial or unmapped. Required for anything that is not `mapped`. */
  readonly note: string | null;
  readonly bytes: number;
  /** What it produced — `3 requirements`, `1 ADR`. Empty for unmapped. */
  readonly produced: string[];
}

export interface ImportReport {
  readonly root: string;
  readonly dryRun: boolean;
  readonly files: readonly FileOutcome[];
  readonly totals: {
    readonly seen: number;
    readonly mapped: number;
    readonly partial: number;
    readonly unmapped: number;
  };
  readonly projects: { code: string; folder: string; files: number; derived: boolean }[];
  /** Every citation rewritten, for review before anybody trusts the prose (T-8.5). */
  readonly substitutions: readonly (Substitution & { file: string })[];
  readonly entities: Record<string, number>;
  /**
   * A project whose files all "mapped" and whose shape is still wrong.
   *
   * The reconciliation report accounts for files, and d3cloud.io's scope of work was a file the
   * importer read without complaint — into 199 tasks, no phases and no requirements. Every row of
   * the report said `mapped`. A project with that shape is almost never what its author wrote, so
   * the report says so by name before anybody writes it.
   */
  readonly warnings: readonly { code: string; folder: string; message: string }[];
}

/** Folders that are not projects. `Templates` is not a project; nor is the audit index. */
const NOT_PROJECTS = new Set(['templates', 'master notes', '.obsidian', '.git']);

/**
 * The codes the ecosystem already uses.
 *
 * **These are not derivable and must not be guessed.** A project code is embedded in every human
 * ID in that project and is immutable once assigned (ADR-008) — so a cutover that imports Bindery
 * as `BIND` rather than `BND` is a cutover that cannot be corrected afterwards. Deriving from the
 * folder name gave `BIND`, `DA` and `CLEA`; the vault, the CLAUDE.md files and every existing
 * citation say `BND`, `AUTH` and `CW`.
 */
const KNOWN_CODES: Record<string, string> = {
  bindery: 'BND',
  burrow: 'BURR',
  'd3 auth': 'AUTH',
  clearwhen: 'CW',
  foreman: 'FRM',
  'someday vault': 'SV',
  'sarah byrne licsw': 'SBL',
  'personal website': 'PW',
  'design system': 'DS',
  murmur: 'MUR',
  'd3 chat': 'CHAT',
  subtitler: 'SUB',
  kardashev: 'KDV',
  blockslam: 'BS',
  sceptrefall: 'SCF',
  'battlefront remake': 'GF',
  'bambu print notifier': 'BPN',
  atlas: 'ATL',
  'd3cloud.io': 'DI',
};

/**
 * Folders that hold projects rather than being one. `Personal Projects/Subtitler` is the project
 * Subtitler; importing `Personal Projects` would have made one project called that, coded `PP`.
 */
const CONTAINERS = new Set(['personal projects']);

/** More than this many tasks with no phase and no requirement is a scope of work misread. */
const SHAPELESS_TASKS = 50;

/**
 * A project code from a folder name, deterministic so a re-run produces the same one.
 *
 * The known map wins. The derivation below exists for a folder nobody has assigned a code to yet,
 * and the reconciliation report names every code it derived so a wrong one is visible *before* the
 * write rather than after.
 */
export function codeFor(folder: string): string {
  const known = KNOWN_CODES[folder.toLowerCase()];
  if (known !== undefined) return known;

  const words = folder
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (words.length === 1) {
    return (words[0] ?? '').slice(0, 4).toUpperCase();
  }
  // Initials, for a multi-word name: "Sarah Byrne LICSW" → "SBL".
  const initials = words.map((w) => w[0] ?? '').join('').toUpperCase();
  return initials.slice(0, 8);
}

/** Whether a path is there, without making a missing one an error. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function markdownIn(dir: string, root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir)) {
    if (entry.startsWith('.')) continue;
    const path = join(dir, entry);
    const info = await stat(path);
    if (info.isDirectory()) found.push(...(await markdownIn(path, root)));
    else if (entry.endsWith('.md')) found.push(relative(root, path));
  }
  return found;
}

export async function runImport(db: Db, options: ImportOptions): Promise<ImportReport> {
  const root = options.path;
  const dirs = async (at: string) =>
    (await readdir(join(root, at), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => (at === '' ? e.name : join(at, e.name)));

  const candidates: string[] = [];
  for (const dir of await dirs('')) {
    if (NOT_PROJECTS.has(dir.toLowerCase())) continue;
    if (CONTAINERS.has(dir.toLowerCase())) candidates.push(...(await dirs(dir)));
    else candidates.push(dir);
  }
  // `--only Subtitler` and `--only "Personal Projects/Subtitler"` both name the same project.
  const folders = candidates.filter(
    (dir) => options.only === undefined || options.only.includes(dir) || options.only.includes(basename(dir)),
  );

  const files: FileOutcome[] = [];
  const substitutions: (Substitution & { file: string })[] = [];
  const entities: Record<string, number> = {};
  const projects: { code: string; folder: string; files: number; derived: boolean }[] = [];
  const warnings: { code: string; folder: string; message: string }[] = [];

  const count = (kind: string, n = 1) => {
    entities[kind] = (entities[kind] ?? 0) + n;
  };

  for (const dir of folders) {
    const folder = basename(dir);
    const code = codeFor(folder);
    const paths = await markdownIn(join(root, dir), root);

    /**
     * The project's overview, which does not live in the project's folder.
     *
     * `Master Notes/` is excluded from the project scan — correctly, it is not a project — and the
     * overviews sit inside it, one per project. So every project's prose description of *what it
     * is* was invisible to the importer, including Personal Website's, whose folder holds nothing
     * else at all. The comment below has said "Personal Website has an overview" since this was
     * written; the importer simply never saw it.
     */
    const overview = join('Master Notes', 'Overviews', `${folder} Overview.md`);
    if (await exists(join(root, overview))) paths.push(overview);
    projects.push({
      code,
      folder,
      files: paths.length,
      // A derived code is a guess at something immutable, so the report says which are guesses.
      derived: KNOWN_CODES[folder.toLowerCase()] === undefined,
    });

    // A project folder with zero files is legal — Personal Website has an overview and nothing
    // else. It still gets a project row, because the folder existing is the statement.
    // What this project alone produced, for the shape check after its files are read.
    const before = { ...entities };
    const produced = (kind: string) => (entities[kind] ?? 0) - (before[kind] ?? 0);

    /**
     * Whether the project has a register. A discovery document's MoSCoW table becomes the
     * project's requirements only when there is no register to say otherwise — the register has
     * authored IDs, and two sources numbering the same requirements would collide on them.
     */
    const hasRegister = paths.some(
      (path) => classify(path, {}).kind === 'requirements-register',
    );

    const existed =
      options.dryRun || (await db.project.findUnique({ where: { code }, select: { id: true } })) !== null;
    const project = options.dryRun
      ? null
      : await db.project.upsert({
          where: { code },
          create: { code, name: folder, slug: folder.toLowerCase().replace(/[^a-z0-9]+/g, '-') },
          update: { name: folder },
        });
    // A project the import created joins the end of the ungrouped, keeping positions 0..n-1
    // (FRM-REQ-226); one it updated keeps its place.
    if (project !== null && !existed) {
      await settleInserted(db, { actor: 'importer', actorKind: 'importer' }, project.id, `${code} imported`);
    }

    for (const path of paths) {
      const raw = await readFile(join(root, path), 'utf8');
      const { data, body } = parseFrontmatter(raw);
      const { kind, because } = classify(path, data);
      const bytes = Buffer.byteLength(raw, 'utf8');

      // The offset makes every logged line number match the file rather than the stripped body.
      const frontmatterLines = raw.split('\n').length - body.split('\n').length;
      const rewritten = rewriteCitations(body, code, { lineOffset: frontmatterLines });
      for (const substitution of rewritten.substitutions) {
        substitutions.push({ ...substitution, file: path });
      }

      const outcome = await mapFile(db, {
        path,
        kind,
        because,
        body: rewritten.text,
        data,
        bytes,
        code,
        projectId: project?.id ?? null,
        dryRun: options.dryRun,
        hasRegister,
        count,
      });
      files.push(outcome);
    }

    if (produced('phase') === 0 && produced('requirement') === 0 && produced('task') > SHAPELESS_TASKS) {
      warnings.push({
        code,
        folder,
        message:
          `${String(produced('task'))} tasks, but 0 phases and 0 requirements — the scope of work ` +
          'was almost certainly misread; check it before writing',
      });
    }

    /**
     * Bring the project's ID counters up to what was just written.
     *
     * `allocate` takes the next number from `project.id_counters`, deliberately — not from
     * `count(*)`, so a deleted `BND-REQ-007` never hands its number to something else. The importer
     * writes human IDs straight from the source files and never touches that counter, so after a
     * cutover every counter still read zero while the rows numbered into the hundreds: the next
     * finding created through the API asked for `BND-CR-001` and hit a unique-constraint violation.
     *
     * Every audit skill writes findings. All four would have failed on every imported project.
     */
    if (!options.dryRun && project !== null) {
      await db.$executeRaw`
        with seen as (
          -- nullif on both casts: a sequence part that is empty, and a counter stored as an empty
          -- string rather than absent, both fail the cast with a message naming no row at all.
          select split_part(human_id, '-', 2) as type,
                 max(nullif(regexp_replace(split_part(human_id, '-', 3), '[^0-9].*$', ''), '')::int) as high
          from (
            select human_id from requirement where project_id = ${project.id}::uuid
            union all select human_id from task       where project_id = ${project.id}::uuid
            union all select human_id from adr        where project_id = ${project.id}::uuid
            union all select human_id from finding    where project_id = ${project.id}::uuid
            union all select human_id from risk       where project_id = ${project.id}::uuid
            union all select human_id from decision   where project_id = ${project.id}::uuid
            union all select human_id from audit      where project_id = ${project.id}::uuid
            union all select human_id from phase      where project_id = ${project.id}::uuid
          ) ids
          where human_id ~ '^[A-Z0-9]+-[A-Z]+-[0-9]'
          group by 1
          having max(nullif(regexp_replace(split_part(human_id, '-', 3), '[^0-9].*$', ''), '')::int) is not null
        )
        update project p
        set id_counters = coalesce(p.id_counters, '{}'::jsonb) || (
          select coalesce(jsonb_object_agg(type, greatest(high, coalesce(nullif(p.id_counters ->> type, '')::int, 0))), '{}'::jsonb)
          from seen
        )
        where p.id = ${project.id}::uuid
      `;
    }

    /**
     * A phase whose tasks are all done is complete, and saying so is what makes a brief useful.
     *
     * Everything imports as `planned`, because the vault records phase progress only as the state
     * of the tasks underneath. Left that way, Bindery — finished through Phase 20 — briefed as
     * *Phase 0, Foundation*: the brief falls back to a phase that is not complete, and every one
     * of them qualified.
     */
    if (!options.dryRun && project !== null) {
      const phases = await db.phase.findMany({
        where: { projectId: project.id, deletedAt: null },
        select: { id: true, tasks: { where: { deletedAt: null }, select: { status: true } } },
      });
      for (const phase of phases) {
        if (phase.tasks.length === 0) continue;
        const done = phase.tasks.every((t) => t.status === 'done');
        await db.phase.update({
          where: { id: phase.id },
          data: { status: done ? 'complete' : 'planned' },
        });
      }
    }
  }

  const totals = {
    seen: files.length,
    mapped: files.filter((f) => f.status === 'mapped').length,
    partial: files.filter((f) => f.status === 'partial').length,
    unmapped: files.filter((f) => f.status === 'unmapped').length,
  };

  return { root, dryRun: options.dryRun, files, totals, projects, substitutions, entities, warnings };
}

interface MapContext {
  readonly path: string;
  readonly kind: FileKind;
  readonly because: string;
  readonly body: string;
  readonly data: Record<string, unknown>;
  readonly bytes: number;
  readonly code: string;
  readonly projectId: string | null;
  readonly dryRun: boolean;
  readonly hasRegister: boolean;
  readonly count: (kind: string, n?: number) => void;
}

async function mapFile(db: Db, ctx: MapContext): Promise<FileOutcome> {
  const produced: string[] = [];

  const outcome = (status: ImportStatus, note: string | null): FileOutcome => ({
    path: ctx.path,
    status,
    kind: ctx.kind,
    note,
    bytes: ctx.bytes,
    produced,
  });

  switch (ctx.kind) {
    case 'requirements-register': {
      const rows = parseTables(ctx.body)
        .filter((t) => t.headers.includes('ID') || t.headers.includes('Req'))
        .flatMap((t) => t.rows)
        .filter((row) => /^[A-Z]*-?REQ-\d+$|^REQ-\d+$/i.test(row['ID'] ?? ''));

      if (rows.length === 0) {
        return outcome('partial', 'recognised as a register, but no requirement rows parsed');
      }

      if (!ctx.dryRun && ctx.projectId !== null) {
        for (const [index, row] of rows.entries()) {
          await upsertRequirement(db, ctx.projectId, ctx.code, row, index + 1);
        }
      }
      ctx.count('requirement', rows.length);
      produced.push(`${String(rows.length)} requirements`);
      return outcome('mapped', null);
    }

    case 'scope-of-work': {
      const all = parseChecklist(ctx.body);
      if (all.length === 0) {
        return outcome('partial', 'recognised as a scope of work, but it has no checklist items');
      }

      /**
       * What is a task, and what is not.
       *
       * A group line (`- [ ] **Repo setup**` with children) names the work under it and is not
       * work itself. A deliverable is what the phase's tasks produce — it becomes the phase's exit
       * demo, not a second task for the same work. Sceptrefall's `**Deliverables & Tasks**` is one
       * list and stays tasks, because nothing in it says which half a line belongs to.
       */
      const isDeliverable = (subsection: string | null) =>
        subsection !== null && /^deliverables?\b/i.test(subsection) && !/\btasks?\b/i.test(subsection);
      /**
       * Only where the phase has a task list of its own. Someday Vault's Phases 3–5 have a
       * Deliverables list and no Tasks list, and the open work — the Stripe keys nobody has
       * created yet — is in it. Turning that into an exit demo would leave a phase with no tasks
       * and its outstanding work nowhere a brief could see it.
       */
      const hasTasks = new Set(
        all.filter((i) => !i.isGroup && !isDeliverable(i.subsection)).map((i) => i.section),
      );
      const asDemo = (i: (typeof all)[number]) => isDeliverable(i.subsection) && hasTasks.has(i.section);
      const items = all.filter((i) => !i.isGroup && !asDemo(i));
      const deliverables = all.filter((i) => !i.isGroup && asDemo(i));
      const groups = all.filter((i) => i.isGroup).length;

      // Phases are read whether or not anything is written, so a dry run reports them too. It
      // counted them only inside the write, and a dry run of every project said `phase: 0`.
      const meta = parsePhaseMeta(ctx.body);
      const phaseSections = [...new Set(all.map((i) => i.section))].flatMap((section) => {
        const parsed = section === null ? null : parsePhaseHeading(section);
        return section === null || parsed === null ? [] : [{ section, ...parsed }];
      });

      const authored = items.map((i) => taskFrom(i, ctx.code, '0', 0)).filter((t) => !t.synthesized);
      const explicitIds = new Set(authored.map((t) => t.humanId));
      const withIds = authored.length;
      ctx.count('task', items.length);
      ctx.count('task-synthesized', items.length - withIds);
      ctx.count('phase', phaseSections.length);

      if (!ctx.dryRun && ctx.projectId !== null) {
        const write: WriteContext = { db, projectId: ctx.projectId, code: ctx.code };

        // Phases first: a task's ID carries its phase number, so the phase has to exist and be
        // known before any task under it can be named.
        const phases = new Map<string, { id: string; number: string }>();
        for (const [order, { section, number, name }] of phaseSections.entries()) {
          const its = deliverables.filter((d) => d.section === section);
          const id = await writePhase(write, {
            number,
            name,
            sortOrder: order,
            objective: meta.get(section)?.objective ?? null,
            size: meta.get(section)?.size ?? null,
            exitDemo: its.length === 0 ? null : its.map((d) => `- [${d.marker}] ${d.text}`).join('\n'),
          });
          phases.set(section, { id, number });
        }

        const positions = new Map<string, number>();
        for (const item of items) {
          const phase = item.section === null ? undefined : phases.get(item.section);
          const number = phase?.number ?? '0';
          let position = (positions.get(number) ?? 0) + 1;
          let task = taskFrom(item, ctx.code, number, position);
          /**
           * A synthesized ID never takes one an author wrote. A phase mixing `**T-0.1**` lines
           * with bare ones synthesized `T-0.1` for the first bare line, and the upsert on
           * `human_id` then wrote the authored task's title over it.
           */
          while (task.synthesized && explicitIds.has(task.humanId)) {
            position += 1;
            task = taskFrom(item, ctx.code, number, position);
          }
          positions.set(number, position);
          await writeTask(write, { ...task, phaseId: phase?.id ?? null });
        }
      }

      produced.push(
        `${String(items.length)} tasks${items.length - withIds > 0 ? ` (${String(items.length - withIds)} with synthesized IDs)` : ''}`,
      );
      if (phaseSections.length > 0) produced.push(`${String(phaseSections.length)} phases`);
      if (deliverables.length > 0) {
        produced.push(`${String(deliverables.length)} deliverables, as phase exit demos`);
      }
      if (groups > 0) produced.push(`${String(groups)} group headings, folded into their tasks`);

      if (phaseSections.length === 0 && items.length > SHAPELESS_TASKS) {
        return outcome(
          'partial',
          `${String(items.length)} tasks and not one phase heading (\`## Phase N — Name\`) — ` +
            'every task would land in no phase',
        );
      }
      return outcome(
        'mapped',
        withIds === 0
          ? 'no task IDs in the file — every task ID was synthesized and flagged'
          : null,
      );
    }

    case 'adr': {
      const number = /^adr-(\d+)/i.exec(basename(ctx.path))?.[1];
      if (number === undefined) {
        return outcome('partial', 'an ADR whose filename carries no number');
      }
      if (!ctx.dryRun && ctx.projectId !== null) {
        await writeAdr(
          { db, projectId: ctx.projectId, code: ctx.code },
          ctx.path,
          ctx.data,
          parseSections(ctx.body),
        );
      }
      ctx.count('adr');
      produced.push('1 ADR');
      return outcome('mapped', null);
    }

    case 'finding': {
      const id = ctx.data['finding_id'];
      if (typeof id !== 'string') {
        return outcome('partial', 'a finding with no finding_id in its frontmatter');
      }
      if (!ctx.dryRun && ctx.projectId !== null) {
        await writeFinding(
          { db, projectId: ctx.projectId, code: ctx.code },
          ctx.data,
          basename(ctx.path).replace(/\.md$/i, '').replace(/^[A-Z]+-\d+\s*[—–-]\s*/, ''),
          parseSections(ctx.body),
        );
      }
      ctx.count('finding');
      produced.push('1 finding');
      return outcome('mapped', null);
    }

    case 'risk-register': {
      const rows = parseTables(ctx.body).flatMap((t) => t.rows);
      let written = 0;
      if (!ctx.dryRun && ctx.projectId !== null) {
        const write: WriteContext = { db, projectId: ctx.projectId, code: ctx.code };
        for (const [index, row] of rows.entries()) {
          if (await writeRisk(write, row, index + 1)) written += 1;
        }
      }
      ctx.count('risk', rows.length);
      produced.push(`${String(rows.length)} risks`);
      return outcome(
        rows.length === 0 ? 'partial' : 'mapped',
        rows.length === 0
          ? 'no risk rows parsed'
          : written === 0 && !ctx.dryRun
            ? 'rows parsed, but none had a title column this importer recognises'
            : null,
      );
    }

    case 'glossary': {
      const rows = parseTables(ctx.body).flatMap((t) => t.rows);
      let written = 0;
      if (!ctx.dryRun && ctx.projectId !== null) {
        const write: WriteContext = { db, projectId: ctx.projectId, code: ctx.code };
        for (const row of rows) if (await writeTerm(write, row)) written += 1;
      }
      ctx.count('term', rows.length);
      produced.push(`${String(rows.length)} terms`);
      return outcome(
        rows.length === 0 ? 'partial' : 'mapped',
        rows.length === 0
          ? 'no term rows parsed'
          : written === 0 && !ctx.dryRun
            ? 'rows parsed, but none had a term and a definition column'
            : null,
      );
    }

    case 'phase-plan':
    case 'document':
    case 'audit-summary':
    case 'project-overview': {
      const sections = parseSections(ctx.body);
      if (sections.length === 0) {
        // Nothing to split, but there may still be prose. A file with neither headings nor body
        // is the only thing that is genuinely unreadable.
        if (ctx.body.trim().length === 0) {
          return outcome('unmapped', 'the file is empty: no frontmatter, no headings, no prose');
        }
        ctx.count('document');
        return outcome('partial', 'no headings to split into sections — imported as one body');
      }
      if (!ctx.dryRun && ctx.projectId !== null) {
        await writeDocument(
          { db, projectId: ctx.projectId, code: ctx.code },
          basename(ctx.path).replace(/\.md$/i, ''),
          documentKindFor(basename(ctx.path)) ?? 'research',
          ctx.path,
          sections,
        );
      }
      ctx.count('document');
      ctx.count('document_section', sections.length);
      produced.push(`1 document, ${String(sections.length)} sections`);

      /**
       * The discovery document is also where a project without a register keeps its requirements:
       * a MoSCoW feature scope, the tier on every row. It stays a document — the notes beside each
       * feature are prose worth keeping — and its rows become requirements too, numbered in the
       * order they were written, because nothing else in the project numbers them.
       */
      if (documentKindFor(basename(ctx.path)) === 'discovery' && !ctx.hasRegister) {
        const moscow = parseMoscow(ctx.body);
        if (moscow.length > 0) {
          if (!ctx.dryRun && ctx.projectId !== null) {
            for (const [index, item] of moscow.entries()) {
              await upsertRequirement(db, ctx.projectId, ctx.code, {
                ID: `REQ-${String(index + 1).padStart(3, '0')}`,
                Req: item.statement,
                Pri: item.priority,
                // Provenance, since the ID is ours: where it came from, and the author's label.
                Src: item.label === null ? 'MoSCoW' : `MoSCoW ${item.label}`,
              }, index + 1);
            }
          }
          ctx.count('requirement', moscow.length);
          produced.push(`${String(moscow.length)} requirements, from the MoSCoW scope (IDs assigned in order)`);
        }
      }
      return outcome('mapped', documentKindFor(basename(ctx.path)) === null ? 'stored as a research document: no typed kind matches this filename' : null);
    }

    case 'unknown':
      // The category that makes the contract true: recognised as *something*, accounted for, and
      // never quietly absent.
      return outcome('unmapped', ctx.because);
  }
}

async function upsertRequirement(
  db: Db,
  projectId: string,
  code: string,
  row: Record<string, string>,
  seq: number,
): Promise<void> {
  const raw = row['ID'] ?? '';
  const humanId = raw.startsWith(`${code}-`) ? raw : `${code}-${raw}`;
  const statement = row['Req'] ?? row['Requirement'] ?? '';
  const priority = (row['Pri'] ?? 'M').trim().toUpperCase();

  // Lint here, on the same terms as a requirement written through the API. The importer used to
  // skip it, so all 210 of the real corpus landed on the column defaults — `unparsed`, not ok,
  // and no note — and the EARS engine that P3 tuned against 591 real requirements produced
  // nothing at all for the only corpus that matters. The lint warns and never blocks
  // (FRM-REQ-072), so a statement it cannot read is still imported, now with the reason.
  const ears = lintEars(statement);

  await db.requirement.upsert({
    where: { humanId },
    // Idempotent by natural key: running twice updates rather than duplicating (FRM-REQ-150).
    create: {
      projectId,
      humanId,
      seq,
      statement,
      earsPattern: ears.pattern,
      earsLintOk: ears.ok,
      earsLintNote: ears.note ?? null,
      priority: (['M', 'S', 'C', 'W'].includes(priority) ? priority : 'M') as 'M',
      ...(row['Src'] === undefined ? {} : { source: row['Src'] }),
      ...(row['Acceptance'] === undefined ? {} : { acceptanceTest: row['Acceptance'] }),
    },
    // The statement can change between runs, and the lint is a function of it — leaving the old
    // verdict beside a new statement is the one state that is worse than not linting at all.
    update: {
      statement,
      earsPattern: ears.pattern,
      earsLintOk: ears.ok,
      earsLintNote: ears.note ?? null,
      ...(row['Acceptance'] === undefined ? {} : { acceptanceTest: row['Acceptance'] }),
    },
  });
}
