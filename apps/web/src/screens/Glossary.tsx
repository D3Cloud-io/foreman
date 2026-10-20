import {
  Badge,
  EmptyState,
  Page,
  Skeleton,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { foreman, type TermRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { InlineMarkdown } from '../components/InlineMarkdown';
import { ProjectHeader } from '../components/ProjectHeader';

/**
 * The Glossary, generated (T-4.12, FRM-REQ-071, FRM-REQ-073).
 *
 * Ecosystem terms appear in every project's glossary, and a project term of the same name shadows
 * one — the meaning in force is the one written down where the work is happening.
 *
 * Terms and definitions render through `InlineMarkdown` (FRM-REQ-250): the importer left the
 * vault's `**Asset**` in the data, `clean-markup` strips what is plainly residue, and what remains —
 * a backticked identifier in a definition — is formatted rather than printed with its marks.
 */

export function Glossary({ code }: { code: string }) {
  const { state } = useAsync(() => foreman.glossary(code), [code]);

  const columns: TableColumn<TermRow>[] = [
    { key: 'term', header: 'Term', width: '14rem', sortable: true, cell: (row) => <InlineMarkdown>{row.term}</InlineMarkdown> },
    { key: 'definition', header: 'Definition', cell: (row) => <InlineMarkdown>{row.definition}</InlineMarkdown> },
    {
      key: 'aliases',
      header: 'Also called',
      width: '12rem',
      cell: (row) =>
        row.aliases.length === 0 ? (
          <span className="fm-muted">—</span>
        ) : (
          <InlineMarkdown>{row.aliases.join(', ')}</InlineMarkdown>
        ),
    },
    {
      key: 'scope',
      header: 'Scope',
      width: '8rem',
      cell: (row) => (
        <Badge tone={row.scope === 'ecosystem' ? 'attention' : 'neutral'}>{row.scope}</Badge>
      ),
    },
  ];

  return (
    <Page>
      <ProjectHeader
        code={code}
        section="glossary"
        description={`${code}'s own terms, plus everything the ecosystem defines.`}
      />

      {state.status === 'loading' ? (
        <Skeleton lines={8} />
      ) : state.status === 'error' ? (
        <EmptyState kind="error" heading="The glossary did not load">
          {state.message}
        </EmptyState>
      ) : (
        <Table
          caption={`Glossary for ${code}`}
          captionHidden
          density="compact"
          columns={columns}
          rows={state.value.items}
          rowKey={(row) => `${row.scope}:${row.term}`}
          empty={
            <EmptyState kind="empty" size="inline" heading="No terms defined">
              A glossary exists so two people mean the same thing by one word.
            </EmptyState>
          }
        />
      )}
    </Page>
  );
}
