# AGENTS.md — drone-agent

This file describes how to work on the `drone-agent` project itself. The project is a pnpm workspace monorepo.

**If you encounter any discrepancy between this document and the code, the code is the source of truth, and this document should be updated.**

**Aspirational statements should be kept to preserve overall project direction. A statement is aspirational only when all of the following are true:**

1. It uses explicit future-intent language (for example: "will", "planned", "intended", "future", "roadmap") and/or primarily future-tense verbs.
2. It does not claim current behavior.
3. The capability is not implemented in code at all (including no stubs).

If any implementation artifact exists (even a stub), rewrite the statement as current-state factual documentation, including what is incomplete.

If classification is ambiguous, ask for clarification before editing that specific statement.

## Project Structure

| Package                     | Purpose                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `drone-agent/`              | CLI + TUI coding agent (Ink-based). Entry point, plugins, runtime, TUI components.                                                          |
| `drone-core/`               | Shared types, contracts, config defaults, token estimation.                                                                                 |
| `drone-beacon/`             | Local hub for drone swarm (Fastify + SQLite + WebSocket).                                                                                   |
| `drone-coordinator/`        | Global hub for swarm coordination (Fastify + SQLite).                                                                                       |
| `drone-coordinator-ui/`     | Web UI for the coordinator (React + Vite + Tailwind).                                                                                       |
| `drone-swarm-common/`       | Shared utilities for beacon and coordinator.                                                                                                |
| `drone-swarm/`              | Standalone REST CLI for the swarm (session pipeline + wiki).                                                                                |
| `drone-gateway/`            | Chat API gateway (Matrix, Discord, Slack).                                                                                                  |
| `mcp-swarm/`                | Reference swarm extension: exposes swarm functions to MCP clients over stdio.                                                               |
| `drone-extension-ui-types/` | Types-only package: the coordinator UI extension-bundle contract (`PluginClientExport`, `UIRegion`, `UIExtensionApi`, `PluginClientRoute`). |
| `skill-library/`            | Reusable skill `.md` files (not a workspace package).                                                                                       |

Key source directories within `drone-agent/`:

- `src/plugins/` — All built-in plugins, each in its own directory or file
- `src/runtime/` — Plugin engine, config loader, conversation service, session manager
- `src/shared/` — Shared utilities (diff rendering, patch applier, type guards)
- `src/tui/` — Ink-based TUI components (App, ChatLog, InputLine, StatusBar, etc.)
- `test/` — Vitest tests

## Development Commands

| Command                  | Purpose                             |
| ------------------------ | ----------------------------------- |
| `pnpm build`             | Compile all packages                |
| `pnpm typecheck`         | Type-check all packages             |
| `pnpm test`              | Run all tests (vitest)              |
| `pnpm test:watch`        | Watch mode                          |
| `pnpm test:coverage`     | Run tests with coverage             |
| `pnpm test:integration`  | Run integration tests               |
| `pnpm lint`              | ESLint + Prettier                   |
| `pnpm clean`             | Remove all dist/ directories        |
| `pnpm docker:build`      | Build Docker images for smoke test  |
| `pnpm docker:smoke-test` | Run full smoke test suite in Docker |

## Architecture Overview

### Plugin System

Everything is a plugin. Each plugin implements `DronePlugin` with a `register(registration)` function. During registration, a plugin can:

- **Register tools** via `registration.registerTool(...)` — these become callable by the LLM
- **Register prompt fragments** via `registration.registerPromptFragment(...)` — injected into the system prompt as header or footer
- **Register workflows** via `registration.registerWorkflow(...)` — multi-step interactive flows (e.g., `skills__create`, `persona__create`, `bootstrap__project`, `bootstrap__user`)
- **Register slash commands** via `registration.registerSlashCommand(...)` — interactive `/command` handlers
- **Offer capabilities** via `registration.offer(...)` — expose an API to other plugins
- **Request capabilities** via `registration.request<T>(pluginId)` — consume another plugin's API
- **Register help snippets** via `registration.registerHelp(...)`
- **Hook into lifecycle events** via `registration.hooks.onPluginsLoaded(...)`, `onSessionStart(...)`, `onBeforePrompt(...)`, `onAfterToolCall(...)`, `onShutdown(...)`, `onSessionClear(...)`, `onSessionRecycle(...)`, `onSessionSafetyTrimWillRun(...)`, `onSessionSafetyTrimApplied(...)`, `onConversationEvent(...)`

