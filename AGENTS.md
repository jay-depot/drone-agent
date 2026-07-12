# AGENTS.md — drone-agent

This file describes how to work on the `drone-agent` project itself. The project is a monorepo (pnpm workspace) with seven packages: `drone-agent`, `drone-core`, `drone-beacon`, `drone-coordinator`, `drone-coordinator-ui`, `drone-swarm-common`, and `drone-gateway`.

**If you encounter any discrepancy between this document and the code, the code is the source of truth, and this document should be updated.**

**Aspirational statements should be kept to preserve overall project direction. A statement is aspirational only when all of the following are true:**

1. It uses explicit future-intent language (for example: "will", "planned", "intended", "future", "roadmap") and/or primarily future-tense verbs.
2. It does not claim current behavior.
3. The capability is not implemented in code at all (including no stubs).

If any implementation artifact exists (even a stub), rewrite the statement as current-state factual documentation, including what is incomplete.

If classification is ambiguous, ask for clarification before editing that specific statement.

## Project Structure

**Update this list in this file immediately when you create a new file in the project.**

**If you see a file listed here that does not exist, create a git commit so any mistake can be undone, and then remove the missing file from this list.**

```
drone-agent/          ← The CLI + TUI coding agent (Ink-based)
  src/
    index.tsx         ← Main entry point, CLI arg parsing, first-run setup
    cli.ts            ← CLI argument parsing (--once, --plugin, --workflow, etc.)
    elicitation.ts    ← Readline-based elicitation for plain-output mode
    interactive.ts    ← Interactive loop and JSON mode for non-TUI sessions
    output-handlers.ts← Plain output event handler
    first-run.tsx     ← First-run setup wizard (LLM provider probing)
    lib.ts            ← Public library exports for embedding drone-agent
    migrate.ts        ← Migration workflows (promote/demote skills/personas)
    plugins/          ← All built-in plugins
      anthropic/     ← Anthropic LLM provider
      bootstrap/     ← Bootstrap plugin (project/user setup workflows)
        index.ts      ← Plugin registration, analyze tool, project & user workflows
        project-detect.ts ← Project detection logic (shared by tool and workflow)
      compaction/    ← Context compaction (summary-drop strategy)
      config/        ← Config capability (injectors, rebuild)
      echo/          ← Mock LLM provider for deterministic testing
      git/           ← Git operations (status, diff, log, commit, branch, etc.)
      lightpanda/    ← Lightpanda browser automation MCP integration
      llm/           ← LLM provider broker
      log/           ← Session logging to JSON files
      lsp/           ← LSP server connections
      macros/        ← Custom slash commands from .macro files
      mcp/           ← MCP client (stdio and streamable HTTP)
      memory/        ← Project-level memory (JSON files)
      notepad.ts     ← Session notepad (included in system prompt)
      ollama.ts      ← Ollama LLM provider
      openai/        ← OpenAI LLM provider
      openrouter/    ← OpenRouter LLM provider
      persona/       ← Persona broker plugin
      persona-provider-project/ ← Project-level persona provider
      persona-provider-user/    ← User-level persona provider
      prompt-file/   ← Prompt file injection
      search.ts      ← Text search (ripgrep/grep)
      self-improvement/ ← Insight and principle system
      skill-provider-project/  ← Project-level skill provider
      skill-provider-user/     ← User-level skill provider
      skills/        ← Skills broker plugin
      startup.ts     ← Startup banner and status tool
      subagent/      ← Subagent spawning
      swarm/         ← Swarm plugin (beacon/coordinator integration)
      terminal/      ← Terminal emulator plugin
      todo.ts        ← TODO list management
      utils.ts       ← Utility tools (arithmetic, counting, spelling)
      exec.ts        ← Shell command execution
      external-loader.ts ← External plugin discovery, loading, trust management
      fetch.ts       ← HTTP fetch tool
      file.ts        ← File read/write/glob/diff tools
      focus.ts       ← Session focus management
    runtime/          ← Plugin engine, config loader, conversation service, session manager
      plugin-engine.ts
      builtin-commands.ts  ← Built-in slash command definitions
      config.ts
      conversation-service.ts
      session-manager.ts
      context-budget-service.ts
      token-estimator.ts
      migration/     ← Migration helpers (backup, promote, demote, wiki, etc.)
    shared/           ← Shared utilities
      diff-renderer.ts
      exec-async.ts
      openai-compatible.ts
      patch-applier.ts
      type-guards.ts
      unified-diff-parser.ts
    tui/              ← Ink-based TUI (App, ChatLog, InputLine, StatusBar, etc.)
      app.tsx
      index.tsx
      theme.tsx
      types.ts
      elicitation.ts
      components/
        AssistantMessageBlock.tsx
        ChatLog.tsx
        ElicitationPrompt.tsx
        GitDiffBlock.tsx
        InputLine.tsx
        Markdown.tsx
        MidPanel.tsx
        ModelPicker.tsx
        MultilineTextInput.tsx
        ReasoningBlock.tsx
        StatusBar.tsx
        TailRegion.tsx
        ToolCallProgress.tsx
      hooks/
        useChatLog.ts
        useColorOverrides.ts
        useDebouncedWindowSize.ts
        useElicitation.ts
        useLlmIndicator.ts
        useStatusBar.ts
        useTailRegion.ts
      shared/
        format.ts
  test/               ← Vitest tests
drone-core/           ← Shared types, contracts, config defaults, token estimation
  src/
    index.ts          ← Re-exports all public types
    config-types.ts   ← DroneAgentConfig, PartialDroneAgentConfig, defaults
    config-schema.ts  ← JSON schema parsing and validation
    session-types.ts  ← Session, message, tool, and token types
    plugin-system.ts  ← DronePlugin, DronePluginRegistration, workflows, slash commands
    capabilities.ts   ← Capability registry types (config, skills, LLM, principles)
    provider-types.ts ← Provider types for brokers
    skill-types.ts    ← Skill definition types
    persona-types.ts  ← Persona definition and capability types
    domain-types.ts   ← Domain types for beacon/coordinator
    lsp-types.ts      ← LSP server types
    mcp-types.ts      ← MCP server types
    wiki-types.ts     ← Wiki page types
    token-estimate.ts ← Token estimation functions
    utils.ts          ← Utility functions
  test/
drone-beacon/         ← Local hub for drone swarm (Fastify + SQLite + WebSocket)
  src/
    index.ts          ← Server entry point, CLI arg parsing
    routes/           ← Domain-specific route files
      index.ts        ← Route registration assembly
      context.ts      ← Shared state, setters, proxy helpers
      health.ts       ← GET /health
      personas.ts     ← Persona CRUD
      skills.ts       ← Skill CRUD
      agents.ts       ← Agent session management
      memory.ts       ← Memory CRUD
      messages.ts     ← Inter-agent messaging
      spawn.ts        ← Agent spawn management
      config.ts       ← Config override CRUD
      events.ts       ← Event log
      insights.ts     ← Insight CRUD (with coordinator proxy)
      principles.ts   ← Principle CRUD (with coordinator proxy)
      wiki.ts         ← Wiki page CRUD (with coordinator proxy)
      sync.ts         ← Coordinator sync trigger
    ws-server.ts      ← WebSocket server for agent messaging
    db/               ← SQLite database layer (split by domain)
      index.ts
      init.ts
      agents.ts
      config.ts
      event-log.ts
      insights.ts
      knowledge.ts
      memory.ts
      messages.ts
      personas.ts
      principles.ts
      skills.ts
      spawns.ts
    coordinator-client.ts ← HTTP client to drone-coordinator
    spawner.ts        ← Agent process spawning
    identity.ts       ← Ed25519 keypair identity
    types.ts          ← Internal types
    logger.ts         ← Pino logger
  test/               ← Vitest tests
drone-coordinator/    ← Global hub for swarm coordination (Fastify + SQLite)
  src/
    index.ts          ← Server entry point, CLI arg parsing
    routes/           ← Domain-specific route files
      index.ts        ← Route registration assembly
      health.ts       ← GET /health
      personas.ts     ← Persona CRUD
      skills.ts       ← Skill CRUD
      beacons.ts      ← Beacon registration, trust, approval, sessions
      knowledge.ts    ← Knowledge CRUD + search + sync
      insights.ts     ← Insight CRUD
      principles.ts   ← Principle CRUD
      wiki.ts         ← Wiki page CRUD
      swarm.ts        ← Swarm sessions, events, agent locations
      messages.ts     ← Cross-beacon message relay and broadcast
      spawn.ts        ← Agent spawn management across beacons
    db/               ← SQLite database layer (split by domain)
      index.ts
      init.ts
      agent-locations.ts
      beacon-sessions.ts
      beacon-trust.ts
      beacons.ts
      insights.ts
      knowledge.ts
      personas.ts
      principles.ts
      skills.ts
      swarm-sessions.ts
      web-token.ts
    storage.ts        ← Storage layer
    web-auth.ts       ← Web UI authentication
    ws-pubsub.ts      ← WebSocket pub/sub for live updates
    types.ts          ← Internal types
    logger.ts         ← Pino logger
  test/               ← Vitest tests
drone-coordinator-ui/ ← Web UI for the coordinator (React + Vite + Tailwind)
  src/
    main.tsx
    App.tsx
    components/
    hooks/
    pages/
    lib/
drone-swarm-common/   ← Shared utilities for beacon and coordinator
  src/
    index.ts
    db-helpers.ts
    logger.ts
    spawner.ts
    tls.ts
    wiki-storage.ts
  test/
drone-gateway/        ← Chat API gateway (Matrix, Discord, Slack) — in testing
  src/
    index.ts
    engine.ts
    adapters/
    store/
    config/
    coordinator-client.ts
    coordinator-spawn-backend.ts
    local-spawn-backend.ts
    spawn-backend.ts
    markdown.ts
    cleanup.ts
    types.ts
    logger.ts
    which.ts
  test/
skill-library/        ← Reusable skill .md files (not a workspace package)
```

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
- **Hook into lifecycle events** via `registration.hooks.onPluginsLoaded(...)`, `onSessionStart(...)`, `onBeforePrompt(...)`, `onAfterToolCall(...)`, `onShutdown(...)`, `onSessionClear(...)`, `onSessionSafetyTrimWillRun(...)`, `onSessionSafetyTrimApplied(...)`, `onConversationEvent(...)`

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

