# Hook Ordering Guarantees

The `onAfterToolCall` hook fires **after tool results have been appended to the
session**. This means hooks observe the full session state, including the latest
tool results. This ordering is critical for plugins like compaction, which need
an accurate view of context usage to decide whether to summarize.

The hook receives an optional `DroneAfterToolCallPayload` — `{ calls: [{ name,
arguments }] }` listing every tool call executed in the round (a parallel batch
from one LLM response, or a single entry for `/tool` and `/exec` slash-command
executions). Callbacks registered without parameters keep working; hosts that
cannot supply a payload may invoke the hook without one. Consumers should treat
the payload as fire-and-forget material (the lsp plugin uses it to warm ambient
language servers when file tools touch servable files) and never as a signal to
block the round.

## Tool-call loop order

Inside the conversation service's tool-call loop, the order of operations per
iteration is:

1. Build system messages and run safety budget check
2. Send messages to the LLM
3. Execute tool calls and buffer results
4. Append tool results to the session manager
5. Run `onAfterToolCall` hooks (compaction, logging, etc.)
6. Continue to next iteration

## onShutdown ordering guarantees

`onShutdown(callback, options?)` accepts an optional `options.priority?: number`.
Lower numeric priorities run first. Hooks registered without an explicit
priority run LAST, in registration order. Hooks with explicit priorities are
sorted ascending, and the sort is stable — equal priorities keep registration
order. This preserves the prior behavior of existing one-argument
registrations.

The swarm plugin's `registerShutdown` registers its hook with `{ priority: 0 }`,
so the agent informs the beacon of shutdown before every other `onShutdown`
hook. Its sequence: set `shuttingDown`, clear the heartbeat intervals, close the
WebSocket, flush the event buffer, unregister the config injector, then
`DELETE /sync/sessions/:id` and `DELETE /agents/:id`. The beacon learns the
agent is going offline even if a later hook blocks.

## Shutdown is bounded by a watchdog

`main()` in `index.tsx` arms `armShutdownWatchdog(session.shutdownTimeoutMs ??
30000)` (from `src/runtime/shutdown-watchdog.ts`) BEFORE
`runHooks('onShutdown')`. The watchdog is an unref'd timer that force-exits
with code 1 if the deadline elapses. On clean completion the disarm helper
clears the watchdog and arms a residual 5-second unref'd timer
(`SHUTDOWN_RESIDUAL_MS`) that exits with `process.exitCode ?? 0`, so leftover
handles cannot block exit. `session.shutdownTimeoutMs` is a drone-core config
key (default 30000). OnShutdown is therefore bounded, never unbounded.

## SIGTERM / SIGINT in every run mode

All run modes handle SIGTERM and SIGINT the same way `runSwarmListenMode`
does:

- `runJsonListenMode` and `runInteractiveLoop` register once-handlers that call
  the runtime capability's `cancelCurrentRequest()` and then close the readline,
  so the loop returns normally and `onShutdown` runs. The handlers are removed
  in the `finally` block.
- `runJsonMode`'s error path sets `process.exitCode = 1` instead of calling
  `process.exit(1)`, so `onShutdown` hooks run before the process exits.

Shutdown is never triggered via `process.kill` or self-signaling: SIGTERM is
uncatchable on Windows, so a self-signal would skip `onShutdown` entirely.
Shutdown is routed in-process instead (deferred `shutdownSignalRef` /
`cancelCurrentRequest` pattern).
