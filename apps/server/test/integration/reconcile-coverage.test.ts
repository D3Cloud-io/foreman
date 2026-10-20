import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db.js';
import { coverageFor } from '../../src/domain/coverage.js';
import { reconcileCoverage, type CoverageReconciliation } from '../../src/domain/reconcile-coverage.js';
import { undo } from '../../src/domain/undo.js';

/**
 * The cleanup of what the old `link()` wrote for kinds that did not own it (FRM-T-024).
 *
 * The code since FRM-T-11.3 cannot produce any of these shapes, so they are inserted the way the
 * old code left them: a `task_requirement` row beside a `relates` reference and a link event with
 * no `rows`, an `extends` relation beside a `relates` reference, and so on. Each case is one pair,
 * named for the rule it exercises, and the assertions are the whole classification — what goes,
 * what stays and why — before, during and after a write.
 */

const run = promisify(execFile);
const url = process.env['DATABASE_URL'];
const SCRIPT = fileURLToPath(new URL('../../src/cli/reconcile-coverage.ts', import.meta.url));
const CODE = 'RCOV';
/** A second project with a removable row, which a run scoped to RCOV must not touch. */
const OTHER = 'RCOX';

const ENV = {
  ...process.env,
  BASE_URL: 'http://localhost:3200',
  DATABASE_URL: url ?? '',
  KEK: Buffer.alloc(32, 1).toString('base64'),
  PEPPER: Buffer.alloc(32, 2).toString('base64'),
  COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
};

const cli = (args: string[]) =>
  run(process.execPath, ['--import', 'tsx', SCRIPT, '--project', CODE, ...args], { env: ENV });

const IMPORTED = new Date('2026-09-20T12:00:00Z');
const LINKED = new Date('2026-10-01T12:00:00Z');
const req = (code: string, n: number) => `${code}-REQ-${String(n).padStart(3, '0')}`;
const task = (code: string, n: number) => `${code}-T-${String(n).padStart(3, '0')}`;
const adr = (n: number) => `${CODE}-ADR-${String(n).padStart(3, '0')}`;

