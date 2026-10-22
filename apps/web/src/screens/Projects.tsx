import { useState, type SyntheticEvent } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Cluster,
  EmptyState,
  FormActions,
  FormField,
  Input,
  Link,
  Modal,
  Page,
  PageHeader,
  SearchField,
  Select,
  Skeleton,
  Stack,
  Textarea,
} from '@d3cloud/ui';
import { Check, Minus } from 'lucide-react';
import { ProjectCode, type GroupListing } from '@foreman/shared';
import { ScopeNotice, UnknownScope } from '../components/ScopeSwitcher';
import { foreman, type PortfolioRow } from '../lib/api';
import { useMutate } from '../lib/mutate';
import { replaceLocation } from '../lib/router';
import {
  matchScope,
  scopeOf,
  scopeOptions,
  UNGROUPED as UNGROUPED_SCOPE,
  useScope,
  withParams,
} from '../lib/scope';
import { Snippet } from './ConnectAgent';
import { useAsync } from '../lib/useAsync';
import { descriptionsOf, portfolioSections, sectionSummary } from '../lib/groups';
import { AccentDot, MoveToGroupDialog, useMoveToast } from '../ui/groups';
import { Pill } from '../ui/viz';
import { rowPlanned } from '../ui/status';
import { ciTone, lifecycleTone } from '../ui/tone';

/**
 * Projects — every project, grouped (17.04, FRM-REQ-229, FRM-REQ-231).
 *
 * A table with a section per group in the order set on the Groups screen, Ungrouped last: the
 * columns are the ones you compare down (lifecycle, phase, drift, CI), and the group header says
 * how the family is doing as a whole. Rows carry a checkbox; with any selected, a bar offers
 * **Move to group…**, which opens the dialog that says what the move does to the guidelines before
 * it happens. The toast after it has Undo.
 *
 * Moving is a button, never a drag (FRM-REQ-230, FRM-REQ-125): the whole of it is reachable by
 * Tab and Space.
 *
 * One `<table>` with a `<tbody>` per group rather than a library Table per group: the library's
 * Table has no row groups, and a table per group would repeat its header row once a family.
 *
 * The header has **Import…** and **New project** (FRM-T-18.9, FRM-REQ-248): import is the CLI it
 * is, composed for the operator to copy — nothing here sends a path to the server — and a new
 * project's code is typed, checked against the shared rule, and said to be permanent (ADR-008).
 * Either opens from the address (`?new=1`, `?import=1`), so the Home checklist can link to it. A
 * seeded sample is labelled in its row.
 */

/** The Select's value for every project. Never sent: an unscoped read names no group. */
const ALL = 'all';

function phaseLabel(row: PortfolioRow): string {
  if (row.phase !== null) return `P-${row.phase.number} · ${row.phase.name}`;
  const total = row.tasks.open + row.tasks.blocked + row.tasks.done + row.tasks.cancelled;
  return total === 0 ? 'Not started' : 'No active phase';
}

function ciLabel(row: PortfolioRow): string {
  if (row.ci.unknown) return 'No CI';
  if (row.ci.conclusion === 'success') return 'CI';
  if (row.ci.conclusion === 'failure' || row.ci.conclusion === 'timed_out') return 'CI failing';
  return `CI ${row.ci.conclusion ?? 'pending'}`;
}