The plugin engine (`runtime/plugin-engine.ts`) manages all of this. The built-in plugins are listed in `plugins/index.ts`.

→ See `docs/agents/dynamic-plugin-enabling.md` for details on `enablePlugin()` and the `--plugin` CLI flag.

### `--debug` CLI Flag

The `--debug` flag enables subsystem-specific debug logging to stderr. Supports comma-separated and repeated flag forms (e.g., `--debug llm,mcp` or `--debug llm --debug mcp`).

→ See `docs/agents/debug-flag.md` for full details, current subsystems, and the data flow.

### Hook Ordering Guarantees

`onAfterToolCall` fires **after tool results have been appended to the session** — critical for compaction's context-usage view. The per-iteration tool-call loop order and the `DroneAfterToolCallPayload` contract live in `docs/agents/hook-ordering.md`.

### Broker + Provider Pattern (Skills & Personas)

Skills and personas use a two-layer architecture:

- **Broker plugin** (`skills`, `persona`) — manages the list of providers, offers the capability, registers tools
- **Provider plugins** (`skill-provider-project`, `skill-provider-user`, `persona-provider-project`, `persona-provider-user`) — read from disk and feed skills/personas to the broker

Providers are sorted by precedence (lower number = higher priority). Duplicate IDs are resolved by the highest-precedence provider.

### Config System

Config files live in `.drone-agent/config.json` at each scope; the loader (`runtime/config.ts`) walks up the directory tree, so project config overrides user config. The `enabledPlugins` override map, the `mergeMaps` rule, and the `search.paths[].ragSource` option are in `docs/agents/config-system.md` (ADR 251, ADR 245). The swarm config underlay (coordinator → beacon → agent, including secrets and reactivity) is in `docs/agents/swarm-plugin.md`.

### TUI Architecture

The TUI is built with Ink 5.x (React for CLIs). It renders a five-region layout: chat log (scrollable via `<Static>`), tail region (live-updating in-flight content), mid panel (widgets), input line (custom multiline), optional elicitation prompt, and status bar. The TUI deliberately avoids the alternate screen buffer.

**→ When working on TUI components, recall the `ui-architecture` skill via `skills.recall({"id": "ui-architecture"})` for detailed component tree, theme system, and patterns.**

### Memory System

Project-level memory is stored as Markdown files with YAML frontmatter in `.drone-agent/memory/`. Tools: `memory__manage` (store/recall/delete actions) and `memory__browse` (list/search actions). The memory plugin is opt-in (not enabled by default).

### Insight System

The `self-improvement` plugin records insights about personas, skills, or the project. Insights are stored in `.drone-agent/insights/` (for project/skill) or `.drone-agent/personas/<id>/insights/` (for persona). For swarm-scoped assets, insights are stored on the owning server (beacon/coordinator) via HTTP storage engines registered by the swarm plugin. Principles are derived from insights and injected into the system prompt via a combined prompt fragment.

Use `self-improvement__insight` to log observations during development.

### Workflow System

Workflows are multi-step interactive flows registered by plugins. They receive a `DroneWorkflowContext` with `elicit` (for asking the user questions), `projectDir`, `config`, `requestCapability`, and `enablePlugin` (for dynamically enabling plugins mid-session). Workflows can return a `toolResult` (JSON for the caller) and/or a `kickMessage` (synthetic user message to re-enter the chat loop).

Existing workflows: `skills__create`, `persona__create`, `bootstrap__project`, `bootstrap__user`.

### Macros

Custom slash commands defined in `.macro` files. The `macros` plugin loads them from the project directory. Each macro file defines a command name, description, and a sequence of steps (slash commands and chat prompts).

### Slash Commands

All slash commands (built-in and plugin-registered) are dispatched through the engine's unified registry; plugin commands take precedence over built-ins, and unrecognized commands error instead of reaching the LLM. The built-in list, `/steer` and `/btw`, the `busyBehavior` deferral contract, and the `--now` escape hatch are documented in `docs/agents/slash-commands.md`.

### Specialized Subsystems

The following subsystems have dedicated documentation in `docs/agents/`:

