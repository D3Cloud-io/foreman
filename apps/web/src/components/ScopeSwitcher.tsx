import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { EmptyState, Link, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Modal } from '@d3cloud/ui';
import { Check, ChevronsUpDown, Settings2 } from 'lucide-react';
import { foreman } from '../lib/api';
import {
  matchScope,
  scopeName,
  scopeOptions,
  scopePhrase,
  useScope,
  type ScopeOption,
} from '../lib/scope';
import { useAsync } from '../lib/useAsync';
import { AccentDot } from '../ui/groups';
import './ScopeSwitcher.css';

/**
 * The scope switcher (17.03, FRM-ADR-024, FRM-T-17.4): All projects, each group with its count,
 * Ungrouped, then Manage groups…, the current one checked.
 *
 * - **`menu`** — the sidebar's: a full-width button under the brand, opening a Menu.
 * - **`sheet`** — the phone top bar's: a chip with the group's dot and name, opening the same list
 *   as a bottom sheet (the library's Modal is one below 600px).
 *
 * Every entry is a real link to the same page in that scope, so a scope is something you can open
 * in a new tab or copy; the URL is the only place it is kept. A group's dot is never shown without
 * its name. On a page a scope does not narrow, choosing one goes to Home in it.
 */

const SHEET_TITLE = 'Show projects from';

function Option({ option }: { option: ScopeOption }) {
  return (
    <>
      <span className="fm-scope__dot">
        {option.accent === null ? (
          <span className="fm-accent fm-accent--md fm-accent--none" aria-hidden="true" />
        ) : (
          <AccentDot accent={option.accent} />
        )}
      </span>
      <span className="fm-scope__name">{option.name}</span>
      <span className="fm-scope__count">{option.count}</span>
    </>
  );
}

/** An entry's name for assistive tech: "Dormice, 2 projects" — the count is a bare figure on screen. */
function optionLabel(option: ScopeOption): string {
  return `${option.name}, ${String(option.count)} ${option.count === 1 ? 'project' : 'projects'}`;
}

/**
 * The scope in view, and the switcher's options once the groups have loaded — what a scoped page
 * needs to name its scope in copy (`phrase`: "Open findings across D3 Cloud").
 */
export function useScopeView() {
  const state = useScope();
  const groups = useAsync(() => foreman.groups(), []);
  const options = groups.state.status === 'ready' ? scopeOptions(groups.state.value) : [];
  const current = matchScope(state.scope, options);
  return {
    ...state,
    groups,
    options,
    current,
    /** Loaded, and the URL's scope names no group: the page's own read will be a 404. */
    unknown: state.scope !== null && groups.state.status === 'ready' && current === undefined,
    name: scopeName(state.scope, current),
    phrase: scopePhrase(state.scope, current),
  };
}

