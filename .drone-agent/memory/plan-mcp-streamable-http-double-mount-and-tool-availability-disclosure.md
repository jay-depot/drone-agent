---
key: plan-mcp-streamable-http-double-mount-and-tool-availability-disclosure
tags:
  - plan
  - mcp
  - bug-fix
  - planning
created: 2026-10-13T16:34:13.752Z
updated: 2026-10-13T16:34:13.752Z
---

# Plan: Fix MCP `streamable_http` double-mount crash + add tool-availability disclosure

**Status:** Ready for execution · **ADR to write:** `docs/adr/252-mcp-double-mount-and-tool-availability-disclosure.md`
**Planned by:** plan persona, 2026-10-13 · **Executed by:** `code` persona

## 1. Feature summary and motivation

A `streamable_http` MCP server can mount its tools twice on connect, which throws
`Tool already registered` from the engine guard and aborts the `drone-agent`
process via an unhandled promise rejection. The crash is intermittent (depends on
SSE stream timing). `stdio` servers are unaffected.

Fix the crash (idempotent, serialized per-server mount; callbacks split so an
initial connect never fires the remount path; fire-and-forget callbacks caught),
and — because the same reconnect/list-change churn can silently remove tools the
model has already been using — add a **core-level, engine-owned disclosure** that
tells the model which previously-available tools are gone and whether they can be
brought back. Finally, improve the `mount an already-mounted tool` message so it
stops reading as a failure.

Root-cause reference (swarm wiki, coordinator scope, confirmed against current
code): `drone-agent-mcp-streamable-http-double-mount-race`.

## 2. Root cause (verified in the current tree)

Two mount paths race for the same `streamable_http` server, and the mount is not
idempotent:

- `drone-agent/src/plugins/mcp/client.ts`
  - `:1230` wires `onStreamReconnected: options.onReconnected`.
  - `:764` fires `options.onStreamReconnected?.()` the moment the GET SSE stream
    opens — i.e. on the **first** connect, not a real reconnect. This is the
    trigger `stdio` lacks.
  - `:1499` fires `options.onReconnected?.()` at the end of the initial connect
    (both transports) — redundant with the caller's own mount.
  - `:1421` fires `options.onReconnected?.()` on a **stdio child respawn** (a
    genuine reconnect: the child restarted, so its tool list may differ).
  - All three are fire-and-forget with no `.catch`.
- `drone-agent/src/plugins/mcp/index.ts`
  - `:583` the caller independently runs `await listAndMountTools(serverId, connection, serverConfig, 'ready')` after `createMcpClientConnection` resolves.
  - `:545` `onReconnected` unregisters `serverToolMaps` entries then calls
    `listAndMountTools(..., 'reconnected')`.
  - `~:289` `listAndMountTools` calls `registration.registerTool(toolDef)` for
    every discovered tool with **no prior unregistration** → not idempotent.
- `drone-agent/src/runtime/plugin-engine.ts:779` `registerTool` throws
  `Tool already registered: <canonicalName>` on a duplicate.
- Because `onReconnected` is invoked fire-and-forget from the transport, the throw
  escapes as an unhandled rejection → Node aborts the process.
- **Latent second bug:** `onReconnected`'s unmount loop walks only
  `serverToolMaps` (the MCP tools), never the `mcp__<server>__list` /
  `mcp__<server>__get` resource/prompt helpers registered by
  `registerResourcePromptTools`. So a _genuine_ reconnect re-registers those and
  collides on them too.

## 3. Design decisions (locked during planning)

- **D1 — Initial connect never fires the remount path.** There is no
  `onConnected` callback today; the initial mount is the caller's explicit
  `listAndMountTools(..., 'ready')`. Remove the connect-end `onReconnected` fire
  (`client.ts:1499`) and stop pointing the SSE stream-open hook at
  `onReconnected` (`client.ts:1230`).
