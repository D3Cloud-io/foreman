import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Modal, useTheme } from '@d3cloud/ui';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import mermaid from 'mermaid';
import { mermaidThemeVariables, wrapTables } from './markdownSupport';

/**
 * Markdown, rendered — with Mermaid diagrams (FRM-REQ-066).
 *
 * Three decisions:
 *
 * 1. **Sanitised, always.** The prose is written by the one operator, so this is not a defence
 *    against a hostile author — it is a defence against a document *imported* from the vault,
 *    where a stray `<script>` in a code sample would otherwise run inside the console's origin,
 *    which holds the session cookie.
 * 2. **Mermaid is loaded with the page, not lazily.** The console is desktop-only and
 *    single-operator; a spinner on every architecture document buys nothing.
 * 3. **A diagram that will not parse renders as its source**, with the parser's complaint. A blank
 *    space where a diagram should be is the failure that gets shipped.
 * 4. **A diagram follows the theme after it is drawn.** Mermaid bakes its palette into the SVG at
 *    render time, so a diagram drawn in light mode stays light when the theme flips — pale edge
 *    labels on pale plates, failing contrast. The theme is a dependency of the drawing, and a
 *    change redraws.
 * 5. **A diagram is drawn from the console's tokens** (FRM-REQ-250). Mermaid's own `default` theme
 *    draws dark-grey edges on any fill, 1.26:1 on a navy plate. The `--color-*` values are read from
 *    the page when the diagram is drawn — see `mermaidThemeVariables` — and Mermaid is
 *    re-initialised whenever they differ from the last time, so light and dark are each the
 *    console's own palette.
 * 6. **A diagram opens full size.** A wide one is unreadable in a card; clicking it (or Enter on it)
 *    opens the drawing in a Modal, scrollable at its natural width.
 * 7. **A table scrolls inside its card**, in a focusable, named region (`wrapTables`), rather than
 *    pushing the page sideways on a phone.
 */

/** The token values Mermaid was last initialised with. It is one global configuration. */
let initialisedWith = '';

function initMermaid(dark: boolean): void {
  const root = window.getComputedStyle(window.document.documentElement);
  const variables = mermaidThemeVariables((token) => root.getPropertyValue(token), dark);
  const signature = JSON.stringify(variables);
  if (initialisedWith === signature) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    themeVariables: variables,
    securityLevel: 'strict',
    fontFamily: 'inherit',
  });
  initialisedWith = signature;
}

/**
 * A diagram at its natural width, in a box that scrolls. Mermaid sizes its SVG to `width: 100%` with
 * a `max-width`, which is the right thing in a card and the wrong thing in a zoom.
 */
