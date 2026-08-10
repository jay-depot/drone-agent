---
key: plan-persona-level-tool-premounting
tags:
  - plan
  - persona
  - tool-premount
  - list-mount
  - feature
created: 2026-08-10T02:30:29.742Z
updated: 2026-08-10T02:30:29.742Z
---

# Plan: Persona-Level Tool Pre-mounting

## Summary

Add a `premountedTools` field to persona definitions so that on every persona change, the persona broker plugin (a) unmounts all currently-mounted non-`runtime__*` tools and (b) automatically mounts the newly-active persona's premounted tools. Premounting a `defaultHidden` tool makes it visible to the LLM even if it is absent from `allowedTools`, with a low-priority `registration.logger.warn` so the user knows to reconcile the two lists.

Out of scope (deliberately deferred, record as principle): a tool-level `autoMount` flag on `DroneToolDefinition`. The "none" persona's automount list is just the hardcoded `runtime__*` meta-tools for now.

## Key facts learned during exploration

- Tool mount state lives in `ToolRegistry` (drone-core/src/tool-registry.ts), owned by the engine in `createDronePluginEngine` (drone-agent/src/runtime/plugin-engine.ts). Tools start unmounted; only `runtime__list_tools/mount_tool/unmount_tool` are auto-mounted in `registerRuntimeMetaTools()`.
- Mounted list is read at prompt time via `engine.listTools()` (`toolRegistry.listMounted()`) in `conversation-service.ts` `getLlmTools()`, filtered by the persona capability's `getFilteredTools()`.
- Persona changes funnel through `notifyChange()` in drone-agent/src/plugins/persona/index.ts (the single choke point for `activatePersona` activate/clear, the `persona.select` tool "none" branch, `reloadPersonas` re-activation, and session-start activation). Every persona change calls `notifyChange()`.
- The persona plugin already has `registration.mountTool`/`unmountTool` but no way to enumerate mounted tools.
- Persona `.md` frontmatter is parsed by a simple line-by-line state machine in drone-agent/src/plugins/persona/loader.ts (scalars + flat arrays for `tools`/`skills`/`fragments`; no nested-object support yet).
- `DronePersonaDefinition` lives in drone-core/src/persona-types.ts; `DronePluginRegistration` in drone-core/src/plugin-system.ts; the engine builds the registration object in `registerPlugin`.

## Files to modify

1. drone-core/src/persona-types.ts — add `premountedTools?: Record<string, string[]>` to `DronePersonaDefinition` (nested map: `{ pluginId: [toolName, ...] }`).
2. drone-core/src/plugin-system.ts — add `listMountedTools: () => DroneToolDescriptor[]` to `DronePluginRegistration`.
3. drone-agent/src/runtime/plugin-engine.ts — implement `listMountedTools` in the registration object inside `registerPlugin`: `listMountedTools: () => toolRegistry.listMounted()`.
4. drone-agent/src/plugins/persona/loader.ts — extend the frontmatter parser to parse the nested map-of-arrays `premountedTools:` block. Recommend refactoring the mini state machine to also handle a nested `premountedTools:` map. Format:
   ```
   premountedTools:
     file:
       - read
       - list
       - apply_diff
     git:
       - commit
   ```
   Store as `definition.premountedTools = { file: ['read','list','apply_diff'], git: ['commit'] }`.