Config cascades: **Default → User → Project** (last-write-wins per key, except `enabledPlugins` which is additive at the project level). When the swarm plugin is active, beacon and coordinator config values are injected as additional underlays via the `DroneConfigInjector` capability, not through the file-based config loader. Config injectors are priority-ordered: System Defaults (0) → Coordinator (50) → Beacon (75) → Agent Local (100).

Config files live in `.drone-agent/config.json` at each scope. The config loader (`runtime/config.ts`) walks up the directory tree looking for `.drone-agent/` directories.

Key config sections: `enabledPlugins`, `systemPrompt`, `activePersona`, `llm`, `ollama`, `openrouter`, `session`, `lsp`, `mcp`, `compaction`, `memory`, `log`, `promptFile`, `swarm`.

### TUI Architecture

The TUI is built with Ink 5.x (React for CLIs). It renders a five-region layout: chat log (scrollable via `<Static>`), tail region (live-updating in-flight content), mid panel (widgets), input line (custom multiline), optional elicitation prompt, and status bar. The TUI deliberately avoids the alternate screen buffer.

**→ When working on TUI components, recall the `ui-architecture` skill via `skills.recall({"id": "ui-architecture"})` for detailed component tree, theme system, and patterns.**

### Memory System

Project-level memory is stored as JSON files in `.drone-agent/memory/`. Tools: `memory__store`, `memory__recall`, `memory__list`, `memory__search`, `memory__delete`. The memory plugin is opt-in (not enabled by default).

