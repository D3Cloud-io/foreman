-- FRM-T-12.1: the blob store (FRM-REQ-190, FRM-REQ-191).
--
-- What an uploaded file is, and nothing of what it contains: the bytes live once on the host's
-- disk under FOREMAN_BLOB_DIR, in a file named by `sha256`, and never in PostgreSQL. Additive, and
-- reachable by nothing the previous image serves (expand).

-- AlterEnum
ALTER TYPE "EntityType" ADD VALUE 'blob';

-- CreateTable
CREATE TABLE "blob" (
    "id" UUID NOT NULL,
    "sha256" TEXT NOT NULL,
    "media_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "blob_sha256_key" ON "blob"("sha256");
