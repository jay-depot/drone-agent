# `--debug` CLI Flag

The `--debug` CLI flag enables subsystem-specific debug logging to stderr. It accepts a comma-separated list of subsystem names and supports repeated flags (same pattern as `--plugin`):

- `--debug llm` — log LLM request/response bodies to stderr
- `--debug llm,mcp` — enable multiple subsystems at once
- `--debug llm --debug mcp` — repeated flags form

## Convention

Add new debug subsystems as you add features that need tracing. When a new feature involves network calls, complex state machines, or any subsystem where debugging would be aided by seeing raw I/O, add a corresponding `--debug <subsystem>` option.

## How It Works

1. `cli.ts` parses `--debug` into `debugSubsystems: string[]`
2. `index.tsx` passes `debugSubsystems` to the conversation service
3. The conversation service stores it as a `Set<string>` and passes `debug: debugSet.has('llm')` to `provider.chat()`
4. Each LLM provider logs its request body before sending and the raw response body after receiving, prefixed with `[llm:request]` and `[llm:response]` respectively

**Output goes to stderr** — clean separation from TUI/plain output. Redirect with `2> debug.log` to capture.

## Current Subsystems

| Subsystem | What it logs |
| --------- | ------------ |
| `llm`     | Full request and response bodies for all LLM providers (OpenAI, OpenRouter, Anthropic, Ollama) |
