# Slash Commands

All slash commands (built-in and plugin-registered) are dispatched through the
engine's unified registry. Built-in commands (`/exit`, `/quit`, `/help`,
`/clear`, `/plugins`, `/tools`, `/systemprompt`, `/tool`, `/exec`) have lower
precedence than plugin commands, allowing plugins to override them.
Unrecognized slash commands display an error instead of being sent to the LLM.

## `/steer` and `/btw`

Two built-in commands round out the deferred-input story, both `busyBehavior:
true` so they run immediately even mid-turn:

- **`/steer <message>`** injects `<message>` as a user turn into the _currently
  in-flight_ round — the opt-in restoration of ADR 040's mid-round absorption
  that ADR 215 removed for plain text. It does not go through the queue: the
  message is held in a dedicated `steeringMessages` buffer and absorbed at the
  next tool-loop boundary (after the soft-cancel check), so the model sees it on
  its very next call. Absorbing a steer resets the degeneracy guards
  (empty/reasoning-only/identical-tool-call streaks) but _not_ the tool-call
  iteration count — a steer can break a loop, but cannot extend the depth safety
  limit. When no turn is in flight, `/steer <message>` degrades to a normal
  round (with the usual `onBeforePrompt`/`onAfterToolCall` hooks). A steer that
  never reaches a boundary (the round ends first, or is cancelled) is discarded
  with a `[steering: discarded late steering message: "..."]` notice; a
  successful mid-round injection logs `[steering: <message>]`.
- **`/btw <question>`** asks a **side question about the current context**: it
  re-assembles the current context (header system messages + session turns +
  footer system messages) plus the question, sends it to the LLM **with no
  tools**, displays the answer, and discards the copy. Session history is never
  touched. It surfaces as a single `aside` conversation event (`{ question,
answer }`) — rendered distinctly in the TUI and recorded in the coordinator's
  readable transcript as `[aside Q]`/`[aside A]` lines, but ignored by the
  round-window tracker and wakelock. It runs concurrently with an in-flight turn
  and inherits the active model + reasoning level.

Known caveat (fix later): because `--now` is stripped from the line before
dispatch, a `/steer` or `/btw` message that legitimately contains the standalone
token `--now` has it removed — the same footgun every rest-of-line command
shares.

## Slash commands while the LLM is working

A slash command typed while a turn is in flight is NEVER sent as plain text.
Every entry point (TUI input line, readline loop, remote steering via
`_runtime.submitUserMessage`) routes leading-`/` lines through the engine's
classifier and dispatches or defers them uniformly:

- **`busyBehavior`** — each `DroneSlashCommand` can declare how it behaves when
  the LLM is busy: `true` runs immediately (read-only, instant commands like
  `/help`, `/plugins`, `/context`, `/focus show`), `false`/unset queues the
  command until the current task finishes (mutating commands like `/focus set`,
  `/clear`), and a function receives the parsed `invocation` (`{ subcommand,
flags }`) for subcommand-aware decisions (e.g. `/todo show` immediate, `/todo
add` queued).
- **`--now` escape hatch** — appending `--now` to ANY command overrides queue →
  immediate (including destructive ones like `/clear --now` and `/exec --now`),
  so you can force a queued command to run mid-turn. `--now` is stripped from
  the line before dispatch and never leaks into the handler's args.
- **Queued commands** log a `(deferred — runs when the current task finishes)`
  notice, share one ordered queue with deferred steering text, and drain at the
  next loop boundary (or run as their own full round on normal completion).
  Queued entries are preserved across an Escape-cancel and flushed by `/clear`.
