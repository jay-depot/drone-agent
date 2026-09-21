// ── Reference capability ────────────────────────────────────────────
//
// Registry of `@`-reference kind resolvers plus the message expander. The
// `file` kind ships here; other kinds (e.g. `skill`) are registered by
// plugins through the `reference` capability.

import os from 'node:os';
import type {
  DroneImageContent,
  DroneReferenceCapability,
  DroneReferenceContext,
  DroneReferenceExpansion,
  DroneReferenceKindResolver,
} from 'drone-core';
import { RESERVED_REFERENCE_KINDS } from 'drone-core';
import { tokenizeText } from './parse.js';
import {
  resolveFileReference,
  type ExpansionBudget,
  type ReferenceLimits,
} from './file-kinds.js';

const KIND_NAME_RE = /^[a-z][a-z0-9-]*$/;
const FILE_KIND = 'file';
const TOTAL_BUDGET_BYTES = 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function createReferenceCapability(opts?: {
  cwd?: string;
  homedir?: string;
  maxImageBytes?: number;
}): DroneReferenceCapability {
  const baseCtx: DroneReferenceContext = {
    cwd: opts?.cwd ?? process.cwd(),
    homedir: opts?.homedir ?? os.homedir(),
  };
  const limits: ReferenceLimits = {
    maxImageBytes: opts?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
  };

  const kinds = new Map<string, DroneReferenceKindResolver>();
  let activeBudget: ExpansionBudget = { used: 0, limit: TOTAL_BUDGET_BYTES };
  kinds.set(FILE_KIND, (value, ctx) =>
    resolveFileReference(value, ctx, activeBudget, limits)
  );

  // Expansion mutates `activeBudget`, so concurrent calls are serialized.
  let chain: Promise<unknown> = Promise.resolve();

  async function expandOnce(text: string): Promise<DroneReferenceExpansion> {
    if (!text.includes('@')) {
      return { text, images: [], notices: [] };
    }

    const tokens = tokenizeText(text);
    let body = '';
    for (const token of tokens) {
      body += token.type === 'text' ? token.text : token.raw;
    }

    const blocks: string[] = [];
    const images: DroneImageContent[] = [];
    const notices: string[] = [];
    const seenRaw = new Set<string>();
    const seenKeys = new Set<string>();
    activeBudget = { used: 0, limit: TOTAL_BUDGET_BYTES };

    for (const ref of tokens) {
      if (ref.type !== 'reference') {
        continue;
      }

      let resolver: DroneReferenceKindResolver | undefined;
      let lookupValue: string;
      let fileLike: boolean;

      if (ref.kind && kinds.has(ref.kind)) {
        resolver = kinds.get(ref.kind);
        lookupValue = ref.value;
        fileLike = ref.kind === FILE_KIND;
      } else if (
        ref.kind &&
        (RESERVED_REFERENCE_KINDS as readonly string[]).includes(ref.kind)
      ) {
        notices.push(
          `[${ref.kind} references unavailable: ${ref.kind} plugin not enabled]`
        );
        continue;
      } else {
        resolver = kinds.get(FILE_KIND);
        lookupValue = ref.kind ? ref.body : ref.value;
        fileLike = true;
      }

      if (!resolver) {
        continue;
      }

      if (fileLike) {
        if (seenRaw.has(lookupValue)) {
          continue;
        }
        seenRaw.add(lookupValue);
      }

      let resolution;
      try {
        resolution = await resolver(lookupValue, { ...baseCtx });
      } catch {
        continue;
      }

      const key = resolution.dedupKey ?? lookupValue;
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);

      if (resolution.block) {
        blocks.push(`### ${ref.raw}\n${resolution.block}`);
      }
      if (resolution.images.length > 0) {
        images.push(...resolution.images);
      }
      if (
        resolution.notice &&
        (!fileLike || lookupValue.includes('/') || lookupValue.includes('.'))
      ) {
        notices.push(resolution.notice);
      }
    }

    const finalText =
      blocks.length > 0
        ? `${body}\n\n--- Referenced content ---\n${blocks.join('\n\n')}`
        : body;

    return { text: finalText, images, notices };
  }

  return {
    registerKind(name, resolver) {
      if (!KIND_NAME_RE.test(name)) {
        throw new Error(`Invalid reference kind name: ${name}`);
      }
      kinds.set(name, resolver);
    },
    unregisterKind(name) {
      kinds.delete(name);
    },
    getKinds() {
      return [...kinds.keys()];
    },
    expandUserMessage(text) {
      const run = chain.then(() => expandOnce(text));
      chain = run.catch(() => {});
      return run;
    },
  };
}
