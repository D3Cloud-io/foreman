import type { EntityType } from '../generated/prisma/enums.js';
import { loadConfig } from '../config.js';
import { createDb, type Db } from '../db.js';
import { record, type TransactionClient } from '../domain/audit.js';
import { planRow, type FieldChange, type FieldSpec } from './clean-markup-rules.js';

/**
 * Clean the Markdown and wiki-link residue the vault importer left in stored text
 * (FRM-T-18.11, FRM-REQ-250; audit FRM-DA-011).
 *
 *   docker compose exec -T server node dist/cli/clean-markup.js            # report, write nothing
 *   docker compose exec -T server node dist/cli/clean-markup.js --write
 *   pnpm run clean-markup -- --write [--project CODE]
 *
 * The glossary shows "**Asset**" and "**`field_provenance`**", a risk's tripwire cell begins
 * "**Golden corpus word ac…", and some task titles end in "]]" from a vault wiki link. The importer
 * copied the vault's text verbatim into columns the console prints as plain text. The fix is in the
 * data — this — and the rendering (`InlineMarkdown`) handles only the legitimate markup that remains.
 *
 * **The ADR-008 rewriter pattern**, as `relint` and `reconcile-coverage` do it:
 *   - not writing is the default; `--write` applies;
 *   - every substitution is printed — the rule, what it matched, what it became;
 *   - every changed row is one transaction holding the update **and its audit event** (actor
 *     `clean-markup`, kind `system`), whose `before` is the old value of each changed field. So each
 *     row is undone like any other edit — `undo` replays `before` — and an undo is refused, as ever,
 *     if the field has been edited since;
 *   - idempotent: the output of a rule contains nothing a rule matches, so a second run reports
 *     nothing and touches nothing;
 *   - soft-deleted rows are left alone, and no human ID, key or code is ever touched.
 *
 * **Decided per field** (rules in `clean-markup-rules.ts`):
 *   - *plain text* — task, ADR, phase, idea, finding and document titles, section headings,
 *     requirement statements, risk title / mitigation / tripwire, glossary term and aliases. The
 *     console prints these with `{value}`, so every marker is residue: `**x**` -> `x`, backticks
 *     removed, `[[Note|Label]]` -> `Label`, `[[Note]]` -> `Note`, stray `[[` / `]]` removed.
 *   - *markdown bodies* — glossary definitions, section bodies, task bodies, ADR sections. They are
 *     rendered as Markdown, so `**x**` and backticks are meaning and stay. Only a complete wiki link
 *     (which no renderer understands) is rewritten, and never inside a code span or fence.
 *
 * A glossary term whose cleaned name already exists in the same scope is not renamed: the pair is
 * listed as kept, for a person to merge. A field that would become empty is left as it is.
 */

const write = process.argv.includes('--write');
const only = (() => {
  const at = process.argv.indexOf('--project');
  return at === -1 ? undefined : process.argv[at + 1]?.toUpperCase();
})();

if (process.argv.some((arg) => ['-h', '--help', 'help'].includes(arg))) {
  process.stdout.write(
    'usage: clean-markup [--write] [--project CODE]\n\n' +
      '  Rewrites Markdown markers and wiki-link residue (**, backticks, [[…]], ]]) in stored titles,\n' +
      '  terms, risks and bodies. Reports by default; --write applies, each row as an audited update.\n',
  );
  process.exit(0);
}

const ACTOR = { actor: 'clean-markup', actorKind: 'system' } as const;

interface Row extends Record<string, unknown> {
  id: string;
  humanId?: string;
}

/** The slice of a Prisma delegate this uses; the generated types do not unify across models. */
interface Delegate {
  findMany(args: unknown): Promise<Row[]>;
  update(args: unknown): Promise<unknown>;
}

interface Target {
  readonly type: EntityType;
  readonly label: string;
  readonly delegate: (db: Db | TransactionClient) => Delegate;
  readonly fields: readonly FieldSpec[];
  readonly hasHumanId: boolean;
  /** Narrows to one project; null when the kind belongs to no project, so `--project` skips it. */
  readonly inProject: ((code: string) => Record<string, unknown>) | null;
}

const plain = (...names: string[]): FieldSpec[] => names.map((name) => ({ name, kind: 'plain' }));
const markdown = (...names: string[]): FieldSpec[] => names.map((name) => ({ name, kind: 'markdown' }));
const byProject = (code: string) => ({ project: { code } });

const TARGETS: readonly Target[] = [
  { type: 'task', label: 'task', delegate: (d) => d.task, fields: [...plain('title'), ...markdown('body')], hasHumanId: true, inProject: byProject },
  { type: 'adr', label: 'adr', delegate: (d) => d.adr, fields: [...plain('title'), ...markdown('contextMd', 'decisionMd', 'consequencesMd', 'rejectedMd')], hasHumanId: true, inProject: byProject },
  { type: 'requirement', label: 'requirement', delegate: (d) => d.requirement, fields: plain('statement'), hasHumanId: true, inProject: byProject },
  { type: 'phase', label: 'phase', delegate: (d) => d.phase, fields: plain('name'), hasHumanId: true, inProject: byProject },
  { type: 'risk', label: 'risk', delegate: (d) => d.risk, fields: plain('title', 'mitigation', 'tripwire'), hasHumanId: true, inProject: byProject },
  { type: 'idea', label: 'idea', delegate: (d) => d.idea, fields: plain('title'), hasHumanId: true, inProject: byProject },
  { type: 'finding', label: 'finding', delegate: (d) => d.finding, fields: plain('title'), hasHumanId: true, inProject: byProject },
  {
    type: 'term',
    label: 'term',
    delegate: (d) => d.term,
    fields: [...plain('term'), { name: 'aliases', kind: 'plain-list' }, ...markdown('definition')],
    hasHumanId: false,
    inProject: byProject,
  },
  { type: 'document', label: 'document', delegate: (d) => d.document, fields: plain('title'), hasHumanId: false, inProject: byProject },
  {
    type: 'document_section',
    label: 'section',
    delegate: (d) => d.documentSection,
    fields: [...plain('heading'), ...markdown('bodyMd')],
    hasHumanId: false,
    inProject: (code) => ({ document: { project: { code } } }),
  },
];

