---
key: vision-model-support
tags:
  - vision
  - multimodal
  - feature-plan
created: 2026-07-21T23:30:35.247Z
updated: 2026-07-21T23:32:41.747Z
---

# Vision Model Support — Implementation Plan

## Summary

Add vision/multimodal support to drone-agent so the LLM can "see" images. The approach is:

1. **`file__read_image` tool** — reads image files, returns base64 data with MIME type
2. **`DroneImageContent` type** — extends `DroneChatMessage` with an `images` field
3. **Provider adapter updates** — each provider (Ollama, OpenAI/OpenRouter, Anthropic) converts images to its native wire format
4. **Synthetic user message injection** — for providers that don't support images in tool results (OpenAI/OpenRouter/Ollama), the conversation service injects a synthetic user message with the image
5. **Anthropic inline tool result images** — Anthropic supports images in `tool_result` content blocks, so we use that path when talking to Claude
6. **MCP content sniffing** — detect `data:image/` data URIs in MCP tool results and handle them the same way
7. **Vision capability detection** — Ollama auto-detects via model name patterns; OpenRouter gets an optional `hasVision` flag per model config
8. **Configurable max image size** — `session.maxImageSizeBytes` (default 20MB)
9. **Graceful non-vision fallback** — `file__read_image` always works; if the model doesn't support vision, the image data is simply not injected into the conversation, and the LLM sees the metadata (path, type, size) as plain text
10. **`[vision]` tag in `/model` listing** — models that support vision get a `[vision]` tag next to their name in the `/model` command output

## Files to Modify (12 files)

| File | Change |
|------|--------|
| `drone-core/src/session-types.ts` | Add `DroneImageContent` type, add `images?` to `DroneChatMessage` |
| `drone-core/src/config-types.ts` | Add `hasVision?` to `DroneOllamaConfig` & `DroneOpenRouterModelConfig`, add `maxImageSizeBytes?` to `DroneSessionConfig` |
| `drone-core/src/provider-types.ts` | Add `supportsImagesInToolResults?` to `DroneLlmProvider`, add `hasVision?` to `DroneLlmProviderRegistration` |
| `drone-core/src/capabilities.ts` | Add `hasVision?` to `DroneLlmCapability` |
| `drone-core/src/token-estimate.ts` | Add ~256 tokens per image in `estimateMessageTokens` |
| `drone-agent/src/plugins/file.ts` | Add `file__read_image` tool |
| `drone-agent/src/shared/openai-compatible.ts` | Support `content: string | OpenAiContentPart[]` with `image_url` parts |
| `drone-agent/src/plugins/anthropic/anthropic-adapter.ts` | Add `AnthropicImageBlock`, update `toAnthropicMessage` for images in user/assistant/tool messages, set `supportsImagesInToolResults: true` |
| `drone-agent/src/plugins/ollama.ts` | Pass `images` field in `toOllamaMessage`, add vision auto-detection |
| `drone-agent/src/runtime/session-manager.ts` | Accept optional `images` in `appendUserMessage` and `appendToolResult`, add `updateLastToolResultImages` |
| `drone-agent/src/runtime/conversation-service.ts` | After tool execution, detect images in results and inject synthetic user messages (or update tool result for Anthropic) |
| `drone-agent/src/plugins/llm/index.ts` | Wire `hasVision` through the broker capability, add `[vision]` tag to `/model` listing |

## Step-by-Step

### Step 1: Add image types to drone-core

**File: drone-core/src/session-types.ts**

Add the `DroneImageContent` type and extend `DroneChatMessage`:

```typescript
export type DroneImageContent = {
  mimeType: string;
  data: string; // base64-encoded image data
};

export type DroneChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: DroneImageContent[]; // NEW
  toolCallId?: string;
  toolName?: string;
  toolCalls?: DroneToolCall[];
};
```

### Step 2: Add config types for vision

**File: drone-core/src/config-types.ts**

```typescript
export type DroneOllamaConfig = {
  host: string;
  model: string;
  reasoningLevel?: DroneReasoningLevel;
  hasVision?: boolean; // NEW — auto-detect if undefined
};

export type DroneOpenRouterModelConfig = {
  id: string;
  contextWindow: number;
  hasVision?: boolean; // NEW
};

export type DroneSessionConfig = {
  // ... existing fields
  maxImageSizeBytes?: number; // NEW — default 20MB
};
```

Update `createDefaultAgentConfig()` to include `maxImageSizeBytes: 20 * 1024 * 1024` in session defaults.

### Step 3: Add supportsImagesInToolResults to provider interface

**File: drone-core/src/provider-types.ts**

```typescript
export type DroneLlmProvider = {
  chat: (input: {
    model: string;
    messages: DroneChatMessage[];
    tools?: DroneToolDescriptor[];
    reasoningLevel?: DroneReasoningLevel;
    debug?: boolean;
  }) => Promise<DroneChatResponse>;
  getContextWindowInfo?: (input: {
    model: string;
  }) => Promise<DroneContextWindowInfo | null>;
  supportsImagesInToolResults?: boolean; // NEW
};
```

