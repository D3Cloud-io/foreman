-- FRM-T-017: a task keeps its body.
--
-- `foreman_create` and `foreman_update` advertised a `body` for every kind, and a task had no
-- column to put it in, so a task's body was accepted and dropped. Additive and nullable: every
-- existing task reads as having none, and the previous image ignores the column (expand).
ALTER TABLE "task" ADD COLUMN "body" TEXT;
