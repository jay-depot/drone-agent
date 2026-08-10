# `--debug` CLI Flag

The `--debug` CLI flag enables subsystem-specific debug logging to stderr. It accepts a comma-separated list of subsystem names and supports repeated flags (same pattern as `--plugin`):

- `--debug llm` — log LLM request/response bodies to stderr
- `--debug tools` — log tool surface changes (mount/unmount/register/unregister) to stderr
- `--debug llm,mcp` — enable multiple subsystems at once
- `--debug llm --debug mcp` — repeated flags form

## Convention

Add new debug subsystems as you add features that need tracing. When a new feature involves network calls, complex state machines, or any subsystem where debugging would be aided by seeing raw I/O, add a corresponding `--debug <subsystem>` option.

## How It Works

1. `cli.ts` parses `--debug` into `debugSubsystems: string[]`
2. `index.tsx` creates a shared `DebugFlagRegistry` (in `drone-core`) seeded from `debugSubsystems`, and passes it to both the plugin engine and the conversation service
3. The conversation service passes `debug: debugFlags.isEnabled('llm')` to `provider.chat()`; each LLM provider logs its request body before sending and the raw response body after receiving, prefixed with `[llm:request]` and `[llm:response]` respectively
4. The plugin engine logs tool surface changes (mount/unmount/register/unregister, plugin enable/add-external) prefixed with `[tools:...]` when `debugFlags.isEnabled('tools')`

Because the registry is shared, toggling a subsystem at runtime via `/debug enable|disable <name>` takes effect immediately in both the engine and the conversation service.

**Output goes to stderr** — clean separation from TUI/plain output. Redirect with `2> debug.log` to capture.

## Current Subsystems

| Subsystem | What it logs                                                                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm`     | Full request and response bodies for all LLM providers (OpenAI, OpenRouter, Anthropic, Ollama)                                                                                          |
| `tools`   | Tool surface changes: `[tools:mount]`, `[tools:unmount]`, `[tools:register]`, `[tools:unregister]`, `[tools:unregister-plugin]`, `[tools:enable-plugin]`, `[tools:add-external-plugin]` |