### Step 4: Add hasVision to provider registration

**File: drone-core/src/provider-types.ts**

```typescript
export type DroneLlmProviderRegistration = {
  id: string;
  precedence: number;
  getProvider: () => DroneLlmProvider;
  listModels: () => Promise<string[]>;
  getDefaultModel: () => string;
  hasVision?: (model: string) => boolean | Promise<boolean>; // NEW
};
```

### Step 5: Add hasVision to LLM capability

**File: drone-core/src/capabilities.ts**

```typescript
export type DroneLlmCapability = {
  // ... existing methods
  hasVision?: (model: string) => boolean | Promise<boolean>; // NEW
};
```

### Step 6: Update token estimation

**File: drone-core/src/token-estimate.ts**

Update `estimateMessageTokens` to account for image data. A rough estimate: each image costs ~256 tokens (conservative for typical vision models):

```typescript
export function estimateMessageTokens(message: DroneChatMessage): number {
  let total = 6 + estimateTextTokens(message.content);
  if (message.images) {
    for (const img of message.images) {
      total += 256; // rough estimate per image
    }
  }
  // ... rest unchanged
}
```

### Step 7: Add file__read_image tool

**File: drone-agent/src/plugins/file.ts**

Register a new tool `read_image` that:
1. Resolves the path
2. Reads the file as binary
3. Detects MIME type from extension (.jpg/.jpeg → image/jpeg, .png → image/png, .webp → image/webp, .gif → image/gif)
4. Checks size against `session.maxImageSizeBytes`
5. Base64-encodes the data
6. Returns structured JSON: `{ path, mimeType, data, size }`

### Step 8: Update session manager

**File: drone-agent/src/runtime/session-manager.ts**

Update `appendUserMessage` and `appendToolResult` to accept optional `images`:

```typescript
appendUserMessage: (content: string, images?: DroneImageContent[]) => {
  turns.push(createTurn({ role: 'user', content, images }));
},
appendToolResult: (toolName, content, toolCallId, images?: DroneImageContent[]) => {
  appendToCurrentTurn({ role: 'tool', content, toolName, toolCallId, images });
},
```

Add `updateLastToolResultImages`:

```typescript
updateLastToolResultImages: (images: DroneImageContent[]) => {
  const lastTurn = turns.at(-1);
  if (lastTurn) {
    const lastToolMsg = lastTurn.messages.findLast(m => m.role === 'tool');
    if (lastToolMsg) {
      lastToolMsg.images = images;
    }
  }
},
```

### Step 9: Update OpenAI/OpenRouter adapter

**File: drone-agent/src/shared/openai-compatible.ts**

Update `OpenAiMessage` to support content arrays:

```typescript
export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export type OpenAiMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAiContentPart[];
  // ... rest unchanged
};
```

Update `toOpenAiMessage`:

```typescript
export function toOpenAiMessage(msg: DroneChatMessage): OpenAiMessage {
  const base: OpenAiMessage = {
    role: msg.role,
    content: msg.content,
  };

  // If message has images, build content array
  if (msg.images && msg.images.length > 0) {
    const parts: OpenAiContentPart[] = [];
    if (msg.content) {
      parts.push({ type: 'text', text: msg.content });
    }
    for (const img of msg.images) {
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${img.mimeType};base64,${img.data}`,
          detail: 'auto',
        },
      });
    }
    base.content = parts;
  }

  // ... rest unchanged (tool_call_id, name, tool_calls)
  return base;
}
```

### Step 10: Update Anthropic adapter

**File: drone-agent/src/plugins/anthropic/anthropic-adapter.ts**

Add image block type:

```typescript
export type AnthropicImageBlock = {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
};

// Add to AnthropicContentBlock union
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicSignatureBlock
  | AnthropicImageBlock; // NEW
