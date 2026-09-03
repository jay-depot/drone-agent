import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router-dom';
import { preprocessWikiLinks } from '@/lib/wiki-links';
import { splitFrontmatter } from '@/lib/wiki-frontmatter';
import type { ReactNode } from 'react';

function getHostname(href: string): string | null {
  try {
    return new URL(href).hostname;
  } catch {
    return null;
  }
}

function MarkdownLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  if (!href) {
    return (
      <a className="text-primary underline underline-offset-4">{children}</a>
    );
  }

  // Internal wiki links use client-side navigation.
  if (href.startsWith('/wiki/')) {
    return (
      <Link
        to={href}
        className="text-primary underline underline-offset-4 hover:text-primary/80"
      >
        {children}
      </Link>
    );
  }

  // External links open in a new tab with the hostname shown after the text.
  if (href.startsWith('http:') || href.startsWith('https:')) {
    const hostname = getHostname(href);
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-4 hover:text-primary/80"
      >
        {children}
        {hostname ? (
          <span className="text-muted-foreground"> ({hostname})</span>
        ) : null}
      </a>
    );
  }

  return (
    <a
      href={href}
      className="text-primary underline underline-offset-4 hover:text-primary/80"
    >
      {children}
    </a>
  );
}

export default function WikiMarkdown({ children }: { children: string }) {
  const { frontmatter, body } = splitFrontmatter(children);

  return (
    <div className="text-sm leading-relaxed">
      {frontmatter && (
        <details className="mb-4 rounded-md border border-border bg-muted/40">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground">
            Metadata (YAML frontmatter)
          </summary>
          <pre className="px-3 pb-3 text-xs font-mono whitespace-pre-wrap overflow-x-auto">
            {frontmatter}
          </pre>
        </details>
      )}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: MarkdownLink,
          h1: ({ children }) => (
            <h1 className="text-2xl font-bold mt-6 mb-3 first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-xl font-bold mt-5 mb-2">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-lg font-semibold mt-4 mb-2">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-base font-semibold mt-3 mb-1">{children}</h4>
          ),
          p: ({ children }) => <p className="my-3">{children}</p>,
          ul: ({ children }) => (
            <ul className="list-disc pl-6 my-3 space-y-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-6 my-3 space-y-1">{children}</ol>
          ),
          li: ({ children }) => <li>{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-muted pl-4 my-3 text-muted-foreground italic">
              {children}
            </blockquote>
          ),
          code: ({ className, children }) => {
            const isBlock = className?.includes('language-');
            if (isBlock) {
              return (
                <code className="block bg-muted p-4 rounded-md overflow-x-auto font-mono text-xs">
                  {children}
                </code>
              );
            }
            return (
              <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-xs">
                {children}
              </code>
            );
          },
          pre: ({ children }) => <pre className="my-3">{children}</pre>,
          table: ({ children }) => (
            <div className="overflow-x-auto my-3">
              <table className="w-full text-sm border-collapse">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="border-b border-border">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="text-left font-semibold px-3 py-2">{children}</th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2 border-b border-border/50">{children}</td>
          ),
          hr: () => <hr className="my-4 border-border" />,
          strong: ({ children }) => (
            <strong className="font-semibold">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
        }}
      >
        {preprocessWikiLinks(body)}
      </ReactMarkdown>
    </div>
  );
}