export function ScopeSwitcher({ presentation }: { presentation: 'menu' | 'sheet' }) {
  const { hrefFor, groups, options, current, name } = useScopeView();
  const [open, setOpen] = useState(false);
  // The checked entry, so opening lands on where you are rather than on the first row (17.03).
  // Focus goes back to the trigger on close: the Menu and the Modal (given it as `trigger`) both
  // return it there.
  const currentRef = useRef<HTMLAnchorElement | null>(null);
  // The sheet: after the Modal's own open-focus, which lands on its close button.
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => { currentRef.current?.focus(); });
    return () => { window.cancelAnimationFrame(frame); };
  }, [open, options.length]);
  // The Menu: instead of its own open-focus (the first entry), in the same moment, so a quick
  // reopen never races a late focus. `MenuContent` passes it through to Radix's content.
  const openOnCurrent = {
    onOpenAutoFocus: (event: Event) => {
      if (currentRef.current === null) return;
      event.preventDefault();
      currentRef.current.focus();
    },
  };

  const isCurrent = (option: ScopeOption) => current !== undefined && option.key === current.key;
  // Until the groups load, the button still says where you are — from the URL.
  const label = `Scope: ${name}. Change scope`;

  const dot =
    current?.accent === undefined || current.accent === null ? null : <AccentDot accent={current.accent} size="sm" />;

  if (presentation === 'sheet') {
    return (
      <>
        <Modal
          open={open}
          onOpenChange={setOpen}
          title={SHEET_TITLE}
          closeLabel="Close"
          trigger={
            <button type="button" className="fm-scope-chip" aria-haspopup="dialog" aria-label={label}>
              {dot}
              <span className="fm-scope-chip__name fm-truncate">{name}</span>
              <ChevronsUpDown aria-hidden="true" className="fm-icon-sm" />
            </button>
          }
        >
          <nav aria-label="Scope">
            <ul className="fm-scope-sheet">
              {options.map((option) => (
                <li key={option.key}>
                  <a
                    className={`fm-scope-sheet__row${isCurrent(option) ? ' fm-scope-sheet__row--on' : ''}`}
                    ref={isCurrent(option) ? currentRef : undefined}
                    href={hrefFor(option.value)}
                    aria-label={optionLabel(option)}
                    aria-current={isCurrent(option) ? 'true' : undefined}
                    onClick={() => { setOpen(false); }}
                  >
                    <Option option={option} />
                    <span className="fm-scope__tick" aria-hidden="true">
                      {isCurrent(option) ? <Check className="fm-icon-sm" /> : null}
                    </span>
                  </a>
                </li>
              ))}
              <li className="fm-scope-sheet__sep" aria-hidden="true" />
              <li>
                <a className="fm-scope-sheet__row" href="/groups" onClick={() => { setOpen(false); }}>
                  <span className="fm-scope__dot">
                    <Settings2 aria-hidden="true" className="fm-icon-sm" />
                  </span>
                  <span className="fm-scope__name">Manage groups…</span>
                </a>
              </li>
            </ul>
          </nav>
          {groups.state.status === 'error' && (
            <p className="fm-muted">The groups did not load: {groups.state.message}</p>
          )}
        </Modal>
      </>
    );
  }

  return (
    <div className="fm-scope">
      <span className="fm-scope__caption" aria-hidden="true">
        Scope
      </span>
      <Menu>
        <MenuTrigger>
          <button type="button" className="fm-scope__button" aria-label={label}>
            {dot}
            <span className="fm-scope__label fm-truncate">{name}</span>
            {current !== undefined && <span className="fm-scope__count">{current.count}</span>}
            <ChevronsUpDown aria-hidden="true" className="fm-icon-sm fm-scope__chevron" />
          </button>
        </MenuTrigger>
        <MenuContent className="fm-scope__menu" {...openOnCurrent}>
          {options.map((option) => (
            <MenuItem key={option.key} asChild>
              <a
                ref={isCurrent(option) ? currentRef : undefined}
                href={hrefFor(option.value)}
                aria-label={optionLabel(option)}
                role="menuitemradio"
                aria-checked={isCurrent(option)}
                className="fm-scope__item"
              >
                <span className="fm-scope__tick" aria-hidden="true">
                  {isCurrent(option) ? <Check className="fm-icon-sm" /> : null}
                </span>
                <Option option={option} />
              </a>
            </MenuItem>
          ))}
          {groups.state.status === 'loading' && (
            <MenuItem disabled>Loading groups…</MenuItem>
          )}
          {groups.state.status === 'error' && <MenuItem disabled>The groups did not load</MenuItem>}
          <MenuSeparator />
          <MenuItem asChild icon={<Settings2 />}>
            <a href="/groups">Manage groups…</a>
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

/**
 * "Viewing Dormice · Show all" (17.02): said on every scoped page while a scope is set, so a
 * narrowed list never passes for the whole of it. Nothing when every project is in view.
 */
export function ScopeNotice() {
  const { scope, hrefFor, current, unknown, name } = useScopeView();
  if (scope === null) return null;
  return (
    <p className="fm-scope-notice" role="status">
      {current?.accent !== undefined && current.accent !== null && <AccentDot accent={current.accent} size="sm" />}
      {unknown ? (
        <span>
          No group is called <strong>{scope}</strong>
        </span>
      ) : (
        <span>
          Viewing <strong>{name}</strong>
        </span>
      )}
      <span aria-hidden="true">·</span>
      <Link variant="inline" href={hrefFor(null)}>
        Show all
      </Link>
    </p>
  );
}

/** What a scoped page shows when its read was refused because the scope names no group. */
export function UnknownScope({ scope }: { scope: string }) {
  const { hrefFor } = useScope();
  return (
    <EmptyState kind="no-results" heading={`No group is called “${scope}”`}>
      It may have been renamed or deleted.{' '}
      <Link variant="inline" href={hrefFor(null)}>
        Show every project
      </Link>
    </EmptyState>
  );
}

const WIDE = '(min-width: 1024px)';

function subscribeWide(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

/**
 * The line above a scoped page's content: the switcher, and "Viewing … · Show all".
 *
 * TEMPORARY — the switcher belongs in the sidebar head and the phone top bar, which FRM-T-16.4 is
 * rebuilding. Until that lands it stands here, on each scoped page, in the presentation the shell
 * will give it at this width; once it is mounted in the shell, this keeps only the notice.
 */
export function ScopeBar() {
  const wide = useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
  return (
    <div className="fm-scope-bar">
      <ScopeSwitcher presentation={wide ? 'menu' : 'sheet'} />
      <ScopeNotice />
    </div>
  );
}