- **D2 — Callbacks split by meaning.**
  - `onStreamOpened?: () => void` — the GET SSE (server→client notification)
    channel opened/reopened. The plugin only flips `state.streaming = true` and
    clears `state.lastStreamError`. **Never remounts.**
  - `onReconnected?: () => void | Promise<void>` — a transport reconnect that may
    have changed the tool surface. Fired **only** on a stdio child respawn.
    The plugin reconciles tools here.
  - Both fire-and-forget sites get a `.catch` so a future failure degrades to a
    log line instead of aborting the process.
- **D3 — Idempotent, surgical reconcile replaces blanket unregister+remount.**
  Rename `listAndMountTools` → `reconcileServerTools`. It diffs the previously
  registered set (from `serverToolMaps`) against the freshly listed set and:
  - **unregisters only** tools that vanished (and frees their sanitized names),
  - **registers only** tools that appeared,
  - **leaves persisting tools completely untouched** (no re-register, so their
    engine mount state is preserved).
    Resource/prompt helpers (`__list`/`__get`) are registered **once per server**
    via a per-server flag, so no reconnect can re-register them.
    A no-op reconcile (the common case) changes nothing.
- **D4 — Per-server serialization.** All reconcile call sites (initial mount,
  stdio respawn, `list_changed`) are wrapped in a **keyed promise chain** so
  overlapping triggers queue. It is a **serializing chain, not a coalescer**: a
  `notifications/tools/list_changed` arriving mid-reconcile must re-list
  _afterwards_ (the list did change), not be dropped. Primitive: generalize the
  existing `shared/file-lock.ts` into `shared/keyed-lock.ts` exporting
  `withKeyLock` (key `mcp:<serverId>`).
