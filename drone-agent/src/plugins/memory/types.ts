/**
 * A single memory entry stored in the project-level memory.
 *
 * Each entry is persisted as a JSON file under `.drone-agent/memory/<key>.json`.
 * The `key` must be a filesystem-safe string (no path separators, no leading dots).
 */
export type MemoryEntry = {
  /** Unique identifier (auto-generated UUID). */
  id: string;
  /** Human-readable key used as the filename stem. Must be filesystem-safe. */
  key: string;
  /** Arbitrary JSON-serializable value. */
  value: unknown;
  /** Optional free-form tags for categorization and search. */
  tags: string[];
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-updated timestamp. */
  updatedAt: string;
  /** Optional TTL in seconds. When set, the entry may be pruned after expiry. */
  ttlSeconds?: number;
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
  store: (
    key: string,
    value: unknown,
    tags?: string[],
    ttlSeconds?: number
  ) => Promise<MemoryEntry>;

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
   * Search entries by substring match against the key and tags.
   * Returns up to `limit` entries (default 50).
   */
  search: (query: string, limit?: number) => Promise<MemoryEntry[]>;

  /**
   * Delete a single entry by key. Returns `true` if an entry was removed,
   * `false` if no entry existed.
   */
  delete: (key: string) => Promise<boolean>;

  /**
   * Prune expired and excess entries. Returns the number of entries removed.
   * Removes:
   *   - Entries whose `ttlSeconds` has elapsed since `updatedAt`
   *   - Oldest entries when `maxEntries > 0` and the count exceeds it
   */
  prune: () => Promise<number>;

  /**
   * Return the total number of stored entries.
   */
  count: () => Promise<number>;
};