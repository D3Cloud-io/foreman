-- FRM-T-17.1: groups — the families one Foreman holds, D3 Cloud and Dormice first (FRM-ADR-024).
--
-- A group table with a codeless GRP-<SEQ> ID from its own sequence, a nullable group on each
-- project with its place in that group, and a scope on each guideline: every project, or a chosen
-- set of groups. Additive, and reachable by nothing the previous image serves (expand): every
-- existing project starts ungrouped, and every existing guideline keeps applying to all of them.

-- CreateEnum
CREATE TYPE "GuidelineScope" AS ENUM ('all', 'groups');

-- CreateEnum
CREATE TYPE "GroupAccent" AS ENUM ('foreman', 'shipyard', 'auth', 'bindery', 'ui', 'clearwhen', 'qr', 'floorspec', 'neutral');

-- AlterEnum
ALTER TYPE "EntityType" ADD VALUE 'group';

-- AlterTable
ALTER TABLE "guideline" ADD COLUMN     "applies_to" "GuidelineScope" NOT NULL DEFAULT 'all';

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "group_id" UUID,
ADD COLUMN     "group_position" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "project_group" (
    "id" UUID NOT NULL,
    "human_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "site_url" TEXT,
    "accent" "GroupAccent" NOT NULL DEFAULT 'neutral',
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "project_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guideline_group" (
    "guideline_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guideline_group_pkey" PRIMARY KEY ("guideline_id","group_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_group_human_id_key" ON "project_group"("human_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_group_seq_key" ON "project_group"("seq");

-- CreateIndex
CREATE INDEX "project_group_slug_idx" ON "project_group"("slug");

-- CreateIndex
CREATE INDEX "project_group_position_idx" ON "project_group"("position");

-- CreateIndex
CREATE INDEX "guideline_group_group_id_idx" ON "guideline_group"("group_id");

-- CreateIndex
CREATE INDEX "project_group_id_group_position_idx" ON "project"("group_id", "group_position");

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "project_group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guideline_group" ADD CONSTRAINT "guideline_group_guideline_id_fkey" FOREIGN KEY ("guideline_id") REFERENCES "guideline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guideline_group" ADD CONSTRAINT "guideline_group_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "project_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The allocator for `human_id`. Owned by the column so a drop of the table takes it too, and
-- `nextval` never hands back a number twice — so a deleted group's ID is never reused (ADR-008).
CREATE SEQUENCE "project_group_seq" AS integer START WITH 1 OWNED BY "project_group"."seq";

-- Every live project starts ungrouped, at a dense position in code order — the order the console
-- already lists them in — so positions within a group are exactly 0..n-1 from the start.
UPDATE "project" AS p
SET "group_position" = ranked.position
FROM (
    SELECT "id", (row_number() OVER (ORDER BY "code") - 1)::integer AS position
    FROM "project"
    WHERE "deleted_at" IS NULL
) AS ranked
WHERE p."id" = ranked."id";
