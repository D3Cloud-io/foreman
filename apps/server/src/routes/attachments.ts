import { pipeline } from 'node:stream/promises';
import {
  ATTACHMENT_TYPES_SENTENCE,
  AttachmentListQuery,
  AttachmentTicketCreate,
  AttachmentUploadQuery,
} from '@foreman/shared';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { requireAuth, requireScope, reviews } from '../auth/middleware.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import {
  ALLOWED_ATTACHMENT_TYPES,
  attach,
  attachmentName,
  attachmentsOn,
  attachWithTicket,
  createTicket,
  deleteAttachment,
  findAttachment,
  openAttachment,
  resolveTarget,
  restoreAttachment,
  sniffAttachment,
  targetOf,
  ticketFor,
  TicketGone,
  type AttachTargetRow,
} from '../domain/attachments.js';
import { actorOf, handler, param, parseBody, parseQuery } from './helpers.js';
import { noContentWithEvents } from './undo.js';

/**
 * Attachments over HTTP (FRM-ADR-026, FRM-REQ-252 … FRM-REQ-256).
 *
 * - `GET    /api/attachments?entity=PI-015[&deleted=true]` — what is filed on one entity
 * - `POST   /api/attachments?entity=PI-015` — one file, multipart, in the `file` part
 * - `GET    /api/attachments/:id` — one attachment's metadata
 * - `GET    /api/attachments/:id/content[?download=1]` — its bytes, inline or as a download
 * - `DELETE /api/attachments/:id` — soft; 204 with the audit events in the headers, as every delete
 * - `POST   /api/attachments/:id/restore` — the undo of its newest deletion, by name
 * - `POST   /api/attachments/tickets` — a one-use upload link (`PUT /uploads/:token`)
 *
 * Reads need `read`, writes `write`, like every other route. On a board (ADR-016) a submitter may
 * file on, and remove from, only their own submission; everything else is a reviewer's or an
 * admin's — the same line the project-idea routes draw.
 */

const FIELD = 'file';

/** Who may add to or remove from what is filed on this entity. */
function mayChange(config: Config, req: Request, target: AttachTargetRow): boolean {
  if (reviews(config, req.auth)) return true;
  return target.type === 'project_idea' && target.submittedById !== null && target.submittedById === req.auth?.userId;
}

const forbidden = (res: Response) => {
  res.status(403).json({ error: 'only a reviewer, or the person who submitted it, can change what is attached here' });
};

/** RFC 6266: an ASCII fallback for old clients, and the real name, percent-encoded, for the rest. */
function disposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * What a browser may do with the bytes it is handed (FRM-REQ-255). Text runs in a sandbox with
 * nothing allowed, so a `.md` that is really a page can never script the console's origin. A PDF
 * cannot take `sandbox` — Chrome's viewer refuses to render under it — so it gets everything else.
 * Every type may be framed by the console and by nobody else.
 */
function contentPolicy(mediaType: string): string {
  if (mediaType.startsWith('text/')) return "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'";
  if (mediaType.startsWith('image/')) return "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'";
  return "frame-ancestors 'self'";
}

