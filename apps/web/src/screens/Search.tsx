import { useEffect, useState } from 'react';
import {
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
import { ScopeBar, UnknownScope, useScopeView } from '../components/ScopeSwitcher';
import { foreman, type SearchHit } from '../lib/api';
import { scopeOf, withScope } from '../lib/scope';
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
    default:
      return null;
  }
}

export function Search({ search }: { search: string }) {
  const initial = new URLSearchParams(search);
  const [draft, setDraft] = useState(initial.get('q') ?? '');
  const [query, setQuery] = useState(initial.get('q') ?? '');
  const [type, setType] = useState(initial.get('type') ?? ANY);
  // Narrowed to a group when the URL names one (FRM-T-17.4). Keyed by the query, so a new scope
  // remounts the screen with its search intact.
  const scope = scopeOf(search);
  const { phrase } = useScopeView();

  // The URL carries the search, so a result set is a link somebody can keep.
  useEffect(() => {
    const next = new URLSearchParams();
    if (query !== '') next.set('q', query);
    if (type !== ANY) next.set('type', type);
    // The scope rides along: rewriting the URL for a new search must not drop it.
    const url = withScope(`/search${next.size === 0 ? '' : `?${next.toString()}`}`, scope);
    if (url !== window.location.pathname + window.location.search) {
      window.history.replaceState({}, '', url);
    }
  }, [query, type, scope]);

  const results = useAsync(
    () =>
      query.trim() === ''
        ? Promise.resolve({ items: [], nextCursor: null, total: 0 })
        : foreman.search(query.trim(), type === ANY ? [] : [type], null, scope),
    [query, type, scope],
  );

  return (
    <Page>
      <PageHeader
        title="Search"
        description={
          scope === null
            ? 'Across every project — which is the question the vault could never answer.'
            : `Across ${phrase} — by kind, an exact ID first.`
        }
      />
      <ScopeBar />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(draft);
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
              onValueChange={setType}
              options={[{ value: ANY, label: 'Anything' }, ...TYPES]}
            />
          </FormField>
          <Button type="submit" variant="primary">
            Search
          </Button>
        </FilterBar>
      </form>

      {query.trim() === '' ? (
        <EmptyState kind="empty" heading={scope === null ? 'Search across the whole portfolio' : `Search across ${phrase}`}>
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
      ) : results.state.value.items.length === 0 ? (
        <EmptyState kind="no-results" heading={`Nothing matches “${query}”`}>
          {scope === null ? 'Try a shorter word, or widen the kind.' : 'Try a shorter word, widen the kind, or show every project.'}
        </EmptyState>
      ) : (
        /* Named: a page holds several lists, and "the first list" is the navigation. */
        <Stack gap="16" as="ul" aria-label={`Results for ${query}`}>
          {results.state.value.items.map((hit) => (
            <Hit key={`${hit.type}:${hit.humanId ?? hit.title}`} hit={hit} />
          ))}
        </Stack>
      )}
    </Page>
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
