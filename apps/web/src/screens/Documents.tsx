import {
  Badge,
  EmptyState,
  Link,
  Page,
  Skeleton,
  Table,
} from '@d3cloud/ui';
import { foreman, type DocumentRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { ProjectHeader } from '../components/ProjectHeader';
import { priorityColumns, usePhone, type PriorityColumn } from '../ui/tablePriority';

/**
 * S-21 — the documents of one project, by kind.
 *
 * The five registers are deliberately absent: they are views, not documents (ADR-006), and there is
 * no document kind to author one under. What is here is what somebody actually wrote.
 */

export function Documents({ code }: { code: string }) {
  const { state } = useAsync(() => foreman.documents(code), [code]);

  // Below 768px the document is the title and its link; kind, sections, phase and date fold under it.
  const documentColumns: PriorityColumn<DocumentRow>[] = [
    {
      key: 'title',
      header: 'Document',
      sortable: true,
      phone: 'host',
      phoneCell: (row) => (
        <Link className="fm-rowlink" href={`/projects/${code}/documents/${row.id}`}>
          {row.title}
        </Link>
      ),
      cell: (row) => <Link href={`/projects/${code}/documents/${row.id}`}>{row.title}</Link>,
    },
    {
      key: 'kind',
      header: 'Kind',
      width: '10rem',
      sortable: true,
      phone: 'fold',
      foldLabel: '',
      cell: (row) => <Badge tone="neutral">{row.kind.replace(/_/g, ' ')}</Badge>,
    },
    {
      key: 'sections',
      header: 'Sections',
      width: '6rem',
      phone: 'fold',
      numeric: true,
      cell: (row) => row.sections.length,
    },
    {
      key: 'phase',
      header: 'Phase',
      width: '8rem',
      phone: 'fold',
      foldCell: (row) => row.phase?.humanId ?? null,
      cell: (row) => row.phase?.humanId ?? <span className="fm-muted">—</span>,
    },
    {
      key: 'updatedAt',
      header: 'Last edited',
      width: '10rem',
      sortable: true,
      phone: 'fold',
      cell: (row) => new Date(row.updatedAt).toLocaleDateString(),
    },
  ];

  const columns = priorityColumns(documentColumns, usePhone());

  return (
    <Page>
      <ProjectHeader
        code={code}
        section="documents"
        description="Everything authored for this project, addressable by section."
      />

      {state.status === 'loading' ? (
        <Skeleton lines={8} />
      ) : state.status === 'error' ? (
        <EmptyState kind="error" heading="The documents did not load">
          {state.message}
        </EmptyState>
      ) : (
        <Table
          caption={`Documents of ${code}`}
          captionHidden
          columns={columns}
          rows={state.value.items}
          rowKey={(row) => row.id}
          empty={
            <EmptyState kind="empty" size="inline" heading="Nothing authored yet">
              The registers — scope of work, requirements, risks, glossary — are generated views
              and do not appear here.
            </EmptyState>
          }
        />
      )}
    </Page>
  );
}
