-- FRM-T-008: a build result from a deployer (Shipyard) is recorded once per build ID.
--
-- The check run a build writes is the CI state the brief reads, and it is mutable: a rebuild of
-- the same commit replaces its conclusion. So the check run cannot also be the record of which
-- builds have been heard of — a replay of a superseded build would find nothing and re-apply
-- itself. `build_result` is that record, unique on `build_id`. Additive: a new enum, a new
-- EntityType value and a new table; the previous image never reads any of them (expand).

-- CreateEnum
CREATE TYPE "BuildState" AS ENUM ('succeeded', 'failed', 'cancelled', 'refused');

-- AlterEnum
ALTER TYPE "EntityType" ADD VALUE 'build';

-- CreateTable
CREATE TABLE "build_result" (
    "id" UUID NOT NULL,
    "build_id" TEXT NOT NULL,
    "project_id" UUID NOT NULL,
    "repo_id" UUID NOT NULL,
    "check_run_id" UUID,
    "app" TEXT NOT NULL,
    "commit_sha" TEXT NOT NULL,
    "state" "BuildState" NOT NULL,
    "conclusion" "CheckConclusion" NOT NULL,
    "environment" TEXT,
    "failed_stage" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6) NOT NULL,
    "details_url" TEXT,
    "applied" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "build_result_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "build_result_build_id_key" ON "build_result"("build_id");

-- CreateIndex
CREATE INDEX "build_result_repo_id_commit_sha_idx" ON "build_result"("repo_id", "commit_sha");

-- CreateIndex
CREATE INDEX "build_result_check_run_id_idx" ON "build_result"("check_run_id");

-- CreateIndex
CREATE INDEX "build_result_project_id_idx" ON "build_result"("project_id");

-- AddForeignKey
ALTER TABLE "build_result" ADD CONSTRAINT "build_result_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "build_result" ADD CONSTRAINT "build_result_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "build_result" ADD CONSTRAINT "build_result_check_run_id_fkey" FOREIGN KEY ("check_run_id") REFERENCES "check_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