- **Config System** (`docs/agents/config-system.md`) — `enabledPlugins` override map, `mergeMaps` merge rule, key sections, `search.paths[].ragSource` (ADR 251, ADR 245)
- **Hook Ordering** (`docs/agents/hook-ordering.md`) — the `onAfterToolCall` ordering guarantee, `DroneAfterToolCallPayload` contract, and the per-iteration tool-call loop order
- **Slash Commands** (`docs/agents/slash-commands.md`) — registry/dispatch, `/steer`/`/btw`, the `busyBehavior` deferral contract, and the `--now` escape hatch
- **Reference Expansion** (`docs/agents/reference-expansion.md`) — `@`-references (`@file`, `@skill:`, images, `~/`/cwd, dir/glob) plus TUI tab completion
- **Bootstrap Plugin** (`docs/agents/bootstrap-plugin.md`) — Setup workflows for new projects and users
- **Swarm Plugin** (`docs/agents/swarm-plugin.md`) — Beacon/coordinator integration: swarm-wide personas/skills, the beacon config underlay and secret handling, TLS trust, and the `# Swarm Status`/`# Swarm Identity` fragments
- **Swarm Extensions** (`docs/agents/swarm-extensions.md`) — External services that register as beacons with a capability manifest; the `createExtensionNode` SDK and `mcp-swarm` reference package (ADR 254)
- **External Plugin Loading** (`docs/agents/external-plugin-loading.md`) — User/project-scope plugin discovery, trust model, engine integration
- **MCP Plugin** (`docs/agents/mcp-plugin.md`) — Deferred list/mount via the runtime `ToolRegistry` + `runtime__*` meta-tools, per-server resource/prompt helpers, LLM-generated descriptions, persona filtering
- **Herdr Plugin** (`docs/agents/herdr-plugin.md`) — Agent `idle`/`working` state + session resume command for the Herdr multiplexer (ADR 239)
- **Portable Context** (`docs/agents/portable-context.md`) — Versioned JSON context serialization + brand-new-session continuation; the `checkpoint` plugin and `--output-json` commands (ADR 246/247)
- **Memory Pipeline** (`docs/agents/memory-pipeline.md`) — The session-collection → memory-retrieval pipeline and the opinionated `bootstrap__swarm-memory` default
- **Provider / Model Config** (`docs/agents/provider-model-config.md`) — Protocols (code) vs providers (data) vs models, and the `config.providers` schema
- **Session Import** (`docs/agents/session-import.md`) — The `/swarm-session` import command
- **Import Conventions** (`docs/agents/import-conventions.md`) — Monorepo build/type gotchas (e.g. `.js` imports for `.tsx` siblings)

## Working on the Project

### Adding a new plugin

1. Create a directory under `src/plugins/<name>/` with an `index.ts` that exports a `DronePlugin`
2. Add it to `src/plugins/index.ts` in the `staticBuiltInPlugins` array
3. If it needs dependencies from the engine (like `sessionManager`), add it to `createBuiltInPlugins()` instead
4. Register tools, prompt fragments, workflows, and capabilities in the `register()` function
5. Add tests in `test/`

Plugins can declare optional dependencies via the `optional` field in their metadata (e.g., `{ id: 'self-improvement', optional: true }`). The engine will not throw if an optional dependency is not enabled.

### Adding a new tool

Call `registration.registerTool({ name, description, inputSchema, execute })` in the plugin's `register()` function. The tool name is scoped to the plugin (e.g., `skills__recall`).

### Adding a new prompt fragment

Call `registration.registerPromptFragment({ key, phase: 'header'|'footer', render })`. The `render` function returns a string or `false` (to hide). Fragments are injected into the system prompt.

**Note:** Prompt fragments are sent as separate messages to the LLM, so each fragment should start with a top-level `# Heading` (e.g., `# Skills`, `# Personas`) to clearly delineate sections in the conversation history.

### Adding a new workflow

Call `registration.registerWorkflow({ name, description, inputSchema, run })`. The `run` function receives `(input, ctx)` where `ctx` has `elicit`, `projectDir`, `config`, `requestCapability`, and `enablePlugin`.

`ctx.agent(prompt)` runs one agent-assisted step: a synthetic user turn through the full conversation machinery (tools, guardrails, events) whose final assistant reply is returned as a string. Agent steps share a workflow-scoped ephemeral conversation — they see each other, the main session's history is untouched. `run` may return `continueSession: true` (workflow-owned) to keep the host session alive after completion instead of exiting.

**Kick-message contract:** a workflow's `kickMessage` is an instruction to the agent, not a report to the user — reports belong in `toolResult`. The runner wraps every kickMessage in a standard envelope before injecting it; never pre-append a synthetic turn (sendUserMessage appends its own prompt). See the workflow-system docs for details.

### Adding a new slash command

