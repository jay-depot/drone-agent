# AGENTS.md — drone-agent

This file describes how to work on the `drone-agent` project itself. The project is a monorepo (pnpm workspace) with four packages, though only `drone-agent` and `drone-core` are implemented so far.

**If you encounter any discrepancy between this document and the code, with the exception of aspirational statements, the code is the source of truth, and this document should be updated.**

**Aspirational statements in this document should be kept, so the project remains focused on its long-term vision, but do turn them into concrete statements of fact when they are implemented.**

## Project Structure

```
drone-agent/          ← The CLI + TUI coding agent (Ink-based)
  src/
    index.tsx         ← Main entry point, CLI arg parsing, first-run setup
    plugins/          ← All built-in plugins (skills, persona, memory, lsp, mcp, etc.)
      bootstrap/     ← Bootstrap plugin (project/user setup workflows)
        index.ts      ← Plugin registration, analyze tool, project & user workflows
        project-detect.ts ← Project detection logic (shared by tool and workflow)
    runtime/          ← Plugin engine, config loader, conversation service, session manager
    tui/              ← Ink-based TUI (App, ChatLog, InputLine, StatusBar, etc.)
  test/               ← Vitest tests
drone-core/           ← Shared types, contracts, config defaults, token estimation
  src/index.ts        ← All shared types (DronePlugin, DroneAgentConfig, etc.)
  test/
drone-beacon/         ← Placeholder (not yet implemented)
drone-coordinator/    ← Placeholder (not yet implemented)
```

## Development Commands

| Command           | Purpose                      |
| ----------------- | ---------------------------- |
| `pnpm build`      | Compile all packages         |
| `pnpm typecheck`  | Type-check all packages      |
| `pnpm test`       | Run all tests (vitest)       |
| `pnpm test:watch` | Watch mode                   |
| `pnpm lint`       | ESLint + Prettier            |
| `pnpm clean`      | Remove all dist/ directories |

## Architecture Overview

### Plugin System

Everything is a plugin. Each plugin implements `DronePlugin` with a `register(registration)` function. During registration, a plugin can:

- **Register tools** via `registration.registerTool(...)` — these become callable by the LLM
- **Register prompt fragments** via `registration.registerPromptFragment(...)` — injected into the system prompt as header or footer
- **Register workflows** via `registration.registerWorkflow(...)` — multi-step interactive flows (e.g., `skills.create`, `persona.create`, `bootstrap.project`, `bootstrap.user`)
- **Register slash commands** via `registration.registerSlashCommand(...)` — interactive `/command` handlers
- **Offer capabilities** via `registration.offer(...)` — expose an API to other plugins
- **Request capabilities** via `registration.request<T>(pluginId)` — consume another plugin's API
- **Register help snippets** via `registration.registerHelp(...)`
- **Hook into lifecycle events** via `registration.hooks.onPluginsLoaded(...)`, `onSessionStart(...)`, `onBeforePrompt(...)`, `onAfterToolCall(...)`, `onShutdown(...)`, `onSessionClear(...)`

The plugin engine (`runtime/plugin-engine.ts`) manages all of this. The built-in plugins are listed in `plugins/index.ts`.

### Dynamic Plugin Enabling

The engine supports `enablePlugin(pluginId)` — dynamically enabling and registering a plugin mid-session. This is used by bootstrap workflows to activate recommended plugins immediately after writing config, without requiring a restart. The method:

- Returns `false` if the plugin ID is unknown
- Returns `true` (idempotent) if the plugin is already enabled
- Throws if a non-optional dependency is not enabled
- Registers tools, workflows, hooks, and capabilities
- Runs `onPluginsLoaded` and `onSessionStart` hooks for catch-up

The `--plugin` CLI flag enables plugins for the current session by merging plugin IDs into the `enabledPlugins` config before engine initialization. Supports comma-separated names (`--plugin bootstrap,lsp,git`) and repeated flags.

### Hook Ordering Guarantees

The `onAfterToolCall` hook fires **after tool results have been appended to the session**. This means hooks observe the full session state, including the latest tool results. This ordering is critical for plugins like compaction, which need an accurate view of context usage to decide whether to summarize.

Inside the conversation service's tool-call loop, the order of operations per iteration is:

1. Build system messages and run safety budget check
2. Send messages to the LLM
3. Execute tool calls and buffer results
4. Append tool results to the session manager
5. Run `onAfterToolCall` hooks (compaction, logging, etc.)
6. Continue to next iteration

### Broker + Provider Pattern (Skills & Personas)

Skills and personas use a two-layer architecture:

- **Broker plugin** (`skills`, `persona`) — manages the list of providers, offers the capability, registers tools
- **Provider plugins** (`skill-provider-project`, `skill-provider-user`, `persona-provider-project`, `persona-provider-user`) — read from disk and feed skills/personas to the broker

Providers are sorted by precedence (lower number = higher priority). Duplicate IDs are resolved by the highest-precedence provider.

### Config System

Config cascades: **Project > User > Default** (last-write-wins per key, except `enabledPlugins` which is additive at the project level).

Config files live in `.drone-agent/config.json` at each scope. The config loader (`runtime/config.ts`) walks up the directory tree looking for `.drone-agent/` directories.

Key config sections: `enabledPlugins`, `ollama`, `session`, `lsp`, `mcp`, `compaction`, `memory`, `log`, `promptFile`.

### TUI Architecture

The TUI is built with Ink 5.x (React for CLIs). It renders a four-region layout: chat log (scrollable via `<Static>`), mid panel (widgets), input line (custom multiline), and status bar. The TUI deliberately avoids the alternate screen buffer.

