import {
  extractSecretRefs,
  type CoordinatorConfigEntry,
  type ResolvedConfigEntry,
} from 'drone-core';

/**
 * Substitute every `${secret:NAME}` reference in `value` with the matching
 * entry from `secrets`. Pure string work — no DB access. Returns the missing
 * names when any reference is unresolved so callers decide drop/warn policy.
 */
export function resolveSecretRefs(
  value: string,
  secrets: ReadonlyMap<string, string>
): { ok: true; value: string } | { ok: false; missing: string[] } {
  const refs = extractSecretRefs(value);
  if (refs.length === 0) {
    return { ok: true, value };
  }
  const missing = refs.filter(name => !secrets.has(name));
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  const resolved = value.replace(
    new RegExp(SECRET_REF_SOURCE, 'g'),
    (_, name: string) => secrets.get(name)!
  );
  return { ok: true, value: resolved };
}

const SECRET_REF_SOURCE = '\\$\\{secret:([A-Za-z0-9_]+)\\}';

export interface DroppedDistributionEntry {
  key: string;
  missing: string[];
}

/**
 * Build the beacon-facing distribution payload from stored coordinator
 * config rows plus the secret store accessor. Rows referencing
 * `${secret:NAME}` are resolved; a row whose references cannot all be
 * resolved is dropped whole (config entries are whole-entry units) and
 * reported in `dropped` so the caller can warn. Resolution happens ONLY
 * here, on the beacon-facing payload — never on UI-facing listings.
 */
export function buildDistributionEntries(
  rows: CoordinatorConfigEntry[],
  getSecretValue: (name: string) => string | undefined
): { entries: ResolvedConfigEntry[]; dropped: DroppedDistributionEntry[] } {
  const secretCache = new Map<string, string>();
  const entries: ResolvedConfigEntry[] = [];
  const dropped: DroppedDistributionEntry[] = [];

  for (const row of rows) {
    const refs = extractSecretRefs(row.value);
    if (refs.length > 0) {
      const secrets = new Map<string, string>();
      const missing: string[] = [];
      for (const name of refs) {
        let value = secretCache.get(name);
        if (value === undefined) {
          const raw = getSecretValue(name);
          if (raw === undefined) {
            missing.push(name);
            continue;
          }
          value = raw;
          secretCache.set(name, raw);
        }
        secrets.set(name, value);
      }
      if (missing.length > 0) {
        dropped.push({ key: row.key, missing });
        continue;
      }
      const resolved = resolveSecretRefs(row.value, secrets);
      if (!resolved.ok) {
        dropped.push({ key: row.key, missing });
        continue;
      }
      entries.push({
        ...row,
        value: resolved.value,
        containsSecrets: true,
      });
      continue;
    }

    entries.push({
      ...row,
      containsSecrets: row.secret === true,
    });
  }

  return { entries, dropped };
}
