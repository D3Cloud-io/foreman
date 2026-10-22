-- FRM-T-18.9: a project may be a sample — EXMP and NBR, seeded to show what a full plan looks like.
--
-- One defaulted column (expand): every existing project is real, and the image before this one
-- neither reads nor writes it. The example seed sets it; the console labels such a project
-- "Sample", leaves it out of Home's figures, and offers to remove it.

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "sample" BOOLEAN NOT NULL DEFAULT false;
