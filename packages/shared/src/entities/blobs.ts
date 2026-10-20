import { z } from 'zod';
import { Uuid } from './common.js';

/**
 * Blobs: uploaded images and source files (FRM-REQ-190, FRM-REQ-191).
 *
 * Each file is stored once, on the host's disk, named by the SHA-256 of its bytes; PostgreSQL holds
 * only what the file is. The hash is therefore the address a client keeps — `url` is derived from
 * it, and uploading the same bytes twice answers with the same one.
 */

/**
 * The only types an upload may be. Decided from the bytes, never from what the client declared:
 * an image is recognised by its signature, and JSON by parsing.
 */
export const BLOB_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/json'] as const;
export const BlobMediaType = z.enum(BLOB_MEDIA_TYPES);
export type BlobMediaType = z.infer<typeof BlobMediaType>;

/** Lowercase hex, 64 characters: the file's name on disk and its address over HTTP. */
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'not a lowercase hex SHA-256');
export type Sha256 = z.infer<typeof Sha256>;

/** What `POST /api/blobs` answers, both for a new file (201) and one already stored (200). */
export const Blob = z.object({
  id: Uuid,
  sha256: Sha256,
  mediaType: BlobMediaType,
  byteSize: z.number().int().nonnegative(),
  /** Where to read it back: `/api/blobs/<sha256>`, behind the same authentication as the API. */
  url: z.string(),
});
export type Blob = z.infer<typeof Blob>;