```

Update `toAnthropicMessage` to include image blocks:

In the user/assistant fallthrough case:
```typescript
if (message.images && message.images.length > 0) {
  const content: AnthropicContentBlock[] = [];
  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }
  for (const img of message.images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.data },
    });
  }
  return { role: message.role === 'assistant' ? 'assistant' : 'user', content };
}
return {
  role: message.role === 'assistant' ? 'assistant' : 'user',
  content: [{ type: 'text', text: message.content }],
};
```

In the tool result case, update to include images in the `tool_result` content:
```typescript
if (message.role === 'tool') {
  const content: AnthropicContentBlock[] = [];
  if (message.images && message.images.length > 0) {
    for (const img of message.images) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType, data: img.data },
      });
    }
  }
  content.push({
    type: 'tool_result',
    tool_use_id: message.toolCallId ?? `call_${Math.random().toString(36).slice(2, 10)}`,
    content: message.content,
  });
  return { role: 'user', content };
}
```

Set `supportsImagesInToolResults: true` on the Anthropic provider.

### Step 11: Update Ollama adapter

**File: drone-agent/src/plugins/ollama.ts**

Update `toOllamaMessage` to pass images:

```typescript
function toOllamaMessage(message: DroneChatMessage) {
  return {
    role: message.role,
    content: message.content,
    images: message.images?.map(img => img.data), // Ollama accepts raw base64 strings
    tool_name: message.toolName,
    tool_calls: message.toolCalls?.map(toolCall => ({
      function: { name: toolCall.name, arguments: toolCall.arguments },
    })),
  };
}
```

Add vision detection to the provider registration:

```typescript
hasVision: (model: string) => {
  const config = registration.getConfig().ollama;
  if (config.hasVision !== undefined) return config.hasVision;
  // Auto-detect: check model name against known vision model patterns
  const visionPatterns = ['llava', 'bakllava', 'moondream', 'minicpm-v', 'cogvlm', 'qwen-vl', 'gemma-v', 'phi-vision'];
  const lower = model.toLowerCase();
  return visionPatterns.some(p => lower.includes(p));
},
```

### Step 12: Wire vision detection through LLM broker

**File: drone-agent/src/plugins/llm/index.ts**

In the `DroneLlmCapability` implementation, add:

```typescript
hasVision: (model: string) => {
  const active = getActiveRegistration();
  if (active?.hasVision) {
    return active.hasVision(model);
  }
  return false;
},
```

Update the `/model` command's model listing to include a `[vision]` tag:

```typescript
const lines = await Promise.all(models.map(async m => {
  const isCurrent = m === current;
  const hasVision = await llm.hasVision?.(m) ?? false;
  const visionTag = hasVision ? ' [vision]' : '';
  return isCurrent
    ? `  * ${m}${visionTag} (current)`
    : `    ${m}${visionTag}`;
}));
```

### Step 13: Add image injection logic to conversation service

**File: drone-agent/src/runtime/conversation-service.ts**

After tool results are appended (after the `for (const result of bufferedResults)` loop), add image detection logic:

```typescript
// After appending tool results, check for image data
for (const result of bufferedResults) {
  const imageContent = extractImageFromToolResult(result.content);
  if (imageContent) {
    const provider = llm.getActiveProvider();
    if (provider.supportsImagesInToolResults) {
      // Anthropic: update the tool result message to include images inline
      sessionManager.updateLastToolResultImages([imageContent]);
    } else {
      // OpenAI/OpenRouter/Ollama: inject synthetic user message
      sessionManager.appendUserMessage(
        `[Image from ${result.name} tool]`,
        [imageContent]
      );
    }
  }
}
```

Add helper functions:

```typescript
function extractImageFromToolResult(content: string): DroneImageContent | null {
  try {
    const parsed = JSON.parse(content);
    if (isRecord(parsed)) {
      // Check for file__read_image format
      if (typeof parsed.mimeType === 'string' && parsed.mimeType.startsWith('image/') && typeof parsed.data === 'string') {
        return { mimeType: parsed.mimeType, data: parsed.data };
      }
      // Check for MCP data URI in any string field
      const dataUri = findDataUri(parsed);
      if (dataUri) return dataUri;
    }
  } catch {}
  return null;
}

function findDataUri(obj: unknown): DroneImageContent | null {
  if (typeof obj === 'string') {
    const match = obj.match(/^data:(image\/\w+);base64,(.+)$/);
    if (match) return { mimeType: match[1], data: match[2] };
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const result = findDataUri(item);
      if (result) return result;
    }
  }
  if (isRecord(obj)) {
    for (const val of Object.values(obj)) {
      const result = findDataUri(val);
      if (result) return result;
    }
  }
  return null;
}
```

### Step 14: Add tests

New test files or additions to existing test files covering:

- `file__read_image` tool (valid image, unsupported format, oversized image, non-existent path)
- `toOpenAiMessage` with images (user message, tool message without images)
- `toAnthropicMessage` with images (user message, tool result with images)
- `toOllamaMessage` with images
- `estimateMessageTokens` with images
- `extractImageFromToolResult` (file__read_image format, MCP data URI, no image)
- Synthetic user message injection logic
- Ollama vision auto-detection

## Validation Criteria

1. **LSP passes** — `pnpm typecheck` with zero errors across all packages
2. **Build passes** — `pnpm build` with zero errors
3. **Lint passes** — `pnpm -r run lint` with zero errors
4. **Tests pass** — `pnpm -r run test` with zero failures
5. **New tests exist** covering all the scenarios listed in Step 14
6. **Manual verification**: Run with a vision-capable model and verify the LLM can describe an image via `file__read_image`, and that `/model` shows `[vision]` tags on vision-capable models