export function attachmentRoutes(db: Db, config: Config): Router {
  const router = Router();
  // First, so an anonymous request is refused before a byte of its body is parsed (FRM-REQ-028).
  router.use(requireAuth);
  const canRead = requireScope(db, 'read');
  const canWrite = requireScope(db, 'write');
  const cap = config.FOREMAN_ATTACHMENT_MAX_BYTES;

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: cap, files: 1, fields: 16, fieldSize: 1024 },
  }).single(FIELD);

  /** Multer's refusals in HTTP, the blob route's way: too big is 413, anything else malformed 400. */
  const receive = (req: Request, res: Response, next: NextFunction): void => {
    upload(req, res, (error: unknown) => {
      if (error === undefined || error === null) {
        next();
        return;
      }
      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: `the file is larger than ${String(cap)} bytes`, maxBytes: cap });
          return;
        }
        res.status(400).json({ error: `send exactly one file, in the \`${FIELD}\` field` });
        return;
      }
      res.status(400).json({ error: 'the request body is not valid multipart/form-data' });
    });
  };

  router.get(
    '/',
    canRead,
    handler(async (req, res) => {
      const query = parseQuery(AttachmentListQuery, req, res);
      if (query === null) return;
      const target = await resolveTarget(db, query.entity);
      const items = await attachmentsOn(db, target, { deleted: query.deleted });
      res.json({ items, nextCursor: null, total: items.length, maxBytes: cap, allowed: ALLOWED_ATTACHMENT_TYPES });
    }),
  );

  router.post(
    '/',
    canWrite,
    // The entity is checked before the body is read: a refusal costs nothing, and a 404 or 403
    // never waits on 25 MB it was always going to throw away.
    handler(async (req, res) => {
      const query = parseQuery(AttachmentUploadQuery, req, res);
      if (query === null) return;
      const target = await resolveTarget(db, query.entity);
      if (!mayChange(config, req, target)) {
        forbidden(res);
        return;
      }
      // Multer answers its own refusals; `false` means it already has.
      const received = await new Promise<boolean>((resolve) => {
        res.once('finish', () => {
          resolve(false);
        });
        receive(req, res, () => {
          resolve(true);
        });
      });
      if (!received || res.headersSent) return;

      const extra = Object.keys((req.body ?? {}) as Record<string, unknown>);
      if (extra.length > 0) {
        res.status(400).json({
          error: `not a field this stores, so it would be lost: ${extra.join(', ')}`,
          fields: extra.map((path) => ({ path, message: 'not a field this stores — it would be lost, so it is refused' })),
        });
        return;
      }
      const file = req.file;
      if (file === undefined) {
        res.status(400).json({ error: `send the file as multipart/form-data, in the \`${FIELD}\` field` });
        return;
      }
      // Multer hands the part's filename over as latin1; browsers and curl send UTF-8.
      const name = attachmentName(Buffer.from(file.originalname, 'latin1').toString('utf8'));
      const mediaType = sniffAttachment(file.buffer, name);
      if (mediaType === null) {
        res.status(415).json({
          error: `not an accepted type; ${ATTACHMENT_TYPES_SENTENCE}`,
          allowed: ALLOWED_ATTACHMENT_TYPES,
        });
        return;
      }
      const result = await attach(db, actorOf(req), config.FOREMAN_BLOB_DIR, target, {
        bytes: file.buffer,
        name,
        mediaType,
      });
      res.status(201).json({ ...result.attachment, auditEventIds: result.auditEventIds });
    }),
  );

  router.post(
    '/tickets',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(AttachmentTicketCreate, req, res);
      if (body === null) return;
      const target = await resolveTarget(db, body.entity);
      if (!mayChange(config, req, target)) {
        forbidden(res);
        return;
      }
      const ticket = await createTicket(db, actorOf(req), config.BASE_URL, cap, target, body.name);
      res.status(201).json(ticket);
    }),
  );

  router.get(
    '/:humanId',
    canRead,
    handler(async (req, res) => {
      res.json(await findAttachment(db, param(req, 'humanId')));
    }),
  );

  router.get(
    '/:humanId/content',
    canRead,
    handler(async (req, res) => {
      const { attachment, blob } = await openAttachment(db, config.FOREMAN_BLOB_DIR, param(req, 'humanId'));
      const download = req.query['download'] === '1' || req.query['download'] === 'true';
      res.setHeader(
        'Content-Type',
        attachment.mediaType.startsWith('text/') ? `${attachment.mediaType}; charset=utf-8` : attachment.mediaType,
      );
      res.setHeader('Content-Length', String(blob.byteSize));
      res.setHeader('Content-Disposition', disposition(download ? 'attachment' : 'inline', attachment.name));
      // The type was sniffed, and the browser must not second-guess it into HTML.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', contentPolicy(attachment.mediaType));
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      // The bytes behind an attachment never change, but a deleted one must stop being served, so
      // the reader's cache revalidates every time — cheaply, against the hash.
      res.setHeader('ETag', `"${attachment.sha256}"`);
      res.setHeader('Cache-Control', 'private, no-cache');
      if (req.headers['if-none-match'] === `"${attachment.sha256}"`) {
        blob.stream.destroy();
        res.status(304).end();
        return;
      }
      await pipeline(blob.stream, res);
    }),
  );

  router.delete(
    '/:humanId',
    canWrite,
    handler(async (req, res) => {
      const humanId = param(req, 'humanId');
      const attachment = await findAttachment(db, humanId);
      if (!mayChange(config, req, await targetOf(db, attachment))) {
        forbidden(res);
        return;
      }
      const { auditEventIds } = await deleteAttachment(db, actorOf(req), humanId);
      noContentWithEvents(res, auditEventIds);
    }),
  );

  router.post(
    '/:humanId/restore',
    canWrite,
    handler(async (req, res) => {
      const humanId = param(req, 'humanId');
      const attachment = await findAttachment(db, humanId, { deleted: true });
      if (!mayChange(config, req, await targetOf(db, attachment))) {
        forbidden(res);
        return;
      }
      const result = await restoreAttachment(db, actorOf(req), humanId);
      res.json({ ...result.attachment, auditEventIds: result.auditEventIds });
    }),
  );

  return router;
}

