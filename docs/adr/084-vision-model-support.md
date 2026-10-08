---
tags: [decision, vision, multimodal, llm]
related:
  [
    concepts/vision-support.md,
    modules/drone-core.md,
    modules/drone-agent-plugins.md,
  ]
---

# Decision 084: Vision Model Support

**Summary**: Add image input support across all four LLM providers (OpenAI, OpenRouter, Anthropic, Ollama) with a `file__read_image` tool and automatic image injection into conversation context.

## Context

The agent had no way to process images — no image types, no image-reading tool, and no provider adapter support for multimodal content. Users couldn't ask the agent to analyze screenshots, diagrams, or photos.

## Decision

Add a `DroneImageContent` type (mimeType + base64 data) to `DroneChatMessage`, a `file__read_image` tool for reading image files, and image content-part support in all four LLM provider adapters.

### Key design choices

1. **Images are injected after tool execution**, not during the initial user message. The conversation service detects images in tool results (e.g., from `file__read_image` or MCP data URIs) and injects them as synthetic user messages (or inline tool result images for Anthropic).

2. **Anthropic gets special treatment** — it supports images directly in `tool_result` content blocks, so `updateLastToolResultImages` modifies the tool result message in-place rather than creating a synthetic user message.

3. **Vision capability is auto-detected** for Ollama via model name patterns (llava, bakllava, llava-llama3, moondream, gemma3, deepseek-vision, etc.) with a config override. OpenAI, OpenRouter, and Anthropic are assumed vision-capable by default.

4. **Token estimation** adds ~256 tokens per image as a rough estimate.

5. **`file__read_image` always works** regardless of model capability — the conversation service decides whether to inject the image based on the active model's `hasVision` check.

## Consequences

- Users can now ask the agent to analyze images (screenshots, diagrams, photos)
- ~256 tokens per image added to context budget
- New `session.maxImageSizeBytes` config (default 20MB) prevents oversized images
- Provider-specific image handling adds some complexity to the conversation service
