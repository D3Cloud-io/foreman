import { Prisma, type Db } from '../db.js';
import type { ActorKind, AuditAction, EntityType } from '../generated/prisma/enums.js';

/**
 * Every mutation writes an `audit_event` — MCP writes and importer writes included, no exceptions
 * (Data Model invariant 4). It is also the substrate for undo: `before` is what a reversal replays.
 *
 * Two rules this file enforces rather than hopes for:
 *   1. The event is written **in the same transaction** as the change, so a mutation cannot exist
 *      without its record.
 *   2. Nothing sensitive reaches the snapshot — a password hash or a TOTP secret in an audit trail
 *      is a second copy of the secret, in a table built for reading.
 */

/** Field names never recorded in a before/after snapshot, whatever entity they appear on. */
const REDACTED = new Set([
  'passwordHash',
  'password_hash',
  'totpSecret',
  'totp_secret',
  'tokenHash',
  'token_hash',
  'password',
  'token',
  'clientSecret',
]);

export function scrub(value: unknown): unknown {
  // BigInt first: it does not survive JSON.stringify, and it is not an object to fall through to.
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(scrub);
  if (value instanceof Date) return value.toISOString();

  // Anything that is not a plain object is a value, not a bag of fields: Prisma's `Decimal` is the
  // one that matters here, and walking into it serialises its internals — including a `constructor`
  // the database rightly refuses. A phase number is `8.5`, not `{ s: 1, e: 0, d: [85] }`.
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    const candidate = value as { toJSON?: unknown; toString?: unknown };
    if (typeof candidate.toJSON === 'function') {
      return scrub((candidate.toJSON as () => unknown).call(value));
    }
    // Only a `toString` the class actually wrote. Object's default would record the useless
    // "[object Object]" and quietly lose whatever the value was.
    if (typeof candidate.toString === 'function' && candidate.toString !== Object.prototype.toString) {
      return (candidate.toString as () => string).call(value);
    }
    const name = (prototype as { constructor?: { name?: string } }).constructor?.name;
    return `[${name ?? 'object'}]`;
  }

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED.has(key) ? '[redacted]' : scrub(inner);
  }
  return out;
}

export interface Actor {
  readonly actor: string;
  readonly actorKind: ActorKind;
  readonly requestId?: string | undefined;
}

export interface AuditInput extends Actor {
  readonly action: AuditAction;
  readonly entityType: EntityType;
  readonly entityId: string;
  readonly entityHumanId?: string | undefined;
  readonly before?: unknown;
  readonly after?: unknown;
}

/**
 * The IDs of the audit events a write produced, own event first, with the ones that did not
 * happen (a renumbering that moved nothing is `null`) dropped. This is what a response carries as
 * `auditEventIds`, so the console can offer Undo on the change it just made (FRM-REQ-243).
 */
export function eventIds(...ids: readonly (string | null | undefined)[]): string[] {
  return ids.filter((id): id is string => typeof id === 'string');
}

/** What a `$transaction` callback is handed: the client without the connection-level methods. */
export type TransactionClient = Parameters<Parameters<Db['$transaction']>[0]>[0];

export async function record(db: TransactionClient, input: AuditInput): Promise<string> {
  const event = await db.auditEvent.create({
    data: {
      actor: input.actor,
      actorKind: input.actorKind,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      ...(input.entityHumanId !== undefined ? { entityHumanId: input.entityHumanId } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      before:
        input.before === undefined
          ? Prisma.JsonNull
          : (scrub(input.before) as Prisma.InputJsonValue),
      after:
        input.after === undefined ? Prisma.JsonNull : (scrub(input.after) as Prisma.InputJsonValue),
    },
    select: { id: true },
  });
  return event.id;
}

/**
 * Run a mutation and its audit event as one transaction. If the event cannot be written, the change
 * does not happen — which is the only way "no exceptions" can be true.
 */
export async function withAudit<T>(
  db: Db,
  input: Omit<AuditInput, 'entityId'> & { entityId?: string },
  mutate: (tx: TransactionClient) => Promise<{ entity: T; entityId: string; after?: unknown }>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    const { entity, entityId, after } = await mutate(tx);
    await record(tx, { ...input, entityId, after: after ?? entity });
    return entity;
  });
}

// ─── Reading an event as a sentence (FRM-REQ-243) ──────────────────────────

type Snapshot = Record<string, unknown> | null;

const asSnapshot = (value: unknown): Snapshot =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Columns the database owns: a change to one of these alone is not a change anybody made. */
const NOISE = new Set(['updatedAt', 'createdAt', 'id', 'seq']);

