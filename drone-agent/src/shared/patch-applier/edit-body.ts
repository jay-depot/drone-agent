/**
 * Shared "apply a unified diff to a body of text" helper.
 *
 * Both the swarm wiki editor and the memory editor (and the notepad) need the
 * same three steps: parse a unified diff, apply it to a body, and render the
 * result for a tool response — including the two failure shapes (no hunks
 * found in the diff; no hunks applied to the body / partial application).
 *
 * The body-owning tool keeps control of *when* the result is committed (some
 * write under a lock, some PUT over HTTP, some mutate in-memory state), so
 * this helper only computes the outcome and never writes anything itself.
 */

import type { DiffSummary } from '../diff-renderer.js';
import { renderDiffV2 } from '../diff-renderer.js';
import { parseUnifiedDiff } from '../unified-diff-parser.js';
import { applyPatch } from '../patch-applier.js';
import { formatPatchError } from './errors.js';

/** Options controlling the wording and rendered-diff label for an edit. */
export interface EditBodyOptions {
  /** Label used as the "file path" in the rendered diff (e.g. `memory:key`). */
  label: string;
  /** Tool name used as the failure-message prefix (e.g. `memory.manage edit`). */
  toolName: string;
  /** Noun for the edited thing in failure messages (e.g. `entry body`). */
  targetNoun: string;
  /** Recovery advice appended to every failure message. */
  recoveryTip: string;
}

/** Outcome of applying a diff to a body. */
export type EditBodyOutcome =
  | {
      status: 'applied';
      /** The patched body text. */
      value: string;
      /** Rendered plain diff (for the tool result). */
      diff: string;
      /** Diff summary (hunks/additions/deletions/maxFuzz). */
      summary: DiffSummary;
      /** Present when some hunks failed but at least one applied. */
      partialFailureMessage?: string;
    }
  | {
      status: 'none-applied';
      /** Ready-to-return error message. */
      error: string;
    };

/**
 * Parse `diff`, apply it to `body`, and render the result.
 *
 * Returns `{ status: 'none-applied' }` when the diff contains no change lines
 * or when zero hunks matched the body — in both cases the caller must NOT
 * write. On partial success the patched value is returned alongside a
 * `partialFailureMessage`; the caller writes the partial result and surfaces
 * the failure, matching `file__apply_diff` semantics.
 */
export function applyEditToBody(
  body: string,
  diff: string,
  options: EditBodyOptions
): EditBodyOutcome {
  const { label, toolName, targetNoun, recoveryTip } = options;

  const hunks = parseUnifiedDiff(diff);
  if (hunks.length === 0) {
    return {
      status: 'none-applied',
      error:
        `${toolName}: no hunks found in the diff. The patch must contain ` +
        '`-`/`+` change lines (a headerless patch parses as one hunk).',
    };
  }

  const result = applyPatch(body.split('\n'), hunks);
  if (result.appliedHunks.length === 0) {
    return {
      status: 'none-applied',
      error:
        `${toolName}: no hunks applied to the ${targetNoun}. ` +
        `${result.errors.map(formatPatchError).join('\n\n')}\n\n` +
        recoveryTip,
    };
  }

  const fuzzByIndex = new Map(
    result.appliedHunks.map(a => [a.hunkIndex, a.fuzz])
  );
  const diffHunks = hunks
    .map((hunk, i) => ({ hunk, i }))
    .filter(({ i }) => fuzzByIndex.has(i))
    .map(({ hunk, i }) => ({
      anchors: hunk.anchors,
      contextBefore: hunk.contextBefore,
      changeZone: hunk.changeZone,
      oldLines: hunk.oldLines,
      newLines: hunk.newLines,
      contextAfter: hunk.contextAfter,
      fuzz: fuzzByIndex.get(i),
    }));
  const rendered = renderDiffV2(label, diffHunks, false);

  return {
    status: 'applied',
    value: result.patchedLines.join('\n'),
    diff: rendered.plain,
    summary: rendered.summary,
    partialFailureMessage: result.success
      ? undefined
      : `${toolName}: ${result.errors.length} of ${hunks.length} hunk(s) failed to apply. ` +
        `The edit was written with ${result.appliedHunks.length} successful hunk(s) applied.\n\n` +
        `${result.errors.map(formatPatchError).join('\n\n')}\n\n` +
        recoveryTip,
  };
}
