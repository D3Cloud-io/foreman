-- FRM-T-030: attachments — files filed on project ideas, projects, phases, tasks, requirements and
-- ADRs (FRM-ADR-026, FRM-REQ-252 … FRM-REQ-258).
--
-- An `attachment` row is a name on one entity pointing at a `blob` by its SHA-256; the bytes stay
-- in the blob store on the host's disk (FRM-ADR-020), so the nightly backup set and the restore
-- drill already carry them. Codeless ATT-<SEQ> IDs come from their own sequence, as PI-, GL- and
-- GRP- do. `attachment_ticket` holds the one-use upload links the remote /mcp hands out.
--
-- Additive, and reachable by nothing the previous image serves (expand).


-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EntityType" ADD VALUE 'attachment';
ALTER TYPE "EntityType" ADD VALUE 'attachment_ticket';

-- CreateTable
CREATE TABLE "attachment" (
    "id" UUID NOT NULL,
    "human_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "entity_type" "EntityType" NOT NULL,
    "entity_id" UUID NOT NULL,
    "entity_human_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "blob_sha256" TEXT NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachment_ticket" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "entity_type" "EntityType" NOT NULL,
    "entity_id" UUID NOT NULL,
    "entity_human_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "actor_kind" "ActorKind" NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "attachment_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_ticket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attachment_human_id_key" ON "attachment"("human_id");

-- CreateIndex
CREATE UNIQUE INDEX "attachment_seq_key" ON "attachment"("seq");

-- CreateIndex
CREATE INDEX "attachment_entity_type_entity_id_idx" ON "attachment"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "attachment_blob_sha256_idx" ON "attachment"("blob_sha256");

-- CreateIndex
CREATE UNIQUE INDEX "attachment_ticket_token_hash_key" ON "attachment_ticket"("token_hash");

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_blob_sha256_fkey" FOREIGN KEY ("blob_sha256") REFERENCES "blob"("sha256") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The six kinds an attachment can be filed on (ATTACHABLE_TYPES in packages/shared). Compared as
-- text so the check names only values that existed before this migration added two.
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_entity_type_check"
  CHECK ("entity_type"::text IN ('project_idea', 'project', 'phase', 'task', 'requirement', 'adr'));
ALTER TABLE "attachment_ticket" ADD CONSTRAINT "attachment_ticket_entity_type_check"
  CHECK ("entity_type"::text IN ('project_idea', 'project', 'phase', 'task', 'requirement', 'adr'));

-- ATT-<SEQ>. A sequence, not a counter column: there is no parent row to lock, and `nextval` never
-- hands back a number twice, even across a rolled-back transaction.
CREATE SEQUENCE "attachment_seq" START 1;
