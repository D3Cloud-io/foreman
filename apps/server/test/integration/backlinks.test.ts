import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db.js';
import { getByHumanId } from '../../src/domain/entities.js';
import { link } from '../../src/domain/links.js';
import type { EntityType } from '../../src/generated/prisma/enums.js';

/**
 * Backlinks name what cites them (FRM-T-18.17).
 *
 * A backlink is resolved by the kind of its source. Every kind the resolver had no case for came
 * back as "(deleted)" with no human ID — three live phases linked to SHP-ADR-013 among them. So
 * this links one entity of every citing kind to an ADR and expects each by its ID and title, and
 * only the soft-deleted one to read as deleted.
 */

const url = process.env['DATABASE_URL'];
const CODE = 'BKL';
// Codeless kinds draw their numbers from global sequences; these sit far above any real one.
const SEQ = 990_017;
const ACTOR = { actor: 'backlinks@example.com', actorKind: 'user' } as const;

describe.skipIf(url === undefined)('backlinks', () => {
  let db: Db;
  let projectId: string;
  let adrId: string;

  const cleanUp = async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.projectIdea.deleteMany({ where: { seq: SEQ } });
    await db.guideline.deleteMany({ where: { seq: SEQ } });
    await db.projectGroup.deleteMany({ where: { seq: SEQ } });
    await db.reference.deleteMany({ where: { toType: 'adr', toId: adrId } });
  };

  const cite = (fromType: EntityType, fromId: string) =>
    db.reference.create({ data: { fromType, fromId, toType: 'adr', toId: adrId, kind: 'relates' } });

  const backlinks = async () => {
    const result = await getByHumanId(db, `${CODE}-ADR-001`);
    return result.backlinks;
  };

  beforeAll(() => {
    db = createDb(url ?? '');
  });

  beforeEach(async () => {
    adrId = '00000000-0000-7000-8000-000000000000';
    await cleanUp();
    const project = await db.project.create({ data: { code: CODE, name: 'Backlinks Test', slug: 'backlinks-test' } });
    projectId = project.id;
    const adr = await db.adr.create({
      data: { projectId, humanId: `${CODE}-ADR-001`, number: 1, title: 'The cited decision' },
    });
    adrId = adr.id;
  });

  afterAll(async () => {
    await cleanUp();
    await db.$disconnect();
  });

  it('names a phase linked to an ADR by its ID and name, not "(deleted)"', async () => {
    await db.phase.create({
      data: { projectId, humanId: `${CODE}-P-19`, number: 19, sortOrder: 19, name: 'Volumes' },
    });
    await link(db, ACTOR, `${CODE}-P-19`, `${CODE}-ADR-001`, 'relates');

    expect(await backlinks()).toEqual([
      { fromType: 'phase', humanId: `${CODE}-P-19`, title: 'Volumes', kind: 'relates' },
    ]);
  });

  it('names every other citing kind the resolver used to miss', async () => {
    const decision = await db.decision.create({
      data: { projectId, humanId: `${CODE}-D-001`, statement: 'Use Postgres', value: 'yes' },
    });
    const risk = await db.risk.create({ data: { projectId, humanId: `${CODE}-R-001`, title: 'Disk fills' } });
    const term = await db.term.create({ data: { projectId, term: 'tripwire', definition: 'A named condition.' } });
    const idea = await db.idea.create({ data: { projectId, humanId: `${CODE}-IDEA-001`, seq: 1, title: 'Dark mode' } });
    const audit = await db.audit.create({
      data: {
        projectId,
        humanId: `${CODE}-AUD-001`,
        kind: 'design',
        runDate: new Date('2026-11-02'),
        scope: 'console',
      },
    });
    const projectIdea = await db.projectIdea.create({ data: { humanId: `PI-${String(SEQ)}`, seq: SEQ, title: 'A new app' } });
    const guideline = await db.guideline.create({
      data: { humanId: `GL-${String(SEQ)}`, seq: SEQ, title: 'Ship small', area: 'process', decision: 'Small PRs.' },
    });
    const group = await db.projectGroup.create({
      data: { humanId: `GRP-${String(SEQ)}`, seq: SEQ, name: 'Test family', slug: 'test-family-bkl' },
    });

    await cite('decision', decision.id);
    await cite('risk', risk.id);
    await cite('term', term.id);
    await cite('idea', idea.id);
    await cite('audit', audit.id);
    await cite('project_idea', projectIdea.id);
    await cite('guideline', guideline.id);
    await cite('group', group.id);

    const byType = Object.fromEntries((await backlinks()).map((b) => [b.fromType, b]));
    expect(byType['decision']).toMatchObject({ humanId: `${CODE}-D-001`, title: 'Use Postgres' });
    expect(byType['risk']).toMatchObject({ humanId: `${CODE}-R-001`, title: 'Disk fills' });
    // A term has no human ID; it is named by the term itself.
    expect(byType['term']).toMatchObject({ humanId: null, title: 'tripwire' });
    expect(byType['idea']).toMatchObject({ humanId: `${CODE}-IDEA-001`, title: 'Dark mode' });
    expect(byType['audit']).toMatchObject({ humanId: `${CODE}-AUD-001`, title: 'Design audit 2026-11-02 — console' });
    expect(byType['project_idea']).toMatchObject({ humanId: `PI-${String(SEQ)}`, title: 'A new app' });
    expect(byType['guideline']).toMatchObject({ humanId: `GL-${String(SEQ)}`, title: 'Ship small' });
    expect(byType['group']).toMatchObject({ humanId: `GRP-${String(SEQ)}`, title: 'Test family' });
    expect(Object.keys(byType)).toHaveLength(8);
  });

  it('reads as deleted only when the source is soft-deleted', async () => {
    const live = await db.phase.create({
      data: { projectId, humanId: `${CODE}-P-20`, number: 20, sortOrder: 20, name: 'Live' },
    });
    const gone = await db.phase.create({
      data: { projectId, humanId: `${CODE}-P-21`, number: 21, sortOrder: 21, name: 'Gone', deletedAt: new Date() },
    });
    await cite('phase', live.id);
    await cite('phase', gone.id);

    const titles = (await backlinks()).map((b) => [b.humanId, b.title]);
    expect(titles).toContainEqual([`${CODE}-P-20`, 'Live']);
    expect(titles).toContainEqual([null, '(deleted)']);
  });
});