function ZoomedDiagram({ svg }: { svg: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current?.querySelector('svg');
    if (!element) return;
    const width = element.viewBox.baseVal.width;
    element.style.maxWidth = 'none';
    element.style.width = width > 0 ? `${String(width)}px` : '100%';
  }, [svg]);
  return (
    <div
      ref={box}
      className="fm-mermaid-zoom"
      role="region"
      tabIndex={0}
      aria-label="Diagram, full size"
      style={{ overflow: 'auto', maxHeight: '70vh' }}
      // Mermaid's own output, drawn with `securityLevel: 'strict'`.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * A page-unique id per drawing. `mermaid.render` removes whatever element already holds the id it
 * is given, and a theme change redraws every diagram on the page in the same tick — so an id built
 * from the slot index and `Date.now()` could collide across two sections and delete one's diagram.
 */
let drawings = 0;

/** Pull the mermaid fences out, leaving placeholders the renderer fills in. */
function split(markdown: string): { text: string; diagrams: string[] } {
  const diagrams: string[] = [];
  const text = markdown.replace(/```mermaid\s*\n([\s\S]*?)```/g, (_match, body: string) => {
    diagrams.push(body.trim());
    return `\n<div data-mermaid="${String(diagrams.length - 1)}"></div>\n`;
  });
  return { text, diagrams };
}

export function Markdown({ children }: { children: string }) {
  const host = useRef<HTMLDivElement>(null);
  // `resolved`, not `preference`: `system` is followed live through `prefers-color-scheme` by the
  // provider, so this one value changes for the ThemeSwitch and for the OS alike.
  const dark = useTheme().resolved === 'dark';
  const [zoomed, setZoomed] = useState<string | null>(null);
  const [rendered, setRendered] = useState<{ html: string; diagrams: string[] }>({
    html: '',
    diagrams: [],
  });

  useEffect(() => {
    const { text, diagrams } = split(children);
    const parsed = marked.parse(text, { async: false, gfm: true, breaks: false });
    // `data-mermaid` must survive the sanitiser, or the placeholders are unreachable.
    const html = wrapTables(DOMPurify.sanitize(parsed, { ADD_ATTR: ['data-mermaid'] }));
    setRendered({ html, diagrams });
  }, [children]);

  /**
   * Diagrams are drawn in their own effect, keyed on the rendered HTML.
   *
   * The first version drew them in a microtask queued from the effect above, which usually ran
   * *before* React committed the new HTML — so `querySelector` found no placeholder and the
   * diagram silently never appeared. An effect that depends on the HTML runs after it is in the
   * DOM, which is the only ordering that is actually guaranteed.
   *
   * It is keyed on the theme too, and redraws into the same slots when the theme changes. Reading
   * `data-theme` from `<html>` once, at first draw, is what left every diagram in its old palette.
   */
  useEffect(() => {
    if (rendered.diagrams.length === 0) return;
    const root = host.current;
    if (root === null) return;

    // An AbortController rather than a boolean: rendering a diagram is asynchronous, and a render
    // that finishes after the section changed must not paint over what replaced it.
    const cancel = new AbortController();
    // A function, so the check after an `await` is not narrowed to what it was before it.
    const cancelled = () => cancel.signal.aborted;

    void (async () => {
      // A macrotask, not a microtask: the theme provider sets `data-theme` in an effect of its own,
      // which runs *after* this child's, and the tokens must be read once it has.
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      if (cancelled()) return;
      initMermaid(dark);
      for (const [index, source] of rendered.diagrams.entries()) {
        const slot = root.querySelector(`[data-mermaid="${String(index)}"]`);
        if (slot === null) continue;
        try {
          drawings += 1;
          const { svg } = await mermaid.render(`fm-mermaid-${String(drawings)}`, source);
          if (cancelled()) continue;
          slot.innerHTML = svg;
          // Reachable and named, so the zoom is not a mouse-only feature.
          slot.setAttribute('role', 'button');
          slot.setAttribute('tabindex', '0');
          slot.setAttribute('aria-label', 'Diagram. Activate to open it full size.');
          slot.setAttribute('style', 'cursor:zoom-in;overflow-x:auto');
        } catch (error) {
          if (cancelled()) return;
          // The source and the complaint, not an empty box: a diagram that silently vanished is
          // one nobody notices is broken.
          const message = error instanceof Error ? error.message : String(error);
          const pre = window.document.createElement('pre');
          pre.className = 'fm-mermaid-error';
          pre.textContent = `${message}\n\n${source}`;
          slot.replaceChildren(pre);
        }
      }
    })();

    return () => {
      cancel.abort();
    };
  }, [rendered, dark]);

  const zoomFrom = (target: EventTarget | null): string | null => {
    if (!(target instanceof Element)) return null;
    const slot = target.closest('[data-mermaid]');
    if (slot === null || !host.current?.contains(slot)) return null;
    return slot.querySelector('svg')?.outerHTML ?? null;
  };
  const onClick = (event: MouseEvent) => {
    const svg = zoomFrom(event.target);
    if (svg !== null) setZoomed(svg);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // Only the slot itself: a space typed in a focused table region must still scroll it.
    if (!(event.target instanceof Element) || !event.target.hasAttribute('data-mermaid')) return;
    const svg = zoomFrom(event.target);
    if (svg === null) return;
    event.preventDefault();
    setZoomed(svg);
  };

  return (
    <>
      <div
        ref={host}
        className="fm-markdown"
        onClick={onClick}
        onKeyDown={onKeyDown}
        // Sanitised in the effect above, and the only path by which content reaches this.
        dangerouslySetInnerHTML={{ __html: rendered.html }}
      />
      <Modal
        open={zoomed !== null}
        onOpenChange={(open) => {
          if (!open) setZoomed(null);
        }}
        title="Diagram"
        size="lg"
      >
        {zoomed !== null && <ZoomedDiagram svg={zoomed} />}
      </Modal>
    </>
  );
}