Call `registration.registerSlashCommand({ command, description, handler })`. The handler receives a `DroneSlashCommandContext` with the raw line, args, engine, conversation, session manager, logger, and optional fields `exit?`, `clearSession?`, and `printHelp?`.

### Modifying shared types

Shared types live in `drone-core/src/index.ts`. After changing them, run `pnpm build` to recompile the workspace.

### Architecture Decision Records

ADRs live in `docs/adr/` (sequential `NNN-slug.md`, 3-digit here — see the `domain-modelling` skill). This is the single home; the project wiki's `decisions/` pages are **pointer stubs** that redirect here so its `[[decisions/…]]` links keep resolving. When a decision is made, write it to `docs/adr/`. Keep the stub in sync if a page moves.

### Testing patterns

- Unit tests use Vitest
- TUI component tests use `ink-testing-library`
- Plugin tests create a mock `DronePluginRegistration` and call `register()` directly
- Config tests use temporary directories
- See existing tests in `drone-agent/test/` for patterns

### Self-improvement workflow

When working on the project, proactively log insights using `self-improvement.insight`. This is how the project tracks issues, gaps, and opportunities for improvement. Insights are evaluated periodically to identify patterns.

## Design Principles

- **Minimalist core**: The agent should work with almost nothing enabled. Plugins add functionality.
- **Model-centric**: No hundreds of lines of system prompts. Let the LLM figure it out with tools.
- **Project-first**: Config cascades top-down. Project-level config overrides user-level.
- **Self-dogfooding**: The project should be developed using itself. Use the tools to improve the tools.
- **Single-user swarm**: The swarm is designed to work with a single human, meaning that all agents in the swarm are expected to be working for the same user. If you are trying to set up coordination between multiple users, you would want to set up separate swarms for each user, and then have each set up to connect to an MCP server that is designed for multi-user coordination.

## Standards

**Ensure the following standards are met before you consider a job "done"**

- LSP must pass. No exceptions for tests, no exceptions for code you're not working on.
- `pnpm run lint` and `pnpm -r run build` must pass with zero errors.
- `pnpm run lint` will run prettier by default, whenever eslint succeeds. Keep two things in mind about this:
  1. **If you run the linter, you will need to re-read all files before attempting to modify them again**, because prettier will reformat them.
  2. You don't need to worry about matching the formatting rules of the project in your changes. Worry about making LSP, typecheck, eslint, and build pass, then prettier will handle the formatting for you.
- The "fast" test suite (`pnpm run test`) must pass. Check the "slow" test suite at your discretion (immediately before opening a pull request is a good time to check it, for example), or when you are told to do so.
- All new code must be covered by unit tests. If you are adding a new feature, you must add tests for it. If you are fixing a bug, you must add a test that reproduces the bug and then fixes it.
- Dead code must be removed. Unused variables must be removed. "Fluff" comments must be removed.
- If a comment isn't jsdoc, then it needs to be explaining a complex process or algorithm. If it is not explaining a complex process or algorithm either, then the only other kind of comment that is allowed is a TODO/FIXME comment. All other comments must be removed.
- Single-word comments indicating the "step" in a process should not be used. Name your functions and variables in a way that makes the step clear. When you encounter these comments, remove them.
- If a file is growing beyond 750 lines, consider splitting it into multiple files. If a file is growing beyond 1000 lines, you must split it into multiple files.
- Be absolutely ruthless when it comes to duplicated code. If you see a pattern emerging, extract it into a function or class. If you see a pattern that is already implemented elsewhere, extract it and use that. If you see any existing duplicated code, refactor it.
- Prefer `node:fs/promises` over sync `node:fs` methods. The project uses ESM throughout, so async `fs` is always available. Sync methods (`readFileSync`, `writeFileSync`, `mkdirSync`, `existsSync`, `accessSync`, etc.) block the event loop and should only be used when there is no practical async alternative (e.g., in a constructor that must be synchronous).

## Special note (for drone-agent working on itself):

If you _are_ drone-agent, know that the "project memory," and all other `.drone-agent` contents besides config.json itself, for this project are _checked into version control intentionally_, so that other users working on the project can share the same library of plans, skills, insights, other project memories and eventually principles. When these files are unstaged, always check them in with your next set of changes. Wait to make your final commit until _after_ you are done logging insights and project memories. If you leave uncommitted memories, skills, insights, or principles, and we are on a feature branch, check them in. Only leave them "hanging" unstaged if we're on the main branch or if we're not on a named branch at all (e.g. detached HEAD). Do not commit them to main.
