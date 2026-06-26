# drone-agent

CLI worker that embodies a persona and executes tasks. This is the interface users interact with directly.

## Language

**Session**:
A single invocation of the drone-agent CLI. Starts when the agent starts, ends when it exits. Stateless — all state is persisted to persona or memory.
_Avoid_: Run, instance, worker

**Persona**:
A persistent identity that carries knowledge, preferences, and history across sessions. Gets embodied by a session agent to perform work.
_Avoid_: Identity, profile, user, character

**Skill**:
A reusable capability that can be recalled during a session based on conversation context. Attached to a persona or available globally.
_Avoid_: Tool, capability, feature, action

**Plugin**:
An extension that provides capabilities to the agent (LLM providers, MCP servers, LSP servers, etc.). Plugins register tools, prompts, and hooks.
_Avoid_: Extension, addon, module

**Turn**:
A single round in the conversation between the agent and the LLM. Contains a user message (or tool result), the LLM response, and optionally tool calls.
_Avoid_: Round, exchange, message

**Tool**:
A function the LLM can invoke to interact with the outside world (file system, shell, git, etc.). Exposed to the LLM via its tool definition.
_Avoid_: Command, action, function, capability

**Tool Call**:
An invocation of a tool by the LLM, including the tool name and arguments.
_Avoid_: Tool invocation, command execution

**Message**:
A single contribution to the conversation. Has a role (system, user, assistant, tool) and content.
_Avoid_: Prompt, request, response

**System Prompt**:
The base instruction set that defines the agent's behavior and personality. Can be overridden by persona.
_Avoid_: Base prompt, default prompt, instructions

**Persona Provider**:
A source that provides personas (project directory, user home, beacon, coordinator). Providers are sorted by precedence.
_Avoid_: Persona source, persona store

**Skill Provider**:
A source that provides skills. Providers are sorted by precedence; lower number wins for conflicts.
_Avoid_: Skill source, skill store

**Config Injector**:
A hook that provides config values as an underlay. Lower precedence = runs first (underlay), higher = runs last (overlay).
_Avoid_: Config provider, config source