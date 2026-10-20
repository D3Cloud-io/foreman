import { loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { reconcileCoverage, type ReconcileSection } from '../domain/reconcile-coverage.js';

/**
 * Remove the coverage and ADR-graph rows the old `link()` wrote for kinds that did not own them
 * (FRM-T-024). The write side stopped with FRM-T-11.3; this is the cleanup of what it left.
 *
 *   docker compose exec -T server node dist/cli/reconcile-coverage.js            # report only
 *   docker compose exec -T server node dist/cli/reconcile-coverage.js --write
 *
 * Three passes, each printed with human IDs — what was removed, and what was kept and why:
 *   - task_requirement rows no satisfies backs, written by a relates or violates link;
 *   - extends adr_relation rows a relates or violates link between two ADRs left;
 *   - the relates reference an old extends link wrote beside its relation.
 * The rules are in `domain/reconcile-coverage.ts`. A row it cannot prove came from an old link is
 * kept and listed. Every removal is its own audit event (`reconcile-coverage`, a system actor).
 *
 * **A report is the same code as the write**: one transaction, rolled back unless `--write` is
 * given. Idempotent: a second `--write` removes nothing.
 */

const write = process.argv.includes('--write');
const only = (() => {
  const at = process.argv.indexOf('--project');
  return at === -1 ? undefined : process.argv[at + 1]?.toUpperCase();
})();

if (process.argv.some((arg) => ['-h', '--help', 'help'].includes(arg))) {
  process.stdout.write(
    'usage: reconcile-coverage [--write] [--project CODE]\n\n' +
      '  Removes task_requirement rows no satisfies link backs, and the ADR relation and relates\n' +
      '  reference rows old links left, where the audit trail proves where they came from.\n' +
      '  Reports by default; --write applies.\n',
  );
  process.exit(0);
}

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

const print = (title: string, arrow: string, section: ReconcileSection) => {
  process.stdout.write(
    `\n${title}: ${String(section.removed.length)} ${write ? 'removed' : 'to remove'}, ` +
      `${String(section.kept.length)} kept` +
      (section.backed > 0 ? `, ${String(section.backed)} backed by their own link` : '') +
      '\n',
  );
  for (const row of section.removed) {
    process.stdout.write(`  ${write ? 'removed' : 'remove '}  ${row.from} ${arrow} ${row.to}  (${row.reason})\n`);
  }
  for (const row of section.kept) {
    process.stdout.write(`  kept     ${row.from} ${arrow} ${row.to}  (${row.reason})\n`);
  }
};

try {
  const result = await reconcileCoverage(db, { write, project: only });

  process.stdout.write(`reconcile-coverage${only === undefined ? '' : ` --project ${only}`}${write ? ' --write' : ''}\n`);
  print('task_requirement (task -> requirement)', '->', result.taskRequirements);
  print('adr_relation extends (adr -> adr)', 'extends', result.adrRelations);
  print('relates twin of an extends link (adr -> adr)', 'relates', result.relatesTwins);

  const removed =
    result.taskRequirements.removed.length + result.adrRelations.removed.length + result.relatesTwins.removed.length;
  process.stdout.write(
    `\n${String(removed)} row(s) ${write ? 'removed' : 'would be removed'}.\n` +
      (removed === 0 ? 'Nothing to do.\n' : write ? 'Written.\n' : 'Nothing written. Re-run with --write to apply.\n'),
  );
} finally {
  await db.$disconnect();
}
