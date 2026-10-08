# Herdr Plugin

Reports drone-agent's `idle`/`working` state and a session **resume command**
to [Herdr](https://herdr.dev), a terminal multiplexer for coding agents. With
this plugin, drone-agent appears in `herdr agent list` and the sidebar, raises
notifications when a turn finishes, and can be **restored into the same pane
after a Herdr server restart**.

Opt-in and inert outside Herdr. See ADR
[`239-herdr-agent-integration`](../adr/239-herdr-agent-integration.md) for the
full design.

## Enabling

1. Add `herdr` to `enabledPlugins` (or `--plugin herdr`).
2. Run drone-agent inside a Herdr pane **with the swarm plugin enabled and
   connected** (a session id is required).

`herdr` is `defaultEnabled: false`; a `herdr.enabled` config gate (default
`true`) turns reporting off without touching `enabledPlugins`.

## Config

| Key                   | Default       | Meaning                                                        |
| --------------------- | ------------- | -------------------------------------------------------------- |
| `herdr.enabled`       | `true`        | Master toggle.                                                 |
| `herdr.resumeCommand` | `drone-agent` | `argv[0]` of the resume command; must be a plain name on PATH. |
| `herdr.agentLabel`    | `drone-agent` | Herdr `--agent` label (the name shown in the sidebar).         |

`--debug herdr` enables verbose logging (report failures, argv decisions).

## What is reported

Herdr contract: each process in a Herdr pane inherits `HERDR_ENV=1`,
`HERDR_PANE_ID`, `HERDR_BIN_PATH`, and `HERDR_SOCKET_PATH`. The plugin does
nothing unless those are present.

- **State** — `working` when a turn starts (the `userMessage` event), `idle`
  when it completes (the `roundComplete` event), plus an initial `idle` on
  load. Reports carry a strictly increasing `--seq` and are coalesced to one
  in-flight call (only the latest state is sent). `--source` is fixed to
  `drone-agent`.
- **Resume command** — attached to the first state report (which holds the
  pane, satisfying Herdr's `resume_not_accepted` rule):

  ```
  drone-agent --swarm.session-import <sessionId> [--persona <id>] [--model <id>] [--beacon-host <h> --beacon-port <p>]
  ```

  `argv[0]` comes from `herdr.resumeCommand`. The command is validated against
  Herdr's rules (plain PATH name first, no apostrophes/control characters,
  ≤64 args, ≤8 KiB); on violation it is dropped and state reporting continues.
  It never includes `--session-id`/`--spawn-id` (would self-import), `--swarm`
  (would select listen-mode), or `--once`/`--output-json`/`--working-dir`.

- **Release** — on `onShutdown`, so the pane's agent + resume command clear
  immediately on a clean exit or TUI Ctrl-C.

## `--swarm.session-import <sessionId>`

The resume command's workhorse. Runs at startup (after `onSessionStart`,
before the host mounts), fetching the old session transcript through the
beacon, summarizing it in chunks, and injecting each chunk as its own
synthetic `session_import` turn. The terse result is seeded into the TUI log
(via `DroneTuiOptions.initialEntries`) or logged in non-TUI hosts.

The flag is a **plugin-namespaced** flag (`--<pluginId>.<flag>`); it also
auto-enables the swarm plugin, so it works without `--swarm`. The same
machinery backs the `/swarm-session import` slash command.

## Verifying

Inside a Herdr pane:

```
herdr agent list                       # the agent should appear
herdr pane get "$HERDR_PANE_ID"        # agent_status + agent_session
```

To test restore without touching a normal session:

```
herdr --session herdr-test
# run drone-agent (swarm connected) in a pane
herdr session stop herdr-test
herdr --session herdr-test             # the pane runs the resume command
```

## Documented limitations

- **`blocked` is not reported** (deferred; drone-agent emits no
  awaiting-input event yet — a `TODO(FIXME)` marks the insertion point).
- **No signal-trap release.** `onShutdown` runs on a clean exit or Ctrl-C;
  the TUI/plain/JSON-listen modes do not trap SIGTERM, so a `kill -9` relies
  on Herdr's shell-prompt safety net (~1–2 s).
- **Resume is an import, not a continuation** (ADR 158): the resumed process
  mints a **new** swarm session id and recreates the old session's context.
- Without a swarm session id the plugin reports nothing and warns once.
- Subagents skip reporting (they inherit `HERDR_ENV` and share the parent
  pane).