- **D5 — Core-level, engine-owned tool-availability disclosure.** The engine
  tracks `everMounted` (every canonical tool name ever successfully mounted) and
  renders `everMounted − currentlyMounted` as an engine-owned **footer**
  fragment, merged into the single trailing `<system-reminder>` message per
  ADR 207. It renders `false` when empty. Sticky (survives turns) but
  non-growing history, and self-heals when a tool returns. This is deliberately
  _not_ a one-shot system reminder (the model re-tries dead tools once it
  scrolls out — the failure ADR 246 documented) and _not_ a stored turn
  (ADR 246's cost).
- **D6 — Per-entry annotation, derived at render from registry membership.**
  - name still registered (`getTool(name)` defined) →
    `(Automatically unmounted, mount again if needed)`
  - name gone from the registry →
    `(Removed from available set, do not attempt to call or mount again)`
- **D7 — Suppression is per-operation, opt-out, default announce.** The engine's
  removal primitives take `{ announce?: boolean }` (default `true`).
  - `runtime__unmount_tool` (the model unmounted it itself) → `announce: false`
    (its name is removed from `everMounted`, so it never appears).
  - `/tool unmount` and `/tool unmount --all` (operator) → **announce**.
  - persona `applyToolPremount`, MCP unregister/reconcile → **announce**.
  - Global kill-switch: `session.announceToolRemovals` (boolean, default `true`).
- **D8 — Human-facing notice.** When the unavailable set gains names, emit one
  coalesced `notice` conversation event (`[N tool(s) became unavailable]`) so the
  operator sees it in the TUI. Coalesced at flush time over the _net_ delta, so a
  bulk unmount+remount that nets to zero is silent.
- **D9 — `mount` on an already-mounted tool is a success.** Both
  `runtime__mount_tool` (returns `{ success: true, alreadyMounted: true, message }`)
  and `/tool mount` (logs `Already mounted <name>.`) detect the already-mounted
  case via `ToolRegistry.get` + `isMounted` (engine) / `listMountedTools` (slash
  context) — no new registry API needed.

## 4. Execution steps

Assigned agent types: `coder` (implementation), `tester` (tests), `reviewer`
(review). Order is dependency-driven; steps 1 and 2 are independent.

### Step 1 — `coder` · drone-core: `session.announceToolRemovals` config (blocks 3)

- `drone-core/src/config-types.ts`: add to `DroneSessionConfig`:
  ```ts
  /**
   * When true (default), the engine discloses tools that were mounted earlier
   * in the session but are no longer available, via a footer prompt fragment.
   * Set false to silence the disclosure entirely.
   */
  announceToolRemovals?: boolean;
  ```
  Add `announceToolRemovals: true` to the `session` block of
  `createDefaultAgentConfig`'s `base`. It is a scalar boolean — no `deepMerge`
  entry needed.
- `drone-core/src/config-schema.ts`: add `announceToolRemovals:
Type.Optional(Type.Boolean())` to the `session: Type.Object({...})` block.
- Run `pnpm -r run build` (drone-core resolves via built `dist/`).

### Step 2 — `coder` · drone-agent: generalize the keyed lock (blocks 6)

- Create `drone-agent/src/shared/keyed-lock.ts`; move the body of
  `shared/file-lock.ts` there and rename the generic function:
  ```ts
  const queues = new Map<string, Promise<unknown>>();

  export async function withKeyLock<T>(
    key: string,
    task: () => Promise<T>
  ): Promise<T> {
    const prev = queues.get(key) ?? Promise.resolve();
    const run = prev.then(task, task);
    queues.set(key, run);
    try {
      return await run;
    } finally {
      if (queues.get(key) === run) queues.delete(key);
    }
  }

  export function withPathLock<T>(
    filePath: string,
    task: () => Promise<T>
  ): Promise<T> {
    return withKeyLock(path.resolve(filePath).toLowerCase(), task);
  }
  ```
- Delete `drone-agent/src/shared/file-lock.ts`.
- Update the 3 importers:
  - `plugins/file.ts` — import `withPathLock` from `../shared/keyed-lock.js`.
  - `plugins/self-improvement/file-engine.ts` — `withFileLock` → `withKeyLock`,
    import from `../../shared/keyed-lock.js`.
  - `plugins/mcp/server-description.ts` — import `withPathLock` from
    `../../shared/keyed-lock.js`.

### Step 3 — `coder` · drone-agent: engine-owned disclosure + mount tracking (depends on 1; blocks 4, 6, 8)

In `drone-agent/src/runtime/plugin-engine.ts`:

1. Add state near `const systemReminders = new SystemReminderQueue();`:
   ```ts
   const everMountedTools = new Set<string>();
   let lastNotifiedUnavailable = new Set<string>();
   let unavailableNoticePending = false;
   ```
2. Add a single mount wrapper and route **every** mount through it:
   ```ts
   function mountTracked(
     canonicalName: string
   ): DroneToolDefinition | undefined {
     const def = toolRegistry.mount(canonicalName);
     if (def) {
       everMountedTools.add(canonicalName);
       logToolChange('mount', canonicalName);
     }
     return def;
   }
   ```
   Use it in: `registration.mountTool`, the engine `mountTool` return member, the
   `runtime__mount_tool` meta-tool, and the portable-context capability's
   `mountTool` dep. (Persona premount reaches `registration.mountTool`.)
3. Add an unmount wrapper with the announce flag:
   ```ts
   function unmountTracked(
     canonicalName: string,
     opts?: { announce?: boolean }
   ): void {
     toolRegistry.unmount(canonicalName);
     logToolChange('unmount', canonicalName);
     if (opts?.announce === false) {
       everMountedTools.delete(canonicalName);
     } else {
       scheduleUnavailableNotice();
     }
   }
   ```
   Route `registration.unmountTool` and the engine `unmountTool` member through
   it with default announce. Call it as
   `unmountTracked(name, { announce: false })` from `runtime__unmount_tool`.
4. Add the coalesced notice + disclosure computer:
   ```ts
   function computeUnavailableTools(): string[] {
     const mounted = new Set(toolRegistry.listMounted().map(t => t.name));
     return [...everMountedTools]
       .filter(name => !mounted.has(name))
       .sort((a, b) => {
         // registry-removed first (do-not-call), then auto-unmounted, each alphabetical
         const aGone = !toolRegistry.get(a),
           bGone = !toolRegistry.get(b);
         if (aGone !== bGone) return aGone ? -1 : 1;
         return a.localeCompare(b);
       });
   }

   function scheduleUnavailableNotice(): void {
     if (unavailableNoticePending) return;
     unavailableNoticePending = true;
     queueMicrotask(() => {
       unavailableNoticePending = false;
       const current = new Set(computeUnavailableTools());
       const gained = [...current].filter(n => !lastNotifiedUnavailable.has(n));
       lastNotifiedUnavailable = current;
       if (gained.length > 0) {
         dispatchConversationEvent({
           kind: 'notice',
           content: `[${gained.length} tool(s) became unavailable]`,
         }).catch(err => logger.error(`disclosure notice failed: ${err}`));
       }
     });
   }
   ```
5. Register the engine-owned footer fragment (place it after plugin registration
   so it renders **last**), e.g. alongside `registerRuntimeMetaTools()`:
   ```ts
   promptFragments.push({
     key: 'unavailable-tools',
     phase: 'footer',
     render: async () => {
       if (config.session.announceToolRemovals === false) return false;
       const unavailable = computeUnavailableTools();
       if (unavailable.length === 0) return false;
       const CAP = 20;
       const shown = unavailable.slice(0, CAP);
       const lines = shown.map(name =>
         toolRegistry.get(name)
           ? `- ${name} (Automatically unmounted, mount again if needed)`
           : `- ${name} (Removed from available set, do not attempt to call or mount again)`
       );
       const extra = unavailable.length - shown.length;
       if (extra > 0)
         lines.push(
           `- …and ${extra} more (call runtime__list_tools for the current set)`
         );
       return `# Unavailable tools\n\nThe following tools were available earlier in the session but are no longer available.\n\n${lines.join('\n')}`;
     },
   });
   ```
6. Reset on the session boundary: in `clearSession()` (or the clear path) add
   `everMountedTools.clear(); lastNotifiedUnavailable = new Set();`. Match the
   existing `systemReminders.clear()` location.

### Step 4 — `coder` · drone-agent: already-mounted is a success (independent)

- `drone-agent/src/runtime/plugin-engine.ts`, `runtime__mount_tool.execute`:
  distinguish the three cases and keep **`Unknown tool`** only for the truly
  unknown case:
  ```ts
  if (!toolRegistry.get(toolName)) {
    return JSON.stringify(
      {
        success: false,
        error: `Unknown tool: ${toolName}. Use runtime__list_tools to see available tools.`,
      },
      null,
      2
    );
  }
  if (toolRegistry.isMounted(toolName)) {
    return JSON.stringify(
      {
        success: true,
        tool: toolName,
        alreadyMounted: true,
        message: `${toolName} was already mounted.`,
      },
      null,
      2
    );
  }
  const result = mountTracked(toolName); // see Step 3
  return JSON.stringify(
    { success: true, tool: toolName, description: result?.description },
    null,
    2
  );
  ```
- `drone-agent/src/runtime/builtin-commands.ts`, `/tool mount` handler:
  ```ts
  const alreadyMounted =
    ctx.engine.listMountedTools?.().some(t => t.name === name) ?? false;
  if (alreadyMounted) {
    ctx.logger.info(`Already mounted ${name}.`);
    return true;
  }
  const def = ctx.engine.mountTool(name);
  if (!def) ctx.logger.error(`Unknown tool: ${name}`);
  else ctx.logger.info(`Mounted ${name}.`);
  ```

### Step 5 — `coder` · drone-agent: MCP client callback split (blocks 6)

In `drone-agent/src/plugins/mcp/client.ts`:

- Rename the stream-open option `onStreamReconnected?: () => void` →
  `onStreamOpened?: () => void`.
- Change the connection option to `onReconnected?: () => void | Promise<void>`
  and add `onStreamOpened?: () => void`.
- In `createMcpClientConnection`'s streamable-http branch, wire
  `onStreamOpened: options.onStreamOpened` (**not** `onReconnected`).
- In `openGetStream`, keep firing at the successful-open point (line ~764) but
  as `options.onStreamOpened?.()`.
- **Delete** the connect-end `options.onReconnected?.();` (line ~1499).
- Guard the remaining fire-and-forget hook (stdio respawn, line ~1421) with a
  catch:
  ```ts
  void Promise.resolve(options.onReconnected?.()).catch(err =>
    options.logger.warn(
      `mcp ${options.serverId} onReconnected failed: ${err instanceof Error ? err.message : String(err)}`
    )
  );
  ```

### Step 6 — `coder` · drone-agent: MCP plugin reconcile (depends on 2, 3, 5)

In `drone-agent/src/plugins/mcp/index.ts`:

- Import `withKeyLock` from `../../shared/keyed-lock.js`.
- Add `const registeredResourceServers = new Set<string>();` next to the other
  per-server maps.
- Rename `listAndMountTools` → `reconcileServerTools` and make it surgical
  (parameter names/signature unchanged: `(serverId, connection, serverConfig, logMessage)`):
  ```ts
  const oldMap =
    serverToolMaps.get(serverId) ??
    new Map<string, { definition: DroneToolDefinition; mounted: boolean }>();
  const usedNames = serverUsedNames.get(serverId) ?? new Set<string>();
  const newMap = new Map<
    string,
    { definition: DroneToolDefinition; mounted: boolean }
  >();

  const newNames = new Set(tools.map(t => t.name));
  for (const [oldName, entry] of oldMap) {
    if (!newNames.has(oldName)) {
      registration.unregisterTool(`mcp__${entry.definition.name}`);
      usedNames.delete(entry.definition.name);
    }
  }
  for (const tool of tools) {
    const existing = oldMap.get(tool.name);
    if (existing) {
      newMap.set(tool.name, existing);
      continue;
    } // preserve: no re-register
    const mountedName = `${serverId}__${sanitizeToolSegment(tool.name, usedNames)}`;
    const toolDef: DroneToolDefinition = {/* as today */};
    registration.registerTool(toolDef);
    newMap.set(tool.name, { definition: toolDef, mounted: false });
  }
  serverToolMaps.set(serverId, newMap);
  serverUsedNames.set(serverId, usedNames);
  serverAllowlists.set(serverId, allowedToolSet);

  if (!registeredResourceServers.has(serverId)) {
    registerResourcePromptTools(serverId, connection);
    registeredResourceServers.add(serverId);
  }
  // state counts + log line as today
  ```
  Keep the existing `getOrCreateServerDescription` call (cache hit after the
  first connect).
- Replace `handleToolsListChanged`'s inline unregister/re-register block with a
  keyed reconcile call:
  ```ts
  await withKeyLock(`mcp:${serverId}`, () =>
    reconcileServerTools(
      serverId,
      connection,
      serverConfigRef,
      'tools list changed'
    )
  );
  ```
  (Its current signature has no `serverConfig`; pass the per-server config that
  the loop already closes over, or key the reconcile by server and look the
  config up from `mcpConfig.servers[serverId]`. Preserve the fire-and-forget
  `.catch` on the caller at `onNotification`.)
- `onReconnected` becomes:
  ```ts
  const onReconnected = async (): Promise<void> => {
    if (!connection) return;
    await withKeyLock(`mcp:${serverId}`, () =>
      reconcileServerTools(serverId, connection, serverConfig, 'reconnected')
    );
  };
  ```
  (No manual unregister loop — reconcile diffs for it.)
- Add `onStreamOpened`:
  ```ts
  const onStreamOpened = (): void => {
    if (!connection) return;
    connection.state.streaming = true;
    connection.state.lastStreamError = undefined;
    setServerState(connection.state);
  };
  ```
  Pass it through `createMcpClientConnection({ ..., onStreamOpened })`.
- Initial mount: `await withKeyLock(`mcp:${serverId}`, () => reconcileServerTools(serverId, connection, serverConfig, 'ready'))`.
- Make the initial `onPluginsLoaded` per-server `try/catch` still mark a failed
  server `error` (unchanged), but the reconcile itself must not be able to leave
  a half-registered map: because reconcile preserves the old map on any thrown
  error before `serverToolMaps.set`, add a guard note in the code comments.

### Step 7 — `tester` · tests (depends on 3, 4, 6)

- **drone-core:** `test/config.test.ts` — `announceToolRemovals` parses; omitted
  → default `true`; `false` accepted.
- **keyed lock:** new `drone-agent/test/keyed-lock.test.ts` — same-key tasks
  serialize in order; different-key tasks run concurrently; a rejected task does
  not poison the chain.
- **engine disclosure:** new `drone-agent/test/tool-availability-disclosure.test.ts`
  (or extend `plugin-engine.test.ts`):
  - mount `test__alpha` then `unmountTool` it → footer fragment contains
    `# Unavailable tools` + `test__alpha (Automatically unmounted, mount again if needed)`.
  - `unregisterTool` a mounted tool → `(Removed from available set, do not attempt to call or mount again)`.
  - re-mount → fragment renders `false` (absent).
  - `runtime__unmount_tool` → **not** listed.
  - `config.session.announceToolRemovals = false` → never listed.
  - > 20 unavailable → cap line `…and K more`.
  - a `notice` event fires once for a burst of removals and is silent for a
    net-zero unmount+remount.
