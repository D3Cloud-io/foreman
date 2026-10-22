import { loadConfig } from '../config.js';
import { createDb } from '../db.js';
import type { Actor } from '../domain/audit.js';
import { moveWontFixReasons } from '../domain/findings.js';
import { linkDriftAcceptances } from '../domain/record.js';

/**
 * Move what triage used to write into prose into the columns made for it (FRM-T-18.15).
 *
 *   pnpm --filter foreman-server run move-wontfix-reasons                # report, write nothing
 *   pnpm --filter foreman-server run move-wontfix-reasons -- --write
 *   docker compose exec -T server node dist/cli/move-wontfix-reasons.js --write
 *
 * Two things, both left by FRM-T-18.7's console before the columns existed:
 *
 * - **Won't-fix reasons.** Won't fix appended `**Won’t fix** — <reason>` to the finding's
 *   recommendation — the reviewer's text — and Reopen never took it out, so a finding ruled on twice
 *   carries two. Each appended paragraph comes out of `recommendation_md`; a `wont_fix` finding keeps
 *   the latest as its `wont_fix_reason`, and a reopened one keeps none.
 * - **Drift acceptances.** Accepting drift recorded a decision whose statement began
 *   `Accepted drift on <ID> (<category>)`, and the Drift tab found it again by that wording. Each
 *   gets the link columns its statement names; the statement stays as written.
 *
 * **Not writing is the default**, as with `relint`. Every change is its own audited update, as
 * `system`, naming this CLI — so each one is in the record's history and can be undone there.
 * Idempotent: a second run finds nothing.
 */

const write = process.argv.includes('--write');
const only = (() => {
  const at = process.argv.indexOf('--project');
  return at === -1 ? undefined : process.argv[at + 1]?.toUpperCase();
})();

if (process.argv.some((arg) => ['-h', '--help', 'help'].includes(arg))) {
  process.stdout.write(
    'usage: move-wontfix-reasons [--write] [--project CODE]\n\n' +
      "  Moves won't-fix reasons out of finding recommendations into their own column, and links\n" +
      '  decisions that accepted drift to what they accepted. Reports by default; --write applies.\n',
  );
  process.exit(0);
}

const ACTOR: Actor = { actor: 'cli:move-wontfix-reasons (FRM-T-18.15)', actorKind: 'system' };

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

try {
  const reasons = await moveWontFixReasons(db, ACTOR, { write, project: only });
  const acceptances = await linkDriftAcceptances(db, ACTOR, { write, project: only });
  const scope = only === undefined ? '' : ` in ${only}`;

  process.stdout.write(`\n${String(reasons.length)} finding(s)${scope} with a won't-fix reason in the recommendation.\n`);
  for (const row of reasons.slice(0, 20)) {
    process.stdout.write(
      `  ${row.humanId} (${row.status}): ${String(row.removed)} paragraph(s) out` +
        (row.reason === null ? ', no reason kept — not wont_fix\n' : ` -> "${row.reason.slice(0, 60)}"\n`),
    );
  }
  if (reasons.length > 20) process.stdout.write(`  … and ${String(reasons.length - 20)} more\n`);

  process.stdout.write(`\n${String(acceptances.length)} decision(s)${scope} accepting drift by their wording alone.\n`);
  for (const row of acceptances.slice(0, 20)) {
    process.stdout.write(`  ${row.humanId} -> ${row.subject} (${row.category})\n`);
  }
  if (acceptances.length > 20) process.stdout.write(`  … and ${String(acceptances.length - 20)} more\n`);

  process.stdout.write(
    reasons.length + acceptances.length === 0
      ? '\nNothing to do.\n'
      : write
        ? '\nWritten.\n'
        : '\nNothing written. Re-run with --write to apply.\n',
  );
} finally {
  await db.$disconnect();
}
