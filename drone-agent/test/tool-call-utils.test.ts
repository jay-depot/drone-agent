import { describe, expect, it } from 'vitest';
import {
  toolCallSignature,
  deduplicateToolCalls,
} from '../src/runtime/tool-call-utils.js';

describe('toolCallSignature', () => {
  it('combines name and JSON-stringified arguments', () => {
    expect(toolCallSignature({ name: 'a', arguments: { path: '/x' } })).toBe(
      'a:{"path":"/x"}'
    );
  });

  it('is stable across calls with the same name + arguments', () => {
    const sig1 = toolCallSignature({ name: 'a', arguments: { path: '/x' } });
    const sig2 = toolCallSignature({ name: 'a', arguments: { path: '/x' } });
    expect(sig1).toBe(sig2);
  });

  it('distinguishes different arguments for the same name', () => {
    expect(
      toolCallSignature({ name: 'a', arguments: { path: '/x' } })
    ).not.toBe(toolCallSignature({ name: 'a', arguments: { path: '/y' } }));
  });

  it('distinguishes different names with the same arguments', () => {
    expect(
      toolCallSignature({ name: 'a', arguments: { path: '/x' } })
    ).not.toBe(toolCallSignature({ name: 'b', arguments: { path: '/x' } }));
  });

  it('is sensitive to argument key order (matches the streak guardrail)', () => {
    // The streak guardrail historically compared JSON.stringify, so argument
    // key order matters. This pins that behavior.
    expect(
      toolCallSignature({ name: 'a', arguments: { a: 1, b: 2 } })
    ).not.toBe(toolCallSignature({ name: 'a', arguments: { b: 2, a: 1 } }));
  });
});

describe('deduplicateToolCalls', () => {
  it('preserves order and keeps the first occurrence of each distinct call', () => {
    const calls = [
      { id: '1', name: 'a', arguments: { x: 1 } },
      { id: '2', name: 'b', arguments: { y: 2 } },
      { id: '3', name: 'a', arguments: { x: 1 } },
      { id: '4', name: 'a', arguments: { x: 1 } },
    ];
    const { deduped, collapsedGroups } = deduplicateToolCalls(calls);
    expect(deduped.map(c => c.id)).toEqual(['1', '2']);
    expect(deduped[0].arguments).toEqual({ x: 1 });
    expect(deduped[1].arguments).toEqual({ y: 2 });
    expect(collapsedGroups).toEqual([{ name: 'a', removed: 2 }]);
  });

  it('reports per-group collapse counts across multiple distinct groups', () => {
    const calls = [
      { id: '1', name: 'a', arguments: { x: 1 } },
      { id: '2', name: 'b', arguments: { y: 2 } },
      { id: '3', name: 'a', arguments: { x: 1 } },
      { id: '4', name: 'b', arguments: { y: 2 } },
      { id: '5', name: 'b', arguments: { y: 2 } },
      { id: '6', name: 'c', arguments: { z: 3 } },
    ];
    const { deduped, collapsedGroups } = deduplicateToolCalls(calls);
    expect(deduped.map(c => c.id)).toEqual(['1', '2', '6']);
    expect(collapsedGroups).toEqual([
      { name: 'a', removed: 1 },
      { name: 'b', removed: 2 },
    ]);
  });

  it('is a no-op when all calls are unique', () => {
    const calls = [
      { id: '1', name: 'a', arguments: { x: 1 } },
      { id: '2', name: 'b', arguments: { y: 2 } },
      { id: '3', name: 'a', arguments: { x: 3 } },
    ];
    const { deduped, collapsedGroups } = deduplicateToolCalls(calls);
    expect(deduped.map(c => c.id)).toEqual(['1', '2', '3']);
    expect(collapsedGroups).toEqual([]);
  });

  it('ignores the id field when determining identity', () => {
    const calls = [
      { id: 'aaa', name: 'a', arguments: { x: 1 } },
      { id: 'bbb', name: 'a', arguments: { x: 1 } },
    ];
    const { deduped, collapsedGroups } = deduplicateToolCalls(calls);
    // First occurrence (and its id) is kept.
    expect(deduped).toEqual([{ id: 'aaa', name: 'a', arguments: { x: 1 } }]);
    expect(collapsedGroups).toEqual([{ name: 'a', removed: 1 }]);
  });

  it('does not mutate the input array', () => {
    const calls = [
      { id: '1', name: 'a', arguments: { x: 1 } },
      { id: '2', name: 'a', arguments: { x: 1 } },
    ];
    deduplicateToolCalls(calls);
    expect(calls).toHaveLength(2);
  });
});
