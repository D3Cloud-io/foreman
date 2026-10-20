# Reconcile commands

One-off backfills over data written before a rule existed. Each **reports by default** and writes
only with `--write`; each runs its report and its write as the same code, in a transaction rolled
back unless `--write` is given, so the report is exactly what the write will do. Each is idempotent:
a second `--write` changes nothing. Take a backup first (`run-job backup`, see
[backup-restore.md](backup-restore.md)).

Run them in the production server container, from the stack's directory on the host:

```bash
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml exec -T server node dist/cli/<command>.js
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml exec -T server node dist/cli/<command>.js --write
```

`--project CODE` narrows any of them to one project.

## reconcile-coverage (FRM-T-024)

Until FRM-T-11.3 every task→requirement link wrote a `task_requirement` row — so a `relates` or
`violates` link counted as coverage — and every ADR→ADR link but `supersedes` wrote an `extends`
`adr_relation`, with an extends link stored as a `relates` reference. FRM-T-11.3 stopped the writes;
this removes what they left.

```bash
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml exec -T server node dist/cli/reconcile-coverage.js
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml exec -T server node dist/cli/reconcile-coverage.js --write
```

It prints three sections, each pair by human ID, as removed or kept with a reason:

| Section | Removed when | Kept (and listed) when |
|---|---|---|
| `task_requirement` | no `satisfies` reference, a `relates` or `violates` one, and nothing else wrote it | written at task creation or by a task update (`requirementIds`); on an imported task, older than the first relates/violates link, or no such link on record; no reference at all |
| `adr_relation extends` | no `extends` reference, and a `relates` or `violates` one | an extends link is on record anyway; no reference explains it |
| relates twin | a `relates` reference beside an `extends` one, an extends link from before FRM-T-11.3 on record, and no relates link or unlink on record | a relates link is on record; no old extends link to have written it |

References are citations and stay, except the relates twin. Every removal is an `audit_event` by
the `system` actor `reconcile-coverage`, with the removed row in `before` and the link that puts it
back in `after.restoreWith` (undo refuses these and names that link). Record the `--write` report
on FRM-T-024.

## reconcile-status (FRM-REQ-185)

Derives phase status from tasks and project lifecycle from phases over data written before the
rollup existed (ADR-018). Promotes only; lists closed phases it held.

## relint

Re-runs the EARS lint over every stored requirement. The importer did not lint until 2026-09-20.
