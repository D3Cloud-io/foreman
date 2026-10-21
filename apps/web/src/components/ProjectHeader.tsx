import { useEffect, type ReactNode } from 'react';
import { Cluster, PageHeader } from '@d3cloud/ui';
import { briefFor, onBriefForgotten, SECTIONS } from '../lib/project';
import { lifecycleTone } from '../ui/tone';
import { Pill } from '../ui/viz';
import { useAsync } from '../lib/useAsync';
import { OpenInConstellation } from './OpenInConstellation';
import { RealityStrip } from './RealityStrip';

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
 *
 * And a fourth, under them (FRM-T-18.8, board D-08): **does the repo agree** — the reality strip.
 * It is this header's own second row, not a band of its own: the overview shows every cell with its
 * detail line, every other screen the compact row, and a record page (a task, a requirement) the
 * same compact row under its own title.
 */
export function ProjectHeader({
  code,
  section,
  description,
  actions,
  count,
  countNoun,
  badge,
  title,
  strip,
  trail = 'project',
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
  /**
   * The heading, when the page is a record inside the section — a phase, a task, a requirement —
   * and not the section's own list. The lifecycle and the Open in D3 Constellation link belong to
   * the project, so they are left to the project's own overview.
   */
  title?: string;
  /**
   * How much of the reality strip to show. The overview shows `full`; every other screen
   * `compact`; `none` is for a screen that draws its own.
   */
  strip?: 'full' | 'compact' | 'none';
  /**
   * `none` on a flat record page, where the shell already draws the trail above (`RecordTrail`) and
   * a second one would be two ways back.
   */
  trail?: 'project' | 'none';
}) {
  const { state, refresh } = useAsync(() => briefFor(code), [code]);
  // A rename (or any write that forgets the brief) is read again in place: the heading must not
  // keep the old name until a full reload.
  useEffect(
    () =>
      onBriefForgotten((forgotten) => {
        if (forgotten === code) refresh();
      }),
    [code, refresh],
  );
  const here = SECTIONS.find((candidate) => candidate.slug === section);

  // The name if we have it, the code if we do not. Never a spinner: the heading is the first thing
  // painted, and a heading that arrives late moves everything under it.
  const name = state.status === 'ready' ? state.value.project.name : code;
  const lifecycle = state.status === 'ready' ? state.value.project.lifecycle : null;
  const record = title !== undefined;
  const shown = strip ?? (section === undefined ? 'full' : 'compact');

  return (
    <div className="fm-project-header">
      <PageHeader
        title={title ?? (here === undefined ? name : (here.title ?? here.label))}
        {...(description === undefined ? {} : { description })}
        actions={
          // The lifecycle belongs beside the title, not in the trail: in the trail it reads as a
          // third crumb, and "Projects / planned" is not a path.
          <Cluster gap="8" align="center">
            {badge}
            {!record && lifecycle !== null && <Pill tone={lifecycleTone(lifecycle)}>{lifecycle}</Pill>}
            {!record && section === undefined && <OpenInConstellation path={`project/${code}`} />}
            {actions}
          </Cluster>
        }
        {...(count === undefined ? {} : { count })}
        {...(countNoun === undefined ? {} : { countNoun })}
        {...(trail === 'none'
          ? {}
          : {
              back: (
                <Cluster gap="8" align="center">
                  <a href="/projects">Projects</a>
                  {here !== undefined && (
                    <>
                      <span aria-hidden="true" className="fm-crumb__sep">
                        /
                      </span>
                      <a href={`/projects/${code}`}>{name}</a>
                      {record && (
                        <>
                          <span aria-hidden="true" className="fm-crumb__sep">
                            /
                          </span>
                          <a href={`/projects/${code}/${here.slug}`}>{here.label}</a>
                        </>
                      )}
                    </>
                  )}
                </Cluster>
              ),
            })}
      />
      {shown === 'none' ? null : <RealityStrip code={code} compact={shown === 'compact'} />}
    </div>
  );
}