5. drone-agent/src/plugins/persona/index.ts:
   - Add `applyToolPremount()` invoked at the top of `notifyChange()` (sync — all mount/unmount/list primitives are sync):
     ```ts
     function applyToolPremount(): void {
       for (const tool of registration.listMountedTools()) {
         if (!tool.name.startsWith('runtime__')) registration.unmountTool(tool.name);
       }
       const premount = activePersona?.premountedTools;
       if (!premount) return;
       for (const [pluginId, toolNames] of Object.entries(premount)) {
         for (const toolName of toolNames) {
           const canonical = `${pluginId}__${toolName}`;
           const def = registration.mountTool(canonical);
           if (!def) {
             registration.logger.warn(`premountedTools: unknown tool "${canonical}"`);
             continue;
           }
           if (def.defaultHidden && !allowedToolsMatches(canonical)) {
             registration.logger.warn(
               `premountedTools: "${canonical}" is defaultHidden and not in allowedTools; it will still be visible because premounted. Add it to allowedTools or remove the premount.`
             );
           }
         }
       }
     }
     ```
     `allowedToolsMatches(canonical)` = `activePersona.allowedTools` matches the canonical name via `filterByGlobPatterns`, or is absent (then default-hidden layer applies → warn).
   - Update `getFilteredTools()` to union premounted canonical names so premounted tools stay visible:
     ```ts
     const premountedNames = new Set(expandPremountedCanonical());
     // no activePersona / no allowedTools branch:
     return allTools.filter(t => !t.defaultHidden || premountedNames.has(t.name));
     // allowedTools branch:
     return allTools.filter(t => filteredSet.has(t.name) || premountedNames.has(t.name));
     ```
   - (Nice-to-have) surface `premountCount` in the `persona.list` tool response.
6. drone-agent/src/plugins/persona/wizard.ts — teach `buildPersonaSystemPrompt()` about the `premountedTools:` frontmatter format so `persona.create` can emit it.
7. drone-agent/src/plugins/persona-provider-user/index.ts and persona-provider-project/index.ts — no code change needed (they use `loadPersonasFromDir`); only touched if loader tests require fixture updates.

## Tests

- drone-agent/test/persona-loader.test.ts — add a describe block for `premountedTools`:
  - parses the nested map into `Record<string, string[]>`.
  - leaves `premountedTools` undefined when omitted.
  - coexists with `tools`/`skills`/`fragments` in one file.
- drone-agent/test/persona-select.test.ts (or new persona-premount.test.ts) — using the real engine + persona plugin:
  - activating a persona mounts its premounted tools (assert via `engine.listTools()` includes `file__read` etc.).
  - switching persona unmounts the previous persona's premounted tools and mounts the new one's.
  - clearing persona (`select none`) unmounts everything non-runtime, leaving only `runtime__*`.
  - `runtime__*` tools remain mounted across a persona change.
  - session-start activation premounts (via `onSessionStart` hook).
  - premounting a `defaultHidden` tool (e.g. `terminal__create`) makes it visible via `getFilteredTools` even when not in `allowedTools`.
  - `registration.logger.warn` fires for a premounted unknown tool, and for a premounted defaultHidden tool not in allowedTools (assert via a logger spy or captured log).
- drone-agent/test/plugin-engine.test.ts — add a test that the registration exposes `listMountedTools()` reflecting `toolRegistry` mount state (mount a tool via `runtime__mount_tool`, assert it appears; unmount, assert it disappears).

## Validation criteria

1. LSP passes — no type errors in persona-types.ts, plugin-system.ts, plugin-engine.ts, persona/index.ts, loader.ts, wizard.ts, or the test files.
2. `pnpm -r run build` passes — all packages compile.
3. `pnpm -r run lint` passes — eslint + prettier (note: `pnpm lint` full prettier is known to fail on a pre-existing malformed `.drone-agent/insights/project/drone-agent.json`; changed files must pass prettier).
4. `pnpm -r run test` passes — all existing tests plus the new premount/loader/listMountedTools regression tests.
5. Manual verification: with a persona that declares `premountedTools`, switching to it (via `/persona select` or the `persona.select` tool) mounts only those tools + `runtime__*`; clearing leaves only `runtime__*`; a premounted defaultHidden tool is visible to the LLM and a warning is logged.

## Principles to record

- Prefer `listMountedTools()` over `unmountAllNonRuntimeTools()` as the engine primitive — more broadly reusable. Unmount-all logic belongs in the caller (the persona plugin), iterating `listMountedTools()` and filtering `runtime__*` itself.
- Tool-level `autoMount` on `DroneToolDefinition` is intentionally NOT introduced now; if/until a forced use case arises, the "none" persona's automount list is just the `runtime__*` meta-tools. Revisit "other auto-mount tools merge into the persona automount list" if autoMount is ever added.