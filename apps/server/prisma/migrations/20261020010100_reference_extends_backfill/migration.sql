-- FRM-T-11.3: every extends link gets the `extends` reference it would be written with now.
--
-- Until now an extends link wrote an `extends` adr_relation and a `relates` reference. Neither is
-- proof of an extends link on its own: every ADR→ADR kind but supersedes wrote that same relation,
-- so a relates or violates link between two ADRs left one too. The audit trail tells them apart —
-- each link event records its kind — so a relation gets an `extends` reference when an extends
-- link between the pair is on record, or when no link between them is on record at all (a
-- relation written some other way, which says extends and nothing contradicts). One a relates or
-- violates link left behind gets none, and stays as it is for the cleanup of those rows
-- (FRM-T-024). The reference is cited as its `relates` twin was, or by the target's human ID.
--
-- The `relates` references are left where they are. One written by an extends link cannot be
-- told apart from one a person wrote as a relates link between the same two ADRs, and removing a
-- person's citation to tidy up after the code would be the silent loss this change exists to
-- prevent. An old extends link therefore reads as both an extends and a relates; unlinking the
-- relates is the way to drop the second.

INSERT INTO "reference" ("id", "from_type", "from_id", "to_type", "to_id", "kind", "cited_as", "created_at")
SELECT
    gen_random_uuid(),
    'adr',
    relation."adr_id",
    'adr',
    relation."related_adr_id",
    'extends',
    COALESCE(
        (
            SELECT twin."cited_as"
            FROM "reference" twin
            WHERE twin."from_type" = 'adr'
              AND twin."from_id" = relation."adr_id"
              AND twin."to_type" = 'adr'
              AND twin."to_id" = relation."related_adr_id"
              AND twin."kind" = 'relates'
            LIMIT 1
        ),
        target."human_id"
    ),
    relation."created_at"
FROM "adr_relation" relation
JOIN "adr" target ON target."id" = relation."related_adr_id"
WHERE relation."kind" = 'extends'
  AND (
    EXISTS (
        SELECT 1
        FROM "audit_event" event
        WHERE event."entity_type" = 'adr'
          AND event."entity_id" = relation."adr_id"
          AND event."action" = 'create'
          AND event."after" ->> 'event' = 'link'
          AND event."after" ->> 'to' = target."human_id"
          AND event."after" ->> 'kind' = 'extends'
    )
    OR NOT EXISTS (
        SELECT 1
        FROM "audit_event" event
        WHERE event."entity_type" = 'adr'
          AND event."entity_id" = relation."adr_id"
          AND event."action" = 'create'
          AND event."after" ->> 'event' = 'link'
          AND event."after" ->> 'to' = target."human_id"
    )
  )
ON CONFLICT ("from_type", "from_id", "to_type", "to_id", "kind") DO NOTHING;
