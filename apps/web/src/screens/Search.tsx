import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  FilterBar,
  FormField,
  Input,
  Link,
  Page,
  PageHeader,
  Select,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { ScopeNotice, UnknownScope, useScopeView } from '../components/ScopeSwitcher';
import { foreman, type SearchHit, type SearchResult } from '../lib/api';
import { replaceLocation } from '../lib/router';
import { scopeOf, withParams } from '../lib/scope';
import { useAsync } from '../lib/useAsync';

/**
 * S-06 — typed search across every project (T-4.11, FRM-REQ-132).
 *
 * **Cross-project by default**, which is the half the vault could never do: "did we already decide
 * this somewhere else" is the question an ADR search exists to answer, and it is never scoped to
 * the project you happen to be looking at.
 */

const TYPES = [
  { value: 'adr', label: 'Decision records' },
  { value: 'requirement', label: 'Requirements' },
  { value: 'task', label: 'Tasks' },
  { value: 'finding', label: 'Findings' },
  { value: 'document_section', label: 'Document sections' },
  { value: 'decision', label: 'Decisions' },
  { value: 'risk', label: 'Risks' },
  { value: 'term', label: 'Glossary' },
  { value: 'phase', label: 'Phases' },
] as const;

const ANY = 'any';

/** Where a hit lives, by kind. A result you cannot click is a result you have to go and find. */
function hrefFor(hit: SearchHit): string | null {
  if (hit.humanId === null || hit.projectCode === null) return null;
  switch (hit.type) {
    case 'requirement':
      return `/requirements/${hit.humanId}`;
    case 'task':
      return `/tasks/${hit.humanId}`;
    case 'phase':
      return `/projects/${hit.projectCode}/phases/${hit.humanId}`;
    case 'adr':
      return `/projects/${hit.projectCode}/adrs`;
    case 'risk':
      return `/projects/${hit.projectCode}/risks`;
    case 'term':
      return `/projects/${hit.projectCode}/glossary`;
    case 'finding':
      return `/findings/${hit.humanId}`;
    default:
      return null;
  }
}