const clip = (text: string, max = 60): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The words a record is known by: its title, name, statement or heading, whichever it has. */
function labelOf(...snapshots: readonly Snapshot[]): string | null {
  for (const snapshot of snapshots) {
    if (snapshot === null) continue;
    for (const key of ['title', 'name', 'term', 'statement', 'heading']) {
      const value = snapshot[key];
      if (typeof value === 'string' && value.trim().length > 0) return clip(value);
    }
  }
  return null;
}

/** A value short enough to read inside a sentence, or null when only the field name will do. */
function shortValue(value: unknown): string | null {
  if (value === null) return 'none';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string' && value.length > 0 && value.length <= 24 && !/\s{2,}|\n/.test(value)) {
    return value;
  }
  return null;
}

/** What changed between two snapshots, as `status (todo → done), title`. */
function changesOf(before: Snapshot, after: Snapshot): string | null {
  if (before === null || after === null) return null;
  const fields: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (NOISE.has(key)) continue;
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    const from = shortValue(before[key]);
    const to = shortValue(after[key]);
    fields.push(from !== null && to !== null ? `${key} (${from} → ${to})` : key);
  }
  if (fields.length === 0) return null;
  return fields.length <= 4
    ? fields.join(', ')
    : `${fields.slice(0, 3).join(', ')} and ${String(fields.length - 3)} more`;
}

const KIND_NAME: Record<string, string> = {
  api_token: 'API token',
  document_section: 'document section',
  project_idea: 'project idea',
  tech_item: 'tech item',
};

export interface SummarisableEvent {
  readonly action: string;
  readonly actor: string;
  readonly entityType: string;
  readonly entityHumanId: string | null;
  readonly before: unknown;
  readonly after: unknown;
}

/**
 * One human sentence for one audit event — what the History list shows and the Undo toast quotes.
 * It reads the event's own snapshots, so it needs nothing the trail does not already hold, and it
 * works for a record that has since been deleted.
 */
export function summarize(event: SummarisableEvent): string {
  const before = asSnapshot(event.before);
  const after = asSnapshot(event.after);
  const kind = KIND_NAME[event.entityType] ?? event.entityType;
  const name = event.entityHumanId ?? kind;
  const marker = after?.['event'] ?? before?.['event'];

  if (marker === 'link' || marker === 'unlink') {
    const text = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);
    const to = text(after?.['to'] ?? before?.['to'], 'something');
    const how = text(after?.['kind'] ?? before?.['kind'], 'link');
    if (event.action === 'undo') return `Reversed the ${how} link between ${name} and ${to}`;
    return marker === 'link'
      ? `Linked ${name} to ${to} (${how})`
      : `Unlinked ${name} from ${to} (${how})`;
  }
  if (marker === 'reorder') {
    const scope = after?.['scope'] === 'groups' ? 'groups' : 'projects';
    const cause = typeof after?.['cause'] === 'string' ? ` after ${after['cause']}` : '';
    return event.action === 'undo'
      ? `Put the ${scope} back in their earlier order`
      : `Reordered ${scope}${cause}`;
  }
  if (marker === 'reconcile') return `Coverage cleanup recorded on ${name}`;

  if (event.actor.startsWith('rollup via ') && event.action === 'update') {
    const cause = event.actor.slice('rollup via '.length);
    const status = before !== null && after !== null && before['status'] !== after['status'];
    const field = status ? 'status' : 'lifecycle';
    return (
      `${name} moved ${field} ${shortValue(before?.[field]) ?? ''} → ${shortValue(after?.[field]) ?? ''}` +
      ` because of ${cause}`
    ).replace(/\s+/g, ' ');
  }

  const label = labelOf(after, before);
  const titled = label === null ? name : `${name} “${label}”`;

  switch (event.action) {
    case 'create':
      return event.entityType === 'api_token'
        ? `Issued ${kind} ${name}${label === null ? '' : ` “${label}”`}`
        : `Created ${kind} ${titled}`;
    case 'delete':
      return event.entityType === 'api_token' ? `Revoked ${kind} ${name}` : `Deleted ${kind} ${titled}`;
    case 'restore':
      return `Restored ${kind} ${titled}`;
    case 'undo':
      return `Undid an earlier change to ${kind} ${titled}`;
    default: {
      const changed = changesOf(before, after);
      return changed === null ? `Saved ${kind} ${titled} with no visible change` : `Changed ${changed} on ${titled}`;
    }
  }
}
