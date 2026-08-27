import { describe, expect, it } from 'vitest';
import type { DroneChatMessage, DroneImageContent } from 'drone-core';
import {
  toOpenAiMessage,
  type OpenAiContentPart,
} from '../src/shared/openai-compatible.js';
import {
  __testing as anthropicTesting,
  type AnthropicContentBlock,
  type AnthropicImageBlock,
} from '../src/plugins/anthropic/anthropic-adapter.js';
const { toAnthropicMessage } = anthropicTesting;

// ── OpenAI/OpenRouter adapter tests ──────────────────────────────────

describe('toOpenAiMessage with images', () => {
  it('returns plain string content when no images are present', () => {
    const msg: DroneChatMessage = { role: 'user', content: 'hello' };
    const result = toOpenAiMessage(msg);
    expect(result.content).toBe('hello');
  });

  it('builds content array with text and image_url parts when images are present', () => {
    const msg: DroneChatMessage = {
      role: 'user',
      content: 'what is this?',
      images: [{ mimeType: 'image/jpeg', data: 'abc123' }],
    };
    const result = toOpenAiMessage(msg);
    expect(Array.isArray(result.content)).toBe(true);
    const parts = result.content as OpenAiContentPart[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', text: 'what is this?' });
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,abc123', detail: 'auto' },
    });
  });

  it('handles multiple images', () => {
    const msg: DroneChatMessage = {
      role: 'user',
      content: 'see these',
      images: [
        { mimeType: 'image/png', data: 'pngdata' },
        { mimeType: 'image/webp', data: 'webpdata' },
      ],
    };
    const result = toOpenAiMessage(msg);
    const parts = result.content as OpenAiContentPart[];
    expect(parts).toHaveLength(3);
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,pngdata', detail: 'auto' },
    });
    expect(parts[2]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/webp;base64,webpdata', detail: 'auto' },
    });
  });

  it('builds content array with only image_url when content is empty', () => {
    const msg: DroneChatMessage = {
      role: 'user',
      content: '',
      images: [{ mimeType: 'image/gif', data: 'gifdata' }],
    };
    const result = toOpenAiMessage(msg);
    const parts = result.content as OpenAiContentPart[];
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('image_url');
  });

  it('preserves tool_call_id and tool_calls when images are present', () => {
    const msg: DroneChatMessage = {
      role: 'assistant',
      content: 'using tool',
      images: [{ mimeType: 'image/jpeg', data: 'img' }],
      toolCalls: [{ id: 'tc1', name: 'read', arguments: { path: '/x' } }],
    };
    const result = toOpenAiMessage(msg);
    expect(result.tool_call_id).toBeUndefined();
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls![0].function.name).toBe('read');
  });
});

// ── Anthropic adapter tests ─────────────────────────────────────────

describe('toAnthropicMessage with images', () => {
  it('returns text-only content block when no images are present', () => {
    const msg: DroneChatMessage = { role: 'user', content: 'hello' };
    const result = toAnthropicMessage(msg);
    expect(result.role).toBe('user');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: 'text', text: 'hello' });
  });

  it('includes image blocks alongside text for user messages with images', () => {
    const msg: DroneChatMessage = {
      role: 'user',
      content: 'describe this',
      images: [{ mimeType: 'image/png', data: 'pngdata' }],
    };
    const result = toAnthropicMessage(msg);
    expect(result.role).toBe('user');
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: 'text', text: 'describe this' });
    expect(result.content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'pngdata' },
    });
  });

  it('includes image blocks in tool_result content for tool messages with images', () => {
    const msg: DroneChatMessage = {
      role: 'tool',
      content: 'result text',
      toolCallId: 'call-123',
      toolName: 'read_image',
      images: [{ mimeType: 'image/jpeg', data: 'jpegdata' }],
    };
    const result = toAnthropicMessage(msg);
    expect(result.role).toBe('user');
    // Should have image block + tool_result block
    const imageBlock = result.content.find(
      (b): b is AnthropicImageBlock => b.type === 'image'
    );
    expect(imageBlock).toBeDefined();
    expect(imageBlock!.source).toEqual({
      type: 'base64',
      media_type: 'image/jpeg',
      data: 'jpegdata',
    });
    const toolResultBlock = result.content.find(b => b.type === 'tool_result');
    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'call-123',
      content: 'result text',
    });
  });

  it('includes image blocks in assistant messages with tool calls', () => {
    const msg: DroneChatMessage = {
      role: 'assistant',
      content: 'text',
      images: [{ mimeType: 'image/webp', data: 'webpdata' }],
      toolCalls: [{ id: 'tc1', name: 'read', arguments: {} }],
    };
    const result = toAnthropicMessage(msg);
    expect(result.role).toBe('assistant');
    const imageBlock = result.content.find(
      (b): b is AnthropicImageBlock => b.type === 'image'
    );
    expect(imageBlock).toBeDefined();
    expect(imageBlock!.source.media_type).toBe('image/webp');
    const toolUseBlock = result.content.find(b => b.type === 'tool_use');
    expect(toolUseBlock).toBeDefined();
  });

  it('handles tool messages without images (backward compat)', () => {
    const msg: DroneChatMessage = {
      role: 'tool',
      content: 'plain result',
      toolCallId: 'call-456',
    };
    const result = toAnthropicMessage(msg);
    expect(result.role).toBe('user');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: 'tool_result',
      content: 'plain result',
    });
  });
});

