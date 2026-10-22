import { randomBytes } from 'node:crypto';
import { hashToken } from '../auth/sessions.js';
import type { Scope } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { record, type Actor } from './audit.js';
import { NotFound } from './errors.js';

/**
 * Issuing and revoking scoped API tokens (FRM-REQ-025, FRM-REQ-026, FRM-REQ-027).
 *
 * This lives in the domain layer rather than in the route for the same reason everything else does:
 * the audit event has to be written **in the same transaction** as the change. A route that writes
 * and then records is a route where the second write can fail on its own — and an issued token with
 * no record of being issued is precisely the thing an audit trail exists to make impossible.
 */

export interface IssuedToken {
  readonly id: string;
  /**
   * The audit event that issued it (FRM-REQ-243). A token is not undoable — `api_token` is not in
   * `UNDOABLE` — so its history says why; revoking it is the way back.
   */
  readonly auditEventIds: string[];
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  /** Shown exactly once. No route returns it again, on purpose. */
  readonly token: string;
}

export async function issueToken(
  db: Db,
  actor: Actor,
  input: { name: string; scopes: readonly Scope[]; expiresInDays?: number },
): Promise<IssuedToken> {
  const token = `frm_${randomBytes(32).toString('base64url')}`;
  // A short, non-secret prefix, so a token can be recognised in a list without revealing it.
  const prefix = token.slice(0, 12);

  return db.$transaction(async (tx) => {
    const created = await tx.apiToken.create({
      data: {
        name: input.name,
        tokenHash: hashToken(token),
        prefix,
        scopes: [...input.scopes],
        createdBy: actor.actor,
        ...(input.expiresInDays === undefined
          ? {}
          : { expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000) }),
      },
    });

    const event = await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'api_token',
      entityId: created.id,
      entityHumanId: prefix,
      // The token's value never reaches the trail; the prefix, which is not a secret, does.
      after: { name: created.name, scopes: created.scopes, prefix },
    });

    return {
      id: created.id,
      auditEventIds: [event],
      name: created.name,
      prefix,
      scopes: created.scopes,
      token,
    };
  });
}

export async function revokeToken(
  db: Db,
  actor: Actor,
  id: string,
): Promise<{ auditEventIds: string[] }> {
  const before = await db.apiToken.findUnique({ where: { id } });
  if (before === null || before.revokedAt !== null) throw new NotFound(`token ${id}`);

  return db.$transaction(async (tx) => {
    const revoked = await tx.apiToken.update({ where: { id }, data: { revokedAt: new Date() } });
    const event = await record(tx, {
      ...actor,
      action: 'delete',
      entityType: 'api_token',
      entityId: id,
      entityHumanId: before.prefix,
      before,
      after: { revokedAt: revoked.revokedAt },
    });
    return { auditEventIds: [event] };
  });
}

/** Enough to recognise a token, and never enough to use one. */
export async function listTokens(db: Db) {
  return db.apiToken.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      name: true,
      prefix: true,
      scopes: true,
      lastUsedAt: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });
}