### Insight System

The `self-improvement` plugin records insights about personas, skills, or the project. Insights are stored in `.drone-agent/insights/` (for project/skill) or `.drone-agent/personas/<id>/insights/` (for persona). For swarm-scoped assets, insights are stored on the owning server (beacon/coordinator) via HTTP storage engines registered by the swarm plugin. Principles are derived from insights and injected into the system prompt via a combined prompt fragment.

Use `self-improvement__insight` to log observations during development.

### Workflow System

Workflows are multi-step interactive flows registered by plugins. They receive a `DroneWorkflowContext` with `elicit` (for asking the user questions), `projectDir`, `config`, `requestCapability`, and `enablePlugin` (for dynamically enabling plugins mid-session). Workflows can return a `toolResult` (JSON for the caller) and/or a `kickMessage` (synthetic user message to re-enter the chat loop).

Existing workflows: `skills__create`, `persona__create`, `bootstrap__project`, `bootstrap__user`.

### Bootstrap Plugin

The `bootstrap` plugin provides setup workflows for new projects and users. It is not enabled by default — use `--plugin bootstrap` to enable it.

- **`bootstrap__analyze`** (tool) — Detects project language, framework, build system, and suggests plugins
- **`bootstrap__project`** (workflow) — Interactive project setup: detects project type, suggests plugins, writes config, enables them immediately via `enablePlugin()`
- **`bootstrap__user`** (workflow) — Interactive user setup: probes for LLM providers (Ollama, OpenRouter), configures defaults, writes user config

