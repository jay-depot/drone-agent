import { useEffect, useRef, useState } from 'react';
import type { WikiPageMeta } from '@/lib/types';
import {
  countActiveFilters,
  filtersAreDefault,
  type WikiFilters,
} from '@/lib/wiki-filters';
import {
  computeCommaTokenSuggestions,
  distinctSources,
  distinctTags,
} from '@/lib/wiki-filter-suggestions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import WikiSuggestInput from '@/components/wiki-suggest-input';

/** Join the active tokens for the input's display value. */
function listValue(tokens: string[]): string {
  return tokens.join(', ');
}

/** Parse an input string back into a de-duplicated token list. */
function parseTokens(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(',')) {
    const token = part.trim();
    if (token && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

const signature = (tokens: string[]) => tokens.join('\u0000');

/**
 * Keep a raw text draft in sync with a token list WITHOUT clobbering the
 * user's in-progress text. Reformatting the input from parsed tokens on every
 * keystroke would eat the comma as it is typed, making a second tag impossible
 * to enter; instead the draft holds the raw text and is only re-seeded when the
 * tokens change for a reason other than our own typing (e.g. Clear, Back).
 */
function useTokenDraft(
  tokens: string[],
  onTokens: (next: string[]) => void
): { draft: string; onChange: (raw: string) => void } {
  const [draft, setDraft] = useState(() => listValue(tokens));
  const emittedRef = useRef(signature(tokens));
  const currentSig = signature(tokens);

  useEffect(() => {
    if (emittedRef.current !== currentSig) {
      setDraft(listValue(tokens));
      emittedRef.current = currentSig;
    }
  }, [currentSig, tokens]);

  const onChange = (raw: string) => {
    const parsed = parseTokens(raw);
    emittedRef.current = signature(parsed);
    setDraft(raw);
    onTokens(parsed);
  };

  return { draft, onChange };
}

export default function WikiFilterBar({
  filters,
  onChange,
  onClear,
  pages,
}: {
  filters: WikiFilters;
  onChange: (next: WikiFilters) => void;
  onClear: () => void;
  pages: WikiPageMeta[];
}) {
  const activeCount = countActiveFilters(filters);
  const patch = (overrides: Partial<WikiFilters>) =>
    onChange({ ...filters, ...overrides });

  const tags = useTokenDraft(filters.tags, next => patch({ tags: next }));
  const sources = useTokenDraft(filters.sources, next =>
    patch({ sources: next })
  );

  const tagSuggestions = computeCommaTokenSuggestions(
    tags.draft,
    distinctTags(pages)
  ).suggestions;
  const sourceSuggestions = computeCommaTokenSuggestions(
    sources.draft,
    distinctSources(pages)
  ).suggestions;

  const toggleButton = (
    label: string,
    active: boolean,
    onClick: () => void
  ) => (
    <Button
      type="button"
      size="sm"
      variant={active ? 'default' : 'outline'}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </Button>
  );

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <WikiSuggestInput
        id="wiki-filter-tags"
        ariaLabel="Filter by tags"
        className="w-56"
        placeholder="Tags (comma-separated)"
        value={tags.draft}
        suggestions={tagSuggestions}
        onChange={tags.onChange}
      />
      <WikiSuggestInput
        id="wiki-filter-sources"
        ariaLabel="Filter by source session"
        className="w-56"
        placeholder="Source sessions"
        value={sources.draft}
        suggestions={sourceSuggestions}
        onChange={sources.onChange}
      />

      <div className="flex items-center gap-1">
        <span className="text-xs text-muted-foreground">Date</span>
        {toggleButton('Created', filters.dateField === 'created', () =>
          patch({ dateField: 'created' })
        )}
        {toggleButton('Updated', filters.dateField === 'updated', () =>
          patch({ dateField: 'updated' })
        )}
      </div>

      <Input
        aria-label="Filter created or updated from"
        type="date"
        className="w-40"
        value={filters.dateFrom ?? ''}
        onChange={e => patch({ dateFrom: e.target.value || null })}
      />
      <Input
        aria-label="Filter created or updated to"
        type="date"
        className="w-40"
        value={filters.dateTo ?? ''}
        onChange={e => patch({ dateTo: e.target.value || null })}
      />

      {toggleButton('Has links', filters.hasLinks, () =>
        patch({ hasLinks: !filters.hasLinks })
      )}
      {toggleButton('Has sources', filters.hasSources, () =>
        patch({ hasSources: !filters.hasSources })
      )}
      {toggleButton('Recently created', filters.recentlyCreated, () =>
        patch({ recentlyCreated: !filters.recentlyCreated })
      )}

      {!filtersAreDefault(filters) && (
        <>
          <Badge variant="secondary" className="text-xs">
            {activeCount} filter{activeCount === 1 ? '' : 's'}
          </Badge>
          <Button type="button" variant="ghost" size="sm" onClick={onClear}>
            Clear
          </Button>
        </>
      )}
    </div>
  );
}