- **already-mounted:** update `drone-agent/test/mcp.test.ts` "runtime__mount_tool
  is idempotent" to assert `success: true`, `alreadyMounted: true`, message
  `<name> was already mounted.`; keep "rejects a non-existent tool name"
  asserting `success:false` + `Unknown`. Split
  `drone-agent/test/builtin-commands.test.ts`'s "unknown or already-mounted"
  case into an unknown case (error `Unknown tool: <name>`) and an
  already-mounted case (info `Already mounted <name>.`). Grep for remaining
  `Unknown or already mounted` assertions and update all of them.
- **MCP callback contract:** `drone-agent/test/mcp-client.test.ts` — assert
  `onStreamOpened` fires when the GET stream opens while `onReconnected` does
  **not** fire from a streamable-http connect.
- **MCP reconcile idempotency:** `drone-agent/test/mcp.test.ts` — call the
  server's mount path twice (e.g. invoke a `list_changed` after connect) and
  assert no throw and a stable tool count; assert `mcp__<server>__list`/`__get`
  are registered exactly once.

### Step 8 — `coder` · docs (depends on 5, 6)

- Update `docs/agents/mcp-plugin.md`: replace the reconnect/list-change
  description with the callback split (`onStreamOpened` vs `onReconnected`), the
  idempotent `reconcileServerTools` diff, the once-per-server resource/prompt
  helper registration, and the per-server `withKeyLock` serialization.
