import { preprocessWikiLinks } from '@/lib/wiki-links';
import { splitFrontmatter } from '@/lib/wiki-frontmatter';
import Markdown from './markdown';

export default function WikiMarkdown({ children }: { children: string }) {
  const { frontmatter, body } = splitFrontmatter(children);

  return (
    <div>
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
      <Markdown>{preprocessWikiLinks(body)}</Markdown>
    </div>
  );
}
