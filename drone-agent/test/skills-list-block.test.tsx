/**
 * Tests for SkillsListBlock's remark rendering: the ↳ remark line appears
 * only when the list payload includes it (i.e. user-initiated listings).
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { SkillsListBlock } from '../src/tui/components/SkillsListBlock.js';
import { DEFAULT_GRAYSCALE_SCHEME } from '../src/tui/theme.js';
import type { ToolRenderState } from 'drone-core';

const REMARK = 'All credit to Matt Pocock. I just ported it.';

function makeState(overrides: Partial<ToolRenderState> = {}): ToolRenderState {
  return {
    name: 'skills__list',
    arguments: {},
    status: 'done',
    scheme: DEFAULT_GRAYSCALE_SCHEME as unknown,
    ...overrides,
  };
}

describe('SkillsListBlock remark line', () => {
  it('renders an indented remark line when present in the payload', () => {
    const state = makeState({
      status: 'done',
      result: JSON.stringify({
        count: 1,
        skills: [
          {
            id: 'grilling',
            name: 'grilling',
            description: 'Interview the user relentlessly.',
            recall: [],
            source: 'user',
            hasBody: true,
            remark: REMARK,
          },
        ],
      }),
    });
    const { lastFrame } = render(<SkillsListBlock state={state} />);
    expect(lastFrame()).toContain('✓ skills.list: 1 skill');
    expect(lastFrame()).toContain('grilling');
    expect(lastFrame()).toContain(`↳ ${REMARK}`);
  });

  it('renders no remark line when absent (LLM-initiated lists)', () => {
    const state = makeState({
      status: 'done',
      result: JSON.stringify({
        count: 1,
        skills: [
          {
            id: 'plain',
            name: 'plain',
            description: 'No remark here.',
            recall: [],
            source: 'user',
            hasBody: true,
          },
        ],
      }),
    });
    const { lastFrame } = render(<SkillsListBlock state={state} />);
    expect(lastFrame()).toContain('plain');
    expect(lastFrame()).not.toContain('↳');
  });
});
