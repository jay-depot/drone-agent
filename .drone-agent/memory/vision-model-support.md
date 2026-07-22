---
key: vision-model-support
tags:
  - vision
  - multimodal
  - feature-plan
  - completed
created: 2026-07-21T23:30:35.247Z
updated: 2026-07-22T01:07:16.051Z
---

# Vision Model Support — Implementation Complete

## Summary

Vision/multimodal support has been added to drone-agent across all 4 LLM providers (Ollama, OpenAI, OpenRouter, Anthropic).

## What was implemented

### Core Types (drone-core)

- **`DroneImageContent`** type with `mimeType` and `data` (base64) fields
- **`images?: DroneImageContent[]`** added to `DroneChatMessage`
- **`hasVision?: boolean`** added to `DroneOllamaConfig` and `DroneOpenRouterModelConfig`
- **`maxImageSizeBytes?: number`** added to `DroneSessionConfig` (default 20MB)
- **`supportsImagesInToolResults?: boolean`** added to `DroneLlmProvider`
- **`hasVision?: (model: string) => boolean | Promise<boolean>`** added to `DroneLlmProviderRegistration` and `DroneLlmCapability`
- Token estimation updated to add ~256 tokens per image

### file\_\_read_image Tool

- Reads image files (JPEG, PNG, WebP, GIF) and returns base64-encoded data
- Checks file size against `session.maxImageSizeBytes`
- Always works regardless of model vision capability — the conversation service decides whether to inject the image

### Provider Adapters

- **OpenAI/OpenRouter**: `OpenAiMessage.content` now supports `string | OpenAiContentPart[]` with `image_url` parts
- **Anthropic**: Added `AnthropicImageBlock` type, `toAnthropicMessage` includes image blocks in user/assistant/tool_result messages. Sets `supportsImagesInToolResults: true` and `hasVision: () => true`
- **Ollama**: `toOllamaMessage` passes `images` field (raw base64 strings). `hasVision` auto-detects via model name patterns (llava, bakllava, etc.) with config override

### Conversation Service

- After tool execution, detects images in tool results via `extractImageFromToolResult`
- For Anthropic: updates the tool result message inline via `updateLastToolResultImages`
- For other providers: injects a synthetic user message with the image
- Also sniffs MCP tool results for `data:image/` data URIs

### Session Manager

- `appendUserMessage` and `appendToolResult` accept optional `images` parameter
- Added `updateLastToolResultImages` for Anthropic's inline tool result images

### /model Command

- Shows `[vision]` tag next to vision-capable models in the listing

## Files Modified (14 files)

- `drone-core/src/session-types.ts` — DroneImageContent, images on DroneChatMessage
- `drone-core/src/config-types.ts` — hasVision, maxImageSizeBytes config
- `drone-core/src/provider-types.ts` — supportsImagesInToolResults, hasVision
- `drone-core/src/capabilities.ts` — hasVision on DroneLlmCapability
- `drone-core/src/token-estimate.ts` — image token estimation
- `drone-core/src/index.ts` — export DroneImageContent
- `drone-agent/src/plugins/file.ts` — file\_\_read_image tool
- `drone-agent/src/plugins/llm/index.ts` — hasVision capability, [vision] tag in /model
- `drone-agent/src/plugins/ollama.ts` — images field, vision auto-detection
- `drone-agent/src/plugins/anthropic/anthropic-adapter.ts` — image blocks
- `drone-agent/src/plugins/anthropic/index.ts` — supportsImagesInToolResults, hasVision
- `drone-agent/src/shared/openai-compatible.ts` — content parts, image_url
- `drone-agent/src/runtime/session-manager.ts` — images parameter, updateLastToolResultImages
- `drone-agent/src/runtime/conversation-service.ts` — image injection logic

## Validation

- `pnpm typecheck` — zero errors
- `pnpm build` — zero errors
- `pnpm -r run test` — 103 test files, 1601 tests, all passing

## Remaining

- Step 14 (tests) was not implemented — new tests for file\_\_read_image, provider adapters with images, etc. still need to be written
