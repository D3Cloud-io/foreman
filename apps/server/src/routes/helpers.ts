import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '../db.js';
import type { Actor } from '../domain/audit.js';
import { Conflict, ConflictWith, Invalid, NotFound } from '../domain/errors.js';
import { ImmutableHumanIdError } from '../domain/humanId.js';
import { GateRefused } from '../domain/coverage.js';
import { StaleWrite } from './concurrency.js';

/**
 * The plumbing every route shares: who is acting, what a body must look like, and what a domain
 * error is in HTTP.
 *
 * It lives here so a route file reads as the endpoints it defines, and so the mapping from domain
 * error to status code is made once rather than remembered five times.
 */

/** The actor for an audit event. Every mutation carries one; there is no anonymous write. */
export function actorOf(req: Request): Actor {
  const auth = req.auth;
  if (auth === undefined) throw new Error('actorOf called on an unauthenticated request');
  return {
    actor: auth.actor,
    actorKind: auth.actorKind,
    ...(typeof req.headers['x-request-id'] === 'string'
      ? { requestId: req.headers['x-request-id'] }
      : {}),
  };
}

/**
 * Wrap an async handler so a rejected promise becomes a response rather than an unhandled
 * rejection. Express 5 forwards rejections itself, but only for handlers it awaits — this is
 * explicit, and it is where domain errors become status codes.
 */
export function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch((error: unknown) => {
      respondToError(error, res, next);
    });
  };
}

function respondToError(error: unknown, res: Response, next: NextFunction): void {
  if (res.headersSent) return;

  if (error instanceof NotFound) {
    res.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof StaleWrite) {
    // 412, and the current state with it: a caller that lost a race should be able to see what it
    // lost to without a second request.
    res.setHeader('ETag', error.currentEtag);
    res.status(412).json({ error: error.message, current: error.current });
    return;
  }
  if (error instanceof GateRefused) {
    // 409 with every failure listed. "The exit gate failed" sends somebody looking; naming the
    // three Musts with no task tells them what to do (FRM-REQ-056).
    res.status(409).json({ error: error.message, gate: error.result });
    return;
  }
  if (error instanceof ConflictWith) {
    res.status(409).json({ error: error.message, ...error.detail });
    return;
  }
  if (error instanceof Conflict) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof Invalid) {
    res.status(422).json({ error: error.message, fields: error.fields });
    return;
  }
  if (error instanceof ImmutableHumanIdError) {
    // 409, not 422: the request is well-formed and the state forbids it.
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    // A unique index refused the write: the state forbids it, the request is fine. Still a bug
    // somewhere upstream — an allocator should never hand out a taken ID — but a 500 said nothing
    // and sent somebody to the logs. The value is not echoed: it came from the row that failed.
    res.status(409).json({ error: 'that would duplicate an existing record' });
    return;
  }
  // Anything else is a bug. The error handler logs it and says nothing specific.
  next(error);
}

/**
 * A path parameter, as the string it always is in practice. Express 5's types allow an array — a
 * repeated parameter — which cannot happen for these routes, and a cast at every call site would
 * be six chances to cast the wrong thing.
 */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string') throw new NotFound(`:${name}`);
  return value;
}

/**
 * The top-level fields a body sends that its schema does not declare.
 *
 * A zod object strips an unknown key and parses, so a field the entity has no column for used to
 * be accepted and dropped: the request answered 200, and the text was gone (FRM-T-017 — twenty FLR
 * task bodies). Every write refuses one by name instead. Top level only: that is where a field is
 * a column, and a nested shape is the schema's own business.
 */
function unknownFields(schema: z.ZodType, body: unknown): string[] {
  if (!(schema instanceof z.ZodObject)) return [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return [];
  const known = new Set(Object.keys(schema.shape));
  return Object.keys(body).filter((key) => !known.has(key));
}

/** Parse a body against a schema, or answer 400 with per-field detail. */
export function parseBody<T extends z.ZodType>(
  schema: T,
  req: Request,
  res: Response,
): z.infer<T> | null {
  const unknown = unknownFields(schema, req.body);
  const parsed = schema.safeParse(req.body);
  if (parsed.success && unknown.length === 0) return parsed.data;

  res.status(400).json({
    error:
      unknown.length > 0
        ? `not a field this stores, so it would be lost: ${unknown.join(', ')}`
        : 'the request body is not valid',
    fields: [
      ...unknown.map((key) => ({
        path: key,
        message: 'not a field this stores — it would be lost, so it is refused',
      })),
      ...(parsed.success
        ? []
        : parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          }))),
    ],
  });
  return null;
}

/** Parse a query string the same way. */
export function parseQuery<T extends z.ZodType>(
  schema: T,
  req: Request,
  res: Response,
): z.infer<T> | null {
  const parsed = schema.safeParse(req.query);
  if (parsed.success) return parsed.data;

  res.status(400).json({
    error: 'the query is not valid',
    fields: parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
  return null;
}

/**
 * Keyset paging over an ordered column. Offsets drift under concurrent writes; a cursor does not,
 * and the corpus is big enough for that to matter.
 */
export function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}
