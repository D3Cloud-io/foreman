import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db.js';
import { undo } from '../../src/domain/undo.js';

/**
 * The one-off cleanup of the importer's Markdown residue (FRM-T-18.11, FRM-REQ-250, FRM-DA-011).
 *
 * Rows are written the way the importer wrote them — straight to the tables — with the residue the
 * audit found: a bolded glossary term, a tripwire that opens `**`, a task title ending `]]`.
 */

const run = promisify(execFile);
const url = process.env['DATABASE_URL'];
const SCRIPT = fileURLToPath(new URL('../../src/cli/clean-markup.ts', import.meta.url));
const CODE = 'CMKP';
/** A second project with residue, which a run scoped to CMKP must not touch. */
const OTHER = 'CMKX';

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

describe.skipIf(url === undefined)('clean-markup', () => {
  let db: Db;
  let projectId: string;
  let otherId: string;

  beforeAll(async () => {
    db = createDb(url ?? '');
    for (const code of [CODE, OTHER]) await db.project.deleteMany({ where: { code } });
    const project = await db.project.create({
      data: { code: CODE, name: 'Clean markup', slug: 'clean-markup', lifecycle: 'building' },
    });
    projectId = project.id;
    otherId = (
      await db.project.create({
        data: { code: OTHER, name: 'Clean markup other', slug: 'clean-markup-other', lifecycle: 'building' },
      })
    ).id;

    await db.term.createMany({
      data: [
        { projectId, term: '**Asset**', definition: 'A **kept** thing, see [[Glossary|the glossary]].' },
        { projectId, term: '**`field_provenance`**', definition: 'Where a field came from.', aliases: ['**fp**', 'prov'] },
        { projectId, term: 'Plain', definition: 'Already clean, with `code`.' },
        // Cleaning this one would collide with the existing 'Plain'.
        { projectId, term: '**Plain**', definition: 'A duplicate once cleaned.' },
      ],
    });
    await db.risk.create({
      data: {
        projectId,
        humanId: `${CODE}-RISK-001`,
        title: '**Transcript** quality',
        tripwire: '**Golden corpus word accuracy drops below 90%',
      },
    });
    await db.task.create({
      data: { projectId, humanId: `${CODE}-T-1.1`, title: 'Write the importer ]]', body: 'Body with **bold** and [[Note]].' },
    });
    await db.task.create({ data: { projectId, humanId: `${CODE}-T-1.2`, title: 'Already clean' } });
    await db.task.create({
      data: { projectId, humanId: `${CODE}-T-1.3`, title: 'Deleted **one**', deletedAt: new Date() },
    });
    await db.task.create({ data: { projectId: otherId, humanId: `${OTHER}-T-1.1`, title: '**Other** project ]]' } });
  });

  afterAll(async () => {
    for (const code of [CODE, OTHER]) await db.project.deleteMany({ where: { code } });
    await db.$disconnect();
  });

  const title = async (humanId: string) => (await db.task.findFirstOrThrow({ where: { humanId } })).title;

  it('writes nothing until it is told to, and shows every substitution', async () => {
    const { stdout } = await cli([]);
    expect(stdout).toContain('Nothing written');
    expect(stdout).toContain('stray-brackets');
    expect(stdout).toContain('"**Asset**" -> "Asset"');

    expect(await title(`${CODE}-T-1.1`)).toBe('Write the importer ]]');
    expect(await db.auditEvent.count({ where: { actor: 'clean-markup', entityHumanId: `${CODE}-T-1.1` } })).toBe(0);
  });

  it('cleans plain-text fields, keeps markdown bodies, and rewrites only their wiki links', async () => {
    await cli(['--write']);

    expect(await title(`${CODE}-T-1.1`)).toBe('Write the importer');
    const task = await db.task.findFirstOrThrow({ where: { humanId: `${CODE}-T-1.1` } });
    expect(task.body).toBe('Body with **bold** and Note.');

    const risk = await db.risk.findFirstOrThrow({ where: { humanId: `${CODE}-RISK-001` } });
    expect(risk.title).toBe('Transcript quality');
    expect(risk.tripwire).toBe('Golden corpus word accuracy drops below 90%');

    const terms = await db.term.findMany({ where: { projectId }, orderBy: { term: 'asc' } });
    const byTerm = new Map(terms.map((t) => [t.term, t]));
    expect(byTerm.get('Asset')?.definition).toBe('A **kept** thing, see the glossary.');
    expect(byTerm.get('field_provenance')?.aliases).toEqual(['fp', 'prov']);
    expect(byTerm.get('Plain')?.definition).toBe('Already clean, with `code`.');
  });

  it('keeps a term whose cleaned name already exists, rather than failing on the unique key', async () => {
    expect(await db.term.count({ where: { projectId, term: '**Plain**' } })).toBe(1);
  });

  it('does not touch a soft-deleted row, a clean row, or another project', async () => {
    expect(await title(`${CODE}-T-1.3`)).toBe('Deleted **one**');
    expect(await title(`${CODE}-T-1.2`)).toBe('Already clean');
    expect(await title(`${OTHER}-T-1.1`)).toBe('**Other** project ]]');
  });

  it('audits every change as a system update by clean-markup, with the old value in before', async () => {
    const event = await db.auditEvent.findFirstOrThrow({
      where: { entityHumanId: `${CODE}-T-1.1`, action: 'update', actor: 'clean-markup' },
    });
    expect(event.actorKind).toBe('system');
    expect(event.before).toEqual({ title: 'Write the importer ]]', body: 'Body with **bold** and [[Note]].' });
    expect(event.after).toMatchObject({ title: 'Write the importer', cleanedBy: 'clean-markup' });
  });

  it('is idempotent: a second run changes and audits nothing', async () => {
    const events = await db.auditEvent.count({ where: { actor: 'clean-markup' } });
    const { stdout } = await cli(['--write']);
    // Only the kept duplicate is left to report.
    expect(stdout).toContain('0 row(s) cleaned');
    expect(await db.auditEvent.count({ where: { actor: 'clean-markup' } })).toBe(events);
  });

  it('is undone like any other edit', async () => {
    const event = await db.auditEvent.findFirstOrThrow({
      where: { entityHumanId: `${CODE}-RISK-001`, action: 'update', actor: 'clean-markup' },
    });
    await undo(db, { actor: 'tester', actorKind: 'user' }, event.id);

    const risk = await db.risk.findFirstOrThrow({ where: { humanId: `${CODE}-RISK-001` } });
    expect(risk.title).toBe('**Transcript** quality');
    expect(risk.tripwire).toBe('**Golden corpus word accuracy drops below 90%');
  });
});