describe.skipIf(url === undefined)('reconcile-coverage', () => {
  let db: Db;
  const reqId = new Map<string, string>();
  const taskId = new Map<string, string>();
  const adrId = new Map<string, string>();

  const pairs = (section: CoverageReconciliation['taskRequirements']) => ({
    removed: section.removed.map((row) => `${row.from} ${row.to}`),
    kept: section.kept.map((row) => `${row.from} ${row.to}`),
  });

  const snapshot = async () => ({
    taskRequirements: await db.taskRequirement.count({ where: { task: { project: { code: { in: [CODE, OTHER] } } } } }),
    adrRelations: await db.adrRelation.count({ where: { adr: { project: { code: CODE } } } }),
    references: await db.reference.count({ where: { fromId: { in: [...taskId.values(), ...adrId.values()] } } }),
    events: await db.auditEvent.count({ where: { actor: 'reconcile-coverage' } }),
  });

  async function makeProject(code: string, requirements: number) {
    await db.project.deleteMany({ where: { code } });
    const project = await db.project.create({
      data: { code, name: `Reconcile ${code}`, slug: `reconcile-${code.toLowerCase()}`, lifecycle: 'building' },
    });
    for (let n = 1; n <= requirements; n += 1) {
      const row = await db.requirement.create({
        data: { projectId: project.id, humanId: req(code, n), seq: n, statement: `Requirement ${String(n)}`, priority: 'M' },
      });
      reqId.set(row.humanId, row.id);
    }
    return project.id;
  }

  /**
   * A task as one of its two origins writes it: through the API, with a creation event whose
   * snapshot carries the requirement rows it was made with, or by the importer, with no event.
   */
  async function makeTask(
    projectId: string,
    humanId: string,
    origin: { api: true; createdWith?: string[] } | { api: false },
  ) {
    const row = await db.task.create({ data: { projectId, humanId, title: humanId } });
    taskId.set(humanId, row.id);
    if (origin.api) {
      const createdWith = origin.createdWith ?? [];
      for (const r of createdWith) {
        await db.taskRequirement.create({ data: { taskId: row.id, requirementId: reqId.get(r) ?? '', createdAt: IMPORTED } });
      }
      await db.auditEvent.create({
        data: {
          actor: 'someone',
          actorKind: 'user',
          action: 'create',
          entityType: 'task',
          entityId: row.id,
          entityHumanId: humanId,
          after: {
            id: row.id,
            humanId,
            requirements: createdWith.map((r) => ({
              taskId: row.id,
              requirementId: reqId.get(r),
              createdAt: IMPORTED.toISOString(),
            })),
          },
          createdAt: IMPORTED,
        },
      });
    }
    return row.id;
  }

  /** What the old `link()` left: the reference, optionally the row, and an event with no `rows`. */
  async function legacyTaskLink(
    from: string,
    to: string,
    kind: 'relates' | 'violates' | 'satisfies',
    options: { row?: Date | false; event?: Date | false } = {},
  ) {
    const fromId = taskId.get(from) ?? '';
    const toId = reqId.get(to) ?? '';
    await db.reference.create({
      data: { fromType: 'task', fromId, toType: 'requirement', toId, kind, citedAs: to },
    });
    if (options.row !== false) {
      await db.taskRequirement.upsert({
        where: { taskId_requirementId: { taskId: fromId, requirementId: toId } },
        create: { taskId: fromId, requirementId: toId, createdAt: options.row ?? LINKED },
        update: {},
      });
    }
    if (options.event !== false) {
      await db.auditEvent.create({
        data: {
          actor: 'someone',
          actorKind: 'mcp',
          action: 'create',
          entityType: 'task',
          entityId: fromId,
          entityHumanId: from,
          after: { event: 'link', to, kind },
          createdAt: options.event ?? LINKED,
        },
      });
    }
  }

  async function adrRef(from: string, to: string, kind: 'relates' | 'violates' | 'extends') {
    await db.reference.create({
      data: { fromType: 'adr', fromId: adrId.get(from) ?? '', toType: 'adr', toId: adrId.get(to) ?? '', kind, citedAs: to },
    });
  }
  async function adrRelation(from: string, to: string) {
    await db.adrRelation.create({
      data: { adrId: adrId.get(from) ?? '', relatedAdrId: adrId.get(to) ?? '', kind: 'extends' },
    });
  }
  async function adrEvent(from: string, to: string, kind: string, shape: 'legacy' | 'current' | 'unlink' = 'legacy') {
    await db.auditEvent.create({
      data: {
        actor: 'someone',
        actorKind: 'mcp',
        action: shape === 'unlink' ? 'delete' : 'create',
        entityType: 'adr',
        entityId: adrId.get(from) ?? '',
        entityHumanId: from,
        after:
          shape === 'legacy'
            ? { event: 'link', to, kind }
            : shape === 'unlink'
              ? { event: 'unlink', to, kind }
              : {
                  event: 'link',
                  to,
                  kind,
                  changed: true,
                  rows: { reference: true, taskRequirement: false, taskDependency: false, adrRelation: true, supersededBy: false, status: false },
                },
        createdAt: LINKED,
      },
    });
  }

  beforeAll(async () => {
    db = createDb(url ?? '');
    await db.auditEvent.deleteMany({ where: { actor: 'reconcile-coverage' } });

    const projectId = await makeProject(CODE, 10);
    const otherId = await makeProject(OTHER, 1);

    // ── task_requirement ──
    // 1: an API task relates-linked by the old code. The row is the link's.
    await makeTask(projectId, task(CODE, 1), { api: true });
    await legacyTaskLink(task(CODE, 1), req(CODE, 1), 'relates');
    // 2: the same, for violates.
    await makeTask(projectId, task(CODE, 2), { api: true });
    await legacyTaskLink(task(CODE, 2), req(CODE, 2), 'violates');
    // 3: made with requirementIds, then relates-linked too: the creation wrote the row.
    await makeTask(projectId, task(CODE, 3), { api: true, createdWith: [req(CODE, 3)] });
    await legacyTaskLink(task(CODE, 3), req(CODE, 3), 'relates');
    // 4: an imported task whose row is older than the relates link: the importer's.
    await makeTask(projectId, task(CODE, 4), { api: false });
    await legacyTaskLink(task(CODE, 4), req(CODE, 4), 'relates', { row: IMPORTED });
    // 5: an imported task with a relates reference and no link on record: kept.
    await makeTask(projectId, task(CODE, 5), { api: false });
    await legacyTaskLink(task(CODE, 5), req(CODE, 5), 'relates', { row: IMPORTED, event: false });
    // 6: an imported task, relates-linked later, the row born with the link: the link's.
    await makeTask(projectId, task(CODE, 6), { api: false });
    await legacyTaskLink(task(CODE, 6), req(CODE, 6), 'relates');
    // 7: a row with no reference at all: unexplained, kept.
    await makeTask(projectId, task(CODE, 7), { api: true });
    await db.taskRequirement.create({
      data: { taskId: taskId.get(task(CODE, 7)) ?? '', requirementId: reqId.get(req(CODE, 7)) ?? '' },
    });
    // 8: satisfies and relates both: the satisfies owns the row.
    await makeTask(projectId, task(CODE, 8), { api: true });
    await legacyTaskLink(task(CODE, 8), req(CODE, 8), 'satisfies');
    await legacyTaskLink(task(CODE, 8), req(CODE, 8), 'relates');
    // 9: a task update set requirementIds after a relates link: the update wrote it.
    await makeTask(projectId, task(CODE, 9), { api: true });
    await legacyTaskLink(task(CODE, 9), req(CODE, 9), 'relates', { row: false });
    const nine = taskId.get(task(CODE, 9)) ?? '';
    const written = new Date('2026-10-05T12:00:00Z');
    await db.taskRequirement.create({ data: { taskId: nine, requirementId: reqId.get(req(CODE, 9)) ?? '', createdAt: written } });
    await db.auditEvent.create({
      data: {
        actor: 'someone',
        actorKind: 'user',
        action: 'update',
        entityType: 'task',
        entityId: nine,
        entityHumanId: task(CODE, 9),
        before: { id: nine, requirements: [] },
        after: {
          id: nine,
          requirements: [{ taskId: nine, requirementId: reqId.get(req(CODE, 9)), createdAt: written.toISOString() }],
        },
        createdAt: written,
      },
    });

    // The other project's removable row, out of scope for every run below.
    await makeTask(otherId, task(OTHER, 1), { api: true });
    await legacyTaskLink(task(OTHER, 1), req(OTHER, 1), 'relates');

    // ── ADRs ──
    for (let n = 1; n <= 16; n += 1) {
      const row = await db.adr.create({ data: { projectId, humanId: adr(n), number: n, title: `ADR ${String(n)}` } });
      adrId.set(row.humanId, row.id);
    }
    // adr_relation: 1→2 left by a relates link; 3→4 by a violates link.
    await adrRelation(adr(1), adr(2));
    await adrRef(adr(1), adr(2), 'relates');
    await adrEvent(adr(1), adr(2), 'relates');
    await adrRelation(adr(3), adr(4));
    await adrRef(adr(3), adr(4), 'violates');
    await adrEvent(adr(3), adr(4), 'violates');
    // 5→6: a relation nothing explains. 7→8: an extends link's own, backed.
    await adrRelation(adr(5), adr(6));
    await adrRelation(adr(7), adr(8));
    await adrRef(adr(7), adr(8), 'extends');
    // 9→10: a relates reference, but an extends link on record too: ambiguous, kept.
    await adrRelation(adr(9), adr(10));
    await adrRef(adr(9), adr(10), 'relates');
    await adrEvent(adr(9), adr(10), 'extends');

    // relates twins: 11→12 an old extends link and nothing else — the twin goes.
    await adrRelation(adr(11), adr(12));
    await adrRef(adr(11), adr(12), 'extends');
    await adrRef(adr(11), adr(12), 'relates');
    await adrEvent(adr(11), adr(12), 'extends');
    // 13→14: the same, but a person also linked relates (and later unlinked and relinked): kept.
    await adrRelation(adr(13), adr(14));
    await adrRef(adr(13), adr(14), 'extends');
    await adrRef(adr(13), adr(14), 'relates');
    await adrEvent(adr(13), adr(14), 'extends');
    await adrEvent(adr(13), adr(14), 'relates');
    // 15→16: extends and relates references with no link on record at all: kept.
    await adrRelation(adr(15), adr(16));
    await adrRef(adr(15), adr(16), 'extends');
    await adrRef(adr(15), adr(16), 'relates');
  });

  afterAll(async () => {
    const ids = [...taskId.values(), ...adrId.values()];
    await db.reference.deleteMany({ where: { fromId: { in: ids } } });
    await db.auditEvent.deleteMany({ where: { entityId: { in: ids } } });
    await db.project.deleteMany({ where: { code: { in: [CODE, OTHER] } } });
    await db.$disconnect();
  });

  const expectedTaskRemovals = [
    `${task(CODE, 1)} ${req(CODE, 1)}`,
    `${task(CODE, 2)} ${req(CODE, 2)}`,
    `${task(CODE, 6)} ${req(CODE, 6)}`,
  ];

  it('reports exactly what it would remove and keep, and writes nothing', async () => {
    const before = await snapshot();
    const coverageBefore = await coverageFor(db, CODE);
    expect(coverageBefore.requirements.covered).toBe(9);

    const result = await reconcileCoverage(db, { write: false, project: CODE });
    expect(result.written).toBe(false);

    expect(pairs(result.taskRequirements)).toEqual({
      removed: expectedTaskRemovals,
      kept: [
        `${task(CODE, 3)} ${req(CODE, 3)}`,
        `${task(CODE, 4)} ${req(CODE, 4)}`,
        `${task(CODE, 5)} ${req(CODE, 5)}`,
        `${task(CODE, 7)} ${req(CODE, 7)}`,
        `${task(CODE, 9)} ${req(CODE, 9)}`,
      ],
    });
    expect(result.taskRequirements.backed).toBe(1);
    const why = new Map(result.taskRequirements.kept.map((row) => [row.from, row.reason]));
    expect(why.get(task(CODE, 3))).toMatch(/task creation/);
    expect(why.get(task(CODE, 4))).toMatch(/importer/);
    expect(why.get(task(CODE, 5))).toMatch(/importer/);
    expect(why.get(task(CODE, 7))).toMatch(/unexplained/);
    expect(why.get(task(CODE, 9))).toMatch(/task update/);
    expect(result.taskRequirements.removed.find((row) => row.from === task(CODE, 2))?.reason).toMatch(/violates/);

    expect(pairs(result.adrRelations)).toEqual({
      removed: [`${adr(1)} ${adr(2)}`, `${adr(3)} ${adr(4)}`],
      kept: [`${adr(5)} ${adr(6)}`, `${adr(9)} ${adr(10)}`],
    });
    // 7→8, 11→12, 13→14, 15→16 all have their extends reference.
    expect(result.adrRelations.backed).toBe(4);

    expect(pairs(result.relatesTwins)).toEqual({
      removed: [`${adr(11)} ${adr(12)}`],
      kept: [`${adr(13)} ${adr(14)}`, `${adr(15)} ${adr(16)}`],
    });

    expect(await snapshot()).toEqual(before);
    expect(await coverageFor(db, CODE)).toEqual(coverageBefore);
  });

  it('prints every pair with human IDs from the CLI, and still writes nothing', async () => {
    const before = await snapshot();
    const { stdout } = await cli([]);
    expect(stdout).toContain(`remove   ${task(CODE, 1)} -> ${req(CODE, 1)}`);
    expect(stdout).toContain(`kept     ${task(CODE, 7)} -> ${req(CODE, 7)}`);
    expect(stdout).toContain(`remove   ${adr(1)} extends ${adr(2)}`);
    expect(stdout).toContain(`remove   ${adr(11)} relates ${adr(12)}`);
    expect(stdout).toContain('6 row(s) would be removed.');
    expect(stdout).toContain('Nothing written');
    expect(stdout).not.toContain(OTHER);
    expect(await snapshot()).toEqual(before);
  });

  it('removes them with --write, auditing each, and moves coverage only where expected', async () => {
    const before = await snapshot();
    const coverageBefore = await coverageFor(db, CODE);

    const result = await reconcileCoverage(db, { write: true, project: CODE });
    expect(result.written).toBe(true);
    expect(pairs(result.taskRequirements).removed).toEqual(expectedTaskRemovals);

    const after = await snapshot();
    expect(after.taskRequirements).toBe(before.taskRequirements - 3);
    expect(after.adrRelations).toBe(before.adrRelations - 2);
    expect(after.references).toBe(before.references - 1);
    expect(after.events).toBe(before.events + 6);

    // Exactly the pairs named, and nothing beside them.
    for (const n of [1, 2, 6]) {
      expect(
        await db.taskRequirement.count({ where: { taskId: taskId.get(task(CODE, n)) ?? '' } }),
      ).toBe(0);
    }
    for (const n of [3, 4, 5, 7, 8, 9]) {
      expect(
        await db.taskRequirement.count({ where: { taskId: taskId.get(task(CODE, n)) ?? '' } }),
      ).toBe(1);
    }
    expect(await db.taskRequirement.count({ where: { taskId: taskId.get(task(OTHER, 1)) ?? '' } })).toBe(1);
    // References are citations: the relates and violates links stay.
    expect(
      await db.reference.count({ where: { fromId: taskId.get(task(CODE, 1)) ?? '', kind: 'relates' } }),
    ).toBe(1);
    expect(
      await db.reference.count({ where: { fromId: adrId.get(adr(11)) ?? '', kind: { in: ['extends', 'relates'] } } }),
    ).toBe(1);
    expect(await db.adrRelation.count({ where: { adrId: adrId.get(adr(11)) ?? '' } })).toBe(1);

    const coverageAfter = await coverageFor(db, CODE);
    expect(coverageAfter.requirements.covered).toBe(coverageBefore.requirements.covered - 3);
    expect(coverageAfter.uncoveredMusts.map((hole) => hole.humanId).sort()).toEqual(
      [...coverageBefore.uncoveredMusts.map((hole) => hole.humanId), req(CODE, 1), req(CODE, 2), req(CODE, 6)].sort(),
    );
    expect(coverageAfter.tasksWithoutRequirements.map((t) => t.humanId).sort()).toEqual(
      [...coverageBefore.tasksWithoutRequirements.map((t) => t.humanId), task(CODE, 1), task(CODE, 2), task(CODE, 6)].sort(),
    );

    const events = await db.auditEvent.findMany({ where: { actor: 'reconcile-coverage' } });
    expect(events).toHaveLength(6);
    for (const event of events) {
      expect(event.actorKind).toBe('system');
      expect(event.action).toBe('delete');
      expect((event.after as { event?: string }).event).toBe('reconcile');
    }
    const first = events.find((event) => event.entityHumanId === task(CODE, 1));
    expect(first?.entityType).toBe('task');
    expect(first?.after).toMatchObject({
      removed: 'task_requirement',
      to: req(CODE, 1),
      restoreWith: `link ${task(CODE, 1)} satisfies ${req(CODE, 1)}`,
    });
    expect(first?.before).toMatchObject({
      taskRequirement: { taskId: taskId.get(task(CODE, 1)), requirementId: reqId.get(req(CODE, 1)) },
    });
    expect(events.find((event) => event.entityHumanId === adr(1))?.after).toMatchObject({
      removed: 'adr_relation',
      restoreWith: `link ${adr(1)} extends ${adr(2)}`,
    });
    expect(events.find((event) => event.entityHumanId === adr(11))?.after).toMatchObject({
      removed: 'reference',
      restoreWith: `link ${adr(11)} relates ${adr(12)}`,
    });

    // Undo would reverse it as a change to the task; it refuses and names the link instead.
    await expect(undo(db, { actor: 'cli', actorKind: 'system' }, first?.id ?? '')).rejects.toThrow(
      /coverage cleanup.*satisfies/,
    );
  });

  it('removes nothing on a second run', async () => {
    const before = await snapshot();
    const result = await reconcileCoverage(db, { write: true, project: CODE });
    expect(result.taskRequirements.removed).toEqual([]);
    expect(result.adrRelations.removed).toEqual([]);
    expect(result.relatesTwins.removed).toEqual([]);
    // What it kept, it keeps saying, so a re-run is still a full report.
    expect(result.taskRequirements.kept).toHaveLength(5);
    expect(result.adrRelations.kept).toHaveLength(2);
    expect(result.relatesTwins.kept).toHaveLength(2);
    expect(await snapshot()).toEqual(before);

    const { stdout } = await cli(['--write']);
    expect(stdout).toContain('0 row(s) removed.');
    expect(stdout).toContain('Nothing to do.');
    expect(await snapshot()).toEqual(before);
  });
});
