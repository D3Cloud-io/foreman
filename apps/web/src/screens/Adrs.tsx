import { useState } from 'react';
import {
  Alert,
  Card,
  Cluster,
  EmptyState,
  Grid,
  Modal,
  Page,
  Section,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { Markdown } from '../components/Markdown';
import { ProjectHeader } from '../components/ProjectHeader';
import { foreman, type AdrRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useRowAnchor } from '../lib/useRowAnchor';
import { formatDate, plainText } from '../lib/text';
import { Pill, SegmentBar } from '../ui/viz';
import { SERIES, type Tone } from '../ui/tone';

/**
 * S-19 and S-20 — the decisions of a project, and the chain between them.
 *
 * This screen used to print every ADR in full, one after another: thirteen decision records, each
 * with context, decision, consequences and what was rejected, as a single column of markdown. It
 * was several thousand words before you could see how many there were, and finding a specific
 * decision meant scrolling past the others.
 *
 * The list is now the list — number, title, status, and the one-line abstract that already exists
 * on the record for exactly this purpose — and the body opens in a dialog. The chain moved into a
 * collapsed section, because it is worth having and is not what you came for.
 */

const STATUS_TONE: Record<string, Tone> = {
  accepted: 'success',
  proposed: 'accent',
  superseded: 'neutral',
  rejected: 'danger',
};

export function Adrs({ code }: { code: string }) {
  const adrs = useAsync(() => foreman.adrs(code), [code]);
  const graph = useAsync(() => foreman.adrGraph(code), [code]);
  const [open, setOpen] = useState<AdrRow | null>(null);

  const items = adrs.state.status === 'ready' ? adrs.state.value.items : [];
  // A jump from ⌘K lands on `#<ID>`: the card scrolls into view, takes focus and is outlined.
  useRowAnchor(items.length > 0);
  const byStatus = (status: string) => items.filter((adr) => adr.status === status).length;

  return (
    <Page>
      <ProjectHeader
        code={code}
        section="adrs"
        description="What was decided, why, and what replaced it."
        {...(adrs.state.status === 'ready'
          ? { count: items.length, countNoun: { one: 'decision', other: 'decisions' } }
          : {})}
      />

      {adrs.state.status === 'loading' ? (
        <Skeleton lines={10} />
      ) : adrs.state.status === 'error' ? (
        <EmptyState kind="error" heading="The decisions did not load">
          {adrs.state.message}
        </EmptyState>
      ) : items.length === 0 ? (
        <EmptyState kind="empty" heading="No decisions recorded">
          Nothing has been written down as a decision yet.
        </EmptyState>
      ) : (
        <Stack gap="24">
          <Section title="Status" surface="card">
            <SegmentBar
              segments={[
                { label: 'Accepted', value: byStatus('accepted'), color: SERIES.done },
                { label: 'Proposed', value: byStatus('proposed'), color: SERIES.active },
                { label: 'Superseded', value: byStatus('superseded'), color: SERIES.waiting },
                { label: 'Rejected', value: byStatus('rejected'), color: SERIES.blocked },
              ]}
            />
          </Section>

          <Grid minItemWidth="md">
            {items.map((adr) => (
              <AdrCard key={adr.humanId} adr={adr} onOpen={() => { setOpen(adr); }} />
            ))}
          </Grid>

          {graph.state.status === 'ready' && graph.state.value.edges.length > 0 && (
            <Section
              title="The supersedes chain"
              surface="card"
              description="Which decision replaced which."
            >
              {graph.state.value.cycle !== null && (
                // A cycle rendered silently is a cycle nobody notices. Named, with the loop.
                <Alert tone="danger" title="These supersede each other in a circle">
                  {graph.state.value.cycle.join(' → ')}
                </Alert>
              )}
              <Markdown>{mermaidFor(graph.state.value)}</Markdown>
            </Section>
          )}
        </Stack>
      )}

      {/* The body, on demand. A decision record is a document; a list of them is an index, and
          printing every document into the index is what made this screen unreadable. */}
      <Modal
        open={open !== null}
        onOpenChange={(next) => { if (!next) setOpen(null); }}
        size="lg"
        title={open === null ? '' : `${open.humanId} — ${plainText(open.title)}`}
      >
        {open !== null && <AdrBody adr={open} />}
      </Modal>
    </Page>
  );
}

function AdrCard({ adr, onOpen }: { adr: AdrRow; onOpen: () => void }) {
  const supersededBy = adr.relations.filter((relation) => relation.kind === 'superseded_by');

  return (
    <Card id={adr.humanId} padding="md" interactive onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <Stack gap="8">
        <Cluster gap="8" align="center" justify="between">
          <code className="fm-card__code">{adr.humanId}</code>
          <Pill tone={STATUS_TONE[adr.status] ?? 'neutral'}>{adr.status}</Pill>
        </Cluster>
        <span className="fm-card__title">{plainText(adr.title)}</span>
        {adr.decisionAbstract !== null && (
          <span className="fm-adr__abstract">{plainText(adr.decisionAbstract)}</span>
        )}
        <Cluster gap="8" align="center">
          {adr.decidedOn !== null && (
            <span className="fm-muted">decided {formatDate(adr.decidedOn)}</span>
          )}
          {supersededBy.length > 0 && (
            <Pill tone="warning" dot>
              superseded by {supersededBy.map((r) => r.relatedAdr.humanId).join(', ')}
            </Pill>
          )}
        </Cluster>
      </Stack>
    </Card>
  );
}

function AdrBody({ adr }: { adr: AdrRow }) {
  return (
    <Stack gap="16">
      <Cluster gap="8" align="center">
        <Pill tone={STATUS_TONE[adr.status] ?? 'neutral'}>{adr.status}</Pill>
        {adr.decidedOn !== null && (
          <span className="fm-muted">decided {formatDate(adr.decidedOn)}</span>
        )}
      </Cluster>

      {adr.decisionAbstract !== null && (
        <div className="fm-callout">
          <span className="fm-callout__label">In short</span>
          {plainText(adr.decisionAbstract)}
        </div>
      )}

      {adr.contextMd !== null && <Part label="Context" body={adr.contextMd} />}
      {adr.decisionMd !== null && <Part label="Decision" body={adr.decisionMd} />}
      {adr.consequencesMd !== null && <Part label="Consequences" body={adr.consequencesMd} />}
      {/* The half of an ADR usually lost: what was considered and turned down. */}
      {adr.rejectedMd !== null && <Part label="What was rejected" body={adr.rejectedMd} />}
    </Stack>
  );
}

function Part({ label, body }: { label: string; body: string }) {
  return (
    <Stack gap="4">
      <span className="fm-part__label">{label}</span>
      <Markdown>{body}</Markdown>
    </Stack>
  );
}

/** The graph as a Mermaid source block, which the markdown renderer already knows how to draw. */
function mermaidFor(graph: {
  nodes: { humanId: string; title: string; status: string }[];
  edges: { from: string; to: string; kind: string }[];
}): string {
  const id = (humanId: string) => humanId.replace(/-/g, '_');
  const lines = [
    'graph TB',
    ...graph.nodes.map(
      (node) => `  ${id(node.humanId)}["${node.humanId}<br/>${escape(node.title)}"]`,
    ),
    ...graph.edges.map((edge) => `  ${id(edge.from)} -->|${edge.kind}| ${id(edge.to)}`),
  ];
  return ['```mermaid', ...lines, '```'].join('\n');
}

/** Quotes and pipes break a Mermaid label; nothing else in a title does. */
function escape(text: string): string {
  return plainText(text).replace(/["|]/g, ' ').slice(0, 60);
}
