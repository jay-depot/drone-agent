// ── Reference-expansion types ───────────────────────────────────────
//
// A user message can carry `@`-references (`@src/foo.ts`, `@skill:code-review`)
// that are expanded into the prompt before it becomes a session turn. Expansion
// is registry-based: the core grammar is resolved by kind resolvers registered
// on the `reference` capability.

import type { DroneImageContent } from './session-types.js';

export const DRONE_REFERENCE_CAPABILITY_ID = 'reference';

/**
 * Kind names reserved by the core grammar. A token carrying a reserved kind is
 * always a namespace reference (never a file path), even when no resolver is
 * registered — so `@skill:x` yields an "unavailable" notice when the skills
 * plugin is disabled rather than being misread as a file.
 */
export const RESERVED_REFERENCE_KINDS = ['skill'] as const;

export type DroneReferenceContext = { cwd: string; homedir: string };

export type DroneReferenceResolution = {
  /** Block body (files: fenced content; skills: raw body). The expander prepends `### @<token>`. */
  block: string;
  /** Images to attach to the user turn (v1: always empty; reserved for image refs). */
  images: DroneImageContent[];
  /** Optional user-facing notice (e.g. "unknown skill", "skipped binary"). */
  notice?: string;
  /** Dedup key (resolved absolute path / skill id). Defaults to the raw value. */
  dedupKey?: string;
};

export type DroneReferenceKindResolver = (
  value: string,
  ctx: DroneReferenceContext
) => Promise<DroneReferenceResolution>;

export type DroneReferenceExpansion = {
  text: string;
  images: DroneImageContent[];
  notices: string[];
};

export type DroneReferenceCapability = {
  registerKind(name: string, resolver: DroneReferenceKindResolver): void;
  unregisterKind(name: string): void;
  getKinds(): string[];
  expandUserMessage(text: string): Promise<DroneReferenceExpansion>;
};
