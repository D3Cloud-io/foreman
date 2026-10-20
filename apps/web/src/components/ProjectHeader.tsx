import type { ReactNode } from 'react';
import { Cluster, PageHeader } from '@d3cloud/ui';
import { briefFor, SECTIONS } from '../lib/project';
import { lifecycleTone } from '../ui/tone';
import { Pill } from '../ui/viz';
import { useAsync } from '../lib/useAsync';
import { OpenInConstellation } from './OpenInConstellation';

/**
 * The heading every screen inside a project wears.
 *
 * It exists because the section screens had no shared chrome at all: `/projects/BND/adrs` rendered
 * the word "Decision records" and a three-character link, so a reader two clicks deep could not
 * tell which project they were in without reading the URL, and the only route onwards was the
 * browser's back button.
 *
 * Three things, in the order they answer the reader's questions: **where am I** (the trail),
 * **whose is this** (the project, named, with its lifecycle), and **what is this** (the section).
 */
export function ProjectHeader({
  code,
  section,
  description,
  actions,
  count,
  countNoun,
  badge,
}: {
  code: string;
  /** The section slug, or undefined on the project's own overview. */
  section?: string;
  description?: ReactNode;
  actions?: ReactNode;
  count?: number;
  /** What the count counts. `countLabel` replaces the accessible name instead, which is not this. */
  countNoun?: { one: string; other: string };
  /**
   * Sits first in the row beside the title — the project's group chip on its overview (17.12).
   * The board puts it against the title itself; `PageHeader` has no slot there yet (DS-REQ-014…025).
   */
  badge?: ReactNode;
}) {
  const { state } = useAsync(() => briefFor(code), [code]);
  const here = SECTIONS.find((candidate) => candidate.slug === section);

  // The name if we have it, the code if we do not. Never a spinner: the heading is the first thing
  // painted, and a heading that arrives late moves everything under it.
  const name = state.status === 'ready' ? state.value.project.name : code;
  const lifecycle = state.status === 'ready' ? state.value.project.lifecycle : null;

  return (
    <PageHeader
      title={here === undefined ? name : (here.title ?? here.label)}
      {...(description === undefined ? {} : { description })}
      actions={
        // The lifecycle belongs beside the title, not in the trail: in the trail it reads as a
        // third crumb, and "Projects / planned" is not a path.
        <Cluster gap="8" align="center">
          {badge}
          {lifecycle !== null && <Pill tone={lifecycleTone(lifecycle)}>{lifecycle}</Pill>}
          {section === undefined && <OpenInConstellation path={`project/${code}`} />}
          {actions}
        </Cluster>
      }
      {...(count === undefined ? {} : { count })}
      {...(countNoun === undefined ? {} : { countNoun })}
      back={
        <Cluster gap="8" align="center">
          <a href="/projects">Projects</a>
          {here !== undefined && (
            <>
              <span aria-hidden="true" className="fm-crumb__sep">
                /
              </span>
              <a href={`/projects/${code}`}>{name}</a>
            </>
          )}
        </Cluster>
      }
    />
  );
}