Future workflows (not yet implemented): `bootstrap__standalone-agent`, `bootstrap__swarm`.

### Macros

Custom slash commands defined in `.macro` files. The `macros` plugin loads them from the project directory. Each macro file defines a command name, description, and a sequence of steps (slash commands and chat prompts).

### Swarm Plugin

The `swarm` plugin connects to a `drone-beacon` instance to provide swarm-wide personas, skills, and config injection. It registers persona and skill providers at both the beacon and coordinator precedence levels, provides a WebSocket-based messaging channel for inter-agent communication, registers HTTP storage engines for swarm-scoped insights and principles, registers wiki tools (`wiki_read`, `wiki_write`, `wiki_search`, `wiki_list`, `wiki_delete`, `wiki_lint`), and pushes conversation events to the coordinator. The swarm plugin is not enabled by default.

### External Plugin Loading

External plugins can be loaded from well-known directories at both user scope
(`~/.drone-agent/plugins/`) and project scope (`<project>/.drone-agent/plugins/`).
Each plugin is a directory named `<plugin-id>/` containing at minimum an `index.js`
(or `.mjs`) that exports a `DronePlugin` object (either as the default export or
as a named export `plugin`).

**User-scope plugins** are loaded silently — the user owns their own config.
**Project-scope plugins** require user trust on first encounter. Trust decisions
are persisted to `~/.drone-agent/trusted-plugins.json` (user-scoped, so a project
cannot push its own trust).

The trust prompt offers three options:

- **Yes, trust it** — loads the plugin now and on future starts
- **No, skip this time** — skips the plugin for this session only
- **No, and don't ask again** — marks the plugin as untrusted, skipped forever

If the config directory is overridden via `--config-dir`, the user plugins
directory follows (e.g., `--config-dir /custom/path` → `/custom/path/.drone-agent/plugins/`).

**Key files:**

- `drone-agent/src/plugins/external-loader.ts` — discovery, loading, trust management
- `drone-agent/src/runtime/plugin-engine.ts` — `addExternalPlugin()` method
- `drone-core/src/config-types.ts` — `externalPlugins`, `trustedPlugins` config fields

**Engine integration:**
External plugins are discovered before engine creation. User and trusted project
plugins are merged with built-in plugins and passed to `createDronePluginEngine()`.
Deferred project plugins are prompted for after elicitation is set up, then added
via `engine.addExternalPlugin()`.