/** A column read as text; a null project id is the empty scope. */
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const clip = (value: string | string[], width = 90): string => {
  const text = (Array.isArray(value) ? value.join(' | ') : value).replace(/\s+/g, ' ');
  return JSON.stringify(text.length > width ? `${text.slice(0, width - 1)}…` : text);
};

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

interface Planned {
  readonly row: Row;
  readonly changes: FieldChange[];
  readonly name: string;
  /** Why the row is listed but not written. */
  readonly kept?: string;
}

try {
  let changedRows = 0;
  let keptRows = 0;
  let substitutionCount = 0;
  const byRule = new Map<string, number>();

  process.stdout.write(`clean-markup${only === undefined ? '' : ` --project ${only}`}${write ? ' --write' : ''}\n`);

  for (const target of TARGETS) {
    if (only !== undefined && target.inProject === null) continue;
    const select: Record<string, boolean> = { id: true };
    if (target.hasHumanId) select['humanId'] = true;
    for (const field of target.fields) select[field.name] = true;
    if (target.type === 'term') select['projectId'] = true;
    const rows = await target.delegate(db).findMany({
      where: { deletedAt: null, ...(only === undefined || target.inProject === null ? {} : target.inProject(only)) },
      select,
      orderBy: { id: 'asc' },
    });

    // A cleaned term must not collide with one already in its scope (the unique key is
    // [projectId, term], and soft-deleted terms still hold theirs).
    const claimed = new Set<string>();
    if (target.type === 'term') {
      const all = await target.delegate(db).findMany({ select: { projectId: true, term: true } });
      for (const t of all) claimed.add(`${str(t['projectId'])}\u0000${str(t['term'])}`);
    }

    const planned: Planned[] = [];
    for (const row of rows) {
      const changes = planRow(row, target.fields);
      if (changes === null) continue;
      const name = target.hasHumanId ? String(row.humanId) : String(row[target.fields[0]?.name ?? 'id']);
      let kept: string | undefined;
      const renamed = changes.find((change) => target.type === 'term' && change.field === 'term');
      if (renamed !== undefined) {
        const scope = str(row['projectId']);
        const key = `${scope}\u0000${String(renamed.after)}`;
        if (claimed.has(key)) kept = `cleaned name ${clip(String(renamed.after))} already exists in this scope; merge by hand`;
        else {
          claimed.add(key);
          claimed.delete(`${scope}\u0000${String(renamed.before)}`);
        }
      }
      planned.push({ row, changes, name, ...(kept === undefined ? {} : { kept }) });
    }
    if (planned.length === 0) continue;

    process.stdout.write(`\n${target.label}: ${String(planned.length)} row(s)\n`);
    for (const { row, changes, name, kept } of planned) {
      process.stdout.write(`  ${target.hasHumanId ? name : clip(name, 50)}${kept === undefined ? '' : `  KEPT: ${kept}`}\n`);
      for (const change of changes) {
        process.stdout.write(`    ${change.field}: ${clip(change.before)} -> ${clip(change.after)}\n`);
        for (const sub of change.substitutions) {
          process.stdout.write(`      ${sub.rule}: ${clip(sub.from, 60)} -> ${clip(sub.to, 60)}\n`);
          if (kept === undefined) {
            substitutionCount += 1;
            byRule.set(sub.rule, (byRule.get(sub.rule) ?? 0) + 1);
          }
        }
      }
      if (kept !== undefined) {
        keptRows += 1;
        continue;
      }
      changedRows += 1;
      if (!write) continue;

      const data = Object.fromEntries(changes.map((change) => [change.field, change.after]));
      const before = Object.fromEntries(changes.map((change) => [change.field, change.before]));
      await db.$transaction(async (tx) => {
        await target.delegate(tx).update({ where: { id: row.id }, data });
        // Every mutation writes an audit event, the CLI's included (FRM-REQ-136). `before` carries
        // only the fields this changed, which is all an undo needs to put back.
        await record(tx, {
          ...ACTOR,
          action: 'update',
          entityType: target.type,
          entityId: row.id,
          ...(target.hasHumanId ? { entityHumanId: String(row.humanId) } : {}),
          before,
          // Not `reason`: an idea has a column of that name, and undo compares every key of `after`.
          after: { ...data, cleanedBy: 'clean-markup' },
        });
      });
    }
  }

  const rules = [...byRule.entries()].map(([rule, count]) => `${rule} ${String(count)}`).join(', ');
  process.stdout.write(
    `\n${String(changedRows)} row(s) ${write ? 'cleaned' : 'would be cleaned'}, ${String(substitutionCount)} substitution(s)` +
      (rules === '' ? '' : ` (${rules})`) +
      `${keptRows === 0 ? '' : `; ${String(keptRows)} kept for a person to resolve`}.\n` +
      (changedRows === 0
        ? 'Nothing to do.\n'
        : write
          ? 'Written. Each row is an audited update by clean-markup; undo it from the activity log.\n'
          : 'Nothing written. Re-run with --write to apply.\n'),
  );
} finally {
  await db.$disconnect();
}
