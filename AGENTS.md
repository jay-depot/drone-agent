# AGENTS.md — drone-agent

This file describes how to work on the `drone-agent` project itself. The project is a monorepo (pnpm workspace) with eight packages.

**If you encounter any discrepancy between this document and the code, the code is the source of truth, and this document should be updated.**

**Aspirational statements should be kept to preserve overall project direction. A statement is aspirational only when all of the following are true:**

1. It uses explicit future-intent language (for example: "will", "planned", "intended", "future", "roadmap") and/or primarily future-tense verbs.
2. It does not claim current behavior.
3. The capability is not implemented in code at all (including no stubs).

If any implementation artifact exists (even a stub), rewrite the statement as current-state factual documentation, including what is incomplete.

If classification is ambiguous, ask for clarification before editing that specific statement.

## Project Structure

The project is a pnpm workspace with seven packages:

| Package                 | Purpose                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `drone-agent/`          | CLI + TUI coding agent (Ink-based). Entry point, plugins, runtime, TUI components. |
| `drone-core/`           | Shared types, contracts, config defaults, token estimation.                        |
| `drone-beacon/`         | Local hub for drone swarm (Fastify + SQLite + WebSocket).                          |
| `drone-coordinator/`    | Global hub for swarm coordination (Fastify + SQLite).                              |
| `drone-coordinator-ui/` | Web UI for the coordinator (React + Vite + Tailwind).                              |
| `drone-swarm-common/`   | Shared utilities for beacon and coordinator.                                       |
| `drone-swarm/`          | `drone-swarm` CLI: standalone REST client for session pipeline + wiki.             |
| `drone-gateway/`        | Chat API gateway (Matrix, Discord, Slack).                                         |
| `skill-library/`        | Reusable skill `.md` files (not a workspace package).                              |

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
| `pnpm test:integration`  | Run integration tests in Docker     |
| `pnpm lint`              | ESLint + Prettier                   |
| `pnpm clean`             | Remove all dist/ directories        |
| `pnpm docker:build`      | Build Docker images for smoke test  |
| `pnpm docker:smoke-test` | Run full smoke test suite in Docker |

Integration tests that talk to the beacon/coordinator are expected to run only inside the isolated Docker swarm provisioned by `pnpm test:integration`. Running the integration Vitest config directly on the host is not the supported path for swarm tests.

The swarm integration tests and `drone-agent/test/subagent/dispatch.test.ts` include provisioning guards:

- They require `RUN_INTEGRATION_TESTS=true`
- They refuse unsafe `localhost:3457` / `localhost:3456` fallbacks outside the provisioned environment
- If the provisioned test swarm is unreachable, they skip rather than touching a user's real local beacon/coordinator

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

→ See `docs/agents/dynamic-plugin-enabling.md` for details on `enablePlugin()` and the `--plugin` CLI flag.

### `--debug` CLI Flag

The `--debug` flag enables subsystem-specific debug logging to stderr. Supports comma-separated and repeated flag forms (e.g., `--debug llm,mcp` or `--debug llm --debug mcp`).

→ See `docs/agents/debug-flag.md` for full details, current subsystems, and the data flow.

### Hook Ordering Guarantees

The `onAfterToolCall` hook fires **after tool results have been appended to the session**. This means hooks observe the full session state, including the latest tool results. This ordering is critical for plugins like compaction, which need an accurate view of context usage to decide whether to summarize.

Inside the conversation service's tool-call loop, the order of operations per iteration is:

1. Build system messages and run safety budget check
2. Send messages to the LLM
3. Execute tool calls and buffer results
4. Append tool results to the session manager
5. Run `onAfterToolCall` hooks (compaction, logging, etc.)
6. Continue to next iteration

### Plugin Observability — Emit Events for Background Work

Any plugin that performs background maintenance (compaction, safety trimming, index refresh, cache eviction, sync pulls, etc.) **must emit `DroneConversationEvent` events** so the TUI can surface progress in the tail region and commit entries to scrollback. Silent background work is indistinguishable from broken background work.

The compaction plugin demonstrates the pattern:

```typescript
// In plugin registration, receive the optional emitter:
const emitEvent = deps.emitEvent;

// Emit at each phase of a background operation:
emitEvent?.({
  kind: 'compaction',
  message: 'Compacting 4 turn(s)...',
  status: 'started',
});

try {
  await doCompaction();
  emitEvent?.({
    kind: 'compaction',
    message: 'Compacted 4 turn(s)',
    status: 'completed',
  });
} catch (error) {
  emitEvent?.({
    kind: 'compaction',
    message: `Compaction failed: ${error.message}`,
    status: 'failed',
  });
  throw error;
}
```

