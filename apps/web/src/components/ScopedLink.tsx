import { Link, type LinkProps } from '@d3cloud/ui';
import { useScope } from '../lib/scope';

/**
 * A link that keeps the scope in its href (FRM-T-17.4): to a scoped page it carries `?group=`, to
 * any other page it drops it. In the href itself rather than added on click, so a middle-click, a
 * new tab or a copied link opens in the same scope as a plain click does.
 */
export function ScopedLink({ href, ...rest }: Extract<LinkProps, { href: string }>) {
  const { link } = useScope();
  return <Link {...rest} href={link(href)} />;
}
