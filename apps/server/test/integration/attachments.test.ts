import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { copyBlobs } from '../../src/jobs/backup.js';

/**
 * Attachments over HTTP (FRM-ADR-026, FRM-REQ-252 … FRM-REQ-258).
 *
 * The claims: a file lands on the entity it was sent to, its bytes once in the blob store whichever
 * entities carry it; only a PDF, an image or a named text file under the cap gets in, decided from
 * the bytes; it is served back only to a reader, with headers that stop a browser treating it as a
 * page; deleting it hides it and keeps everything, so Undo and Restore bring it back; an upload
 * link files exactly one file, once; and the backup copies what an attachment names.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'attachments@example.com';
const PASSWORD = 'a-password-for-the-attachment-tests';
const CODE = 'ATTST';
/** Small, so "over the cap" is a few kilobytes rather than twenty-five megabytes in a test. */
const CAP = 8192;

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const RUN = String(Date.now());

/** A real signature, then filler that makes each run's bytes its own. */
const PDF = Buffer.from(`%PDF-1.7\n% attachment test ${RUN}\n%%EOF\n`);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(`attachment png ${RUN}`),
]);
const GIF = Buffer.from(`GIF89a attachment gif ${RUN}`);
const MARKDOWN = Buffer.from(`# Living Town\n\nA design note, run ${RUN}.\n`);
const HTML = Buffer.from(`<html><script>alert(${RUN})</script></html>`);

interface AttachmentBody {
  id: string;
  humanId: string;
  name: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  entity: { type: string; humanId: string };
  uploadedBy: string;
  deletedAt: string | null;
  url: string;
  contentUrl: string;
  auditEventIds?: string[];
}

