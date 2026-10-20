import { useId, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * A sidebar row that opens a set of rows under it — the Library, and a project's Knowledge.
 *
 * `@d3cloud/ui` 1.7's `SideNavGroup` has a title and nothing to fold it (DS-REQ-026 asks for one), so
 * this is the smallest disclosure that does the job until it lands, and it should be replaced by the
 * library's when it does: a button with `aria-expanded` and `aria-controls`, and a list that is
 * `hidden` while closed, so a closed group's links are out of the tab order and the accessibility
 * tree rather than merely out of sight.
 *
 * - **Open or closed is remembered**, per browser, under `foreman.nav.<name>`. Storage can be
 *   missing or refuse (a private window, blocked site data), so every read and write is guarded and
 *   the row falls back to closed.
 * - **It opens itself when it holds the page you are on**, so the current row is never hidden
 *   behind a fold. Closing it there is honoured until you leave; leaving puts it back to what you
 *   chose last.
 *
 * It renders an `<li>`: it sits in a `SideNav` list beside the `SideNavItem`s, and its children are
 * `SideNavItem`s.
 */
export function NavDisclosure({
  name,
  label,
  icon,
  holdsCurrent,
  children,
}: {
  /** The storage key's last part, and part of the list's id. */
  name: string;
  label: string;
  icon: ReactNode;
  /** True when one of the rows inside is the page on screen. */
  holdsCurrent: boolean;
  children: ReactNode;
}) {
  const key = `foreman.nav.${name}`;
  const listId = `${useId()}-${name}`;
  const [remembered, setRemembered] = useState(() => readOpen(key));
  // A choice made while the group holds the current page lasts only while it does.
  const [whileCurrent, setWhileCurrent] = useState<boolean | null>(null);

  // Reset during render, as React advises for state derived from a prop, rather than in an effect
  // that would paint the stale state once first.
  const [heldCurrent, setHeldCurrent] = useState(holdsCurrent);
  if (heldCurrent !== holdsCurrent) {
    setHeldCurrent(holdsCurrent);
    setWhileCurrent(null);
  }

  const open = holdsCurrent ? (whileCurrent ?? true) : remembered;

  const toggle = () => {
    if (holdsCurrent) {
      setWhileCurrent(!open);
      return;
    }
    setRemembered(!open);
    writeOpen(key, !open);
  };

  return (
    <li className="fm-disclosure">
      <button
        type="button"
        className="fm-disclosure__toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={toggle}
      >
        <span className="fm-disclosure__icon" aria-hidden="true">
          {icon}
        </span>
        <span className="fm-disclosure__label">{label}</span>
        <ChevronRight className="fm-disclosure__chevron" aria-hidden="true" />
      </button>
      <ul id={listId} role="list" className="fm-disclosure__list" hidden={!open}>
        {children}
      </ul>
    </li>
  );
}

function readOpen(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeOpen(key: string, open: boolean): void {
  try {
    window.localStorage.setItem(key, open ? '1' : '0');
  } catch {
    // Remembering is a convenience; the row still opens and closes without it.
  }
}
