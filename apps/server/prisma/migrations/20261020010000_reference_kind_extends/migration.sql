-- FRM-T-11.3: `extends` is a reference kind of its own.
--
-- An ADR that extends another was stored as a `relates` reference, so an extends link and a
-- relates link between the same two ADRs shared one row, and reversing either took the other's.
-- Every link kind now owns its own reference row. Additive: a new enum value the previous image
-- never writes or reads (expand).
--
-- On its own, because Postgres cannot use an enum value in the transaction that added it; the
-- backfill that writes one is the next migration.

-- AlterEnum
ALTER TYPE "ReferenceKind" ADD VALUE 'extends';