In non-interactive modes (`--once`, `--output-json`), deferred plugins are
silently skipped.

### MCP Plugin (Deferred Tool Loading)

The MCP plugin uses a **deferred list/mount pattern** for tool loading. When an
MCP server connects, its individual tools are NOT mounted as native LLM tool
definitions. Instead, three meta-tools are mounted per server:

- **`<serverId>__list_tools`** — Returns tool names and descriptions (no schemas).
  The LLM calls this to browse available tools.
- **`<serverId>__mount_tool`** — Dynamically registers a specific tool with its
  full JSON schema as a native tool definition. The LLM calls this after
  discovering a tool it wants to use via `__list_tools`.
- **`<serverId>__unmount_tool`** — Removes a previously mounted tool from the
  active tool list.

This bounds context cost to 3 meta-tools per server regardless of how many tools
the server offers. Real-world MCP servers like Datadog (142 tools, ~70K tokens)
or MCP_DOCKER (135 tools, ~126K tokens) can otherwise consume most of the
context window with tool definitions alone.

Resources, prompts, and resource templates are still mounted eagerly (they do
not have the same context cost profile as tool definitions).

The `allowedTools` allowlist is enforced by `__mount_tool` — `__list_tools`
shows all tools, but mounting a non-allowlisted tool throws an error.

When the server sends `notifications/tools/list_changed`, the plugin surgically
updates the per-server tool cache and unmounts any tools that no longer exist on
the server (without nuking all MCP plugin tools across all servers).

The `unregisterTool(canonicalName)` method on the plugin engine is used for
single-tool removal, complementing the existing `unregisterPluginTools(pluginId)`
for bulk removal.

**Long-term vision**: If this pattern works well for MCP, it may be expanded
globally to all tools (not just MCP) to bound context cost across the entire
tool surface.

### Slash Commands

All slash commands (built-in and plugin-registered) are dispatched through the engine's unified registry. Built-in commands (`/exit`, `/quit`, `/help`, `/clear`, `/plugins`, `/tools`, `/systemprompt`, `/tool`, `/exec`) have lower precedence than plugin commands, allowing plugins to override them. Unrecognized slash commands display an error instead of being sent to the LLM. The `?` alias for `/help` has been removed.

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

### Adding a new slash command

