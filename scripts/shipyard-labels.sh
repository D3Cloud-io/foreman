#!/usr/bin/env bash
# Computes the two Shipyard label values for the HEAD commit:
#
#   migration=<expand|contract|none>   from the `Shipyard-Migration` trailer of HEAD, or — when HEAD
#                                      is a merge — the strongest among the commits it brought in
#   schema=<newest migration dir>      the newest directory under apps/server/prisma/migrations
#
# Shipyard (SHP) reads these off the published image (`dev.d3cloud.shipyard.migration` and
# `dev.d3cloud.shipyard.schema`) to decide whether a release may be auto-rolled back on failure —
# a `contract` release never is (SHP-D-057) — and to confirm /health reports the schema it expects
# after a deploy.
#
# Usage: scripts/shipyard-labels.sh
# Prints two lines to stdout: `migration=...` and `schema=...`. Exits non-zero, with a message on
# stderr, if the trailer holds anything other than expand, contract, none, or nothing at all.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The trailer of one commit. Trailers can repeat; take the last non-empty line, matching how git
# itself resolves a repeated key.
trailer_of() {
  git -C "$repo_root" log -1 --format='%(trailers:key=Shipyard-Migration,valueonly)' "$1" \
    | awk 'NF { v = $0 } END { print v }'
}

# A merge commit made by GitHub carries no trailer of its own, so reading HEAD alone would label a
# release that brings in a migration as `none`. For a merge, every commit it brought in counts
# (HEAD^1..HEAD), and the strongest wins: one contract migration makes the whole release contract.
if git -C "$repo_root" rev-parse -q --verify HEAD^2 >/dev/null; then
  commits="$(git -C "$repo_root" rev-list HEAD^1..HEAD)"
else
  commits="HEAD"
fi

migration="none"
for commit in $commits; do
  trailer="$(trailer_of "$commit")"
  value="$(printf '%s' "$trailer" | tr '[:upper:]' '[:lower:]' | xargs 2>/dev/null || true)"
  case "$value" in
    "" | none) ;;
    expand) [ "$migration" = "contract" ] || migration="expand" ;;
    contract) migration="contract" ;;
    *)
      echo "shipyard-labels: Shipyard-Migration trailer must be expand, contract or none (got '$trailer' on $commit)" >&2
      exit 1
      ;;
  esac
done

migrations_dir="$repo_root/apps/server/prisma/migrations"
# Portable across BSD (macOS, local runs) and GNU (CI) find: no -printf, just basename each
# directory entry, excluding migration_lock.toml which lives alongside the migration directories.
schema="$(
  find "$migrations_dir" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null \
    | sort \
    | tail -1
)"

if [ -z "$schema" ]; then
  echo "shipyard-labels: no migration directories found under $migrations_dir" >&2
  exit 1
fi

echo "migration=$migration"
echo "schema=$schema"
