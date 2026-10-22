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
  let documentId: string;
  /** Audit events outlive the projects they describe, so a re-run must only read its own. */
  let startedAt: Date;

  beforeAll(async () => {
    db = createDb(url ?? '');
    startedAt = new Date();
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
        tripwire: '**Golden corpus word accuracy** drops below 90%',
      },
    });
    await db.task.create({
      data: { projectId, humanId: `${CODE}-T-1.1`, title: 'Write the importer ]]', body: 'Body with **bold** and [[Note]].' },
    });
    await db.task.create({ data: { projectId, humanId: `${CODE}-T-1.2`, title: 'Already clean' } });
    await db.task.create({
      data: { projectId, humanId: `${CODE}-T-1.3`, title: 'Deleted **one**', deletedAt: new Date() },
    });
    await db.task.create({
      data: { projectId, humanId: `${CODE}-T-1.4`, title: '~~Old~~ plan: glob `apps/**` and x**2', doneWhen: 'Per [[D3 Auth/Scope of Work|D3 Auth]], **done**' },
    });
    await db.risk.create({
      data: {
        projectId,
        humanId: `${CODE}-RISK-002`,
        title: 'Split cell',
        mitigation: 'Bindery/ADR-006 - Cloudflare Tunnel and Access for **Ingress**\\',
        tripwire: 'ADR-006). App-level JWT stays',
      },
    });
    await db.phase.create({
      data: {
        projectId,
        humanId: `${CODE}-P-1`,
        number: 1,
        sortOrder: 1,
        name: 'One',
        objective: '**Ship** it, per [[D3 Auth/Scope of Work|D3 Auth]]',
        exitDemo: 'Demo [[Plan]]',
      },
    });
    await db.requirement.create({
      data: { projectId, humanId: `${CODE}-REQ-001`, seq: 1, statement: '~~Old~~ statement', acceptanceTest: 'Check **it**', priority: 'M' },
    });
    const document = await db.document.create({
      data: {
        projectId,
        kind: 'architecture',
        title: '**Architecture** notes',
        sections: {
          create: [
            { key: 'overview', heading: '**Overview**', bodyMd: 'Read [[Scope|the scope]] and keep **bold** and `[[code]]`.', sortOrder: 0 },
            { key: 'clean', heading: 'Clean', bodyMd: 'Nothing here.', sortOrder: 1 },
          ],
        },
      },
    });
    documentId = document.id;
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
    expect(await db.auditEvent.count({ where: { createdAt: { gte: startedAt }, actor: 'clean-markup', entityHumanId: `${CODE}-T-1.1` } })).toBe(0);
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

  it('strips strikethrough and the other plain-text fields, and leaves code-like text alone', async () => {
    const task = await db.task.findFirstOrThrow({ where: { humanId: `${CODE}-T-1.4` } });
    expect(task.title).toBe('Old plan: glob apps/** and x**2');
    expect(task.doneWhen).toBe('Per D3 Auth, done');

    const phase = await db.phase.findFirstOrThrow({ where: { humanId: `${CODE}-P-1` } });
    expect(phase.objective).toBe('Ship it, per D3 Auth');
    expect(phase.exitDemo).toBe('Demo Plan');

    const requirement = await db.requirement.findFirstOrThrow({ where: { humanId: `${CODE}-REQ-001` } });
    expect(requirement.statement).toBe('Old statement');
    expect(requirement.acceptanceTest).toBe('Check it');
  });

  it('lists a cell split at an escaped pipe for a person, and leaves it exactly as it was', async () => {
    const risk = await db.risk.findFirstOrThrow({ where: { humanId: `${CODE}-RISK-002` } });
    expect(risk.mitigation).toBe('Bindery/ADR-006 - Cloudflare Tunnel and Access for **Ingress**\\');
    expect(risk.tripwire).toBe('ADR-006). App-level JWT stays');

    const { stdout } = await cli([]);
    expect(stdout).toContain('needs a person');
    expect(stdout).toContain(`${CODE}-RISK-002`);
    expect(stdout).toContain('mitigation: ends with a backslash');
    expect(stdout).toContain('tripwire: starts mid-parenthesis');
  });

  it('rewrites documents through the domain: version moved, revision written, audit by the API path', async () => {
    const document = await db.document.findFirstOrThrow({ where: { id: documentId } });
    expect(document.title).toBe('Architecture notes');

    const overview = await db.documentSection.findFirstOrThrow({ where: { documentId, key: 'overview' } });
    expect(overview.heading).toBe('Overview');
    // The wiki link outside code is rewritten; bold and the code span stay.
    expect(overview.bodyMd).toBe('Read the scope and keep **bold** and `[[code]]`.');

    const revisions = await db.documentRevision.findMany({ where: { documentId }, orderBy: { revisionNo: 'asc' } });
    expect(revisions.length).toBeGreaterThanOrEqual(2);
    expect(revisions.some((r) => r.note === 'clean-markup' && r.actor === 'clean-markup')).toBe(true);
    // The untouched section produced no revision of its own.
    const clean = await db.documentSection.findFirstOrThrow({ where: { documentId, key: 'clean' } });
    expect(clean.bodyMd).toBe('Nothing here.');

    const event = await db.auditEvent.findFirstOrThrow({
      where: { createdAt: { gte: startedAt }, entityId: overview.id, action: 'update', actor: 'clean-markup' },
    });
    expect(event.actorKind).toBe('system');
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
      where: { createdAt: { gte: startedAt }, entityHumanId: `${CODE}-T-1.1`, action: 'update', actor: 'clean-markup' },
    });
    expect(event.actorKind).toBe('system');
    expect(event.before).toEqual({ title: 'Write the importer ]]', body: 'Body with **bold** and [[Note]].' });
    expect(event.after).toMatchObject({ title: 'Write the importer', cleanedBy: 'clean-markup' });
  });

  it('is idempotent: a second run changes and audits nothing', async () => {
    const events = await db.auditEvent.count({ where: { createdAt: { gte: startedAt }, actor: 'clean-markup' } });
    const { stdout } = await cli(['--write']);
    // Only the kept duplicate is left to report.
    expect(stdout).toContain('0 row(s) cleaned');
    expect(await db.auditEvent.count({ where: { createdAt: { gte: startedAt }, actor: 'clean-markup' } })).toBe(events);
  });

  it('is undone like any other edit', async () => {
    const event = await db.auditEvent.findFirstOrThrow({
      where: { createdAt: { gte: startedAt }, entityHumanId: `${CODE}-RISK-001`, action: 'update', actor: 'clean-markup' },
    });
    await undo(db, { actor: 'tester', actorKind: 'user' }, event.id);

    const risk = await db.risk.findFirstOrThrow({ where: { humanId: `${CODE}-RISK-001` } });
    expect(risk.title).toBe('**Transcript** quality');
    expect(risk.tripwire).toBe('**Golden corpus word accuracy** drops below 90%');
  });
});