Call `registration.registerSlashCommand({ command, description, handler })`. The handler receives a `DroneSlashCommandContext` with the raw line, args, engine, conversation, session manager, logger, and optional fields `exit?`, `clearSession?`, and `printHelp?`.

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
| `drone-agent/src/index.tsx`                           | CLI entry point, first-run setup, engine init         |
| `drone-agent/src/cli.ts`                              | CLI argument parsing                                  |
| `drone-agent/src/elicitation.ts`                      | Readline-based elicitation for plain-output mode      |
| `drone-agent/src/interactive.ts`                      | Interactive loop and JSON mode for non-TUI sessions   |
| `drone-agent/src/output-handlers.ts`                  | Plain output event handler                            |
| `drone-agent/src/first-run.tsx`                       | First-run setup wizard (LLM provider probing)         |
| `drone-agent/src/lib.ts`                              | Public library exports for embedding drone-agent      |
| `drone-agent/src/migrate.ts`                          | Migration workflows (promote/demote)                  |
| `drone-agent/src/runtime/plugin-engine.ts`            | Plugin lifecycle, tool dispatch, workflow execution   |
| `drone-agent/src/runtime/builtin-commands.ts`         | Built-in slash command definitions                    |
| `drone-agent/src/runtime/config.ts`                   | Config loading, merging, environment interpolation    |
| `drone-agent/src/runtime/conversation-service.ts`     | LLM conversation loop, tool iteration                 |
| `drone-agent/src/runtime/session-manager.ts`          | Session state, turn tracking                          |
| `drone-agent/src/runtime/context-budget-service.ts`   | Context window budgeting, compaction triggers         |
| `drone-agent/src/tui/app.tsx`                         | Root TUI component                                    |
| `drone-agent/src/plugins/index.ts`                    | Built-in plugin registry                              |
| `drone-agent/src/plugins/bootstrap/index.ts`          | Bootstrap plugin (project/user setup workflows)       |
| `drone-agent/src/plugins/bootstrap/project-detect.ts` | Project detection logic (shared by tool and workflow) |
| `drone-agent/src/plugins/swarm/index.ts`              | Swarm plugin (beacon/coordinator integration)         |
| `drone-agent/src/plugins/subagent/plugin.ts`          | Subagent spawning plugin                              |
| `drone-agent/src/plugins/macros/index.ts`             | Macros plugin (.macro file loading)                   |
| `drone-agent/src/plugins/self-improvement/index.ts`   | Insight and principle system                          |
| `drone-agent/src/plugins/startup.ts`                  | Startup banner and status tool                        |
| `drone-agent/src/plugins/focus.ts`                    | Session focus management                              |
| `drone-agent/src/plugins/lightpanda/index.ts`         | Lightpanda browser automation MCP integration         |
| `drone-agent/src/plugins/ollama.ts`                   | Ollama LLM provider                                   |
| `drone-agent/src/plugins/anthropic/index.ts`          | Anthropic LLM provider                                |
| `drone-agent/src/plugins/openai/index.ts`             | OpenAI LLM provider                                   |
| `drone-agent/src/plugins/openrouter/index.ts`         | OpenRouter LLM provider                               |
| `drone-agent/src/plugins/echo/index.ts`               | Mock LLM provider for deterministic testing           |
| `drone-agent/src/plugins/exec.ts`                     | Shell command execution                               |
| `drone-agent/src/plugins/external-loader.ts`          | External plugin discovery, loading, trust management  |
| `drone-agent/src/plugins/fetch.ts`                    | HTTP fetch tool                                       |
| `drone-agent/src/plugins/file.ts`                     | File read/write/glob/diff tools                       |
| `drone-agent/src/plugins/git/index.ts`                | Git status/diff/commit/log tools                      |
| `drone-agent/src/plugins/search.ts`                   | Text search (ripgrep/grep)                            |
| `drone-agent/src/plugins/todo.ts`                     | TODO list management                                  |
| `drone-agent/src/plugins/utils.ts`                    | Utility tools (arithmetic, counting, spelling)        |
| `drone-agent/src/plugins/notepad.ts`                  | Session notepad                                       |
| `drone-agent/src/plugins/terminal/index.ts`           | Terminal emulator plugin                              |
| `drone-agent/src/plugins/prompt-file/index.ts`        | Prompt file injection                                 |
| `drone-agent/src/plugins/compaction/index.ts`         | Context compaction (summary-drop strategy)            |
| `drone-agent/src/plugins/config/index.ts`             | Config capability (injectors, rebuild)                |
| `drone-agent/src/plugins/log/index.ts`                | Session logging to JSON files                         |
| `drone-agent/src/plugins/memory/index.ts`             | Project-level memory (JSON files)                     |
| `drone-agent/src/plugins/persona/index.ts`            | Persona broker plugin                                 |
| `drone-agent/src/plugins/skills/index.ts`             | Skills broker plugin                                  |
| `drone-agent/src/plugins/llm/index.ts`                | LLM provider broker                                   |
| `drone-agent/src/plugins/mcp/index.ts`                | MCP client (stdio and streamable HTTP)                |
| `drone-agent/src/plugins/lsp/plugin.ts`               | LSP server connections                                |
| `drone-core/src/index.ts`                             | All shared types and config defaults                  |
| `drone-core/src/config-types.ts`                      | DroneAgentConfig, PartialDroneAgentConfig, defaults   |
| `drone-core/src/config-schema.ts`                     | JSON schema parsing and validation                    |
| `drone-core/src/plugin-system.ts`                     | DronePlugin, DronePluginRegistration, workflows       |
| `drone-core/src/capabilities.ts`                      | Capability registry types                             |
| `drone-core/src/session-types.ts`                     | Session, message, tool, and token types               |
| `drone-core/src/provider-types.ts`                    | Provider types for brokers                            |
| `drone-core/src/skill-types.ts`                       | Skill definition types                                |
| `drone-core/src/persona-types.ts`                     | Persona definition and capability types               |
| `drone-core/src/domain-types.ts`                      | Domain types for beacon/coordinator                   |
| `drone-core/src/lsp-types.ts`                         | LSP server types                                      |
| `drone-core/src/mcp-types.ts`                         | MCP server types                                      |
| `drone-core/src/wiki-types.ts`                        | Wiki page types                                       |
| `drone-core/src/token-estimate.ts`                    | Token estimation functions                            |
| `drone-core/src/utils.ts`                             | Utility functions                                     |
| `drone-beacon/src/routes/index.ts`                    | Beacon route registration assembly                    |
| `drone-beacon/src/db/index.ts`                        | Beacon database layer                                 |
| `drone-coordinator/src/routes/index.ts`               | Coordinator route registration assembly               |
| `drone-coordinator/src/db/index.ts`                   | Coordinator database layer                            |
| `drone-coordinator/src/storage.ts`                    | Coordinator storage layer                             |
| `drone-coordinator/src/web-auth.ts`                   | Web UI authentication                                 |
| `drone-coordinator/src/ws-pubsub.ts`                  | WebSocket pub/sub for live updates                    |
| `drone-swarm-common/src/tls.ts`                       | Shared TLS certificate management                     |
| `drone-swarm-common/src/wiki-storage.ts`              | Shared wiki filesystem management                     |

