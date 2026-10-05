// ── Skill storage key ──────────────────────────────────────────────
//
// Skills are stored with a synthetic primary key so that a global skill
// (`personaId === null`) and persona-owned skills can coexist without id
// collisions. Global rows keep `key === id`, so existing single-id
// addressing is unchanged.

/**
 * Compute the storage key for a skill row.
 *
 * Global skills (no owner) key on the bare public id; persona-owned
 * skills key on `<personaId>/<skillId>`.
 */
export function skillStorageKey(
  personaId: string | null | undefined,
  id: string
): string {
  return personaId ? `${personaId}/${id}` : id;
}
