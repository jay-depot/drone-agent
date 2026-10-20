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
