import type { DroneToolCall } from 'drone-core';

/**
 * Canonical identity of a tool call: name + JSON-serialized arguments. This is
 * the single definition of "same tool call" shared by the identical-call
 * streak guardrail and the parallel duplicate-call dedup guardrail. If the
 * identity logic ever needs tightening (e.g. canonical key ordering to avoid
 * false negatives), change it here once.
 */
export function toolCallSignature(call: {
  name: string;
  arguments: Record<string, unknown>;
}): string {
  return `${call.name}:${JSON.stringify(call.arguments)}`;
}

export type CollapsedToolCallGroup = {
  name: string;
  /** Number of duplicate calls removed from the batch for this group. */
  removed: number;
};

export type DeduplicateToolCallsResult = {
  /** The deduplicated list, preserving order of first occurrences. */
  deduped: DroneToolCall[];
  /** Per-group collapse counts, only for groups that actually had duplicates. */
  collapsedGroups: CollapsedToolCallGroup[];
};

/**
 * Collapse parallel identical tool calls within a single batch: keeps the
 * first occurrence of each distinct (name, arguments) pair, preserving order,
 * and reports how many duplicate calls were removed per group. Pure — does not
 * mutate the input. The `id` field is not part of identity; the kept call
 * retains its own id.
 */
export function deduplicateToolCalls(
  toolCalls: DroneToolCall[]
): DeduplicateToolCallsResult {
  const deduped: DroneToolCall[] = [];
  const collapsedGroups: CollapsedToolCallGroup[] = [];
  const seen = new Set<string>();

  for (const call of toolCalls) {
    const signature = toolCallSignature(call);
    if (seen.has(signature)) {
      const group = collapsedGroups.find(g => g.name === call.name);
      if (group) {
        group.removed += 1;
      } else {
        collapsedGroups.push({ name: call.name, removed: 1 });
      }
    } else {
      seen.add(signature);
      deduped.push(call);
    }
  }

  return { deduped, collapsedGroups };
}
