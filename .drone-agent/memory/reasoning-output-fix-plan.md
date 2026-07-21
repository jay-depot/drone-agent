---
key: reasoning-output-fix-plan
tags:
  []
created: 2026-07-21T21:11:27.913Z
updated: 2026-07-21T21:11:27.913Z
---

# Plan: Fix Reasoning Output for All LLM Providers

## Summary

The `DroneChatResponse` type has a `reasoning` field that the conversation service already consumes and the TUI already renders. However, only the Ollama provider populates it. OpenRouter sends reasoning in the request but doesn't extract it from the response. OpenAI doesn't send reasoning in the request *or* extract it from the response. Anthropic does neither. This plan fixes all three providers so reasoning output flows end-to-end.

## Design Decisions

1. **OpenAI vs OpenRouter format**: OpenAI uses `reasoning_effort` (top-level, snake_case); OpenRouter uses `reasoning: { effort: ... }` (nested). Both fields will be available on `OpenAiChatRequest` — each plugin uses the format its API expects. The API ignores fields it doesn't understand.
2. **Anthropic thinking budget**: 50% of `config.session.responseReserveTokens` as `budget_tokens`.
3. **Anthropic signature blocks**: Silently skipped — they're redacted hashes for Anthropic's internal verification.

## Step-by-Step Implementation

### Step 1: Update shared types in `openai-compatible.ts`

**File:** `drone-agent/src/shared/openai-compatible.ts`

**Changes:**
1. Add `reasoning_effort?: string` to `OpenAiChatRequest` (native OpenAI format, alongside existing `reasoning?: { effort: string }` for OpenRouter)
2. Add `reasoning?: string` to `OpenAiChatChoice` (the OpenAI API returns reasoning as a top-level field on the choice object)

```typescript
export type OpenAiChatRequest = {
  model: string;
  messages: OpenAiMessage[];
  reasoning?: { effort: string };     // OpenRouter format
  reasoning_effort?: string;           // Native OpenAI format
  tools?: OpenAiTool[];
};

export type OpenAiChatChoice = {
  message: OpenAiMessage;
  finish_reason: string;
  reasoning?: string;                  // <-- NEW: reasoning content from API
};
```

### Step 2: Update `fromOpenAiResponse()` to extract reasoning

**File:** `drone-agent/src/shared/openai-compatible.ts`

**Changes:** After extracting `choice.message.content`, also extract `choice.reasoning` and set it on `result.reasoning`.

```typescript
export function fromOpenAiResponse(
  openAi: OpenAiChatResponse
): DroneChatResponse {
  const choice = openAi.choices?.[0];
  if (!choice) {
    return { message: '' };
  }

  const result: DroneChatResponse = {
    message: choice.message.content ?? '',
  };

  // NEW: Extract reasoning from the choice-level field
  if (choice.reasoning) {
    result.reasoning = choice.reasoning;
  }

  // ... existing tool_calls extraction ...
}
```

### Step 3: Update OpenAI plugin to send reasoning in request

**File:** `drone-agent/src/plugins/openai/index.ts`

**Changes:**
1. Destructure `reasoningLevel` from the `chat()` input (currently only destructures `{ model, messages, tools }`)
2. Map `DroneReasoningLevel` to OpenAI's `reasoning_effort` values (`off` → `"none"`, `low` → `"low"`, etc.)
3. Set `reasoning_effort` on the request body

```typescript
// Add a mapping function (similar to OpenRouter's mapReasoningLevel)
function mapReasoningLevel(level: DroneReasoningLevel | undefined): string | undefined {
  if (level === undefined) return undefined;
  if (level === 'off') return 'none';
  if (level === 'low') return 'low';
  if (level === 'medium') return 'medium';
  if (level === 'high') return 'high';
  if (level === 'max') return 'max';
  return level;
}

// In the chat() function:
chat: async ({ model, messages, tools, reasoningLevel }) => {
  // ...
  const body: OpenAiChatRequest = {
    model,
    messages: messages.map(toOpenAiMessage),
  };

  const reasoningEffort = mapReasoningLevel(reasoningLevel);
  if (reasoningEffort) {
    body.reasoning_effort = reasoningEffort;
  }

  // ... rest of existing code ...
}
```

### Step 4: Update Anthropic types in `anthropic-adapter.ts`

**File:** `drone-agent/src/plugins/anthropic/anthropic-adapter.ts`

**Changes:**
1. Add `thinking` field to `AnthropicChatRequest`
2. Add `AnthropicThinkingBlock` type (`type: 'thinking'`, `text: string`, `signature?: string`)
3. Add `AnthropicSignatureBlock` type (`type: 'signature'`, `signature: string`)
4. Update `AnthropicContentBlock` union to include the new types

```typescript
export type AnthropicThinkingBlock = {
  type: 'thinking';
  text: string;
  signature?: string;
};

export type AnthropicSignatureBlock = {
  type: 'signature';
  signature: string;
};

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicSignatureBlock;

export type AnthropicChatRequest = {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  thinking?: { type: 'enabled'; budget_tokens: number };
};
```

