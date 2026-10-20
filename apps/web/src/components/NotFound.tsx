import { EmptyState, Link, Page } from '@d3cloud/ui';

/**
 * The one not-found page: a path nothing serves, and a page whose project does not exist.
 *
 * `/projects/ZZZ` used to render a project block titled "ZZZ" with all fourteen sections, and a
 * "ZZZ" tab on a phone (MOB-13) — offering a project that is not there. The shell now renders this
 * instead, with no project block, no trail and no project tab. It sits in a `Page` so it keeps the
 * page gutter every other screen has, and it offers the way out a person most likely wants.
 */
export function NotFound({ path, code }: { path: string; code: string | null }) {
  return (
    <Page>
      <EmptyState
        kind="no-results"
        size="page"
        headingLevel={2}
        heading="That page does not exist"
        action={<Link href={code === null ? '/' : '/projects'}>{code === null ? 'Go to Home' : 'Go to Projects'}</Link>}
      >
        {code === null
          ? `Nothing is served at ${path}.`
          : `Nothing in Foreman is at ${path}: no project has the code ${code}.`}
      </EmptyState>
    </Page>
  );
}