The TUI (`src/tui/app.tsx`) renders any `DroneConversationEvent` with a recognized `kind` in both the live tail region and the committed scrollback. Adding a new event kind requires:

1. Add the kind to the `DroneConversationEvent` union in `drone-core/src/index.ts`
2. Add a color in `src/tui/theme.tsx` (e.g., `compaction: 'cyan'`, `notice: 'yellow'`)
3. Add a case in `src/tui/app.tsx` to render the message

**Rule of thumb**: If a plugin mutates session state without a user command, it must emit at least `started` and `completed`/`failed` events. The latch bug in compaction (Decision 053) went undetected for weeks partly because the plugin was observability-free — no events meant no visible signal that it had stopped firing.

### Guardrail System

The conversation service includes built-in guardrails that detect and mitigate common LLM reliability issues. These are configured under `session.guardrail` in the config:

| Setting                            | Default | Purpose                                                                |
| ---------------------------------- | ------- | ---------------------------------------------------------------------- |
| `brokenResponses.hintAfter`        | 2       | Number of empty/reasoning-only responses before phase 1 retries        |
| `brokenResponses.maxHints`         | 2       | Max number of system-hint retries (phase 2) before hard limit          |
| `reasoningOnlyResponses.hintAfter` | 4       | Same as `brokenResponses` but for reasoning-only responses             |
| `reasoningOnlyResponses.maxHints`  | 2       | Same as `brokenResponses` but for reasoning-only responses             |
| `identicalToolCalls.hintAfter`     | 2       | Number of identical single-tool-call iterations before nudging         |
| `identicalToolCalls.maxHints`      | 3       | Max nudges before hard limit (total iterations = hintAfter + maxHints) |

**Broken responses** (Feature 1): When the LLM produces an empty response or a reasoning-only response, the conversation service retries without appending the degenerate response to the session. After `hintAfter` silent retries, it injects a non-persisted system hint. After `hintAfter + maxHints` total attempts, it prompts the user via `onBrokenResponseLimitReached`.

**Identical tool-call streak** (Feature 2): When the LLM repeatedly makes the exact same single tool call (same name and arguments), the service tracks a streak counter. After `hintAfter` repetitions, it injects a non-persisted nudge message. After `hintAfter + maxHints` total repetitions, it prompts the user via `onIdenticalToolCallLimitReached` or throws an error.

**Assistant text before tool calls** (Feature 3): When an LLM response includes both text and tool calls, the `assistantMessage` and `assistantMessageComplete` events are emitted before the `toolCallBatch` event, so the TUI can show the text immediately.

All guardrail state (broken-response counter, identical-call streak, nudge flags) is reset when:

- A new user message enters the conversation loop
- `conversation.resetStuckDetectors()` is called
- `conversation.clearSession()` is called

Guardrail events use the `notice` event kind (rendered in yellow/italic in the TUI, and prefixed with ⚠ in plain-text mode).

### Broker + Provider Pattern (Skills & Personas)

Skills and personas use a two-layer architecture:

- **Broker plugin** (`skills`, `persona`) — manages the list of providers, offers the capability, registers tools
- **Provider plugins** (`skill-provider-project`, `skill-provider-user`, `persona-provider-project`, `persona-provider-user`) — read from disk and feed skills/personas to the broker

Providers are sorted by precedence (lower number = higher priority). Duplicate IDs are resolved by the highest-precedence provider.

### Config System

Config cascades: **Default → User → Project** (last-write-wins per key, except `enabledPlugins` which is additive at the project level). When the swarm plugin is active, beacon and coordinator config values are injected as additional underlays via the `DroneConfigInjector` capability, not through the file-based config loader. Config injectors are priority-ordered: System Defaults (0) → Coordinator (50) → Beacon (75) → Agent Local (100).

Config files live in `.drone-agent/config.json` at each scope. The config loader (`runtime/config.ts`) walks up the directory tree looking for `.drone-agent/` directories.

Key config sections: `enabledPlugins`, `systemPrompt`, `activePersona`, `providers` (user-defined LLM providers; banned at project scope), `llm` (active selection + reasoning), legacy `ollama`/`openai`/`anthropic`/`openrouter` (migration window only — migrated into `providers` and persisted to the file on first load), `session`, `lsp`, `mcp`, `compaction`, `memory`, `log`, `promptFile`, `swarm`.

→ See `docs/agents/provider-model-config.md` for the provider/protocol/model model, parameters, secrets, scopes, and migration.

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

### Macros

Custom slash commands defined in `.macro` files. The `macros` plugin loads them from the project directory. Each macro file defines a command name, description, and a sequence of steps (slash commands and chat prompts).

### Slash Commands

