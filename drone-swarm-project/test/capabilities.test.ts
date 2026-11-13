import { describe, expect, it } from 'vitest';
import { CAPABILITIES, CARD_TOOL_CAPABILITIES } from '../src/capabilities.js';

const MCP_TIER = [
  'project.list',
  'board.get',
  'card.get',
  'card.create',
  'card.update',
  'card.move',
];

describe('capability catalog', () => {
  it('has unique names', () => {
    const names = CAPABILITIES.map(c => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('exposes exactly the six card tools as mcp tier', () => {
    const mcp = CAPABILITIES.filter(c => c.exposed !== 'ui').map(c => c.name);
    expect(mcp.sort()).toEqual([...MCP_TIER].sort());
    expect([...CARD_TOOL_CAPABILITIES].sort()).toEqual([...MCP_TIER].sort());
  });

  it('marks every non-card capability as ui tier', () => {
    for (const cap of CAPABILITIES) {
      if (!MCP_TIER.includes(cap.name)) {
        expect(cap.exposed).toBe('ui');
      }
    }
  });

  it('gives each capability a param schema', () => {
    for (const cap of CAPABILITIES) {
      expect(cap.description.length).toBeGreaterThan(0);
      expect(cap.paramSchema).toMatchObject({ type: 'object' });
    }
  });

  it('makes card.* params optional so the card-bound shortcut works', () => {
    for (const name of ['card.get', 'card.update', 'card.move']) {
      const cap = CAPABILITIES.find(c => c.name === name)!;
      expect(cap.paramSchema.required ?? []).not.toContain('cardId');
      expect(cap.paramSchema.required ?? []).not.toContain('projectId');
    }
  });
});