## Design Principles

- **Minimalist core**: The agent should work with almost nothing enabled. Plugins add functionality.
- **Model-centric**: No hundreds of lines of system prompts. Let the LLM figure it out with tools.
- **Project-first**: Config cascades top-down. Project-level config overrides user-level.
- **Self-dogfooding**: The project should be developed using itself. Use the tools to improve the tools.
- **Single-user swarm**: The swarm is designed to work with a single human, meaning that all agents in the swarm are expected to be working for the same user. If you are trying to set up coordination between multiple users, you would want to set up separate swarms for each user, and then have each set up to connect to an MCP server that is designed for multi-user coordination.

## Standards

**Ensure the following standards are met before you consider a job "done"**

- LSP must pass. No exceptions for tests, no exceptions for code you're not working on.
- `pnpm -r run lint` and `pnpm -r run build` must pass with zero errors.
- `pnpm -r run lint` will run prettier by default, whenever eslint succeeds. Keep two things in mind about this:
  1. **If you run the linter, you will need to re-read all files before attempting to modify them again**, because prettier will reformat them.
  2. You don't need to worry about matching the formatting rules of the project in your changes. Worry about making LSP, typecheck, eslint, and build pass, then prettier will handle the formatting for you.
- The "fast" test suite (`pnpm -r run test`) must pass. Check the "slow" test suite at your discretion, or when you are told to do so.
- All new code must be covered by unit tests. If you are adding a new feature, you must add tests for it. If you are fixing a bug, you must add a test that reproduces the bug and then fixes it.
- Dead code must be removed. Unused variables must be removed. "Fluff" comments must be removed.
- If a comment isn't jsdoc, then it needs to be explaining a complex process or algorithm. If it is not explaining a complex process or algorithm either, then the only other kind of comment that is allowed is a TODO/FIXME comment. All other comments must be removed.
- Single-word comments indicating the "step" in a process should not be used. Name your functions and variables in a way that makes the step clear. When you encounter these comments, remove them.
- If a file is growing beyond 750 lines, consider splitting it into multiple files. If a file is growing beyond 1000 lines, you must split it into multiple files.
- Be absolutely ruthless when it comes to duplicated code. If you see a pattern emerging, extract it into a function or class. If you see a pattern that is already implemented elsewhere, extract it and use that. If you see any existing duplicated code, refactor it.