All slash commands (built-in and plugin-registered) are dispatched through the engine's unified registry. Built-in commands (`/exit`, `/quit`, `/help`, `/clear`, `/plugins`, `/tools`, `/systemprompt`, `/tool`, `/exec`) have lower precedence than plugin commands, allowing plugins to override them. Unrecognized slash commands display an error instead of being sent to the LLM. The `?` alias for `/help` has been removed.

### Specialized Subsystems

The following subsystems have dedicated documentation in `docs/agents/`:

- **Bootstrap Plugin** (`docs/agents/bootstrap-plugin.md`) — Setup workflows for new projects and users
- **Swarm Plugin** (`docs/agents/swarm-plugin.md`) — Beacon/coordinator integration for swarm-wide personas, skills, and config
- **Session Import** (`docs/agents/session-import.md`) — `/swarm-session` command for recreating an old session's context
- **Memory Pipeline** (`docs/agents/memory-pipeline.md`) — Config files, session-end triggers, drone-swarm CLI, beacon outbox
- **External Plugin Loading** (`docs/agents/external-plugin-loading.md`) — User and project-scope plugin discovery, trust model, engine integration
- **MCP Plugin** (`docs/agents/mcp-plugin.md`) — Deferred list/mount pattern for tool loading, `ToolMountingCache`, server descriptions, persona filtering

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

## Design Principles

- **Minimalist core**: The agent should work with almost nothing enabled. Plugins add functionality.
- **Model-centric**: No hundreds of lines of system prompts. Let the LLM figure it out with tools.
- **Project-first**: Config cascades top-down. Project-level config overrides user-level.
- **Self-dogfooding**: The project should be developed using itself. Use the tools to improve the tools.
- **Single-user swarm**: The swarm is designed to work with a single human, meaning that all agents in the swarm are expected to be working for the same user. If you are trying to set up coordination between multiple users, you would want to set up separate swarms for each user, and then have each set up to connect to an MCP server that is designed for multi-user coordination.

## Standards

**Ensure the following standards are met before you consider a job "done"**

- LSP must pass. No exceptions for tests, no exceptions for code you're not working on.
- `pnpm lint` (root-level script) and `pnpm -r run build` must pass with zero errors.
- `pnpm lint` will run prettier by default, whenever eslint succeeds. Keep two things in mind about this:
  1. **If you run the linter, you will need to re-read all files before attempting to modify them again**, because prettier will reformat them.
  2. You don't need to worry about matching the formatting rules of the project in your changes. Worry about making LSP, typecheck, eslint, and build pass, then prettier will handle the formatting for you.
- The "fast" test suite (`pnpm test`) must pass. Check the "slow" test suite at your discretion (immediately before opening a pull request is a good time to check it, for example), or when you are told to do so.
- All new code must be covered by unit tests. If you are adding a new feature, you must add tests for it. If you are fixing a bug, you must add a test that reproduces the bug and then fixes it.
- Dead code must be removed. Unused variables must be removed. "Fluff" comments must be removed.
- If a comment isn't jsdoc, then it needs to be explaining a complex process or algorithm. If it is not explaining a complex process or algorithm either, then the only other kind of comment that is allowed is a TODO/FIXME comment. All other comments must be removed.
- Single-word comments indicating the "step" in a process should not be used. Name your functions and variables in a way that makes the step clear. When you encounter these comments, remove them.
- If a file is growing beyond 750 lines, consider splitting it into multiple files. If a file is growing beyond 1000 lines, you must split it into multiple files.
- Be absolutely ruthless when it comes to duplicated code. If you see a pattern emerging, extract it into a function or class. If you see a pattern that is already implemented elsewhere, extract it and use that. If you see any existing duplicated code, refactor it.
- Prefer `node:fs/promises` over sync `node:fs` methods. The project uses ESM throughout, so async `fs` is always available. Sync methods (`readFileSync`, `writeFileSync`, `mkdirSync`, `existsSync`, `accessSync`, etc.) block the event loop and should only be used when there is no practical async alternative (e.g., in a constructor that must be synchronous).

## Special note (for drone-agent working on itself):

If you _are_ drone-agent, know that the "project memory," and all other `.drone-agent` contents besides config.json itself, for this project are _checked into version control intentionally_, so that other users working on the project can share the same library of plans, skills, insights, other project memories and eventually principles. When these files are unstaged, always check them in with your next set of changes. Wait to make your final commit until _after_ you are done logging insights and project memories. If you leave uncommitted memories, skills, insights, or principles, and we are on a feature branch, check them in. Only leave them "hanging" unstaged if we're on the main branch or if we're not on a named branch at all (e.g. detached HEAD). Do not commit them to main.
