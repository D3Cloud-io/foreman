import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * The record over HTTP (T-4.1 … T-4.8): documents addressable by section, revisions and diffs,
 * ADRs and their chain, decisions, risks and the glossary.
 *
 * The assertions the plan calls out by name: a `PUT` on one section changes only that section, ten
 * edits make ten revisions, a key survives a rename, and opening an ADR lists what cites it.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'record@example.com';
const PASSWORD = 'a-password-for-the-record-tests';
const CODE = 'REC';

describe.skipIf(url === undefined)('the record', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;

  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}/api${path}`, { ...init, headers });
  };
  const post = (path: string, body?: unknown) =>
    api(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const patch = (path: string, body: unknown) =>
    api(path, { method: 'PATCH', body: JSON.stringify(body) });
  const put = (path: string, body: unknown) =>
    api(path, { method: 'PUT', body: JSON.stringify(body) });
  const get = async <T>(path: string): Promise<T> => {
    const res = await api(path);
    expect(res.status, path).toBe(200);
    return (await res.json()) as T;
  };

  beforeAll(async () => {
    const config: Config = loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'http://localhost:3200',
      DATABASE_URL: url ?? '',
      KEK: Buffer.alloc(32, 1).toString('base64'),
      PEPPER: Buffer.alloc(32, 2).toString('base64'),
      COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
    });
    db = createDb(url ?? '');

    await db.user.deleteMany({ where: { email: EMAIL } });
    const user = await db.user.create({
      data: { email: EMAIL, displayName: 'Record', status: 'active' },
    });
    await setPassword({ db, config }, user.id, PASSWORD);

    server = await new Promise<Server>((resolve) => {
      const s = createApp({ config, db }).listen(0, () => { resolve(s); });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    origin = `http://127.0.0.1:${String(address.port)}`;

    const signIn = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  beforeEach(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    // Ecosystem terms belong to no project, so a cascade does not take them.
    await db.term.deleteMany({ where: { projectId: null, term: { startsWith: 'test-' } } });
    await post('/projects', { code: CODE, name: 'Record Test' });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.term.deleteMany({ where: { projectId: null, term: { startsWith: 'test-' } } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  interface DocumentBody {
    id: string;
    title: string;
    sections: {
      id: string;
      key: string;
      heading: string;
      bodyMd: string;
      sortOrder: number;
      updatedAt: string;
    }[];
  }

  const makeDocument = async (
    sections: { heading: string; bodyMd: string; key?: string }[] = [
      { heading: 'Deployment', bodyMd: 'Behind a Cloudflare Tunnel, with no host ports.' },
      { heading: 'Data model', bodyMd: 'Thirty-six tables.' },
    ],
  ): Promise<DocumentBody> => {
    const res = await post(`/projects/${CODE}/documents`, {
      kind: 'architecture',
      title: 'Architecture',
      sections,
    });
    expect(res.status).toBe(201);
    return (await res.json()) as DocumentBody;
  };

  describe('documents and sections (T-4.1, FRM-REQ-061, FRM-REQ-062)', () => {
    it('derives a slug-safe key from each heading', async () => {
      const document = await makeDocument();
      expect(document.sections.map((s) => s.key)).toEqual(['deployment', 'data-model']);
    });

    it('keeps the sections in the order they were given', async () => {
      const document = await makeDocument();
      expect(document.sections.map((s) => s.sortOrder)).toEqual([0, 1]);
    });

    it('refuses two headings that would share one address', async () => {
      // "Deployment" and "deployment!" slug the same, and one section would answer to the other's
      // URI. Refused rather than disambiguated: the author chooses which keeps the key.
      const res = await post(`/projects/${CODE}/documents`, {
        kind: 'architecture',
        title: 'Architecture',
        sections: [
          { heading: 'Deployment', bodyMd: '' },
          { heading: 'deployment!', bodyMd: '' },
        ],
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('deployment');
    });

    it('adds a section after a named one, and renumbers the rest', async () => {
      const document = await makeDocument();
      const added = await post(`/projects/${CODE}/documents/${document.id}/sections`, {
        heading: 'Security',
        bodyMd: 'Argon2id with a pepper.',
        after: 'deployment',
      });
      expect(added.status).toBe(201);

      const fresh = await get<DocumentBody>(`/projects/${CODE}/documents/${document.id}`);
      expect(fresh.sections.map((s) => s.key)).toEqual(['deployment', 'security', 'data-model']);
      expect(fresh.sections.map((s) => s.sortOrder)).toEqual([0, 1, 2]);
    });

    it('lists documents without their bodies', async () => {
      await makeDocument();
      const listed = await get<{
        items: { title: string; sections: { key: string; bodyMd?: string }[] }[];
        total: number;
      }>(`/projects/${CODE}/documents`);

      expect(listed.total).toBe(1);
      // A listing that carries every body gets slower the more anybody writes.
      expect(listed.items[0]?.sections[0]?.bodyMd).toBeUndefined();
      expect(listed.items[0]?.sections[0]?.key).toBe('deployment');
    });
  });

  describe('the single-section write (T-4.2, FRM-REQ-063)', () => {
    it('changes only that section', async () => {
      const document = await makeDocument();
      const untouched = document.sections[1];

      const res = await put(`/projects/${CODE}/documents/${document.id}/sections/deployment`, {
        bodyMd: 'On the Zima, behind a tunnel.',
      });
      expect(res.status).toBe(200);

      const fresh = await get<DocumentBody>(`/projects/${CODE}/documents/${document.id}`);
      expect(fresh.sections[0]?.bodyMd).toBe('On the Zima, behind a tunnel.');
      // The whole claim of the endpoint: the other section's row did not move.
      expect(fresh.sections[1]?.bodyMd).toBe(untouched?.bodyMd);
      expect(fresh.sections[1]?.updatedAt).toBe(untouched?.updatedAt);
    });

    it('renames a heading without moving its address', async () => {
      const document = await makeDocument();
      await put(`/projects/${CODE}/documents/${document.id}/sections/deployment`, {
        heading: 'How it is deployed',
        bodyMd: 'Unchanged.',
      });

      const fresh = await get<DocumentBody>(`/projects/${CODE}/documents/${document.id}`);
      expect(fresh.sections[0]?.heading).toBe('How it is deployed');
      // `foreman://REC/architecture#deployment` still resolves. A key that tracked the heading
      // would have broken every citation and every cached URI.
      expect(fresh.sections[0]?.key).toBe('deployment');
    });

    it('404s a section that does not exist rather than creating one', async () => {
      const document = await makeDocument();
      const res = await put(`/projects/${CODE}/documents/${document.id}/sections/nope`, {
        bodyMd: 'x',
      });
      expect(res.status).toBe(404);
    });

    it('refuses a write against a stale version, and hands back the current one', async () => {
      const document = await makeDocument();
      const first = await api(`/projects/${CODE}/documents/${document.id}`);
      const etag = first.headers.get('etag') ?? '';

      await put(`/projects/${CODE}/documents/${document.id}/sections/deployment`, {
        bodyMd: 'Somebody else got here first.',
      });

      const stale = await api(`/projects/${CODE}/documents/${document.id}/sections/deployment`, {
        method: 'PUT',
        headers: { 'if-match': etag, 'content-type': 'application/json' },
        body: JSON.stringify({ bodyMd: 'My version.' }),
      });
      // Never a silent overwrite: 412, with what it lost to.
      expect(stale.status).toBe(412);
      expect((await stale.json()) as { current: unknown }).toHaveProperty('current');
    });

    it('moves the document’s version when a section save is undone, and records a revision (FRM-T-18.4)', async () => {
      const document = await makeDocument();
      const saved = await put(`/projects/${CODE}/documents/${document.id}/sections/deployment`, {
        bodyMd: 'A line to be undone.',
      });
      const { auditEventIds } = (await saved.json()) as { auditEventIds: string[] };
      const afterSave = await api(`/projects/${CODE}/documents/${document.id}`);
      const savedEtag = afterSave.headers.get('etag') ?? '';

      const undone = await post(`/undo/${auditEventIds[0] ?? ''}`);
      expect(undone.status, await undone.clone().text()).toBe(200);

      // A conditional read with the version from before the undo is not answered 304 with the
      // undone body: the version moved, so the restored text comes back.
      const fresh = await api(`/projects/${CODE}/documents/${document.id}`, {
        headers: { 'if-none-match': savedEtag },
      });
      expect(fresh.status).toBe(200);
      expect(fresh.headers.get('etag')).not.toBe(savedEtag);
      const body = (await fresh.json()) as DocumentBody;
      expect(body.sections.find((s) => s.key === 'deployment')?.bodyMd).toBe(
        'Behind a Cloudflare Tunnel, with no host ports.',
      );

      // And a save still holding that version is refused, rather than writing the undone text back.
      const stale = await api(`/projects/${CODE}/documents/${document.id}/sections/deployment`, {
        method: 'PUT',
        headers: { 'if-match': savedEtag, 'content-type': 'application/json' },
        body: JSON.stringify({ bodyMd: 'A line to be undone.' }),
      });
      expect(stale.status).toBe(412);

      const revisions = await get<{ items: { revisionNo: number; note: string | null }[] }>(
        `/projects/${CODE}/documents/${document.id}/revisions`,
      );
      expect(revisions.items).toHaveLength(3);
      expect(revisions.items[0]?.note).toBe('undo of a change to deployment');
    });
  });

  describe('revisions and diff (T-4.3, FRM-REQ-064, FRM-REQ-065)', () => {
    it('makes ten revisions out of ten edits', async () => {
      const document = await makeDocument();

      for (let i = 1; i <= 9; i += 1) {
        await put(`/projects/${CODE}/documents/${document.id}/sections/deployment`, {
          bodyMd: `Version ${String(i)}.`,
        });
      }

      const revisions = await get<{ items: { revisionNo: number }[] }>(
        `/projects/${CODE}/documents/${document.id}/revisions`,
      );
      // Nine edits plus the creation: the document as first written is itself a revision, so
      // "restore the original" means something.
      expect(revisions.items).toHaveLength(10);
      expect(revisions.items[0]?.revisionNo).toBe(10);
    });

    it('records who made each revision, and any note they left', async () => {
      const document = await makeDocument();
      await put(`/projects/${CODE}/documents/${document.id}/sections/deployment`, {
        bodyMd: 'Moved to the Zima.',
        note: 'The DO droplet was costing more than the box.',
      });

      const revisions = await get<{ items: { actor: string; note: string | null }[] }>(
        `/projects/${CODE}/documents/${document.id}/revisions`,
      );
      expect(revisions.items[0]?.actor).toBe(EMAIL);
      // The diff shows what changed; only a note can say why.
      expect(revisions.items[0]?.note).toContain('costing more');
    });

    it('shows added, removed and changed lines between two revisions', async () => {
      const document = await makeDocument([
        { heading: 'Deployment', bodyMd: 'one\ntwo\nthree' },
      ]);
      await put(`/projects/${CODE}/documents/${document.id}/sections/deployment`, {
        bodyMd: 'one\ntwo and a half\nthree\nfour',
      });

      const diff = await get<{
        sections: { key: string; status: string; lines: { kind: string; text: string }[] }[];
      }>(`/projects/${CODE}/documents/${document.id}/diff?from=1&to=2`);

      const section = diff.sections.find((s) => s.key === 'deployment');
      expect(section?.status).toBe('changed');
      expect(section?.lines.filter((l) => l.kind === 'removed').map((l) => l.text)).toEqual(['two']);
      expect(section?.lines.filter((l) => l.kind === 'added').map((l) => l.text)).toEqual([
        'two and a half',
        'four',
      ]);
      // The unchanged lines are carried too, so a diff reads as a document rather than a fragment.
      expect(section?.lines.filter((l) => l.kind === 'same').map((l) => l.text)).toEqual([
        'one',
        'three',
      ]);
    });

    it('marks a section added when it was not in the earlier revision', async () => {
      const document = await makeDocument([{ heading: 'Deployment', bodyMd: 'one' }]);
      await post(`/projects/${CODE}/documents/${document.id}/sections`, {
        heading: 'Security',
        bodyMd: 'Argon2id.',
      });

      const diff = await get<{ sections: { key: string; status: string }[] }>(
        `/projects/${CODE}/documents/${document.id}/diff?from=1&to=2`,
      );
      expect(diff.sections.find((s) => s.key === 'security')?.status).toBe('added');
      expect(diff.sections.find((s) => s.key === 'deployment')?.status).toBe('unchanged');
    });
  });

  describe('ADRs (T-4.4, FRM-REQ-058)', () => {
    const makeAdr = async (title: string, body: Record<string, unknown> = {}) => {
      const res = await post(`/projects/${CODE}/adrs`, { title, ...body });
      expect(res.status).toBe(201);
      return (await res.json()) as { humanId: string; number: number; status: string };
    };

    it('numbers ADRs from one and carries the number in the ID', async () => {
      expect((await makeAdr('Node over Python')).humanId).toBe(`${CODE}-ADR-001`);
      expect((await makeAdr('A small verb surface')).humanId).toBe(`${CODE}-ADR-002`);
    });

    it('moves proposed to accepted', async () => {
      const adr = await makeAdr('Node over Python');
      const res = await patch(`/projects/${CODE}/adrs/${adr.humanId}`, { status: 'accepted' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe('accepted');
    });

    it('refuses to set superseded directly, and says how it is actually done', async () => {
      const adr = await makeAdr('Node over Python');
      const res = await patch(`/projects/${CODE}/adrs/${adr.humanId}`, { status: 'superseded' });

      expect(res.status).toBe(422);
      // A superseded ADR with nothing recorded as replacing it is the state the register exists
      // to prevent.
      expect(((await res.json()) as { error: string }).error).toContain('linking');
    });

    it('supersedes through the link, which sets the status and draws both edges', async () => {
      const first = await makeAdr('Roll our own OIDC client');
      const second = await makeAdr('Use the published SDK');
      const res = await post('/links', { from: second.humanId, to: first.humanId, kind: 'supersedes' });
      expect(res.status).toBe(200);

      const superseded = await db.adr.findFirstOrThrow({ where: { humanId: first.humanId } });
      expect(superseded.status).toBe('superseded');

      const graph = await get<{
        nodes: { humanId: string }[];
        edges: { from: string; to: string; kind: string }[];
        cycle: string[] | null;
      }>(`/projects/${CODE}/adrs-graph`);

      expect(graph.edges).toContainEqual({
        from: second.humanId,
        to: first.humanId,
        kind: 'supersedes',
      });
      // The inverse edge exists in the table but is not drawn: drawing both would read as a cycle.
      expect(graph.edges.filter((e) => e.kind === 'superseded_by')).toHaveLength(0);
      expect(graph.cycle).toBeNull();
    });

    it('finds a cycle rather than rendering one silently', async () => {
      const a = await makeAdr('A');
      const b = await makeAdr('B');
      await post('/links', { from: a.humanId, to: b.humanId, kind: 'extends' });
      await post('/links', { from: b.humanId, to: a.humanId, kind: 'extends' });

      const graph = await get<{ cycle: string[] | null }>(`/projects/${CODE}/adrs-graph`);
      expect(graph.cycle).not.toBeNull();
      expect(graph.cycle).toContain(a.humanId);
    });
  });

  describe('citations and backlinks (T-4.7, FRM-REQ-067)', () => {
    it('turns a human ID in prose into a backlink', async () => {
      const requirement = await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall be cited.',
      });
      const { humanId } = (await requirement.json()) as { humanId: string };

      await makeDocument([
        { heading: 'Deployment', bodyMd: `This is how ${humanId} is satisfied.` },
      ]);

      const entity = await get<{ backlinks: { title: string; kind: string }[] }>(
        `/entities/${humanId}`,
      );
      expect(entity.backlinks).toHaveLength(1);
      expect(entity.backlinks[0]?.kind).toBe('cites');
      expect(entity.backlinks[0]?.title).toContain('Deployment');
    });

    it('drops the backlink when the mention is edited out', async () => {
      const requirement = await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall be cited, then not.',
      });
      const { humanId } = (await requirement.json()) as { humanId: string };
      const document = await makeDocument([
        { heading: 'Deployment', bodyMd: `Satisfies ${humanId}.` },
      ]);

      await put(`/projects/${CODE}/documents/${document.id}/sections/deployment`, {
        bodyMd: 'It no longer says anything about that.',
      });

      // Citations are re-synced on every write. Appending would fill the panel with links to
      // text that stopped saying anything.
      const entity = await get<{ backlinks: unknown[] }>(`/entities/${humanId}`);
      expect(entity.backlinks).toHaveLength(0);
    });

    it('ignores a human ID inside a code fence', async () => {
      const requirement = await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall not be cited by an example.',
      });
      const { humanId } = (await requirement.json()) as { humanId: string };

      await makeDocument([
        { heading: 'Deployment', bodyMd: `Example:\n\n\`\`\`\nGET /entities/${humanId}\n\`\`\`` },
      ]);

      // An ID in a code sample is an illustration, not a claim about this document.
      const entity = await get<{ backlinks: unknown[] }>(`/entities/${humanId}`);
      expect(entity.backlinks).toHaveLength(0);
    });

    it('stores nothing for a citation of something that does not exist', async () => {
      const document = await makeDocument([
        { heading: 'Deployment', bodyMd: `As ${CODE}-REQ-999 requires.` },
      ]);

      const rows = await db.reference.count({
        where: { fromType: 'document_section', fromId: document.sections[0]?.id ?? '' },
      });
      // A typo is a typo. The prose keeps the text; the graph does not gain a dead edge.
      expect(rows).toBe(0);
    });
  });

  describe('addressed by URI (T-4.9, FRM-REQ-087)', () => {
    it('resolves one section, not the document', async () => {
      await makeDocument();
      const section = await get<{ key: string; markdown: string }>(
        `/projects/${CODE}/documents/at/architecture/sections/deployment`,
      );

      expect(section.key).toBe('deployment');
      expect(section.markdown).toContain('Cloudflare Tunnel');
      // The other section is not in the answer, which is the entire point.
      expect(section.markdown).not.toContain('Thirty-six tables');
    });

    it('resolves the whole document by its kind when that is unambiguous', async () => {
      await makeDocument();
      const document = await get<{ markdown: string }>(
        `/projects/${CODE}/documents/at/architecture`,
      );
      expect(document.markdown).toContain('Cloudflare Tunnel');
      expect(document.markdown).toContain('Thirty-six tables');
    });

    it('gives each of several documents of one kind its own address', async () => {
      for (const title of ['Phase 3 — Traceability', 'Phase 4 — The Record']) {
        await post(`/projects/${CODE}/documents`, {
          kind: 'phase_plan',
          title,
          sections: [{ heading: 'Objective', bodyMd: title }],
        });
      }

      const catalogue = await get<{ items: { uri: string }[] }>(`/projects/${CODE}/resources`);
      const uris = catalogue.items.map((i) => i.uri);
      // An address that silently resolves to whichever plan was written first is worse than a
      // longer one.
      expect(uris).toContain(`foreman://${CODE}/phase-plan-phase-3-traceability`);
      expect(uris).toContain(`foreman://${CODE}/phase-plan-phase-4-the-record`);
    });

    it('names the addresses that do exist when one does not', async () => {
      await makeDocument();
      const res = await api(`/projects/${CODE}/documents/at/nonsense`);
      expect(res.status).toBe(404);
      // A dead end that names the alternatives is the next request rather than a second question.
      expect(((await res.json()) as { error: string }).error).toContain('architecture');
    });

    it('lists every section as its own URI', async () => {
      await makeDocument();
      const catalogue = await get<{ items: { uri: string; description: string }[] }>(
        `/projects/${CODE}/resources`,
      );

      expect(catalogue.items.map((i) => i.uri)).toEqual([
        `foreman://${CODE}/architecture`,
        `foreman://${CODE}/architecture#deployment`,
        `foreman://${CODE}/architecture#data-model`,
      ]);
      // A client that can only see whole documents will fetch whole documents.
      expect(catalogue.items[1]?.description).toContain('Cloudflare Tunnel');
    });
  });

  describe('term occurrences (T-4.8, FRM-REQ-072)', () => {
    it('resolves a term used in a section to its definition', async () => {
      await post(`/projects/${CODE}/terms`, {
        term: 'tripwire',
        definition: 'The named condition that forces a re-plan.',
      });
      await makeDocument([
        { heading: 'Deployment', bodyMd: 'Each risk carries a tripwire that says when to re-plan.' },
      ]);

      const section = await get<{ terms: { term: string; definition: string; count: number }[] }>(
        `/projects/${CODE}/documents/at/architecture/sections/deployment`,
      );
      expect(section.terms).toHaveLength(1);
      expect(section.terms[0]?.definition).toContain('forces a re-plan');
    });

    it('matches an alias, and reports the term once', async () => {
      await post(`/projects/${CODE}/terms`, {
        term: 'human ID',
        definition: 'A project-prefixed identifier.',
        aliases: ['humanId', 'human id'],
      });
      await makeDocument([
        { heading: 'Deployment', bodyMd: 'Every humanId is immutable. A humanId embeds its code.' },
      ]);

      const section = await get<{ terms: { term: string; matched: string; count: number }[] }>(
        `/projects/${CODE}/documents/at/architecture/sections/deployment`,
      );
      // One entry for the term, not one per alias: the reader wants the definition once.
      expect(section.terms).toHaveLength(1);
      expect(section.terms[0]?.term).toBe('human ID');
      expect(section.terms[0]?.matched).toBe('humanId');
      expect(section.terms[0]?.count).toBe(2);
    });

    it('does not resolve a term inside a code span', async () => {
      await post(`/projects/${CODE}/terms`, { term: 'term', definition: 'A glossary entry.' });
      await makeDocument([
        { heading: 'Deployment', bodyMd: 'The `term` column holds it.' },
      ]);

      const section = await get<{ terms: unknown[] }>(
        `/projects/${CODE}/documents/at/architecture/sections/deployment`,
      );
      // In backticks it is an identifier, not the glossary entry.
      expect(section.terms).toHaveLength(0);
    });

    it('leaves the stored markdown exactly as written', async () => {
      await post(`/projects/${CODE}/terms`, { term: 'tripwire', definition: 'A named condition.' });
      const body = 'Each risk carries a tripwire.';
      await makeDocument([{ heading: 'Deployment', bodyMd: body }]);

      const section = await get<{ bodyMd: string }>(
        `/projects/${CODE}/documents/at/architecture/sections/deployment`,
      );
      // Occurrences are a list beside the prose, never links injected into it: rewriting would
      // make the stored text and the rendered text differ, and the next edit is made against
      // whichever one the author was looking at.
      expect(section.bodyMd).toBe(body);
    });
  });

  describe('decisions, risks and the glossary (T-4.6)', () => {
    it('stores a decision with its rationale', async () => {
      const res = await post(`/projects/${CODE}/decisions`, {
        statement: 'Which database?',
        value: 'PostgreSQL 16',
        rationale: 'Every other project here already runs it.',
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { humanId: string }).humanId).toBe(`${CODE}-D-001`);
    });

    it('refuses a risk with no tripwire', async () => {
      const res = await post(`/projects/${CODE}/risks`, { title: 'This might go wrong' });
      expect(res.status).toBe(400);
      // A risk without a named condition is a worry: something you re-read and feel bad about.
      expect(((await res.json()) as { fields: { path: string }[] }).fields[0]?.path).toBe('tripwire');
    });

    it('dates a tripwire when it fires', async () => {
      const created = await post(`/projects/${CODE}/risks`, {
        title: 'The importer drops a file',
        tripwire: 'Any source file appears in no reconciliation row.',
      });
      const { humanId } = (await created.json()) as { humanId: string };

      await patch(`/projects/${CODE}/risks/${humanId}`, { status: 'fired' });

      const risk = await db.risk.findFirstOrThrow({ where: { humanId } });
      expect(risk.status).toBe('fired');
      // "When did we find out" is the question asked afterwards.
      expect(risk.firedAt).not.toBeNull();
    });

    it('shows ecosystem terms in a project glossary', async () => {
      await post(`/projects/${CODE}/terms`, {
        term: 'test-tripwire',
        definition: 'The named condition that forces a re-plan.',
        ecosystem: true,
      });
      await post(`/projects/${CODE}/terms`, {
        term: 'Section key',
        definition: 'The fragment in a resource URI.',
      });

      const glossary = await get<{ items: { term: string; scope: string }[] }>(
        `/projects/${CODE}/glossary`,
      );
      expect(glossary.items.find((t) => t.term === 'test-tripwire')?.scope).toBe('ecosystem');
      expect(glossary.items.find((t) => t.term === 'Section key')?.scope).toBe('project');
    });

    it('lets a project term shadow an ecosystem one', async () => {
      await post(`/projects/${CODE}/terms`, {
        term: 'test-brief',
        definition: 'The ecosystem meaning.',
        ecosystem: true,
      });
      await post(`/projects/${CODE}/terms`, {
        term: 'test-brief',
        definition: 'What this project means by it.',
      });

      const glossary = await get<{ items: { term: string; definition: string }[] }>(
        `/projects/${CODE}/glossary`,
      );
      const entries = glossary.items.filter((t) => t.term === 'test-brief');
      // One entry, and it is the local one: the meaning in force is the one written down here.
      expect(entries).toHaveLength(1);
      expect(entries[0]?.definition).toBe('What this project means by it.');
    });
  });
});