describe.skipIf(url === undefined)('attachments', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;
  let blobDir: string;
  let readToken: string;
  let writeToken: string;
  let idea: string;
  let task: string;

  const auth = (token: string | null) => (token === null ? {} : { authorization: `Bearer ${token}` });
  const form = (bytes: Uint8Array, name: string, type = 'application/octet-stream') => {
    const body = new FormData();
    body.append('file', new File([bytes], name, { type }));
    return body;
  };
  const upload = (entity: string, body: FormData, token: string | null = writeToken) =>
    fetch(`${origin}/api/attachments?entity=${encodeURIComponent(entity)}`, {
      method: 'POST',
      body,
      headers: auth(token),
    });
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the body it expects
  const json = async <T>(path: string, init: RequestInit = {}, token: string | null = writeToken) => {
    const res = await fetch(`${origin}${path}`, {
      ...init,
      headers: { ...auth(token), 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: (text === '' ? null : JSON.parse(text)) as T };
  };
  const attachOk = async (entity: string, bytes: Buffer, name: string): Promise<AttachmentBody> => {
    const res = await upload(entity, form(bytes, name));
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as AttachmentBody;
  };

  beforeAll(async () => {
    blobDir = await mkdtemp(join(tmpdir(), 'foreman-attachments-'));
    const config: Config = loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'http://localhost:3200',
      DATABASE_URL: url ?? '',
      KEK: Buffer.alloc(32, 1).toString('base64'),
      PEPPER: Buffer.alloc(32, 2).toString('base64'),
      COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
      FOREMAN_BLOB_DIR: blobDir,
      FOREMAN_ATTACHMENT_MAX_BYTES: String(CAP),
    });
    db = createDb(url ?? '');

    await db.user.deleteMany({ where: { email: EMAIL } });
    const user = await db.user.create({ data: { email: EMAIL, displayName: 'Attachments', status: 'active' } });
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

    const mint = async (name: string, scopes: string[]) => {
      const res = await fetch(`${origin}/api/tokens`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name, scopes }),
      });
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { token: string }).token;
    };
    readToken = await mint('attachments read', ['read']);
    writeToken = await mint('attachments write', ['read', 'write']);

    // Somewhere to file things: a project idea, and a task in a disposable project.
    await db.attachment.deleteMany({ where: { entityHumanId: { startsWith: CODE } } });
    await db.project.deleteMany({ where: { code: CODE } });
    const project = await json('/api/projects', { method: 'POST', body: JSON.stringify({ code: CODE, name: 'Attachment tests' }) });
    expect(project.status, JSON.stringify(project.body)).toBe(201);
    const created = await json<{ humanId: string }>('/api/projects/' + CODE + '/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'Somewhere to file a spec' }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    task = created.body.humanId;
    const pi = await json<{ humanId: string }>('/api/project-ideas', {
      method: 'POST',
      body: JSON.stringify({ title: `ATTT Living Town ${RUN}` }),
    });
    expect(pi.status).toBe(201);
    idea = pi.body.humanId;
  });

  afterAll(async () => {
    // Every event these tests wrote: PI- numbers are reused in a test database, and a stray event
    // would turn up in another test's history of a different idea with the same number.
    await db.auditEvent.deleteMany({ where: { actor: { in: ['attachments write', 'attachments read', EMAIL] } } });
    await db.attachmentTicket.deleteMany({ where: { actor: { startsWith: 'attachments ' } } });
    await db.attachment.deleteMany({ where: { uploadedBy: { startsWith: 'attachments ' } } });
    await db.blob.deleteMany({ where: { sha256: { in: [PDF, PNG, GIF, MARKDOWN, HTML].map(sha) } } });
    await db.projectIdea.deleteMany({ where: { title: { startsWith: 'ATTT ' } } });
    await db.task.deleteMany({ where: { project: { code: CODE } } });
    await db.project.deleteMany({ where: { code: CODE } });
    await db.apiToken.deleteMany({ where: { name: { startsWith: 'attachments ' } } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await rm(blobDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  it('files a PDF on a project idea: an ATT- ID, its metadata, the bytes once on disk, one audit event (FRM-REQ-252)', async () => {
    const created = await attachOk(idea, PDF, 'living-town-design.pdf');
    expect(created.humanId).toMatch(/^ATT-\d{3,}$/);
    expect(created).toMatchObject({
      name: 'living-town-design.pdf',
      mediaType: 'application/pdf',
      byteSize: PDF.length,
      sha256: sha(PDF),
      entity: { type: 'project_idea', humanId: idea },
      uploadedBy: 'attachments write',
      deletedAt: null,
      url: `/api/attachments/${created.humanId}`,
      contentUrl: `/api/attachments/${created.humanId}/content`,
    });
    expect(created.auditEventIds).toHaveLength(1);
    expect(await readdir(blobDir)).toContain(sha(PDF));

    const events = await db.auditEvent.findMany({ where: { entityType: 'attachment', entityId: created.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'create', entityHumanId: created.humanId, actor: 'attachments write' });

    // Listed under the idea, and on the idea's own read — which is what `foreman_get PI-015` shows.
    const list = await json<{ items: AttachmentBody[]; maxBytes: number }>(`/api/attachments?entity=${idea}`, {}, readToken);
    expect(list.status).toBe(200);
    expect(list.body.items.map((a) => a.humanId)).toEqual([created.humanId]);
    expect(list.body.maxBytes).toBe(CAP);
    const entity = await json<{ attachments: { humanId: string; name: string }[] }>(`/api/entities/${idea}`, {}, readToken);
    expect(entity.body.attachments).toEqual([
      expect.objectContaining({ humanId: created.humanId, name: 'living-town-design.pdf', mediaType: 'application/pdf' }),
    ]);
    // And the attachment reads by its own ID through the same door as everything else.
    const byId = await json<{ type: string }>(`/api/entities/${created.humanId}`, {}, readToken);
    expect(byId.body.type).toBe('attachment');
  });

  it('stores the same bytes once however many entities carry them', async () => {
    const onIdea = await attachOk(idea, PNG, 'sketch.png');
    const onTask = await attachOk(task, PNG, 'the-same-sketch.png');
    expect(onTask.humanId).not.toBe(onIdea.humanId);
    expect(onTask.entity).toEqual({ type: 'task', humanId: task });
    expect(await db.blob.count({ where: { sha256: sha(PNG) } })).toBe(1);
    expect((await readdir(blobDir)).filter((f) => f === sha(PNG))).toHaveLength(1);
  });

  it('files on a project by its bare code', async () => {
    const created = await attachOk(CODE, MARKDOWN, 'notes.md');
    expect(created.entity).toEqual({ type: 'project', humanId: CODE });
    expect(created.mediaType).toBe('text/markdown');
  });

  it('serves the bytes to a reader inline or as a download, with headers that keep it from being a page (FRM-REQ-255)', async () => {
    const pdf = await attachOk(idea, PDF, 'inline.pdf');
    const inline = await fetch(`${origin}${pdf.contentUrl}`, { headers: auth(readToken) });
    expect(inline.status).toBe(200);
    expect(Buffer.compare(Buffer.from(await inline.arrayBuffer()), PDF)).toBe(0);
    expect(inline.headers.get('content-type')).toBe('application/pdf');
    expect(inline.headers.get('x-content-type-options')).toBe('nosniff');
    expect(inline.headers.get('content-disposition')).toMatch(/^inline; filename="inline.pdf"/);
    expect(inline.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    expect(inline.headers.get('etag')).toBe(`"${sha(PDF)}"`);

    const saved = await fetch(`${origin}${pdf.contentUrl}?download=1`, { headers: auth(readToken) });
    expect(saved.headers.get('content-disposition')).toMatch(/^attachment; /);

    const again = await fetch(`${origin}${pdf.contentUrl}`, { headers: { ...auth(readToken), 'if-none-match': `"${sha(PDF)}"` } });
    expect(again.status).toBe(304);

    const md = await attachOk(idea, MARKDOWN, 'Design — ünïcode.md');
    const text = await fetch(`${origin}${md.contentUrl}`, { headers: auth(readToken) });
    expect(text.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    // Text runs sandboxed with nothing allowed, so a page renamed `.md` can never script the console.
    expect(text.headers.get('content-security-policy')).toMatch(/^sandbox; default-src 'none'/);
    expect(text.headers.get('content-disposition')).toContain(`filename*=UTF-8''${encodeURIComponent('Design — ünïcode.md')}`);

    const anonymous = await fetch(`${origin}${pdf.contentUrl}`);
    expect(anonymous.status).toBe(401);
  });

  it('decides the type from the bytes, and refuses what is not allowed with 415, keeping nothing (FRM-REQ-253)', async () => {
    const before = await db.attachment.count();
    // A page calling itself a PDF is a page.
    const lying = await upload(idea, form(HTML, 'deck.pdf', 'application/pdf'));
    expect(lying.status).toBe(415);
    expect(((await lying.json()) as { allowed: string[] }).allowed).toContain('application/pdf');
    // Valid UTF-8 is text only under a text name: a script is not let in as "text".
    expect((await upload(idea, form(HTML, 'page.html', 'text/plain'))).status).toBe(415);
    expect((await upload(idea, form(Buffer.from('console.log(1)'), 'run.js', 'text/plain'))).status).toBe(415);
    // A binary renamed `.txt` is not text.
    expect((await upload(idea, form(Buffer.from([0x41, 0x00, 0x42]), 'notes.txt'))).status).toBe(415);
    expect(await db.attachment.count()).toBe(before);
    expect(await db.blob.count({ where: { sha256: sha(HTML) } })).toBe(0);

    // A GIF is an image here, unlike a screen's proposal.
    expect((await attachOk(idea, GIF, 'loop.gif')).mediaType).toBe('image/gif');
    // And a PDF with no extension at all is still a PDF.
    expect((await attachOk(idea, PDF, 'scan')).mediaType).toBe('application/pdf');
  });

  it('refuses a file over the cap with 413, and keeps nothing (FRM-REQ-253)', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(CAP + 1, 0x41)]);
    const res = await upload(idea, form(big, 'huge.pdf'));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { maxBytes: number }).maxBytes).toBe(CAP);
    expect(await db.blob.count({ where: { sha256: sha(big) } })).toBe(0);
  });

  it('needs write to attach and read to see, and refuses what cannot carry a file', async () => {
    expect((await upload(idea, form(PDF, 'a.pdf'), null)).status).toBe(401);
    expect((await upload(idea, form(PDF, 'a.pdf'), readToken)).status).toBe(403);
    expect((await upload('PI-999999', form(PDF, 'a.pdf'))).status).toBe(404);
    // An idea, a finding or a guideline does not carry files (FRM-ADR-026): 400 from the query.
    expect((await upload(`${CODE}-IDEA-001`, form(PDF, 'a.pdf'))).status).toBe(400);
    expect((await json('/api/attachments?entity=GL-001', {}, readToken)).status).toBe(400);
    expect((await json(`/api/attachments?entity=${idea}`, {}, null)).status).toBe(401);
  });

  it('refuses ATT as a project code: it prefixes attachments', async () => {
    const res = await json('/api/projects', { method: 'POST', body: JSON.stringify({ code: 'ATT', name: 'Nope' }) });
    expect(res.status).toBe(400);
  });

  it('deletes softly — hidden, bytes kept — and Restore and Undo both bring it back (FRM-REQ-254)', async () => {
    const created = await attachOk(task, PDF, 'to-delete.pdf');

    const deleted = await fetch(`${origin}${created.url}`, { method: 'DELETE', headers: auth(writeToken) });
    expect(deleted.status).toBe(204);
    const deletion = deleted.headers.get('audit-event-id');
    expect(deletion).not.toBeNull();

    // Gone from the list, the read and the content; still a row, and the bytes still on disk.
    const listed = await json<{ items: AttachmentBody[] }>(`/api/attachments?entity=${task}`, {}, readToken);
    expect(listed.body.items.map((a) => a.humanId)).not.toContain(created.humanId);
    expect((await fetch(`${origin}${created.contentUrl}`, { headers: auth(readToken) })).status).toBe(404);
    expect((await db.attachment.findUnique({ where: { id: created.id } }))?.deletedAt).not.toBeNull();
    expect(await readdir(blobDir)).toContain(sha(PDF));

    // Listed among the deleted when asked — that is where Restore is offered.
    const withDeleted = await json<{ items: AttachmentBody[] }>(`/api/attachments?entity=${task}&deleted=true`, {}, readToken);
    expect(withDeleted.body.items.find((a) => a.humanId === created.humanId)?.deletedAt).not.toBeNull();

    const restored = await json<AttachmentBody>(`${created.url}/restore`, { method: 'POST' });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body.deletedAt).toBeNull();
    expect((await fetch(`${origin}${created.contentUrl}`, { headers: auth(readToken) })).status).toBe(200);
    // Restoring what is not deleted is a conflict, not a silent success.
    expect((await json(`${created.url}/restore`, { method: 'POST' })).status).toBe(409);

    // And the ordinary undo of a delete works on it like on any other record.
    const again = await fetch(`${origin}${created.url}`, { method: 'DELETE', headers: auth(writeToken) });
    const undo = await json(`/api/undo/${again.headers.get('audit-event-id') ?? ''}`, { method: 'POST' });
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    expect((await db.attachment.findUnique({ where: { id: created.id } }))?.deletedAt).toBeNull();

    // Undoing the upload itself deletes it, softly.
    const upload = await db.auditEvent.findFirst({ where: { entityId: created.id, action: 'create' } });
    expect((await json(`/api/undo/${upload?.id ?? ''}`, { method: 'POST' })).status).toBe(200);
    expect((await db.attachment.findUnique({ where: { id: created.id } }))?.deletedAt).not.toBeNull();
  });

  describe('upload links (FRM-REQ-256)', () => {
    const mintTicket = (entity: string, name: string, token = writeToken) =>
      json<{ uploadUrl: string; expiresAt: string; name: string; maxBytes: number }>(
        '/api/attachments/tickets',
        { method: 'POST', body: JSON.stringify({ entity, name }) },
        token,
      );
    /** The link's path on this test server: BASE_URL is a placeholder origin. */
    const put = (uploadUrl: string, bytes: Buffer) =>
      fetch(`${origin}${new URL(uploadUrl).pathname}`, { method: 'PUT', body: bytes });

    it('files exactly one file, as whoever asked for the link, and is spent by it', async () => {
      const ticket = await mintTicket(idea, '/Users/someone/Desktop/Living Town.pdf');
      expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
      // The name is the last path segment: the caller's directories are nobody's business.
      expect(ticket.body.name).toBe('Living Town.pdf');
      expect(ticket.body.maxBytes).toBe(CAP);
      expect(ticket.body.uploadUrl).toMatch(/^http:\/\/localhost:3200\/uploads\/frmup_/);
      expect(Date.parse(ticket.body.expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);

      // Minting is audited, and the secret is not in the record.
      const minted = await db.auditEvent.findFirst({ where: { entityType: 'attachment_ticket', actor: 'attachments write' }, orderBy: { createdAt: 'desc' } });
      expect(minted?.after).toMatchObject({ entity: idea, name: 'Living Town.pdf' });
      expect(JSON.stringify(minted?.after)).not.toContain('frmup_');
      // A link is not a change to the idea: it stays out of the idea's History.
      expect(minted?.entityHumanId).toBeNull();

      const first = await put(ticket.body.uploadUrl, PDF);
      expect(first.status, await first.clone().text()).toBe(201);
      const filed = (await first.json()) as AttachmentBody;
      expect(filed).toMatchObject({ name: 'Living Town.pdf', mediaType: 'application/pdf', uploadedBy: 'attachments write' });
      expect(filed.entity.humanId).toBe(idea);

      const second = await put(ticket.body.uploadUrl, PNG);
      expect(second.status).toBe(410);
    });

    it('refuses a wrong type without spending the link, an unknown or expired link with 410', async () => {
      const ticket = await mintTicket(task, 'spec.pdf');
      expect((await put(ticket.body.uploadUrl, HTML)).status).toBe(415);
      expect((await put(ticket.body.uploadUrl, PDF)).status).toBe(201);

      expect((await fetch(`${origin}/uploads/frmup_nothing-like-a-real-one`, { method: 'PUT', body: PDF })).status).toBe(410);

      const stale = await mintTicket(task, 'late.pdf');
      await db.attachmentTicket.updateMany({ where: { name: 'late.pdf', usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await put(stale.body.uploadUrl, PDF)).status).toBe(410);
    });

    it('needs write to mint, and a link over the cap is 413', async () => {
      expect((await mintTicket(idea, 'x.pdf', readToken)).status).toBe(403);
      const ticket = await mintTicket(idea, 'big.pdf');
      const res = await put(ticket.body.uploadUrl, Buffer.concat([PDF, Buffer.alloc(CAP + 1, 0x41)]));
      expect(res.status).toBe(413);
    });
  });

  it('is in the backup set: every attachment names a blob, and the blob copy carries its file (FRM-REQ-258)', async () => {
    const created = await attachOk(idea, PDF, 'backed-up.pdf');
    const dest = join(await mkdtemp(join(tmpdir(), 'foreman-attachments-set-')), 'set.blobs');
    await mkdir(dest, { recursive: true });
    await copyBlobs(blobDir, dest);
    expect(await readdir(dest)).toContain(created.sha256);
    // The foreign key is what makes the drill's check enough: no attachment can name a blob row
    // that does not exist, and the drill hashes the file behind every blob row.
    const orphans = await db.$queryRaw<{ n: number }[]>`
      select count(*)::int as n from attachment a left join blob b on b.sha256 = a.blob_sha256 where b.id is null`;
    expect(orphans[0]?.n).toBe(0);
    await rm(dest, { recursive: true, force: true });
  });
});
