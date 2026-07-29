/**
 * Tests for the phase 2 custom tool render components.
 *
 * Each component is rendered with a mock ToolRenderState using
 * ink-testing-library, and the output is checked for expected text.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { UtilsBlock } from '../src/tui/components/UtilsBlock.js';
import { ConfigGetBlock } from '../src/tui/components/ConfigGetBlock.js';
import { ConfigSetBlock } from '../src/tui/components/ConfigSetBlock.js';
import { MemoryManageBlock } from '../src/tui/components/MemoryManageBlock.js';
import { MemoryBrowseBlock } from '../src/tui/components/MemoryBrowseBlock.js';
import { SkillsRecallBlock } from '../src/tui/components/SkillsRecallBlock.js';
import { SkillsListBlock } from '../src/tui/components/SkillsListBlock.js';
import { SkillsCreateBlock } from '../src/tui/components/SkillsCreateBlock.js';
import { PersonaListBlock } from '../src/tui/components/PersonaListBlock.js';
import { PersonaSelectBlock } from '../src/tui/components/PersonaSelectBlock.js';
import { PersonaCreateBlock } from '../src/tui/components/PersonaCreateBlock.js';
import { NotepadBlock } from '../src/tui/components/NotepadBlock.js';
import { SelfImprovementInsightBlock } from '../src/tui/components/SelfImprovementInsightBlock.js';
import { DEFAULT_GRAYSCALE_SCHEME } from '../src/tui/theme.js';
import type { ToolRenderState } from 'drone-core';

const scheme = DEFAULT_GRAYSCALE_SCHEME;

function makeState(overrides: Partial<ToolRenderState> = {}): ToolRenderState {
  return {
    name: 'test__tool',
    arguments: {},
    status: 'done',
    scheme: scheme as unknown,
    ...overrides,
  };
}

// ── UtilsBlock ───────────────────────────────────────────────────────

describe('UtilsBlock', () => {
  it('shows running state for calculator', () => {
    const state = makeState({
      name: 'calculator',
      arguments: { expression: '5 + 5' },
      status: 'running',
    });
    const { lastFrame } = render(<UtilsBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('calculator(5 + 5)');
  });

  it('shows running state for string', () => {
    const state = makeState({
      name: 'string',
      arguments: { operation: 'count_words', target: 'hello world' },
      status: 'running',
    });
    const { lastFrame } = render(<UtilsBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('string(count_words)');
  });

  it('shows calculator result', () => {
    const state = makeState({
      name: 'calculator',
      arguments: { expression: '5 + 5' },
      status: 'done',
      result: JSON.stringify({
        ok: true,
        expression: '5 + 5',
        result: 10,
      }),
    });
    const { lastFrame } = render(<UtilsBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('calculator: "5 + 5" = 10');
  });

  it('shows calculator error', () => {
    const state = makeState({
      name: 'calculator',
      arguments: { expression: '1/0' },
      status: 'done',
      result: JSON.stringify({
        ok: false,
        code: 'DIVISION_BY_ZERO',
        message: 'Evaluation failed: DIVISION_BY_ZERO',
      }),
    });
    const { lastFrame } = render(<UtilsBlock state={state} />);
    expect(lastFrame()).toContain('✗');
    expect(lastFrame()).toContain('calculator');
  });

  it('shows string count_words result', () => {
    const state = makeState({
      name: 'string',
      arguments: { operation: 'count_words', target: 'hello world' },
      status: 'done',
      result: JSON.stringify({ success: true, totalWords: 2 }),
    });
    const { lastFrame } = render(<UtilsBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('count_words → 2 words');
  });

  it('shows string spell result', () => {
    const state = makeState({
      name: 'string',
      arguments: { operation: 'spell', target: 'abc' },
      status: 'done',
      result: JSON.stringify(['a', 'b', 'c']),
    });
    const { lastFrame } = render(<UtilsBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('spell → a b c');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'calculator',
      arguments: { expression: 'bad' },
      status: 'error',
      result: 'calculator failed: invalid expression',
    });
    const { lastFrame } = render(<UtilsBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});

// ── ConfigGetBlock ───────────────────────────────────────────────────

describe('ConfigGetBlock', () => {
  it('shows running state with key', () => {
    const state = makeState({
      name: 'config__get',
      arguments: { key: 'ollama.model' },
      status: 'running',
    });
    const { lastFrame } = render(<ConfigGetBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('config.get("ollama.model")');
  });

  it('shows running state without key', () => {
    const state = makeState({
      name: 'config__get',
      arguments: {},
      status: 'running',
    });
    const { lastFrame } = render(<ConfigGetBlock state={state} />);
    expect(lastFrame()).toContain('config.get()');
  });

  it('shows done state with key and value', () => {
    const state = makeState({
      name: 'config__get',
      arguments: { key: 'ollama.model' },
      status: 'done',
      result: JSON.stringify({
        key: 'ollama.model',
        value: 'llama3',
        source: 'project',
      }),
    });
    const { lastFrame } = render(<ConfigGetBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('ollama.model = "llama3"');
    expect(lastFrame()).toContain('source: project');
  });

  it('shows done state for full config', () => {
    const state = makeState({
      name: 'config__get',
      arguments: {},
      status: 'done',
      result: JSON.stringify({
        enabledPlugins: ['memory'],
        _provenance: { source: 'project' },
      }),
    });
    const { lastFrame } = render(<ConfigGetBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('all');
    expect(lastFrame()).toContain('1 keys');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'config__get',
      arguments: { key: 'bad.key' },
      status: 'error',
      result: 'config.get failed: invalid key',
    });
    const { lastFrame } = render(<ConfigGetBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});

// ── ConfigSetBlock ───────────────────────────────────────────────────

describe('ConfigSetBlock', () => {
  it('shows running state', () => {
    const state = makeState({
      name: 'config__set',
      arguments: { key: 'ollama.model', value: 'llama3' },
      status: 'running',
    });
    const { lastFrame } = render(<ConfigSetBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('config.set("ollama.model"');
  });

  it('shows done state', () => {
    const state = makeState({
      name: 'config__set',
      arguments: { key: 'ollama.model' },
      status: 'done',
      result: JSON.stringify({
        ok: true,
        scope: 'project',
        key: 'ollama.model',
        filePath: '/tmp/.drone-agent/config.json',
      }),
    });
    const { lastFrame } = render(<ConfigSetBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('ollama.model → project scope');
    expect(lastFrame()).toContain('restart to apply');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'config__set',
      arguments: { key: 'bad.key' },
      status: 'error',
      result: 'config.set failed',
    });
    const { lastFrame } = render(<ConfigSetBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});

// ── MemoryManageBlock ────────────────────────────────────────────────

describe('MemoryManageBlock', () => {
  it('shows running state', () => {
    const state = makeState({
      name: 'memory__manage',
      arguments: { action: 'store', key: 'my-key' },
      status: 'running',
    });
    const { lastFrame } = render(<MemoryManageBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('memory.manage("store", "my-key")');
  });

  it('shows store done state', () => {
    const state = makeState({
      name: 'memory__manage',
      arguments: { action: 'store', key: 'my-key' },
      status: 'done',
      result: JSON.stringify({
        key: 'my-key',
        tags: ['tag1', 'tag2'],
        createdAt: '2024-01-01',
      }),
    });
    const { lastFrame } = render(<MemoryManageBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('memory.store: "my-key"');
    expect(lastFrame()).toContain('tags: [tag1, tag2]');
  });

  it('shows delete done state', () => {
    const state = makeState({
      name: 'memory__manage',
      arguments: { action: 'delete', key: 'my-key' },
      status: 'done',
      result: JSON.stringify({ key: 'my-key', removed: true }),
    });
    const { lastFrame } = render(<MemoryManageBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('memory.delete: "my-key"');
    expect(lastFrame()).toContain('removed: true');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'memory__manage',
      arguments: { action: 'recall', key: 'missing' },
      status: 'error',
      result: 'memory.manage failed',
    });
    const { lastFrame } = render(<MemoryManageBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});

// ── MemoryBrowseBlock ────────────────────────────────────────────────

describe('MemoryBrowseBlock', () => {
  it('shows running state for list', () => {
    const state = makeState({
      name: 'memory__browse',
      arguments: { action: 'list', prefix: 'pretty-' },
      status: 'running',
    });
    const { lastFrame } = render(<MemoryBrowseBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('memory.browse("list", "pretty-")');
  });

  it('shows list done state', () => {
    const state = makeState({
      name: 'memory__browse',
      arguments: { action: 'list', prefix: 'pretty-' },
      status: 'done',
      result: JSON.stringify({
        count: 2,
        prefix: 'pretty-',
        entries: [
          { key: 'pretty-key1', tags: ['tag1'] },
          { key: 'pretty-key2', tags: [] },
        ],
      }),
    });
    const { lastFrame } = render(<MemoryBrowseBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('memory.list');
    expect(lastFrame()).toContain('pretty-key1');
    expect(lastFrame()).toContain('pretty-key2');
    expect(lastFrame()).toContain('(2 entries)');
  });

  it('shows search done state', () => {
    const state = makeState({
      name: 'memory__browse',
      arguments: { action: 'search', query: 'test' },
      status: 'done',
      result: JSON.stringify({
        count: 1,
        query: 'test',
        results: [{ key: 'test-key', tags: [] }],
      }),
    });
    const { lastFrame } = render(<MemoryBrowseBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('memory.search "test"');
    expect(lastFrame()).toContain('test-key');
    expect(lastFrame()).toContain('(1 result)');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'memory__browse',
      arguments: { action: 'search', query: 'x' },
      status: 'error',
      result: 'memory.browse failed',
    });
    const { lastFrame } = render(<MemoryBrowseBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});

// ── SkillsRecallBlock ────────────────────────────────────────────────

describe('SkillsRecallBlock', () => {
  it('shows running state', () => {
    const state = makeState({
      name: 'skills__recall',
      arguments: { id: 'ui-architecture' },
      status: 'running',
    });
    const { lastFrame } = render(<SkillsRecallBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('skills.recall("ui-architecture")');
  });

  it('shows done state', () => {
    const state = makeState({
      name: 'skills__recall',
      arguments: { id: 'ui-architecture' },
      status: 'done',
      result: JSON.stringify({
        id: 'ui-architecture',
        name: 'UI Architecture',
        description: 'A description',
        source: 'project',
        body: '# UI Architecture\n\nSome content here.',
      }),
    });
    const { lastFrame } = render(<SkillsRecallBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('skills.recall: "ui-architecture"');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'skills__recall',
      arguments: { id: 'nonexistent' },
      status: 'error',
      result: 'skills.recall: Unknown skill',
    });
    const { lastFrame } = render(<SkillsRecallBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});

// ── SkillsListBlock ──────────────────────────────────────────────────

describe('SkillsListBlock', () => {
  it('shows running state', () => {
    const state = makeState({
      name: 'skills__list',
      arguments: {},
      status: 'running',
    });
    const { lastFrame } = render(<SkillsListBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('skills.list()');
  });

  it('shows done state with skills', () => {
    const state = makeState({
      name: 'skills__list',
      arguments: {},
      status: 'done',
      result: JSON.stringify({
        count: 2,
        skills: [
          { id: 'skill-a', description: 'First skill' },
          { id: 'skill-b', description: 'Second skill' },
        ],
      }),
    });
    const { lastFrame } = render(<SkillsListBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('skills.list: 2 skills');
    expect(lastFrame()).toContain('skill-a');
    expect(lastFrame()).toContain('First skill');
    expect(lastFrame()).toContain('skill-b');
    expect(lastFrame()).toContain('Second skill');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'skills__list',
      arguments: {},
      status: 'error',
      result: 'skills.list failed',
    });
    const { lastFrame } = render(<SkillsListBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});

// ── SkillsCreateBlock ────────────────────────────────────────────────

describe('SkillsCreateBlock', () => {
  it('shows running state', () => {
    const state = makeState({
      name: 'skills__create',
      arguments: {},
      status: 'running',
    });
    const { lastFrame } = render(<SkillsCreateBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('skills.create(...)');
  });

  it('shows done state', () => {
    const state = makeState({
      name: 'skills__create',
      arguments: {},
      status: 'done',
      result: JSON.stringify({ ok: true, message: 'Workflow completed.' }),
    });
    const { lastFrame } = render(<SkillsCreateBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('skills.create: Workflow completed.');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'skills__create',
      arguments: {},
      status: 'error',
      result: 'skills.create failed',
    });
    const { lastFrame } = render(<SkillsCreateBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});

// ── PersonaListBlock ──────────────────────────────────────────────────

describe('PersonaListBlock', () => {
  it('shows running state', () => {
    const state = makeState({
      name: 'persona__list',
      arguments: {},
      status: 'running',
    });
    const { lastFrame } = render(<PersonaListBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('persona.list()');
  });

  it('shows done state with personas', () => {
    const state = makeState({
      name: 'persona__list',
      arguments: {},
      status: 'done',
      result: JSON.stringify({
        activePersona: 'code',
        personas: [
          { id: 'code', description: 'Coding persona' },
          { id: 'plan', description: 'Planning persona' },
        ],
      }),
    });
    const { lastFrame } = render(<PersonaListBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('persona.list: 2 personas');
    expect(lastFrame()).toContain('active: code');
    expect(lastFrame()).toContain('code');
    expect(lastFrame()).toContain('Coding persona');
    expect(lastFrame()).toContain('plan');
    expect(lastFrame()).toContain('Planning persona');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'persona__list',
      arguments: {},
      status: 'error',
      result: 'persona.list failed',
    });
    const { lastFrame } = render(<PersonaListBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});

// ── PersonaSelectBlock ───────────────────────────────────────────────

describe('PersonaSelectBlock', () => {
  it('shows running state', () => {
    const state = makeState({
      name: 'persona__select',
      arguments: { id: 'plan' },
      status: 'running',
    });
    const { lastFrame } = render(<PersonaSelectBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('persona.select("plan")');
  });

  it('shows done state', () => {
    const state = makeState({
      name: 'persona__select',
      arguments: { id: 'plan' },
      status: 'done',
      result: JSON.stringify({
        activePersona: 'plan',
        name: 'plan',
        message: 'Switched to persona "plan".',
      }),
    });
    const { lastFrame } = render(<PersonaSelectBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('persona.select: "plan" → active');
  });

  it('shows clear state', () => {
    const state = makeState({
      name: 'persona__select',
      arguments: { id: 'none' },
      status: 'done',
      result: JSON.stringify({
        activePersona: null,
        message: 'Persona cleared.',
      }),
    });
    const { lastFrame } = render(<PersonaSelectBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('cleared');
  });

  it('shows error state from tool result', () => {
    const state = makeState({
      name: 'persona__select',
      arguments: { id: 'foo' },
      status: 'done',
      result: JSON.stringify({
        error: true,
        message: 'Unknown persona "foo".',
      }),
    });
    const { lastFrame } = render(<PersonaSelectBlock state={state} />);
    expect(lastFrame()).toContain('✗');
    expect(lastFrame()).toContain('Unknown persona "foo"');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'persona__select',
      arguments: { id: 'foo' },
      status: 'error',
      result: 'persona.select failed',
    });
    const { lastFrame } = render(<PersonaSelectBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});

// ── PersonaCreateBlock ───────────────────────────────────────────────

describe('PersonaCreateBlock', () => {
  it('shows running state', () => {
    const state = makeState({
      name: 'persona__create',
      arguments: {},
      status: 'running',
    });
    const { lastFrame } = render(<PersonaCreateBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('persona.create(...)');
  });

  it('shows done state', () => {
    const state = makeState({
      name: 'persona__create',
      arguments: {},
      status: 'done',
      result: JSON.stringify({ ok: true, message: 'Workflow completed.' }),
    });
    const { lastFrame } = render(<PersonaCreateBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('persona.create: Workflow completed.');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'persona__create',
      arguments: {},
      status: 'error',
      result: 'persona.create failed',
    });
    const { lastFrame } = render(<PersonaCreateBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});

// ── NotepadBlock ─────────────────────────────────────────────────────

describe('NotepadBlock', () => {
  it('shows running state', () => {
    const state = makeState({
      name: 'notepad__manage',
      arguments: { action: 'set' },
      status: 'running',
    });
    const { lastFrame } = render(<NotepadBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('notepad.manage("set"');
  });

  it('shows set done state', () => {
    const state = makeState({
      name: 'notepad__manage',
      arguments: { action: 'set', content: 'Hello world' },
      status: 'done',
      result: JSON.stringify({ success: true }),
    });
    const { lastFrame } = render(<NotepadBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('notepad.set');
  });

  it('shows clear done state', () => {
    const state = makeState({
      name: 'notepad__manage',
      arguments: { action: 'clear' },
      status: 'done',
      result: JSON.stringify({ success: true }),
    });
    const { lastFrame } = render(<NotepadBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('notepad.clear');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'notepad__manage',
      arguments: { action: 'set' },
      status: 'error',
      result: 'notepad.manage failed',
    });
    const { lastFrame } = render(<NotepadBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});

// ── SelfImprovementInsightBlock ─────────────────────────────────────

describe('SelfImprovementInsightBlock', () => {
  it('shows running state', () => {
    const state = makeState({
      name: 'self-improvement__insight',
      arguments: { action: 'record' },
      status: 'running',
    });
    const { lastFrame } = render(<SelfImprovementInsightBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('self-improvement.insight("record"');
  });

  it('shows record done state', () => {
    const state = makeState({
      name: 'self-improvement__insight',
      arguments: { action: 'record' },
      status: 'done',
      result: JSON.stringify({
        ok: true,
        targetType: 'persona',
        targetId: 'plan',
        entryCount: 1,
        message: 'Insight recorded for persona "plan".',
      }),
    });
    const { lastFrame } = render(<SelfImprovementInsightBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('recorded for persona "plan"');
  });

  it('shows list done state', () => {
    const state = makeState({
      name: 'self-improvement__insight',
      arguments: { action: 'list' },
      status: 'done',
      result: JSON.stringify({
        insights: [
          { targetType: 'persona', targetId: 'plan', entryCount: 2 },
          { targetType: 'skill', targetId: 'ui-architecture', entryCount: 1 },
        ],
      }),
    });
    const { lastFrame } = render(<SelfImprovementInsightBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('list');
    expect(lastFrame()).toContain('persona/plan (2 entries)');
    expect(lastFrame()).toContain('skill/ui-architecture (1 entry)');
  });

  it('shows recall done state', () => {
    const state = makeState({
      name: 'self-improvement__insight',
      arguments: { action: 'recall', targetType: 'persona', targetId: 'plan' },
      status: 'done',
      result: JSON.stringify({
        targetType: 'persona',
        targetId: 'plan',
        entries: [{ insight: 'First insight' }, { insight: 'Second insight' }],
      }),
    });
    const { lastFrame } = render(<SelfImprovementInsightBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('recall persona "plan"');
    expect(lastFrame()).toContain('First insight');
    expect(lastFrame()).toContain('Second insight');
    expect(lastFrame()).toContain('(2 entries)');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'self-improvement__insight',
      arguments: { action: 'record' },
      status: 'error',
      result: 'self-improvement.insight failed',
    });
    const { lastFrame } = render(<SelfImprovementInsightBlock state={state} />);
    expect(lastFrame()).toContain('✗');
  });
});