**→ When working on TUI components, recall the `ui-architecture` skill via `skills.recall({"id": "ui-architecture"})` for detailed component tree, theme system, and patterns.**

### Memory System

Project-level memory is stored as JSON files in `.drone-agent/memory/`. Tools: `memory.store`, `memory.recall`, `memory.list`, `memory.search`, `memory.delete`. The memory plugin is opt-in (not enabled by default).

### Insight System

The `self-improvement` plugin records insights about personas, skills, or the project. Insights are stored in `.drone-agent/insights/` (for project/skill) or `.drone-agent/personas/<id>/insights/` (for persona). Use `self-improvement.insight` to log observations during development.

### Workflow System

Workflows are multi-step interactive flows registered by plugins. They receive a `DroneWorkflowContext` with `elicit` (for asking the user questions), `projectDir`, `config`, `requestCapability`, and `enablePlugin` (for dynamically enabling plugins mid-session). Workflows can return a `toolResult` (JSON for the caller) and/or a `kickMessage` (synthetic user message to re-enter the chat loop).

Existing workflows: `skills.create`, `persona.create`, `bootstrap.project`, `bootstrap.user`.

### Bootstrap Plugin

The `bootstrap` plugin provides setup workflows for new projects and users. It is not enabled by default — use `--plugin bootstrap` to enable it.

- **`bootstrap.analyze`** (tool) — Detects project language, framework, build system, and suggests plugins
- **`bootstrap.project`** (workflow) — Interactive project setup: detects project type, suggests plugins, writes config, enables them immediately via `enablePlugin()`
- **`bootstrap.user`** (workflow) — Interactive user setup: probes for LLM providers (Ollama, OpenRouter), configures defaults, writes user config

Future workflows (not yet implemented): `bootstrap.standalone-agent`, `bootstrap.swarm`.

### Macros

Custom slash commands defined in `.macro` files. The `macros` plugin loads them from the project directory. Each macro file defines a command name, description, and a sequence of steps (slash commands and chat prompts).

## Working on the Project

### Adding a new plugin

1. Create a directory under `src/plugins/<name>/` with an `index.ts` that exports a `DronePlugin`
2. Add it to `src/plugins/index.ts` in the `staticBuiltInPlugins` array
3. If it needs dependencies from the engine (like `sessionManager`), add it to `createBuiltInPlugins()` instead
4. Register tools, prompt fragments, workflows, and capabilities in the `register()` function
5. Add tests in `test/`

### Adding a new tool

Call `registration.registerTool({ name, description, inputSchema, execute })` in the plugin's `register()` function. The tool name is scoped to the plugin (e.g., `skills.recall`).

### Adding a new prompt fragment

Call `registration.registerPromptFragment({ key, phase: 'header'|'footer', render })`. The `render` function returns a string or `false` (to hide). Fragments are injected into the system prompt.

### Adding a new workflow

Call `registration.registerWorkflow({ name, description, inputSchema, run })`. The `run` function receives `(input, ctx)` where `ctx` has `elicit`, `projectDir`, `config`, `requestCapability`, and `enablePlugin`.

### Adding a new slash command

Call `registration.registerSlashCommand({ command, description, handler })`. The handler receives a `DroneSlashCommandContext` with the raw line, args, engine, conversation, session manager, and logger.

### Modifying shared types

Shared types live in `drone-core/src/index.ts`. After changing them, run `pnpm build` to recompile both packages.

### Testing patterns

- Unit tests use Vitest
- TUI component tests use `ink-testing-library`
- Plugin tests create a mock `DronePluginRegistration` and call `register()` directly
- Config tests use temporary directories
- See existing tests in `drone-agent/test/` for patterns

### Self-improvement workflow

When working on the project, proactively log insights using `self-improvement.insight`. This is how the project tracks issues, gaps, and opportunities for improvement. Insights are evaluated periodically to identify patterns.

## Key Files to Know

| File                                                  | Purpose                                               |
| ----------------------------------------------------- | ----------------------------------------------------- |
| `drone-agent/src/index.tsx`                           | CLI entry point, arg parsing, first-run setup         |
| `drone-agent/src/runtime/plugin-engine.ts`            | Plugin lifecycle, tool dispatch, workflow execution   |
| `drone-agent/src/runtime/config.ts`                   | Config loading, merging, environment interpolation    |
| `drone-agent/src/runtime/conversation-service.ts`     | LLM conversation loop, tool iteration                 |
| `drone-agent/src/runtime/session-manager.ts`          | Session state, turn tracking                          |
| `drone-agent/src/runtime/context-budget-service.ts`   | Context window budgeting, compaction triggers         |
| `drone-agent/src/tui/app.tsx`                         | Root TUI component                                    |
| `drone-agent/src/plugins/index.ts`                    | Built-in plugin registry                              |
| `drone-agent/src/plugins/bootstrap/index.ts`          | Bootstrap plugin (project/user setup workflows)       |
| `drone-agent/src/plugins/bootstrap/project-detect.ts` | Project detection logic (shared by tool and workflow) |
| `drone-core/src/index.ts`                             | All shared types and config defaults                  |

## Existing Skills

The project has one skill loaded:

- **`ui-architecture`** — Detailed description of the Ink-based TUI architecture. **Recall this when working on any TUI component.**

## Design Principles

- **Minimalist core**: The agent should work with almost nothing enabled. Plugins add functionality.
- **Model-centric**: No hundreds of lines of system prompts. Let the LLM figure it out with tools.
- **Project-first**: Config cascades top-down. Project-level config overrides user-level.
- **Self-dogfooding**: The project should be developed using itself. Use the tools to improve the tools.