export function Search({ search }: { search: string }) {
  // The URL is the search (FRM-T-17.4): `q`, `type` and the scope are read from it on every
  // render, and a submitted search or a new kind is written back with `replaceLocation`, which
  // every reader of the location hears — the switcher included, so changing the scope keeps the
  // query, and a result set is a link. Only the half-typed draft is local.
  const params = new URLSearchParams(search);
  const query = params.get('q') ?? '';
  const type = params.get('type') ?? ANY;
  const [draft, setDraft] = useState(query);
  // Back and Forward, or a link with another `q`: the box follows the URL it is showing.
  useEffect(() => { setDraft(query); }, [query]);
  const scope = scopeOf(search);
  const { phrase, hrefFor: scopeHref } = useScopeView();
  const write = (changes: Record<string, string | null>) => {
    replaceLocation(withParams(`/search${search}`, changes));
  };

  const results = useAsync(
    () =>
      query.trim() === ''
        ? Promise.resolve<SearchResult>({ items: [], nextCursor: null, total: 0, outside: null })
        : foreman.search(query.trim(), type === ANY ? [] : [type], null, scope),
    [query, type, scope],
  );
  const everywhere = scopeHref(null);
  const outside = results.state.status === 'ready' ? (results.state.value.outside ?? null) : null;

  return (
    <Page>
      <PageHeader
        title="Search"
        description={
          scope === null
            ? 'Across every project, by ID or by words.'
            : phrase === null
              ? 'By kind, an exact ID first.'
              : `Across ${phrase} — by kind, an exact ID first.`
        }
      />
      <ScopeNotice />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          write({ q: draft.trim() === '' ? null : draft });
        }}
      >
        <FilterBar aria-label="Search everything">
          <FormField label="Find">
            <Input
              value={draft}
              placeholder="pg_trgm, BND-ADR-004, tunnel"
              onChange={(event) => { setDraft(event.currentTarget.value); }}
            />
          </FormField>
          <FormField label="Kind">
            <Select
              value={type}
              onValueChange={(next) => { write({ type: next === ANY ? null : next }); }}
              options={[{ value: ANY, label: 'Anything' }, ...TYPES]}
            />
          </FormField>
          <Button type="submit" variant="primary">
            Search
          </Button>
        </FilterBar>
      </form>

      {query.trim() === '' ? (
        <EmptyState
          kind="empty"
          heading={scope === null || phrase === null ? 'Search across the whole portfolio' : `Search across ${phrase}`}
        >
          An exact human ID — <code>BND-ADR-004</code> — resolves to that entity first.
        </EmptyState>
      ) : results.state.status === 'loading' ? (
        <Skeleton lines={8} />
      ) : results.state.status === 'error' && results.state.notFound && scope !== null ? (
        <UnknownScope scope={scope} />
      ) : results.state.status === 'error' ? (
        <EmptyState kind="error" heading="That search did not run">
          {results.state.message}
        </EmptyState>
      ) : (
        <Stack gap="16">
          {outside !== null && <OutsideScope hit={outside} phrase={phrase} everywhere={everywhere} />}
          {results.state.value.items.length === 0 ? (
            outside !== null ? null : (
              <EmptyState
                kind="no-results"
                heading={scope === null || phrase === null ? `Nothing matches “${query}”` : `Nothing matches “${query}” in ${phrase}`}
              >
                {scope === null ? (
                  'Try a shorter word, or widen the kind.'
                ) : (
                  <>
                    Try a shorter word or widen the kind — or{' '}
                    <Link variant="inline" href={everywhere}>
                      search every project
                    </Link>
                    .
                  </>
                )}
              </EmptyState>
            )
          ) : (
            /* Named: a page holds several lists, and "the first list" is the navigation. */
            <Stack gap="16" as="ul" aria-label={`Results for ${query}`}>
              {results.state.value.items.map((hit) => (
                <Hit key={`${hit.type}:${hit.humanId ?? hit.title}`} hit={hit} />
              ))}
            </Stack>
          )}
        </Stack>
      )}
    </Page>
  );
}

/**
 * "SC4SWI-CR-001 is in Cloud 4SWI, outside Dormice · Show it · Search every project": the exact ID
 * that was asked for exists, and the scope is what hid it — said, with the way to it, rather than
 * "Nothing matches" about a record that is right there.
 */
function OutsideScope({
  hit,
  phrase,
  everywhere,
}: {
  hit: NonNullable<SearchResult['outside']>;
  phrase: string | null;
  everywhere: string;
}) {
  const where = hit.group === null ? `${hit.projectCode ?? 'a project'}, which is in no group` : hit.group.name;
  const record = hrefFor(hit) ?? withParams(everywhere, { q: hit.humanId });
  return (
    <Alert tone="info" dynamic title={`${hit.humanId ?? hit.title} is outside ${phrase ?? 'this scope'}`}>
      <span>
        {hit.humanId ?? hit.title} is in {where}, outside {phrase ?? 'this scope'}.{' '}
      </span>
      <Link variant="inline" href={record}>
        Show it
      </Link>
      {' · '}
      <Link variant="inline" href={everywhere}>
        Search every project
      </Link>
    </Alert>
  );
}

function Hit({ hit }: { hit: SearchHit }) {
  const href = hrefFor(hit);
  const label = hit.humanId ?? hit.title;

  return (
    <li>
      <Stack gap="4">
        <div>
          {/* The project is on every row: a cross-project result set that does not say which
              project each hit is from is a list you have to check one at a time. */}
          {hit.projectCode === null ? null : <Badge tone="neutral">{hit.projectCode}</Badge>}{' '}
          <Badge tone="neutral">{hit.type.replace(/_/g, ' ')}</Badge>{' '}
          {href === null ? <strong>{label}</strong> : <Link href={href}>{label}</Link>}
        </div>
        <div>{hit.title}</div>
        {hit.snippet === null ? null : <div className="fm-muted">{hit.snippet}</div>}
      </Stack>
    </li>
  );
}
