// ── Wiki page types ────────────────────────────────────────────────────

/**
 * Metadata for a wiki page in the swarm knowledge base.
 */
export type DroneWikiPageMeta = {
  /** Unique page identifier (filesystem-safe slug). */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Scope: 'beacon' or 'coordinator'. */
  scope: 'beacon' | 'coordinator';
  /** Free-form tags for categorization. */
  tags: string[];
  /** List of session log IDs that contributed to this page. */
  sources: string[];
  /** ISO-8601 timestamp of creation. */
  createdAt: string;
  /** ISO-8601 timestamp of last update. */
  updatedAt: string;
};

/**
 * A full wiki page including its markdown content.
 */
export type DroneWikiPage = DroneWikiPageMeta & {
  /** Markdown body of the page. */
  content: string;
};

/**
 * Result of a wiki search.
 */
export type DroneWikiSearchResult = {
  /** Page metadata. */
  page: DroneWikiPageMeta;
  /** Snippet of matching content (may be truncated). */
  snippet: string;
  /** Relevance score (0-1). */
  score: number;
};

/**
 * A distinct wiki tag with the number of pages carrying it.
 */
export type DroneWikiTagCount = {
  /** The tag string. */
  tag: string;
  /** Number of pages carrying this tag. */
  count: number;
};
