-- FRM-T-12.2: screens (FRM-REQ-189 … FRM-REQ-199).
--
-- A screen, its proposals and captures as versions of one table, verdicts on captures, and the
-- @d3cloud/ui components it uses or lacks. Additive, and reachable by nothing the previous image
-- serves (expand).

-- CreateEnum
CREATE TYPE "ScreenVersionKind" AS ENUM ('proposal', 'capture');

-- CreateEnum
CREATE TYPE "ScreenViewport" AS ENUM ('desktop', 'mobile');

-- CreateEnum
CREATE TYPE "ScreenTheme" AS ENUM ('light', 'dark');

-- CreateEnum
CREATE TYPE "ScreenProposalStatus" AS ENUM ('current', 'superseded');

-- CreateEnum
CREATE TYPE "ScreenVerdictKind" AS ENUM ('matches', 'drifted_accepted', 'drifted_fix');

-- CreateEnum
CREATE TYPE "ScreenComponentKind" AS ENUM ('uses', 'gap');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EntityType" ADD VALUE 'screen';
ALTER TYPE "EntityType" ADD VALUE 'screen_version';
ALTER TYPE "EntityType" ADD VALUE 'screen_verdict';
ALTER TYPE "EntityType" ADD VALUE 'screen_component';

-- CreateTable
CREATE TABLE "screen" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "human_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "route" TEXT,
    "figma_file_key" TEXT,
    "figma_node_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "screen_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screen_version" (
    "id" UUID NOT NULL,
    "screen_id" UUID NOT NULL,
    "kind" "ScreenVersionKind" NOT NULL,
    "blob_sha256" TEXT NOT NULL,
    "viewport" "ScreenViewport" NOT NULL,
    "theme" "ScreenTheme" NOT NULL,
    "status" "ScreenProposalStatus",
    "figma_file_key" TEXT,
    "figma_node_id" TEXT,
    "figma_file_version" TEXT,
    "commit_sha" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "screen_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screen_verdict" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "verdict" "ScreenVerdictKind" NOT NULL,
    "reviewer" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "screen_verdict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screen_component" (
    "id" UUID NOT NULL,
    "screen_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ScreenComponentKind" NOT NULL,
    "requirement_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "screen_component_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "screen_human_id_key" ON "screen"("human_id");

-- CreateIndex
CREATE UNIQUE INDEX "screen_project_id_seq_key" ON "screen"("project_id", "seq");

-- CreateIndex
CREATE INDEX "screen_version_screen_id_kind_viewport_theme_created_at_idx" ON "screen_version"("screen_id", "kind", "viewport", "theme", "created_at");

-- CreateIndex
CREATE INDEX "screen_version_blob_sha256_idx" ON "screen_version"("blob_sha256");

-- CreateIndex
CREATE INDEX "screen_verdict_version_id_created_at_idx" ON "screen_verdict"("version_id", "created_at");

-- CreateIndex
CREATE INDEX "screen_component_requirement_id_idx" ON "screen_component"("requirement_id");

-- CreateIndex
CREATE UNIQUE INDEX "screen_component_screen_id_name_kind_key" ON "screen_component"("screen_id", "name", "kind");

-- AddForeignKey
ALTER TABLE "screen" ADD CONSTRAINT "screen_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screen_version" ADD CONSTRAINT "screen_version_screen_id_fkey" FOREIGN KEY ("screen_id") REFERENCES "screen"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screen_version" ADD CONSTRAINT "screen_version_blob_sha256_fkey" FOREIGN KEY ("blob_sha256") REFERENCES "blob"("sha256") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screen_verdict" ADD CONSTRAINT "screen_verdict_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "screen_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screen_component" ADD CONSTRAINT "screen_component_screen_id_fkey" FOREIGN KEY ("screen_id") REFERENCES "screen"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screen_component" ADD CONSTRAINT "screen_component_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "requirement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
