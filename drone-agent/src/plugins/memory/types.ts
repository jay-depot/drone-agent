/**
 * A single memory entry stored in the project-level memory.
 *
 * Each entry is persisted as a `.md` file under `.drone-agent/memory/<key>.md`
 * with YAML frontmatter containing metadata and the body as the value text.
 * The `key` must be a filesystem-safe string (no path separators, no leading dots).
 */
export type MemoryEntry = {
  /** Human-readable key used as the filename stem. Must be filesystem-safe. */
  key: string;
  /** The body text of the memory entry (markdown). */
  value: string;
  /** Optional free-form tags for categorization and search. */
  tags: string[];
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-updated timestamp. */
  updatedAt: string;
};

/**
 * Capability offered by the memory plugin so other plugins (compaction,
 * coordinator, etc.) can store and retrieve project-level facts.
 */
export type DroneMemoryCapability = {
  /**
   * Store a value under a given key. Overwrites any existing entry with
   * the same key. Returns the stored entry.
   */
  store: (key: string, value: string, tags?: string[]) => Promise<MemoryEntry>;

  /**
   * Retrieve a single entry by its exact key. Returns `null` when no
   * entry exists for the given key.
   */
  recall: (key: string) => Promise<MemoryEntry | null>;

  /**
   * List all stored keys (with their last-updated timestamp), optionally
   * filtered by a key prefix.
   */
  list: (prefix?: string) => Promise<{ key: string; updatedAt: string }[]>;

  /**
   * Search entries by substring match against the key, tags, and body text.
   * Returns up to `limit` entries (default 50).
   */
  search: (query: string, limit?: number) => Promise<MemoryEntry[]>;

  /**
   * Delete a single entry by key. Returns `true` if an entry was removed,
   * `false` if no entry existed.
   */
  delete: (key: string) => Promise<boolean>;

  /**
   * Edit an existing entry in place. Reads the entry, applies `patch` to
   * produce a new value and optional tags, then writes it back — the whole
   * read-modify-write runs atomically under a per-key lock so concurrent
   * mutations cannot interleave. `createdAt` is preserved; `updatedAt` is
   * bumped. Returns the updated entry, or `null` if no entry exists for
   * the given key.
   */
  edit: (
    key: string,
    patch: (entry: MemoryEntry) => { value: string; tags?: string[] }
  ) => Promise<MemoryEntry | null>;
};
