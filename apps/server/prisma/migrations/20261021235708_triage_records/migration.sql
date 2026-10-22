-- FRM-T-18.15: triage keeps its own records.
--
-- Three nullable columns and an index (expand): the image before this one neither reads nor writes
-- them. A finding's won't-fix reason moves out of its recommendation into `wont_fix_reason`, and a
-- decision that accepts drift names the drifting record and the drift category in two columns
-- instead of a statement prefix. Existing rows are moved by the audited one-off
-- `pnpm --filter foreman-server run move-wontfix-reasons -- --write`, not here: a migration writes
-- no audit event.

-- AlterTable
ALTER TABLE "decision" ADD COLUMN     "accepts_drift_category" TEXT,
ADD COLUMN     "accepts_drift_subject" TEXT;

-- AlterTable
ALTER TABLE "finding" ADD COLUMN     "wont_fix_reason" TEXT;

-- CreateIndex
CREATE INDEX "decision_project_id_accepts_drift_subject_idx" ON "decision"("project_id", "accepts_drift_subject");
