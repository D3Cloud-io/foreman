import { Fragment, type ReactNode } from 'react';
import { marked, type Token, type Tokens } from 'marked';

/**
 * One primitive for inline Markdown in a title or a table cell (FRM-REQ-250, FRM-T-18.11).
 *
 * The imported text carries the vault's marks — `**Asset**`, a backticked identifier, a link — and
 * a screen that prints a title with `{title}` shows the asterisks. The *data* is cleaned once, by
 * `clean-markup` (what is plainly residue); this renders the legitimate markup that remains.
 *
 * **Inline only, and as React elements.** Block syntax (headings, lists, tables) means nothing in a
 * cell, so only the inline lexer runs, and its tokens are turned into elements directly rather than
 * into an HTML string: there is nothing to sanitise because nothing is ever parsed as HTML, and it
 * renders the same on the server, in the unit tests and in the browser. Raw HTML in the text is
 * shown as text, and a link survives only when its scheme is one a title could safely carry.
 *
 * It renders a `<span>`, so it sits inside a heading, a table cell or a link without changing what
 * that element is.
 */

/** The schemes a link in a title or cell may use; anything else renders as its text. */
const SAFE_HREF = /^(https?:|mailto:|\/(?!\/)|#)/i;

function render(tokens: readonly Token[], keyPrefix: string): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}.${String(index)}`;
    switch (token.type) {
      case 'strong':
        return <strong key={key}>{render((token as Tokens.Strong).tokens, key)}</strong>;
      case 'em':
        return <em key={key}>{render((token as Tokens.Em).tokens, key)}</em>;
      case 'del':
        return <del key={key}>{render((token as Tokens.Del).tokens, key)}</del>;
      case 'codespan':
        return <code key={key}>{(token as Tokens.Codespan).text}</code>;
      case 'br':
        return <br key={key} />;
      case 'link': {
        const link = token as Tokens.Link;
        const inner = render(link.tokens, key);
        if (!SAFE_HREF.test(link.href)) return <Fragment key={key}>{inner}</Fragment>;
        const external = /^https?:/i.test(link.href);
        return (
          <a
            key={key}
            href={link.href}
            {...(link.title ? { title: link.title } : {})}
            {...(external ? { rel: 'noreferrer noopener' } : {})}
          >
            {inner}
          </a>
        );
      }
      case 'image':
        // An image has no place in a cell; its alt text is what the author meant to say.
        return <Fragment key={key}>{(token as Tokens.Image).text}</Fragment>;
      case 'escape':
      case 'text':
      case 'html':
      default:
        return <Fragment key={key}>{'text' in token ? String(token.text) : token.raw}</Fragment>;
    }
  });
}

/** The inline tokens of `text`, for tests and for callers that need the structure. */
export function inlineTokens(text: string): Token[] {
  return marked.Lexer.lexInline(text);
}

export function InlineMarkdown({ children }: { children: string | null | undefined }) {
  if (children === null || children === undefined || children === '') return null;
  return <span className="fm-inline-md">{render(inlineTokens(children), 'i')}</span>;
}