### Step 5: Update `fromAnthropicResponse()` to extract reasoning

**File:** `drone-agent/src/plugins/anthropic/anthropic-adapter.ts`

**Changes:** In the content block loop, add handling for `type: 'thinking'` (extract text into `result.reasoning`) and `type: 'signature'` (silently skip).

```typescript
export function fromAnthropicResponse(
  response: AnthropicChatResponse
): DroneChatResponse {
  const textParts: string[] = [];
  const toolCalls: DroneToolCall[] = [];
  let reasoning: string | undefined;

  for (const block of response.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
      continue;
    }

    if (block.type === 'tool_use' && block.name) {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input ?? {},
      });
      continue;
    }

    // NEW: Extract thinking content as reasoning
    if (block.type === 'thinking' && typeof block.text === 'string') {
      reasoning = reasoning
        ? reasoning + '\n' + block.text
        : block.text;
      continue;
    }

    // NEW: Silently skip signature blocks
    if (block.type === 'signature') {
      continue;
    }
  }

  const result: DroneChatResponse = {
    message: textParts.join('\n').trim(),
  };

  if (reasoning) {
    result.reasoning = reasoning;
  }

  if (toolCalls.length > 0) {
    result.toolCalls = toolCalls;
  }

  return result;
}
```

### Step 6: Update Anthropic plugin to send thinking in request

**File:** `drone-agent/src/plugins/anthropic/index.ts`

**Changes:**
1. Destructure `reasoningLevel` from the `chat()` input
2. Map `DroneReasoningLevel` to Anthropic's `thinking` parameter
3. Pass `thinking` through `toAnthropicRequestParts()` or set it directly on the body

The cleanest approach is to add `reasoningLevel` to the `toAnthropicRequestParts` input and handle the thinking config there, since the adapter already owns the request building.

```typescript
// In anthropic-adapter.ts, update toAnthropicRequestParts:
export function toAnthropicRequestParts(input: {
  messages: DroneChatMessage[];
  tools?: DroneToolDescriptor[];
  maxTokens: number;
  model: string;
  reasoningLevel?: DroneReasoningLevel;  // NEW
}): AnthropicChatRequest {
  // ... existing code ...

  // NEW: Add thinking if reasoning is enabled
  if (input.reasoningLevel && input.reasoningLevel !== 'off') {
    request.thinking = {
      type: 'enabled',
      budget_tokens: Math.floor(input.maxTokens * 0.5), // 50% of reserve
    };
  }

  return request;
}
```

And in `anthropic/index.ts`, pass `reasoningLevel` through:

```typescript
chat: async ({ model, messages, tools, reasoningLevel }) => {
  // ...
  const body = toAnthropicRequestParts({
    model,
    messages,
    tools,
    maxTokens: config.session.responseReserveTokens,
    reasoningLevel,  // NEW
  });
  // ...
}
```

### Step 7: Update tests

**File:** `drone-agent/test/openai.test.ts`

Add test cases:
- Verify `reasoning_effort` is sent in the request body when `reasoningLevel` is provided
- Verify reasoning is extracted from a mock response that includes `choice.reasoning`

**File:** `drone-agent/test/openrouter.test.ts`

Add test case:
- Verify reasoning is extracted from a mock response that includes `choice.reasoning`

**File:** `drone-agent/test/anthropic.test.ts`

Add test cases:
- Verify `thinking` is sent in the request body when `reasoningLevel` is provided
- Verify reasoning is extracted from a mock response with `type: 'thinking'` content blocks
- Verify `type: 'signature'` blocks are silently skipped

### Step 8: Verify

Run the full validation suite:
```bash
pnpm -r run lint
pnpm -r run build
pnpm -r run test
```

## Validation Criteria

- [ ] LSP diagnostics pass with zero errors
- [ ] `pnpm -r run lint` passes with zero errors
- [ ] `pnpm -r run build` passes with zero errors
- [ ] `pnpm -r run test` passes (all existing + new tests)
- [ ] OpenAI plugin sends `reasoning_effort` in request body when `reasoningLevel` is set
- [ ] OpenAI plugin extracts `choice.reasoning` from response into `DroneChatResponse.reasoning`
- [ ] OpenRouter plugin extracts `choice.reasoning` from response into `DroneChatResponse.reasoning`
- [ ] Anthropic plugin sends `thinking` with `budget_tokens` in request body when `reasoningLevel` is set
- [ ] Anthropic plugin extracts `type: 'thinking'` blocks into `DroneChatResponse.reasoning`
- [ ] Anthropic plugin silently skips `type: 'signature'` blocks
- [ ] `fromOpenAiResponse()` handles missing `choice.reasoning` gracefully (undefined → no reasoning set)
- [ ] `fromAnthropicResponse()` handles missing `type: 'thinking'` blocks gracefully
