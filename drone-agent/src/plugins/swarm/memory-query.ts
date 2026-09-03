import { createHash } from 'node:crypto';
import { estimateTextTokens } from 'drone-core';
import { chunkText } from 'drone-swarm-common';

import type { WindowParts } from './memory-window.js';
import { filterForQuery } from './memory-window.js';

/**
 * Assembled retrieval query inputs plus the debounce identity of the refresh
 * they represent. The hash covers the FINAL assembled inputs, so identical
 * windows (and identical segmentation) are stable cache keys.
 */
export interface QueryInputs {
  inputs: string[];
  hash: string;
}

export interface QueryBudget {
  maxQueryTokens: number;
  maxQuerySegments: number;
}

const DEFAULT_BUDGET: QueryBudget = {
  maxQueryTokens: 6000,
  maxQuerySegments: 3,
};

/**
 * Build the query inputs for one retrieval refresh:
 * [current query (noise-filtered, first — never truncated), ...compressed window].
 * The window text is tool/code-noise filtered, then token-budgeted; oversized
 * window text is segmented via the prose chunker so no input ever exceeds the
 * embedder's effective limit (Ollama truncates from the END, which would
 * silently drop the current query if we relied on server-side truncation).
 * Pure and deterministic.
 */
export function buildQueryInputs(
  parts: WindowParts,
  budget: QueryBudget = DEFAULT_BUDGET
): QueryInputs {
  const maxTokens = Math.max(1, budget.maxQueryTokens);
  const maxSegments = Math.max(1, budget.maxQuerySegments);

  const currentQuery = filterForQuery(parts.currentQuery);
  const windowText = filterForQuery(
    [parts.prevUserQuery, ...parts.prevSteering, parts.prevResponse]
      .filter(t => t.trim().length > 0)
      .join('\n\n')
  );

  const inputs: string[] = [];
  if (currentQuery.length > 0) {
    inputs.push(currentQuery);
  }

  if (windowText.length > 0) {
    if (estimateTextTokens(windowText) <= maxTokens) {
      inputs.push(windowText);
    } else {
      // Segment and keep the most recent segments that fit the budget, oldest
      // dropped first. The current query is never part of the dropped tail.
      const segments = chunkText(windowText, maxTokens);
      let tokenSum = 0;
      const kept: string[] = [];
      for (
        let i = segments.length - 1;
        i >= 0 && kept.length < maxSegments;
        i--
      ) {
        const tokens = estimateTextTokens(segments[i]);
        if (tokenSum + tokens > maxTokens && kept.length > 0) break;
        kept.unshift(segments[i]);
        tokenSum += tokens;
      }
      inputs.push(...kept);
    }
  }

  const hash = createHash('sha256').update(inputs.join('\u0000')).digest('hex');
  return { inputs, hash };
}