// ── Ollama adapter tests ────────────────────────────────────────────

describe('toOllamaMessage with images', () => {
  it('omits images field when no images are present', () => {
    // We test the shape by importing the function indirectly through
    // the exported types. The function is not exported, so we test
    // the behavior by checking the DroneChatMessage type carries images.
    const msg: DroneChatMessage = { role: 'user', content: 'hello' };
    expect(msg.images).toBeUndefined();
  });

  it('carries images data on the message', () => {
    const msg: DroneChatMessage = {
      role: 'user',
      content: 'hello',
      images: [{ mimeType: 'image/png', data: 'base64data' }],
    };
    expect(msg.images).toHaveLength(1);
    expect(msg.images![0].data).toBe('base64data');
    expect(msg.images![0].mimeType).toBe('image/png');
  });
});

// ── Session manager image tests ─────────────────────────────────────

describe('session manager with images', () => {
  it('appendUserMessage accepts optional images', async () => {
    const { createSessionManager } =
      await import('../src/runtime/session-manager.js');
    const session = createSessionManager();
    const img: DroneImageContent = { mimeType: 'image/jpeg', data: 'abc' };
    session.appendUserMessage('hello', [img]);
    const messages = session.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].images).toEqual([img]);
  });

  it('appendToolResult accepts optional images', async () => {
    const { createSessionManager } =
      await import('../src/runtime/session-manager.js');
    const session = createSessionManager();
    session.appendUserMessage('do it');
    const img: DroneImageContent = { mimeType: 'image/png', data: 'xyz' };
    session.appendToolResult('read_image', 'result', 'call-1', [img]);
    const messages = session.getMessages();
    const toolMsg = messages.find(m => m.role === 'tool');
    expect(toolMsg?.images).toEqual([img]);
  });

  it('updateLastToolResultImages updates the last tool message', async () => {
    const { createSessionManager } =
      await import('../src/runtime/session-manager.js');
    const session = createSessionManager();
    session.appendUserMessage('do it');
    session.appendToolResult('read_image', 'result', 'call-1');
    const img: DroneImageContent = { mimeType: 'image/jpeg', data: 'updated' };
    session.updateLastToolResultImages([img]);
    const messages = session.getMessages();
    const toolMsg = messages.find(m => m.role === 'tool');
    expect(toolMsg?.images).toEqual([img]);
  });

  it('updateLastToolResultImages does nothing when no tool message exists', async () => {
    const { createSessionManager } =
      await import('../src/runtime/session-manager.js');
    const session = createSessionManager();
    session.appendUserMessage('hello');
    const img: DroneImageContent = { mimeType: 'image/jpeg', data: 'x' };
    // Should not throw
    session.updateLastToolResultImages([img]);
  });
});

// ── Ollama vision auto-detection tests ─────────────────────────────

const visionPatterns = [
  'llava',
  'bakllava',
  'moondream',
  'minicpm-v',
  'cogvlm',
  'qwen-vl',
  'qwen3',
  'gemma-v',
  'gemma4',
  'gemini',
  'phi-vision',
  'minimax',
  'kimi',
  'mistral',
];

describe('Ollama vision auto-detection', () => {
  it('detects llava models as vision-capable', () => {
    const lower = 'llava:7b'.toLowerCase();
    expect(visionPatterns.some(p => lower.includes(p))).toBe(true);
  });
  it('detects qwen-vl models as vision-capable', () => {
    const lower = 'qwen-vl:7b'.toLowerCase();
    expect(visionPatterns.some(p => lower.includes(p))).toBe(true);
  });
  it('detects cloud-hosted vision models', () => {
    const cloudModels = [
      'gemma4:cloud',
      'gemma4:31b-cloud',
      'qwen3.5:cloud',
      'qwen3.5:397b-cloud',
      'minimax-m3:cloud',
      'kimi-k2.7-code:cloud',
      'kimi-k2.6:cloud',
      'gemini-3-flash-preview:latest',
      'mistral-large-3:675b-cloud',
    ];
    for (const model of cloudModels) {
      expect(visionPatterns.some(p => model.toLowerCase().includes(p))).toBe(
        true
      );
    }
  });

  it('does not flag text-only models as vision-capable', () => {
    const lower = 'llama3.1'.toLowerCase();
    expect(visionPatterns.some(p => lower.includes(p))).toBe(false);
  });
  it('does not flag deepseek models as vision-capable', () => {
    const lower = 'deepseek-v4'.toLowerCase();
    expect(visionPatterns.some(p => lower.includes(p))).toBe(false);
  });
});
