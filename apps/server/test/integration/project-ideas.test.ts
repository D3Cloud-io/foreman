import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * Project ideas over HTTP (FRM-REQ-159 … FRM-REQ-164, FRM-ADR-015).
 *
 * The one record in Foreman that belongs to no project, which is what most of these assert. Its
 * ID has no code, its path has no code, and the code it will eventually have is asked for exactly
 * once — at conversion, which is the first moment anybody could answer the question.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'project-ideas@example.com';
const PASSWORD = 'a-password-for-the-project-idea-tests';
/** Codes this suite creates by converting. Cleaned up by code, since it invents them. */
const CODES = ['PITA', 'PITB', 'PITC'];

interface Idea {
  id: string;
  humanId: string;
  title: string;
  pitch: string | null;
  status: string;
  reason: string | null;
  convertedAt: string | null;
  project: { code: string; name: string } | null;
}

describe.skipIf(url === undefined)('project ideas', () => {
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
  const create = async (body: unknown): Promise<Idea> => {
    const res = await api('/project-ideas', { method: 'POST', body: JSON.stringify(body) });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as Idea;
  };
  const patch = (humanId: string, body: unknown) =>
    api(`/project-ideas/${humanId}`, { method: 'PATCH', body: JSON.stringify(body) });
  const convert = (humanId: string, body: unknown) =>
    api(`/project-ideas/${humanId}/convert`, { method: 'POST', body: JSON.stringify(body) });

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
      data: { email: EMAIL, displayName: 'Project ideas', status: 'active' },
    });
    await setPassword({ db, config }, user.id, PASSWORD);

    server = await new Promise<Server>((resolve) => {
      const s = createApp({ config, db }).listen(0, () => {
        resolve(s);
      });
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

  afterEach(async () => {
    // By title prefix: these are ecosystem-wide with no project to cascade from, so nothing else
    // cleans them up. The sequence is deliberately *not* reset — a number is never reused.
    await db.projectIdea.deleteMany({ where: { title: { startsWith: 'PIT ' } } });
    await db.project.deleteMany({ where: { code: { in: CODES } } });
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  it('takes one with no project, and gives it a codeless ID', async () => {
    const idea = await create({ title: 'PIT a print notifier', pitch: 'Texts you when it stops.' });

    // The assertion the whole entity exists for: no project code, because there is no project.
    expect(idea.humanId).toMatch(/^PI-\d{3,}$/);
    expect(idea.project).toBeNull();
    expect(idea.status).toBe('new');
  });

  it('numbers them from a sequence that never goes backwards', async () => {
    const first = await create({ title: 'PIT one' });
    const second = await create({ title: 'PIT two' });

    const seqOf = (humanId: string) => Number(humanId.slice('PI-'.length));
    expect(seqOf(second.humanId)).toBe(seqOf(first.humanId) + 1);

    // Deleting the newest does not hand its number back. Every citation of `PI-007` would
    // otherwise start pointing at a different idea (ADR-008).
    await api(`/project-ideas/${second.humanId}`, { method: 'DELETE' });
    const third = await create({ title: 'PIT three' });
    expect(seqOf(third.humanId)).toBe(seqOf(second.humanId) + 1);
  });

  for (const status of ['parked', 'rejected'] as const) {
    it(`refuses ${status} with no reason, and takes it with one`, async () => {
      const idea = await create({ title: 'PIT a second chat client' });

      const bare = await patch(idea.humanId, { status });
      expect(bare.status).toBe(422);
      expect(((await bare.json()) as { fields?: { path: string }[] }).fields?.[0]?.path).toBe(
        'reason',
      );

      const withReason = await patch(idea.humanId, { status, reason: 'D3 Chat already exists.' });
      expect(withReason.status).toBe(200);
      expect(((await withReason.json()) as Idea).reason).toBe('D3 Chat already exists.');
    });
  }

  it('will not let a PATCH claim it was converted', async () => {
    const idea = await create({ title: 'PIT a status page' });

    // `converted` means a project exists. A patch that could set it would produce an idea saying
    // it became something, pointing at nothing — a lie the screen would render as a dead link.
    // 400, not 422: the schema refuses it outright rather than the domain weighing it, which is
    // the stronger of the two — the value is not in the enum the surface accepts at all.
    const res = await patch(idea.humanId, { status: 'converted' });
    expect(res.status).toBe(400);
  });

  it('converts into a project, carrying the pitch across', async () => {
    const idea = await create({
      title: 'PIT a print notifier',
      pitch: 'MQTT on the LAN, the cloud as a fallback.',
    });

    const res = await convert(idea.humanId, { code: 'PITA', name: 'Bambu Print Notifier' });
    expect(res.status, await res.clone().text()).toBe(201);
    const { idea: converted, project } = (await res.json()) as {
      idea: Idea;
      project: { code: string; name: string; pitch: string | null; lifecycle: string };
    };

    expect(project.code).toBe('PITA');
    expect(project.name).toBe('Bambu Print Notifier');
    // The pitch is the reason to write more than a line on an idea: it has somewhere to go.
    expect(project.pitch).toBe('MQTT on the LAN, the cloud as a fallback.');
    expect(project.lifecycle).toBe('planned');

    // And the idea is kept, not consumed. It is the record of where the project came from, which
    // is the one piece of a project's history nothing else writes down.
    expect(converted.status).toBe('converted');
    expect(converted.convertedAt).not.toBeNull();
    expect(converted.project?.code).toBe('PITA');
  });

  it('undoes a conversion by reversing every event it answered with, last-first (FRM-T-18.14)', async () => {
    const idea = await create({ title: 'PIT converted then undone', pitch: 'A pitch that travels.' });
    const res = await convert(idea.humanId, { code: 'PITB', name: 'Undone Conversion' });
    expect(res.status, await res.clone().text()).toBe(201);
    const { auditEventIds } = (await res.json()) as { auditEventIds: string[] };
    expect(auditEventIds.length).toBeGreaterThan(1);

    for (const id of [...auditEventIds].reverse()) {
      const undone = await api(`/undo/${id}`, { method: 'POST' });
      expect(undone.status, await undone.clone().text()).toBe(200);
    }

    const after = (await (await api(`/project-ideas/${idea.humanId}`)).json()) as Idea;
    expect(after.status).toBe('new');
    expect(after.project).toBeNull();
    expect((await api('/projects/PITB')).status).toBe(404);
  });

  it('names the project after the idea when no name is given', async () => {
    const idea = await create({ title: 'PIT an offline notebook' });
    const res = await convert(idea.humanId, { code: 'PITB' });

    expect(res.status).toBe(201);
    const { project } = (await res.json()) as { project: { name: string } };
    expect(project.name).toBe('PIT an offline notebook');
  });

  it('leaves the idea untouched when the code is already taken', async () => {
    await db.project.create({ data: { code: 'PITC', name: 'Already here', slug: 'already-here' } });
    const idea = await create({ title: 'PIT a clash' });

    const res = await convert(idea.humanId, { code: 'PITC' });
    expect(res.status).toBe(409);

    // Half-converted is the failure worth guarding: an idea marked `converted` whose project was
    // never created would be unfixable through any surface, because converting is then refused.
    const after = (await (await api(`/project-ideas/${idea.humanId}`)).json()) as Idea;
    expect(after.status).toBe('new');
    expect(after.project).toBeNull();
  });

  it('refuses to convert the same idea twice', async () => {
    const idea = await create({ title: 'PIT a print notifier' });
    expect((await convert(idea.humanId, { code: 'PITA' })).status).toBe(201);
    expect((await convert(idea.humanId, { code: 'PITB' })).status).toBe(409);
  });

  it('freezes a converted idea, because a project now says what it says', async () => {
    const idea = await create({ title: 'PIT a print notifier' });
    await convert(idea.humanId, { code: 'PITA' });

    const res = await patch(idea.humanId, { title: 'PIT something else entirely' });
    expect(res.status).toBe(409);
  });

  it('refuses `PI` as a project code', async () => {
    // Otherwise `PI-REQ-001` and `PI-001` mean two different things one character apart.
    const res = await api('/projects', {
      method: 'POST',
      body: JSON.stringify({ code: 'PI', name: 'Reserved' }),
    });
    expect(res.status).toBe(400);
  });

  it('is found by its ID and in search, and is undoable when deleted', async () => {
    const idea = await create({ title: 'PIT a findable notion', pitch: 'About webhooks.' });

    const entity = await api(`/entities/${idea.humanId}`);
    expect(entity.status).toBe(200);
    const resolved = (await entity.json()) as { type: string; projectCode: string | null };
    expect(resolved.type).toBe('project_idea');
    // Null rather than absent: the field means "which project", and the answer is "none".
    expect(resolved.projectCode).toBeNull();

    const found = await api('/search?q=findable%20notion&types=project_idea');
    const hits = ((await found.json()) as { items: { humanId: string }[] }).items;
    expect(hits.map((h) => h.humanId)).toContain(idea.humanId);

    await api(`/project-ideas/${idea.humanId}`, { method: 'DELETE' });
    const events = await db.auditEvent.findMany({
      where: { entityId: idea.id, action: 'delete' },
    });
    expect(events).toHaveLength(1);

    const undone = await api(`/undo/${events[0]?.id ?? ''}`, { method: 'POST' });
    expect(undone.status, await undone.clone().text()).toBe(200);
    expect((await api(`/project-ideas/${idea.humanId}`)).status).toBe(200);
  });

  // ── The canvas (FRM-ADR-017) ────────────────────────────────────────────────

  describe('the canvas', () => {
    interface Detail extends Idea {
      related: string[];
      problem: string | null;
      approach: string | null;
      risks: string | null;
      notes: string | null;
      excitement: number | null;
      tags: string[];
      questions: { id: string; text: string; done: boolean }[];
      links: { id: string; label: string; url: string }[];
      maturity: { filled: number; total: number };
    }
    const detail = async (humanId: string): Promise<Detail> =>
      (await (await api(`/project-ideas/${humanId}`)).json()) as Detail;

    it('holds named sections, and an empty one clears rather than counting as written', async () => {
      const idea = await create({ title: 'PIT a canvas', problem: 'Invoices are keyed twice.' });
      expect((await detail(idea.humanId)).problem).toBe('Invoices are keyed twice.');

      // The console sends '' when somebody deletes a section's text. Stored as '', it would count
      // as written to anything that checked for null — and the maturity bar would lie.
      await patch(idea.humanId, { problem: '   ' });
      expect((await detail(idea.humanId)).problem).toBeNull();
    });

    it('counts how much of the thinking is written down', async () => {
      const idea = await create({
        title: 'PIT maturing',
        pitch: 'A line.',
        problem: 'A problem.',
        approach: 'A sketch.',
        // The scratchpad is not counted: a full scratchpad is activity, not understanding.
        notes: 'Pasted a great deal of text here.',
      });
      expect((await detail(idea.humanId)).maturity).toEqual({ filled: 3, total: 6 });

      // A write answers in the same shape as a read. The console swaps its copy for this one, so
      // a patch response without maturity is a page that breaks on its first save.
      const patched = (await (await patch(idea.humanId, { risks: 'Scope creep.' })).json()) as Detail;
      expect(patched.maturity).toEqual({ filled: 4, total: 6 });

      const list = (await (await api('/project-ideas')).json()) as {
        items: (Idea & { maturity: { filled: number }; problem?: string })[];
      };
      const row = list.items.find((i) => i.humanId === idea.humanId);
      // Four now: the list agrees with the patch that just added the risks.
      expect(row?.maturity.filled).toBe(4);
      // The list knows *whether* each section is written, not what it says. Forty ideas each
      // carrying six essays is a payload for nothing.
      expect(row && 'problem' in row).toBe(false);
    });

    it('normalises tags, so one tag does not become three', async () => {
      const idea = await create({
        title: 'PIT tagged',
        tags: ['Hardware', 'hardware', ' home lab '],
      });
      expect((await detail(idea.humanId)).tags).toEqual(['hardware', 'home-lab']);
    });

    it('keeps checklists and links, and refuses a link that is not a URL', async () => {
      const idea = await create({
        title: 'PIT listed',
        questions: [
          { id: 'q1', text: 'Does the printer expose MQTT locally?', done: true },
          { id: 'q2', text: 'Is Twilio the cheapest SMS route?', done: false },
        ],
        links: [{ id: 'l1', label: 'Bambu MQTT notes', url: 'https://example.com/mqtt' }],
      });
      const d = await detail(idea.humanId);
      expect(d.questions.map((q) => q.done)).toEqual([true, false]);
      expect(d.links[0]?.label).toBe('Bambu MQTT notes');

      const bad = await patch(idea.humanId, {
        links: [{ id: 'l2', label: 'nope', url: 'not a url' }],
      });
      expect(bad.status).toBe(400);
    });

    it('relates to a project, a requirement or another idea — and nothing else', async () => {
      const idea = await create({ title: 'PIT related', related: ['BND', 'BND-REQ-012', 'PI-003'] });
      expect((await detail(idea.humanId)).related).toEqual(['BND', 'BND-REQ-012', 'PI-003']);
      // Something that is none of those is a typo, and storing it would render as a dead link.
      expect((await patch(idea.humanId, { related: ['not an id'] })).status).toBe(400);
    });

    it('refuses an excitement outside one to five', async () => {
      const idea = await create({ title: 'PIT keen' });
      expect((await patch(idea.humanId, { excitement: 6 })).status).toBe(400);
      expect((await patch(idea.humanId, { excitement: 4 })).status).toBe(200);
      // And clears with null, which is "I have not decided how I feel", not zero.
      expect((await patch(idea.humanId, { excitement: null })).status).toBe(200);
      expect((await detail(idea.humanId)).excitement).toBeNull();
    });

    it('is found by what is written on it, not only by its title', async () => {
      const idea = await create({ title: 'PIT unmemorable', risks: 'The zeppelin quota may run out.' });
      const found = await api('/search?q=zeppelin&types=project_idea');
      const hits = ((await found.json()) as { items: { humanId: string; snippet: string }[] }).items;
      const hit = hits.find((h) => h.humanId === idea.humanId);
      // And the snippet shows the risk — why it matched — rather than the empty pitch.
      expect(hit?.snippet.toLowerCase()).toContain('zeppelin');
    });

    it('keeps a thoughts log you can reword', async () => {
      const idea = await create({ title: 'PIT thought about' });
      const made = await api(`/project-ideas/${idea.humanId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: 'First pass at the shape.' }),
      });
      expect(made.status).toBe(201);
      const { id } = (await made.json()) as { id: string };

      const edited = await api(`/project-ideas/${idea.humanId}/comments/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body: 'Second pass: it is really two products.' }),
      });
      expect(edited.status).toBe(200);

      const log = (await (await api(`/project-ideas/${idea.humanId}/comments`)).json()) as {
        items: { body: string }[];
      };
      expect(log.items.map((t) => t.body)).toEqual(['Second pass: it is really two products.']);
    });

    it('hands the canvas to the new project as its discovery document', async () => {
      const idea = await create({
        title: 'PIT a print notifier',
        pitch: 'Texts you when a print finishes.',
        problem: 'You come back to a failed print an hour later.',
        approach: '```mermaid\ngraph LR\n  printer --> mqtt --> sms\n```',
        questions: [{ id: 'q1', text: 'Local MQTT or cloud?', done: false }],
      });
      await api(`/project-ideas/${idea.humanId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: 'Start with LAN only.' }),
      });

      const res = await convert(idea.humanId, { code: 'PITA' });
      expect(res.status, await res.clone().text()).toBe(201);
      const { brief } = (await res.json()) as { brief: { id: string; title: string } | null };
      // Without this the thinking stays on a frozen record beside the project instead of inside
      // it, and the first planning session starts from a title.
      expect(brief?.title).toBe('Idea brief — PIT a print notifier');

      const docs = (await (await api('/projects/PITA/documents')).json()) as {
        items: { kind: string; sections: { heading: string }[] }[];
      };
      const doc = docs.items.find((d) => d.kind === 'discovery');
      expect(doc?.sections.map((x) => x.heading)).toEqual([
        'Pitch',
        'The problem',
        'How it might work',
        'Open questions',
        'Thoughts',
      ]);
    });
  });
});
