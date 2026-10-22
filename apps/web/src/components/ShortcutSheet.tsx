import { useEffect, useRef } from 'react';
import { Modal } from '@d3cloud/ui';
import { SHORTCUTS, type ShortcutGroup } from '../lib/shortcuts';
import './CommandPalette.css';

/**
 * A key cap: `@d3cloud/ui`'s `d3-kbd` — the class its `Kbd` draws, which the package does not export
 * (it is internal, drawn by Toast, SearchField and the palette's own hints). Unlike `Kbd` it is not
 * hidden from assistive technology: here the keys are the content, not a repeat of a control's name.
 */
function KeyCap({ children }: { children: string }) {
  return <kbd className="d3-kbd">{children}</kbd>;
}

/** The list itself, apart from the dialog around it, so its structure is testable in Node. */
export function ShortcutList({ groups = SHORTCUTS }: { groups?: readonly ShortcutGroup[] }) {
  return (
    <div className="fm-shortcuts">
      {groups.map((group) => (
        <section key={group.title} aria-label={group.title}>
          <h3 className="fm-shortcuts__title">{group.title}</h3>
          <ul className="fm-shortcuts__group" role="list">
            {group.rows.map((row) => (
              <li key={row.does} className="fm-shortcuts__row">
                <span className="fm-shortcuts__keys">
                  {row.keys.map((key) => (
                    <KeyCap key={key}>{key}</KeyCap>
                  ))}
                </span>
                <span>{row.does}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * Put focus back where it was when the sheet closes. A Modal returns focus to its trigger and
 * this one has none — a key opens it — so focus would fall to the page. The element that had focus
 * is remembered as the sheet opens, and given it back once the dialog has let go: Radix moves
 * focus as the exit animation ends, so this waits for focus to leave the dialog and acts only if it
 * landed nowhere.
 */
function useReturnFocus(open: boolean): void {
  const from = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      const active = document.activeElement;
      from.current = active instanceof HTMLElement && active !== document.body ? active : null;
      return;
    }
    const target = from.current;
    from.current = null;
    if (target === null) return;
    let frame = 0;
    let tries = 0;
    const settle = () => {
      const active = document.activeElement;
      const inDialog = active instanceof HTMLElement && active.closest('[role="dialog"]') !== null;
      if (inDialog && tries < 60) {
        tries += 1;
        frame = window.requestAnimationFrame(settle);
        return;
      }
      if ((active === null || active === document.body) && target.isConnected) target.focus();
    };
    frame = window.requestAnimationFrame(settle);
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);
}

/** `?` — what the keyboard does here (FRM-REQ-244). It lists what is bound and nothing planned. */
export function ShortcutSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useReturnFocus(open);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      description="Keys that work anywhere in the console. They are ignored while you are typing in a field."
      closeLabel="Close"
      size="md"
    >
      <ShortcutList />
    </Modal>
  );
}