export function Projects({ search }: { search: string }) {
  // The group filter is the scope (FRM-T-17.4): `?group=` in the URL, read by the server, so
  // Projects narrowed to Dormice is the same set as Home and Findings narrowed to it. Every state
  // is header, scope bar, body, so the switcher keeps focus while a new scope loads.
  const scope = scopeOf(search);
  const { setScope, path } = useScope();
  const params = new URLSearchParams(search);
  const creating = params.get('new') === '1';
  const importing = params.get('import') === '1';
  const openPanel = (key: 'new' | 'import', open: boolean) => {
    replaceLocation(withParams(`${path}${search}`, { [key]: open ? '1' : null }));
  };
  const portfolio = useAsync(() => foreman.portfolio(scope), [scope]);
  const groups = useAsync(() => foreman.groups(), []);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [moving, setMoving] = useState(false);

  const reload = () => {
    portfolio.reload();
    groups.reload();
  };
  const toastMove = useMoveToast(reload);

  const ready = portfolio.state.status === 'ready' && groups.state.status === 'ready';
  const rows = portfolio.state.status === 'ready' ? portfolio.state.value.items : [];

  const header = (
    <PageHeader
      title="Projects"
      description="Every project Foreman tracks, by group, and where each one actually is."
      {...(ready ? { count: rows.length, countNoun: { one: 'project', other: 'projects' } } : {})}
      actions={
        <Cluster gap="8" align="center">
          <Button onClick={() => { openPanel('import', true); }}>Import…</Button>
          <Button variant="primary" onClick={() => { openPanel('new', true); }}>
            New project
          </Button>
        </Cluster>
      }
    />
  );

  if (portfolio.state.status === 'error' && portfolio.state.notFound && scope !== null) {
    return (
      <Page>
        {header}
        <ScopeNotice />
        <UnknownScope scope={scope} />
      </Page>
    );
  }

  if (portfolio.state.status === 'error' || groups.state.status === 'error') {
    const message =
      portfolio.state.status === 'error'
        ? portfolio.state.message
        : groups.state.status === 'error'
          ? groups.state.message
          : '';
    return (
      <Page>
        {header}
        <ScopeNotice />
        <EmptyState kind="error" heading="The projects did not load">
          {message}
        </EmptyState>
      </Page>
    );
  }

  if (portfolio.state.status !== 'ready' || groups.state.status !== 'ready') {
    return (
      <Page>
        {header}
        <ScopeNotice />
        <Skeleton lines={6} />
      </Page>
    );
  }

  const listing = groups.state.value;
  const needle = query.trim().toLowerCase();
  const matches = (row: PortfolioRow) =>
    needle === '' || row.code.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle);
  // The server has already narrowed the sections to the scope.
  const sections = portfolioSections(portfolio.state.value, descriptionsOf(listing))
    .map((section) => ({ ...section, shown: section.rows.filter(matches) }))
    // With a filter typed, a family with nothing matching is noise; without one it is a family.
    .filter((section) => needle === '' ? section.group !== null || section.rows.length > 0 : section.shown.length > 0);

  const visible = sections.flatMap((section) => section.shown.map((row) => row.code));
  const chosen = rows.filter((row) => selected.has(row.code));
  const allShown = visible.length > 0 && visible.every((code) => selected.has(code));
  const someShown = visible.some((code) => selected.has(code));

  const toggle = (code: string, on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(code);
      else next.delete(code);
      return next;
    });
  };

  const scopes = scopeOptions(listing);
  const groupOptions = scopes.map((option) => ({
    value: option.value ?? ALL,
    label: option.value === null ? 'All groups' : option.name,
  }));
  const groupFilter = matchScope(scope, scopes)?.value ?? ALL;
  const onlyUngrouped = scope?.toLowerCase() === UNGROUPED_SCOPE;

  return (
    <Page>
      {header}
      <ScopeNotice />
      <Stack gap="16">
        <Cluster gap="12" align="center" justify="between">
          <Cluster gap="12" align="center" className="fm-filters">
            <SearchField
              aria-label="Filter by code or name"
              placeholder="Filter by code or name"
              value={query}
              onChange={(event) => { setQuery(event.target.value); }}
            />
            <Select
              aria-label="Group"
              options={groupOptions}
              value={groupFilter}
              onValueChange={(next) => { setScope(next === ALL ? null : next); }}
            />
          </Cluster>
          <span className="fm-muted">
            Grouped in the order set in <Link variant="inline" href="/groups">Settings → Groups</Link>
          </span>
        </Cluster>

        {chosen.length > 0 && (
          <div className="fm-selection" role="region" aria-label="Selected projects">
            <Cluster gap="12" align="center">
              <span className="fm-selection__count" aria-live="polite">
                {chosen.length} selected
              </span>
              <code className="fm-selection__codes">{chosen.map((row) => row.code).join(', ')}</code>
            </Cluster>
            <Cluster gap="8" align="center">
              <Button variant="primary" size="sm" onClick={() => { setMoving(true); }}>
                Move to group…
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setSelected(new Set()); }}>
                Clear
              </Button>
            </Cluster>
          </div>
        )}

        {rows.length === 0 && scope === null ? (
          <EmptyState kind="empty" heading="No projects yet">
            Start one with New project, or bring one in with Import….
          </EmptyState>
        ) : sections.length === 0 && needle === '' && onlyUngrouped ? (
          <EmptyState kind="empty" heading="No project is ungrouped">
            Every project is in a group.
          </EmptyState>
        ) : sections.length === 0 ? (
          <EmptyState kind="no-results" heading="Nothing matches">
            {onlyUngrouped
              ? `No ungrouped project has ${query.trim()} in its code or name.`
              : `No project has ${query.trim()} in its code or name.`}
          </EmptyState>
        ) : (
          <div className="fm-gtable-wrap">
            <table className="fm-gtable">
              <caption className="fm-visually-hidden">Projects, by group</caption>
              <thead>
                <tr>
                  <th scope="col" className="fm-gtable__select">
                    <Checkbox
                      aria-label="Select every project shown"
                      checked={allShown ? true : someShown ? 'indeterminate' : false}
                      checkIcon={allShown ? <Check /> : <Minus />}
                      onCheckedChange={() => {
                        setSelected((current) => {
                          const next = new Set(current);
                          for (const code of visible) {
                            if (allShown) next.delete(code);
                            else next.add(code);
                          }
                          return next;
                        });
                      }}
                    />
                  </th>
                  <th scope="col">Code</th>
                  <th scope="col">Name</th>
                  <th scope="col" className="fm-gtable__wide">Lifecycle</th>
                  <th scope="col" className="fm-gtable__wide">Active phase</th>
                  <th scope="col" className="fm-gtable__wide fm-gtable__num">Drift</th>
                  <th scope="col">CI</th>
                </tr>
              </thead>
              {sections.map((section) => (
                <tbody key={section.key}>
                  <tr className={`fm-gtable__group${section.group === null ? ' fm-gtable__group--quiet' : ''}`}>
                    <th scope="rowgroup" colSpan={7}>
                      <span className="fm-gtable__groupname">
                        {section.group !== null && <AccentDot accent={section.group.accent} size="sm" />}
                        {section.name}
                      </span>
                      <span className="fm-muted">
                        {section.group === null
                          ? `${String(section.rows.length)} ${section.rows.length === 1 ? 'project' : 'projects'}`
                          : sectionSummary(section.rows)}
                      </span>
                    </th>
                  </tr>
                  {section.shown.length === 0 && (
                    <tr>
                      <td />
                      <td colSpan={6} className="fm-muted">
                        No projects yet — select some above and choose Move to group…
                      </td>
                    </tr>
                  )}
                  {section.shown.map((row) => {
                    const on = selected.has(row.code);
                    return (
                      <tr key={row.code} className={on ? 'fm-gtable__row--on' : undefined}>
                        <td className="fm-gtable__select">
                          <Checkbox
                            aria-label={`Select ${row.code} ${row.name}`}
                            checked={on}
                            checkIcon={<Check />}
                            onCheckedChange={(next) => { toggle(row.code, next === true); }}
                          />
                        </td>
                        <td>
                          <code className="fm-gtable__code">{row.code}</code>
                        </td>
                        <td>
                          <a className="fm-gtable__name" href={`/projects/${row.code}`}>
                            {row.name}
                          </a>
                          {row.sample === true && (
                            <span className="fm-sample-label">
                              <Pill tone="neutral">Sample</Pill>
                            </span>
                          )}
                          <span className="fm-muted fm-gtable__sub">
                            {row.lifecycle} · {phaseLabel(row)}
                          </span>
                        </td>
                        <td className="fm-gtable__wide">
                          <Pill tone={lifecycleTone(row.lifecycle)}>{row.lifecycle}</Pill>
                        </td>
                        <td className="fm-gtable__wide">{phaseLabel(row)}</td>
                        <td className="fm-gtable__wide fm-gtable__num">
                          {/* A project with no plan has nothing to drift from: "0" would read as clean. */}
                          {row.drift.total === 0 && !rowPlanned(row) ? (
                            <span className="fm-muted" title="Not measurable yet: no plan">
                              —<span className="fm-visually-hidden"> not measurable yet</span>
                            </span>
                          ) : (
                            row.drift.total
                          )}
                        </td>
                        <td>
                          <Pill tone={ciTone(row.ci.conclusion, row.ci.unknown)} dot>
                            {ciLabel(row)}
                          </Pill>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        )}
      </Stack>
      {/* On a phone the bar is fixed over the foot of the list; this keeps the last row clear of it. */}
      {chosen.length > 0 && <div className="fm-selection-clear" aria-hidden="true" />}

      <MoveToGroupDialog
        open={moving}
        onOpenChange={setMoving}
        projects={chosen.map((row) => ({ code: row.code, name: row.name }))}
        listing={listing}
        onMoved={(result, codes, targetName, origin) => {
          setSelected(new Set());
          reload();
          toastMove(result, codes, targetName, origin);
        }}
      />

      <NewProjectDialog
        open={creating}
        onOpenChange={(open) => { openPanel('new', open); }}
        listing={listing}
        scope={scope}
        taken={rows}
        onCreated={reload}
      />
      <ImportDialog open={importing} onOpenChange={(open) => { openPanel('import', open); }} />
    </Page>
  );
}

// ─── New project (FRM-T-18.9) ───────────────────────────────────────────────

/** The Select's value for no group. */
const NO_GROUP = 'none';

/**
 * What is wrong with a typed code, or null when nothing is — the shared rule (`ProjectCode`), said
 * the way a person fixes it. Empty says nothing yet; the button is what waits.
 */
export function codeProblem(code: string, taken: readonly Pick<PortfolioRow, 'code' | 'name'>[]): string | null {
  if (code === '') return null;
  const owner = taken.find((row) => row.code === code);
  if (owner !== undefined) return `${code} is ${owner.name}’s code already.`;
  const parsed = ProjectCode.safeParse(code);
  if (parsed.success) return null;
  const upper = code.toUpperCase();
  if (upper !== code && ProjectCode.safeParse(upper).success) return `Upper case only. Did you mean ${upper}?`;
  if (code.length < 2) return 'At least 2 characters.';
  return parsed.error.issues[0]?.message ?? 'Not a project code.';
}

/** The IDs a code will stamp, so its permanence is concrete. */
export function stampedIds(code: string): string {
  return `${code}-REQ-001, ${code}-ADR-001, ${code}-T-1.1`;
}

/** The group a new project defaults to: the scope you are in, else none (`lib/scope.ts`). */
export function defaultGroup(scope: string | null, listing: GroupListing): string {
  return matchScope(scope, scopeOptions(listing))?.humanId ?? NO_GROUP;
}

function NewProjectDialog({
  open,
  onOpenChange,
  listing,
  scope,
  taken,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listing: GroupListing;
  scope: string | null;
  /** The rows on screen — possibly one group's. The check reads every project's code as well. */
  taken: readonly PortfolioRow[];
  onCreated: () => void;
}) {
  // Every code, not the scope's: a code is unique across the whole Foreman (ADR-008), and the
  // portfolio this screen holds may be narrowed to one group. Read each time the dialog opens.
  const everyCode = useAsync(() => (open ? foreman.projectCodes() : Promise.resolve([])), [open]);
  const allTaken = everyCode.state.status === 'ready' ? [...everyCode.state.value, ...taken] : taken;
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [pitch, setPitch] = useState('');
  const [group, setGroup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { mutate, pending } = useMutate();

  const chosen = group ?? defaultGroup(scope, listing);
  const problem = codeProblem(code, allTaken);
  const valid = code !== '' && problem === null && name.trim() !== '';
  const groupName = listing.items.find((item) => item.humanId === chosen)?.name ?? null;

  const reset = () => {
    setName('');
    setCode('');
    setPitch('');
    setGroup(null);
    setError(null);
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!valid) return;
    setError(null);
    void mutate({
      subject: code,
      run: () =>
        foreman.createProject({
          code,
          name: name.trim(),
          ...(pitch.trim() === '' ? {} : { pitch: pitch.trim() }),
          group: chosen === NO_GROUP ? null : chosen,
        }),
      message: (created) => `Created ${created.code} — ${created.name}${groupName === null ? '' : ` in ${groupName}`}`,
      refresh: onCreated,
      failure: 'inline',
    }).then((outcome) => {
      if (outcome.ok) {
        reset();
        onOpenChange(false);
      } else if (outcome.inFlight !== true) {
        setError(outcome.message);
      }
    });
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title="New project"
      description={
        groupName === null
          ? 'In no group. It starts as planned.'
          : `Into ${groupName}${scope === null ? '' : ', the scope you are in'}. It starts as planned.`
      }
    >
      <form onSubmit={submit}>
        <Stack gap="16">
          {error !== null && (
            <Alert tone="danger" title="It was not created" dynamic>
              {error}
            </Alert>
          )}
          <FormField label="Name">
            <Input name="name" value={name} maxLength={200} onChange={(e) => { setName(e.target.value); }} />
          </FormField>
          <FormField
            label="Code"
            help="2–8 upper-case letters or digits, letter first. Type it yourself; it is never derived from the name."
            {...(problem === null ? {} : { error: problem })}
          >
            <Input
              name="code"
              className="fm-code-input"
              value={code}
              maxLength={8}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => { setCode(e.target.value.trim()); }}
            />
          </FormField>
          <Alert tone="warning" title="Immutable once created">
            Every ID in this project starts with its code, forever
            {code !== '' && problem === null ? `: ${stampedIds(code)}` : ''}. It cannot be renamed later.
          </Alert>
          <FormField label="Group" help="Defaults to the scope you are in. Ungrouped is an option.">
            <Select
              aria-label="Group"
              value={chosen}
              onValueChange={setGroup}
              options={[
                ...listing.items.map((item) => ({ value: item.humanId, label: item.name })),
                { value: NO_GROUP, label: 'No group (Ungrouped)' },
              ]}
            />
          </FormField>
          <FormField label="Pitch" optional>
            <Textarea name="pitch" value={pitch} maxLength={2000} onChange={(e) => { setPitch(e.target.value); }} />
          </FormField>
          <p className="fm-muted">
            Plan it next with <code>/plan-project {name.trim() === '' ? '<name>' : name.trim()}</code> in Claude Code.
          </p>
          <FormActions>
            <Button type="button" onClick={() => { reset(); onOpenChange(false); }}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!valid} loading={pending}>
              {code !== '' && problem === null ? `Create ${code}` : 'Create'}
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Modal>
  );
}

// ─── Import, as the CLI it is (FRM-T-18.9) ──────────────────────────────────

/**
 * The import lines: the dry run first — not writing is the importer's default — then the same with
 * `--write`. Composed here and copied; the server never reads a filesystem path from a web request.
 */
export function importCommands(vault: string, folder: string): { dryRun: string; write: string } {
  const dryRun = `pnpm --filter foreman-server run import -- --path "${vault === '' ? '<vault>' : vault}" --only "${
    folder === '' ? '<Folder>' : folder
  }"`;
  return { dryRun, write: `${dryRun} --write` };
}

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [vault, setVault] = useState('');
  const [folder, setFolder] = useState('');
  const commands = importCommands(vault.trim(), folder.trim());
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Import from the archived vault"
      description="Import runs on the host, in a shell, from the Foreman checkout. The console shows the command; Foreman’s server never reads a path from a web request."
    >
      <Stack gap="16">
        <FormField label="Vault" help="The vault's root folder on the host.">
          <Input name="vault" value={vault} placeholder="../d3cloud-archive/D3 Cloud Vault" onChange={(e) => { setVault(e.target.value); }} />
        </FormField>
        <FormField label="Project folder" help="The folder of the one project to import, by its own name.">
          <Input name="folder" value={folder} placeholder="Kardashev" onChange={(e) => { setFolder(e.target.value); }} />
        </FormField>
        <Stack gap="4">
          <span className="fm-part__label">1 · Dry run — writes nothing, and accounts for every file</span>
          <Snippet label="the import dry run" text={commands.dryRun} />
        </Stack>
        <Stack gap="4">
          <span className="fm-part__label">2 · Write — once the report has no warning</span>
          <Snippet label="the import with --write" text={commands.write} />
        </Stack>
        <FormActions>
          <Button variant="primary" onClick={() => { onOpenChange(false); }}>
            Done
          </Button>
        </FormActions>
      </Stack>
    </Modal>
  );
}