- Write `docs/adr/252-mcp-double-mount-and-tool-availability-disclosure.md`
  covering: the double-mount root cause; D1–D9; the rejected alternatives
  (relaxing the engine duplicate guard; a one-shot reminder; a stored-turn
  disclosure — cf. ADR 246; a coalescing in-flight guard); and the new
  `session.announceToolRemovals` config.

### Step 9 — `reviewer` · review, then Step 10 validation

Review the diff against D1–D9; then run the full validation gate below.

## 5. Validation criteria

- **LSP clean** on every touched file (typescript LSP; no errors or warnings,
  including tests).
- `pnpm run lint` passes (Prettier runs after ESLint; re-read files before
  editing again).
- `pnpm -r run build` passes with zero errors.
- `pnpm run typecheck` passes.
- `pnpm run test` (fast suite) passes, including the new/updated tests in Step 7.
- `pnpm test:integration` passes (the MCP integration suite lives there).
- Behavioral checks:
  - A `streamable_http` server's tools are registered exactly once per connect;
    an initial connect fires no `onReconnected`; a simulated concurrent
    stream-open + caller mount cannot throw `Tool already registered`.
  - A `list_changed` arriving during a reconcile still re-lists afterwards
    (serializing chain, not coalescer).
  - The footer fragment reflects `everMounted − currentlyMounted`, self-heals on
    re-mount, respects `session.announceToolRemovals: false`, and caps at 20.
  - `runtime__mount_tool` on an already-mounted tool returns
    `{ success: true, alreadyMounted: true }`; the unknown case still returns
    `Unknown tool`.
  - No unhandled promise rejections are produced by the MCP reconnect paths.
- `docs/agents/mcp-plugin.md` and `docs/adr/252-*.md` match the shipped behavior.
- Update the swarm wiki / project memory only if asked; check `.drone-agent/`
  changes into the branch per AGENTS.md.
