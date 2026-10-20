import { pipeline } from 'node:stream/promises';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { requireAuth, requireScope } from '../auth/middleware.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { ALLOWED_MEDIA_TYPES, isSha256, openBlob, sniffMediaType, storeBlob } from '../domain/blobs.js';
import { actorOf, handler, param } from './helpers.js';

/**
 * Uploaded files (FRM-REQ-190, FRM-REQ-191): `POST /api/blobs` takes one file as multipart, and
 * `GET /api/blobs/:sha256` reads it back.
 *
 * Multipart, not JSON with base64 in it: a screenshot is several megabytes, and inflating it by a
 * third to fit through `express.json` — whose 2 MB limit exists for good reasons — is the wrong way
 * round. The global JSON parser ignores a multipart body, so nothing ahead of this router reads it.
 */

/** The one part an upload may carry. Anything else is refused by name, as `parseBody` does. */
const FIELD = 'file';

export function blobRoutes(db: Db, config: Config): Router {
  const router = Router();
  // First, so an anonymous request is refused before a byte of its body is parsed (FRM-REQ-028).
  router.use(requireAuth);
  const canWrite = requireScope(db, 'write');
  const cap = config.FOREMAN_BLOB_MAX_BYTES;

  // In memory, because the bytes are hashed before they have a name, and the cap bounds what
  // memory one request can take. A text field is parsed only so it can be refused by name below.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: cap, files: 1, fields: 16, fieldSize: 1024 },
  }).single(FIELD);

  /** Multer's refusals in HTTP: too big is 413, and every other malformed upload is 400. */
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
        if (error.code === 'LIMIT_UNEXPECTED_FILE' || error.code === 'LIMIT_FILE_COUNT') {
          res.status(400).json({
            error: `send exactly one file, in the \`${FIELD}\` field`,
            fields: error.field === undefined ? [] : [{ path: error.field, message: 'not a field this takes' }],
          });
          return;
        }
        res.status(400).json({ error: `the upload is not valid: ${error.message}` });
        return;
      }
      // Busboy's own refusals — no boundary, a truncated body. Not echoed: they can quote the body.
      res.status(400).json({ error: 'the request body is not valid multipart/form-data' });
    });
  };

  router.post(
    '/',
    canWrite,
    receive,
    handler(async (req, res) => {
      // A text field is not stored anywhere, so it would be lost; it is refused rather than
      // dropped, the same rule every JSON write follows (FRM-T-017).
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

      // From the bytes, not the part's Content-Type: a client can call anything an image (FRM-REQ-191).
      const mediaType = sniffMediaType(file.buffer, file.mimetype);
      if (mediaType === null) {
        res.status(415).json({
          error: `not an accepted type; send one of ${ALLOWED_MEDIA_TYPES.join(', ')}`,
          allowed: ALLOWED_MEDIA_TYPES,
        });
        return;
      }

      const { blob, created } = await storeBlob(db, actorOf(req), config.FOREMAN_BLOB_DIR, {
        bytes: file.buffer,
        mediaType,
      });
      res.status(created ? 201 : 200).json(blob);
    }),
  );

  router.get(
    '/:sha256',
    handler(async (req, res) => {
      const sha256 = param(req, 'sha256');
      if (!isSha256(sha256)) {
        res.status(400).json({ error: 'not a blob address: expected 64 lowercase hex characters' });
        return;
      }
      const blob = await openBlob(db, config.FOREMAN_BLOB_DIR, sha256);
      res.setHeader('Content-Type', blob.mediaType);
      res.setHeader('Content-Length', String(blob.byteSize));
      // Content-addressed, so the bytes behind a name never change: cache them for good, but only
      // in the reader's own cache, because reading one needs a session or a token.
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      // The stored type was sniffed, and the browser must not second-guess it into HTML.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      await pipeline(blob.stream, res);
    }),
  );

  return router;
}