/**
 * `PUT /uploads/:token` — the other end of an upload link (FRM-REQ-256).
 *
 * Outside `/api`, because it takes no session and no token: the link is the credential. It is 32
 * random bytes, kept only as a hash, bound to one name on one entity, fifteen minutes long, and
 * spent by the first upload that lands — the same shape as a presigned object-store URL, and for
 * the same reason. It can only ever *add* one file; it reads nothing and lists nothing.
 *
 * The body is the raw file (`curl -T <file> <url>`), so nothing is base64 and no form is parsed.
 */
export function uploadLinkRoutes(db: Db, config: Config): Router {
  const router = Router();
  const cap = config.FOREMAN_ATTACHMENT_MAX_BYTES;

  router.put(
    '/:token',
    // Checked before the body is read, so a dead link does not wait on the whole file to say so.
    handler(async (req, res) => {
      try {
        await ticketFor(db, param(req, 'token'));
      } catch (error) {
        if (error instanceof TicketGone) {
          res.status(410).json({ error: error.message });
          return;
        }
        throw error;
      }
      await new Promise<void>((resolve, reject) => {
        express.raw({ type: () => true, limit: cap })(req, res, (error?: unknown) => {
          if (error === undefined || error === null) resolve();
          else reject(error instanceof Error ? error : new Error('the upload could not be read'));
        });
      }).catch((error: unknown) => {
        const status = (error as { status?: number }).status;
        res.status(status === 413 ? 413 : 400).json(
          status === 413
            ? { error: `the file is larger than ${String(cap)} bytes`, maxBytes: cap }
            : { error: 'the upload could not be read' },
        );
      });
      if (res.headersSent) return;

      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (bytes.length === 0) {
        res.status(400).json({ error: 'send the file as the request body: curl -T <file> <this url>' });
        return;
      }
      try {
        const result = await attachWithTicket(db, config.FOREMAN_BLOB_DIR, param(req, 'token'), bytes);
        if ('refused' in result) {
          res.status(415).json({
            error: `not an accepted type; ${ATTACHMENT_TYPES_SENTENCE}`,
            allowed: ALLOWED_ATTACHMENT_TYPES,
          });
          return;
        }
        res.status(201).json({ ...result.attachment, auditEventIds: result.auditEventIds });
      } catch (error) {
        if (error instanceof TicketGone) {
          res.status(410).json({ error: error.message });
          return;
        }
        throw error;
      }
    }),
  );

  return router;
}
