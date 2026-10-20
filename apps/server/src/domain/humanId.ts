import { formatHumanId, HUMAN_ID_TYPE, parseHumanId } from '@foreman/shared';
import type { TransactionClient } from './audit.js';

/**
 * Allocating human IDs (FRM-REQ-044, FRM-REQ-045, ADR-008).
 *
 * Two properties carry the weight:
 *
 * 1. **An ID is never reused.** The next sequence comes from a counter on the project, not from
 *    `count(*)` — deleting `BND-REQ-007` must not hand its number to the next requirement, because
 *    every document body that cites `BND-REQ-007` would then point at something else.
 * 2. **An ID is immutable once assigned.** There is deliberately no function here that changes one.
 *    Renumbering breaks every citation in every document body, and the only safe rename is none.
 */

export type HumanIdKind = keyof typeof HUMAN_ID_TYPE;

/**
 * The table each counter-allocated kind's rows live in. Findings share one table across four
 * prefixes; the prefix filter in `highWaterMark` is what separates them.
 *
 * Not user input — a closed map over `HumanIdKind`, which is what makes interpolating the table
 * name below safe. `term` is absent because a term has no human ID.
 */
const TABLE: Partial<Record<HumanIdKind, string>> = {
  requirement: 'requirement',
  task: 'task',
  phase: 'phase',
  adr: 'adr',
  decision: 'decision',
  risk: 'risk',
  finding_code_review: 'finding',
  finding_design: 'finding',
  finding_feature: 'finding',
  finding_api: 'finding',
  idea: 'idea',
  audit: 'audit',
  screen: 'screen',
};

/**
 * The largest sequence this project has actually issued for a type, read from the rows themselves.
 *
 * The counter is the fast path, but it is not the only way rows arrive: **the P10 importer wrote
 * human IDs directly and never seeded `id_counters`**, so all nine imported projects sat on `{}`.
 * The first ADR created through the API in any of them allocated `FRM-ADR-001`, collided with the
 * imported row on the unique index, and surfaced as `internal error` — with nothing to say the
 * cause was a counter thirteen behind the data. A restored partial dump would do the same.
 *
 * Deleted rows count. An ID is never reused (ADR-008), and `deleted_at` does not free its number.
 */
async function highWaterMark(
  tx: TransactionClient,
  projectId: string,
  kind: HumanIdKind,
): Promise<number> {
  const table = TABLE[kind];
  if (table === undefined) return 0;

  // A human ID is exactly `CODE-TYPE-SEQ`: a code is letters and digits and a type is letters, so
  // the third part is the whole sequence.
  //
  // Only undotted sequences count. A task takes its ID from its phase when it has one — `BND-T-0.3`
  // — and from the counter when it does not, and `T-0.3` can never collide with `T-4`. Letting the
  // dotted ones raise the floor would push the counter to 9 because some phase 8 has eight tasks.
  const rows = await tx.$queryRawUnsafe<{ high: number | null }[]>(
    `select max(split_part(human_id, '-', 3)::int) as high
       from "${table}"
      where project_id = $1::uuid
        and split_part(human_id, '-', 2) = $2
        and split_part(human_id, '-', 3) ~ '^[0-9]+$'`,
    projectId,
    HUMAN_ID_TYPE[kind],
  );
  // `max(…::int)` is an int4, which the driver hands back as a number — not the string or BigInt
  // a wider integer type would give.
  return rows[0]?.high ?? 0;
}

/**
 * Take the next sequence for a kind, inside the caller's transaction.
 *
 * Two concurrent creates cannot take the same number: the counter is read and written in one
 * `update … returning`, which holds the project row until the transaction commits, so the second
 * re-reads the value the first wrote rather than the one it saw going in. The high-water mark only
 * raises the floor, so it is safe to compute before taking that lock.
 */
