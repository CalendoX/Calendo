import type { ReactNode } from 'react';

/** Bold, code spans and links — the inline markdown that appears in the README's prose. */
const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Renders one line of markdown as text. Deliberately not a full markdown renderer: the landing
 * page takes only prose from README.md, so block syntax never reaches it and no HTML is ever
 * injected — every part is rendered as a React node, which React escapes.
 */
export function MarkdownText({ children }: { children: string }) {
  const nodes: ReactNode[] = [];
  let index = 0;
  for (const match of children.matchAll(INLINE)) {
    if (match.index > index) nodes.push(children.slice(index, match.index));
    const [whole, bold, code, linkText, href] = match;
    if (bold) nodes.push(<strong key={match.index} className="font-semibold text-zinc-900">{bold}</strong>);
    else if (code) nodes.push(<code key={match.index} className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] text-zinc-700">{code}</code>);
    else if (/^https?:\/\//i.test(href))
      nodes.push(
        <a key={match.index} href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-700 hover:underline">
          {linkText}
        </a>,
      );
    // A relative link (to a file in the repo) has nowhere to point on the site: keep the words.
    else nodes.push(linkText);
    index = match.index + whole.length;
  }
  nodes.push(children.slice(index));
  return <>{nodes}</>;
}