export async function nextSequence(
  tx: TransactionClient,
  projectId: string,
  kind: HumanIdKind,
): Promise<number> {
  const type = HUMAN_ID_TYPE[kind];
  const floor = await highWaterMark(tx, projectId, kind);
  const rows = await tx.$queryRaw<{ id_counters: Record<string, number> }[]>`
    update project
    set id_counters = jsonb_set(
      id_counters,
      array[${type}],
      to_jsonb(greatest(coalesce((id_counters ->> ${type})::int, 0), ${floor}::int) + 1),
      true
    )
    where id = ${projectId}::uuid
    returning id_counters
  `;

  const counters = rows[0]?.id_counters;
  const next = counters?.[type];
  if (next === undefined) throw new Error(`project ${projectId} not found while allocating an ID`);
  return next;
}

/** Allocate the next human ID for a kind — `BND-REQ-008`. */
export async function allocate(
  tx: TransactionClient,
  project: { id: string; code: string },
  kind: HumanIdKind,
): Promise<{ humanId: string; seq: number }> {
  const seq = await nextSequence(tx, project.id, kind);
  return { humanId: formatHumanId(project.code, HUMAN_ID_TYPE[kind], seq), seq };
}

/**
 * A task's ID carries its phase — `BND-T-0.3` — so it is not drawn from the counter. The position
 * within the phase is what makes it unique.
 */
export function taskHumanId(code: string, phaseNumber: number | string, position: number): string {
  return `${code}-${HUMAN_ID_TYPE.task}-${String(phaseNumber)}.${String(position)}`;
}

/**
 * The next position for a task in a phase — one past the highest `CODE-T-<phase>.<n>` the project
 * has ever issued, inside the caller's transaction.
 *
 * **Not a count of the tasks in the phase.** An ID stays with its task when the task moves, so
 * `DI-P-0` holding 36 tasks said nothing about whether `DI-T-0.37` was free — it belonged to a
 * task moved to `DI-P-1`, and the create failed on the unique index as a bare 500. The prefix is
 * read across the whole project, deleted rows included: a soft delete does not free a number
 * (ADR-008).
 *
 * The phase row is locked first, so two creates in one phase cannot read the same high mark.
 */
export async function nextTaskPosition(
  tx: TransactionClient,
  projectId: string,
  phase: { id: string; code: string; number: string },
): Promise<number> {
  await tx.$queryRaw`select 1 from phase where id = ${phase.id}::uuid for update`;

  const prefix = `${phase.code}-${HUMAN_ID_TYPE.task}-${phase.number}.`;
  const rows = await tx.$queryRaw<{ high: number | null }[]>`
    select max(substring(human_id from ${prefix.length + 1}::int)::int) as high
      from task
     where project_id = ${projectId}::uuid
       and starts_with(human_id, ${prefix})
       and substring(human_id from ${prefix.length + 1}::int) ~ '^[0-9]+$'
  `;
  return (rows[0]?.high ?? 0) + 1;
}

/** A phase's ID is its number: `BND-P-8.5`. */
export function phaseHumanId(code: string, phaseNumber: number | string): string {
  return `${code}-${HUMAN_ID_TYPE.phase}-${String(phaseNumber)}`;
}

/**
 * Confirm a human ID belongs to the project it is being used in. A citation that resolves to
 * another project's entity is not a lookup failure, it is a wrong answer.
 */
export function belongsTo(humanId: string, projectCode: string): boolean {
  return parseHumanId(humanId)?.code === projectCode;
}

/** Thrown when something tries to change an ID. There is no code path that catches and proceeds. */
export class ImmutableHumanIdError extends Error {
  constructor(readonly humanId: string) {
    super(
      `${humanId} cannot be renumbered: every citation of it, in every document body, would then ` +
        'point at something else',
    );
    this.name = 'ImmutableHumanIdError';
  }
}

/**
 * Guard an update. Called by every write path that accepts a body which could carry a `humanId`.
 */
export function refuseIdChange(current: string, incoming: unknown): void {
  if (incoming === undefined || incoming === null) return;
  if (typeof incoming === 'string' && incoming === current) return;
  throw new ImmutableHumanIdError(current);
}
