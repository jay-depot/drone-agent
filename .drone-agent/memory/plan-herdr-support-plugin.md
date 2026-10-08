---
key: plan-herdr-support-plugin
tags:
  - plan
  - feature
  - herdr
  - plugin
  - cli-flags
created: 2026-10-08T19:45:52.061Z
updated: 2026-10-08T19:45:52.061Z
---

# Plan: Herdr Support Plugin for drone-agent

## Summary — what & why

Make drone-agent a **first-class Herdr agent**. Herdr (herdr.dev) is a terminal multiplexer for coding agents; agents that report their state get: their name + `idle`/`working`/`blocked` in the sidebar and `herdr agent list`; notifications when they finish; `herdr agent wait` automation; and **restore into the same pane after a Herdr server restart** (via a reported resume command).

Today drone-agent reports nothing, so `herdr agent list` is empty and a Herdr restart loses the session. This plan adds an **opt-in `herdr` plugin** that reports `idle`/`working` state and a resume command to Herdr, plus the two supporting mechanisms it needs: a minimal **plugin CLI-flag facility** (so a plugin can receive a startup session-import id) and a **startup session-import path** (so the resume command can actually restore context).

Deliverable: `herdr` shows drone-agent in `herdr agent list`; finishing a turn raises a Herdr notification; stopping and restarting a Herdr session re-spawns drone-agent and imports the prior session's context.

## Locked decisions (do not re-litigate)

- **D1 — State fidelity:** v1 reports **`idle` and `working` only**. `blocked` is **deferred** (drone-agent has no elicitation/blocked event today; it would require a new event emitted from a wrapper around `engine.setElicitation`). Leave a clean insertion point (see Step 7, "future blocked").
- **D2 — Session scoping:** requires swarm. Session id comes from `registration.request<DroneSwarmCapability>('swarm')?.getAgentId()`. **No session id ⇒ report nothing** and warn once (D6).
- **D3 — Resume mechanism:** synthesise the resume command from the existing **session-import** machinery (`/swarm-session import`), run at **startup** via a new flag. This is an **import, not a continuation** — the resumed process mints a new swarm session id and imports the old transcript (matches ADR 146).
- **D4 — Plugin CLI flags:** add a **minimal dotted-namespace facility**: `--<pluginId>.<flag>[=<value>]`. Dogfooded by `--swarm.session-import <id>`. A full refactor (declared flag specs, parse-time help/validation) is a **later branch — out of scope**.
- **D5 — Enablement:** `herdr` plugin is `defaultEnabled: false` (opt-in) **plus** a `herdr.enabled` config gate (default `true`).
- **D6 — Surfacing:** silent unless `HERDR_ENV === '1'`. If inside Herdr but no session id, report nothing and warn once (lazily, post-mount). `--debug herdr` enables verbose logs.
- **D7 — Shutdown/safety:** release on `onShutdown` **only**; **no** global SIGINT/SIGTERM handlers; no action on `/clear`; **skip subagents**; monotonic in-process `--seq`; single-in-flight coalescing (drop stale queued states).
- **D8 — Config:** `herdr: { enabled: boolean; resumeCommand: string; agentLabel: string }`, defaults `{ enabled: true, resumeCommand: 'drone-agent', agentLabel: 'drone-agent' }`. Herdr `--source` is **fixed** in code to `'drone-agent'`.
- **D9 — Startup import surfacing:** run `runSessionImport` in `index.tsx` **before** `createTui(...)`; buffer a **terse** summary; seed the TUI via a new `DroneTuiOptions.initialEntries`.
- **D10 — Tests/docs:** unit tests for every new unit; new ADR `239-herdr-agent-integration`; new `docs/agents/herdr-plugin.md`; update `AGENTS.md` + plugin list + `KNOWN_CONFIG_KEYS`.

## Herdr protocol reference (from https://herdr.dev/docs/add-herdr-support/ and /docs/socket-api/)

Env vars inherited in a Herdr pane: `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH` (+ `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`). Outside Herdr the integration must do nothing.

State report:

```
"$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID" \
  --source drone-agent --agent <agentLabel> --state working|idle|blocked \
  [--message <text>] [--seq <n>] [--agent-session-id <id>] [-- <resume argv...>]
```

Release:

```
"$HERDR_BIN_PATH" pane release-agent "$HERDR_PANE_ID" --source drone-agent --agent <agentLabel> [--seq <n>]
```

Rules that constrain the resume argv: the first word must be a **plain command name on the user's PATH** (not a path); no argument may contain an **apostrophe or control character**; **≤ 64 args and ≤ 8 KiB** total; the source must **already hold the pane** (send a `report-agent` first) or Herdr replies `resume_not_accepted`; resume needs **Herdr ≥ 0.9.2**. `--seq` must strictly increase per source (a timestamp works); Herdr ignores non-increasing reports. Reports must be backgrounded with a short timeout; failures ignored; only the latest state sent. Verify with `herdr pane get "$HERDR_PANE_ID"` and `herdr agent list`.

Local Herdr for manual testing: v0.9.3, bin `/usr/bin/herdr`.

## Resolved implementation facts (verified in this repo)

- CLI parser: `drone-agent/src/cli.ts` (`CliOptions` at :1-38; `parseCliArgs` at :111; unknown `--*` **throws** at :253). Re-exported as `parseCliInvocation` at `index.tsx:579`.
- Engine: `createDronePluginEngine(...)`; `getDefaultEnabledPluginIds` :284; `resolveEnabledPluginIds` :291; `registerPlugin` :618-754 (hook push :695-710); capabilities set :958-980.
- Registration API: `drone-core/src/plugin-system.ts:107-201`. Metadata: `drone-core/src/config-types.ts:53-69`.
- Config wiring: `config-types.ts` (`DroneWakelockConfig` :254 precedent; `DroneAgentConfig` :437-459; `Partial` :485; merge array :528; `createDefaultAgentConfig` :565-673) and `config-schema.ts` (:330 precedent). Also `KNOWN_CONFIG_KEYS` (in the `config` plugin) **must** be updated or `config_set` throws.
- Swarm: session id at `plugins/swarm/index.ts:93`; `swarmCap { getBeaconUrl, getAgentId }` :164-167. Import: `plugins/swarm/session-command.ts` (`handleImport`), `plugins/swarm/session-import.ts` (`fetchTranscript`, `splitTranscriptIntoChunks`, `summarizeChunk`, `injectChunk`).
- TUI: `tui/app.tsx:276` subscribes to `engine.onConversationEvent` **on mount** (nothing emitted earlier reaches the log; no seed path today). `tui/types.ts` `DroneTuiOptions` (:100-172), `ChatEntry` (:47-72). `createTui` at `tui/index.tsx`.
- Startup: `index.tsx:40` parse; `:66` load config; `:456` `engine.initialize()`; `:472-473` `onPluginsLoaded`/`onSessionStart`; `:451-573` mode dispatch; `:574` `onShutdown`.
- `roundComplete` fires on **every** loop exit (`conversation-service.ts:1438`). The `userMessage` hook is **fire-and-forget** (`conversation-service.ts:678-686`) — so the startup import must complete **before** the first turn (it cannot be triggered from the plugin's first `userMessage` hook without racing the turn).
- Precedents: `plugins/wakelock/index.ts` (opt-in, `onConversationEvent`, `onShutdown`), `shared/exec-async.ts` (`execFileAsync`), subagent skip via `_runtime.isSubagent`.
- Next ADR number: **239**.

## Execution order & dependencies

```
Phase A (foundation, no deps)
  S1 config section (drone-core)
  S2 plugin CLI-flag facility
  S3 tests: config + facility            (deps S1,S2)
Phase B (startup import)  ← deps Phase A
  S4 extract runSessionImport
  S5 swarm flag + capability + startup wiring + TUI initialEntries   (deps S2,S4)
  S6 tests: import + startup wiring      (deps S4,S5)
Phase C (the plugin)      ← deps Phase A (S1) + S5 (resume flag)
  S7 herdr plugin: state + release
  S8 herdr resume-argv builder + validation
  S9 tests: herdr plugin                 (deps S7,S8)
Phase D (finish)
  S10 docs + ADR + AGENTS.md + KNOWN_CONFIG_KEYS   (deps all)
  S11 review vs plan
  S12 full validation gate
```

---

## Step 1 — (coder) `herdr` config section in drone-core

**Files:** `drone-core/src/config-types.ts`, `drone-core/src/config-schema.ts`.

1. Add the type (near `DroneWakelockConfig`, config-types.ts:254):

```ts
export type DroneHerdrConfig = {
  /** Master toggle for reporting to the Herdr terminal multiplexer. */
  enabled: boolean;
  /** argv[0] of the Herdr resume command; must be a plain name on PATH. */
  resumeCommand: string;
  /** Herdr `--agent` label (the name shown in the Herdr sidebar). */
  agentLabel: string;
};
```

2. Add `herdr: DroneHerdrConfig;` to `DroneAgentConfig` and `herdr: Partial<DroneHerdrConfig>;` to `PartialDroneAgentConfig`.
3. Add `'herdr'` to the merge-spec `merge` array.
4. Add the default in `createDefaultAgentConfig()`: `herdr: { enabled: true, resumeCommand: 'drone-agent', agentLabel: 'drone-agent' }`.
5. Add the schema entry (`config-schema.ts`): `herdr: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean()), resumeCommand: Type.Optional(Type.String()), agentLabel: Type.Optional(Type.String()) }))`.

**Verify:** `pnpm -r run build` (dependent packages resolve drone-core from `dist/`).

---

## Step 2 — (coder) Minimal plugin CLI-flag facility

**Files:** `drone-agent/src/cli.ts`, `drone-core/src/plugin-system.ts`, `drone-agent/src/runtime/plugin-engine.ts`, `drone-agent/src/index.tsx`.

**Surface:** `--<pluginId>.<flagName>[=<value>]`. Core flags unchanged. Unknown **non-dotted** `--*` still throws.

1. `cli.ts` — add to `CliOptions`:

```ts
/** Plugin-namespaced flags: `--<pluginId>.<flag>[=<value>]`. */
pluginFlags: Record<string, string | true>;
```

Initialize `pluginFlags: {}` in the options object. Add one parse branch, **after** all core branches and **before** the `Unknown option` throw (cli.ts:253):

```ts
} else if (arg.startsWith('--') && arg.slice(2).includes('.')) {
  const raw = arg.slice(2);
  const eq = raw.indexOf('=');
  let key: string;
  let value: string | true;
  if (eq >= 0) {
    key = raw.slice(0, eq);
    value = raw.slice(eq + 1);
  } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
    key = raw;
    value = argv[++i];
  } else {
    key = raw;
    value = true;
  }
  options.pluginFlags[key] = value;
}
```

2. `drone-core/src/plugin-system.ts` — add to `DronePluginRegistration`:

```ts
/**
 * This plugin's CLI flags, with the `"<pluginId>."` namespace stripped.
 * Values are the raw strings the user passed, or `true` for flag-only forms.
 */
getCliFlags: () => Record<string, string | true>;
```

3. `drone-agent/src/runtime/plugin-engine.ts`:
   - Accept `pluginFlags?: Record<string, string | true>` in the engine options; store as `rawPluginFlags` (default `{}`).
   - In `resolveEnabledPluginIds` (:291): after the existing resolution, force-enable every plugin whose id namespaces a flag (same spirit as `required` plugins):
     ```ts
     const flagNamespaces = new Set(
       Object.keys(rawPluginFlags).map(k => k.split('.')[0])
     );
     for (const id of flagNamespaces) if (pluginsById.has(id)) enabled.add(id);
     ```
   - In `registerPlugin` (:618-754): build a scoped map and wire the getter (and record the namespace as claimed):
     ```ts
     const namespace = `${plugin.metadata.id}.`;
     const scopedFlags: Record<string, string | true> = {};
     for (const [k, v] of Object.entries(rawPluginFlags)) {
       if (k.startsWith(namespace)) scopedFlags[k.slice(namespace.length)] = v;
     }
     // in the registration object:
     getCliFlags: () => scopedFlags,
     ```
   - At the end of engine `initialize()`, warn **once per unclaimed namespace** (never throw):
     ```ts
     for (const ns of flagNamespaces) {
       if (!claimedNamespaces.has(ns)) {
         console.error(
           `[cli:plugin-flag] no enabled plugin owns flag '${ns}.*'`
         );
       }
     }
     ```
   - Optional parity: expose `pluginFlags` on `_runtime`.

4. `index.tsx` — pass `pluginFlags: invocation.options.pluginFlags` into `createDronePluginEngine(...)`.

**Note:** the value-taking heuristic (`next arg doesn't start with --`) can swallow a bare positional; acceptable for v1 (a declared-spec refactor removes it later).

---

## Step 3 — (tester) Tests: config + flag facility

**Files:** `drone-agent/test/cli-plugin-flags.test.ts` (new), plus extend an engine test file.

- Parse forms: `--foo.bar=baz` ⇒ `{ 'foo.bar': 'baz' }`; `--foo.bar baz` ⇒ `{ 'foo.bar': 'baz' }`; bare `--foo.bar` ⇒ `{ 'foo.bar': true }`.
- Core flags still parse; `--bogus` (non-dotted) still **throws** `/Unknown option/`.
- Engine: a plugin declaring itself enabled only when namespaced is auto-enabled by `--<id>.<flag>`; `getCliFlags()` returns the namespace-stripped map; an unclaimed namespace logs the warning once and does not throw.
- Config: `createDefaultAgentConfig().herdr` deep-equals `{ enabled: true, resumeCommand: 'drone-agent', agentLabel: 'drone-agent' }`; schema accepts a partial `herdr` object.

---

## Step 4 — (coder) Extract `runSessionImport` from the slash command

**Files:** `drone-agent/src/plugins/swarm/session-import.ts`, `drone-agent/src/plugins/swarm/session-command.ts`.

Move the body of `handleImport` (session-command.ts) into a context-free function in `session-import.ts`:

```ts
export type SessionImportDeps = {
  baseUrl: string | undefined;
  llm: DroneLlmCapability | undefined;
  sessionManager: DroneSlashCommandSessionManager | undefined;
  logger: { info: (message: string) => void; warn: (message: string) => void };
  config: DroneSessionImportConfig;
  getContextWindowTokens: () => Promise<number>;
  runAfterToolCallHooks: () => Promise<void>;
};

/** Recreates an old swarm session's context into the current session. */
export async function runSessionImport(
  deps: SessionImportDeps,
  sessionId: string,
  opts: { from?: number } = {}
): Promise<{ ok: boolean; summary: string }>;
```

Keep the existing behaviour exactly: self-import guard, `--from` clamp check, `fetchTranscript` → `splitTranscriptIntoChunks` → per-chunk `summarizeChunk` → `injectChunk`, `runAfterToolCallHooks()` between chunks, non-fatal error handling. Progress goes to `deps.logger`; the **returned `summary`** is terse (one line on success, plus the failure/warning lines on abort).

`handleImport` (session-command.ts) becomes a thin adapter: build `deps` from `DroneSlashCommandContext`, parse `--from`, call `runSessionImport`, then `ctx.logger.info(result.summary)`. Behaviour of `/swarm-session import` is unchanged from the user's perspective.

---

## Step 5 — (coder) `--swarm.session-import` + startup wiring + TUI seeding

**Files:** `drone-agent/src/plugins/swarm/index.ts`, `drone-core/src/plugin-system.ts` (capability type), `drone-agent/src/index.tsx`, `drone-agent/src/tui/types.ts`, `drone-agent/src/tui/app.tsx`.

1. **Capability** — add to drone-core:

```ts
export type DroneSessionImportCapability = {
  runImport: (sessionId: string) => Promise<{ ok: boolean; summary: string }>;
};
```

2. **Swarm plugin** — read its flag and offer the capability:
   - `const importIdFlag = registration.getCliFlags()['session-import'];`
   - `registration.offer<DroneSessionImportCapability>({ runImport: async (sessionId) => runSessionImport(deps, sessionId) })`, where `deps` is assembled from the swarm plugin's handles: `baseUrl` (`getBeaconUrl()`), `llm` (`registration.request<DroneLlmCapability>('llm')`), `sessionManager` (wire into `createSwarmPlugin` deps if not already present), `logger`, `config: getConfig().swarm.sessionImport`, `getContextWindowTokens` (broker-resolved, with the config-only fallback), `runAfterToolCallHooks`.
   - Declare `llm` as an optional dependency if not already.
3. **Startup** — in `index.tsx`, **after** `runHooks('onSessionStart')` (:473) and **before** the mode dispatch (:451):

```ts
let startupEntries: ChatEntry[] | undefined;
const importSessionId = invocation.options.pluginFlags['swarm.session-import'];
if (typeof importSessionId === 'string') {
  const cap = engine.getCapability<DroneSessionImportCapability>('swarm');
  if (cap) {
    const res = await cap.runImport(importSessionId);
    if (res.summary) {
      logger.info(res.summary);
      startupEntries = [
        { id: 'startup-session-import', kind: 'notice', text: res.summary },
      ];
    }
  } else {
    logger.warn(
      '--swarm.session-import: swarm plugin unavailable; skipping import.'
    );
  }
}
```

Pass `initialEntries: startupEntries` to **both** `createTui(...)` call sites (:496 and :544). Non-TUI hosts already surface it via `logger.info`. 4. **TUI seeding** — `tui/types.ts`: add `initialEntries?: ChatEntry[];` to `DroneTuiOptions`. `tui/app.tsx`: seed the log state from `opts.initialEntries` on first mount (initialize the log reducer/state from it; do not re-seed on later renders).

**Ordering guarantee:** this runs before `createTui` and before any turn, so it neither races the first LLM call nor emits events the TUI would miss.

---

## Step 6 — (tester) Tests: import extraction + startup wiring + seeding

- `drone-agent/test/session-import.test.ts`: `runSessionImport` success path (fetch → chunk → summarize → inject, `onAfterToolCall` between chunks), self-import guard, `--from` out-of-range, fetch failure → `{ ok: false }` + warning summary, no double-logging. (Use an injected `deps` with fakes — no network.)
- Startup wiring: with `pluginFlags['swarm.session-import'] = 'x'` and a fake swarm capability, `index.tsx` path produces a terse summary and passes it as `initialEntries`; with no capability, it warns and continues.
- TUI: `initialEntries` render as committed chat-log entries on mount (use the existing `ink-testing-library` harness and **poll** for the expected frame — never fixed ticks).

---

## Step 7 — (coder) `herdr` plugin: state reporting + release

**Files:** `drone-agent/src/plugins/herdr/index.ts`, `drone-agent/src/plugins/herdr/reporter.ts`, `drone-agent/src/plugins/index.ts`.

1. **Register** — `drone-agent/src/plugins/index.ts`: import and add to `staticBuiltInPlugins`, and create it via `createBuiltInPlugins(...)` **only if** it needs the CLI overrides (see Step 8) — preferred: `createHerdrPlugin({ modelOverride?, beaconHost?, beaconPort? })` via `createBuiltInPlugins`, mirroring `createSwarmPlugin`.
2. **Metadata:** `{ id: 'herdr', name: 'Herdr', version: '0.1.0', description: 'Report agent state and session resume to the Herdr terminal multiplexer.', defaultEnabled: false, dependencies: [{ id: 'swarm', optional: true }] }`. `swarm` is **optional** so `enablePlugin('herdr')` never throws when swarm is off (the graceful-warn path D2/D6 requires).
3. **Guards** (in `register()`, in order — early-return, never throw):
   - `if (!getConfig().herdr.enabled) return;`
   - `if (process.env.HERDR_ENV !== '1' || !process.env.HERDR_PANE_ID || !process.env.HERDR_BIN_PATH) return;` (silent outside Herdr)
   - `if (runtimeInfo?.isSubagent) return;` (subagents inherit `HERDR_ENV` and would clobber the parent pane)
   - `const swarm = registration.request<DroneSwarmCapability>('swarm'); const sessionId = swarm?.getAgentId();` → if falsy, register a **lazy warn** (below) and return.
4. **Reporter** (`reporter.ts`) — wrap `execFileAsync` from `shared/exec-async.ts`:
   - `report(state, { message?, resumeArgv? })` and `release()`.
   - argv: `[ 'pane', 'report-agent', paneId, '--source', 'drone-agent', '--agent', agentLabel, '--state', state, '--seq', String(seq++) ]`, plus `--message`, `--agent-session-id <id>`, and `-- <resumeArgv...>` when provided; `release` uses `pane release-agent <paneId> --source drone-agent --agent <agentLabel> --seq <seq++>`.
   - `cmd = process.env.HERDR_BIN_PATH`, short timeout (e.g. 2000 ms), **swallow all errors** (log only under `--debug herdr`).
   - **Single in-flight:** keep `inFlight` + `desired`; if desired ≠ lastSent after completion, send once more (drops stale queued states). Monotonic `seq` in process memory.
5. **Hooks:**
   - Send an **initial `idle` report immediately** (at register time, with the resume argv — see Step 8) so the source holds the pane and Herdr accepts the resume command.
   - `registration.hooks.onConversationEvent(event => { if (event.kind === 'userMessage') reporter.report('working'); else if (event.kind === 'roundComplete') reporter.report('idle'); })`.
   - `registration.hooks.onShutdown(() => reporter.release())`. **No** `onSessionClear` handler (session id/argv are unchanged by `/clear`).
6. **Lazy warn (no session id):** when the session id is missing, install a one-shot `onConversationEvent` hook that, on the **first** `userMessage`, emits `registration.emitEvent({ kind: 'notice', content: '[herdr: no swarm session id — not reporting to Herdr]' })` (guaranteed post-mount, so it reaches the TUI), and `registration.logger.warn(...)` once. Then no-op.
7. **Future `blocked` insertion point:** add a `// TODO(FIXME): report 'blocked' when an elicitation-awaiting event lands (wrap engine.setElicitation).` marker only — do **not** implement (D1).

---

## Step 8 — (coder) Herdr resume argv builder + validation

**File:** `drone-agent/src/plugins/herdr/resume-argv.ts`.

```ts
export function buildResumeArgv(input: {
  resumeCommand: string; // config.herdr.resumeCommand
  sessionId: string; // swarm session id (the import target)
  personaId: string | null; // active persona, if any
  modelOverride?: string; // CLI --model, only if explicitly set
  beaconHost?: string; // CLI --beacon-host, only if explicitly set
  beaconPort?: number; // CLI --beacon-port, only if explicitly set
}): string[] {
  const argv = [input.resumeCommand, '--swarm.session-import', input.sessionId];
  if (input.personaId) argv.push('--persona', input.personaId);
  if (input.modelOverride) argv.push('--model', input.modelOverride);
  if (input.beaconHost) argv.push('--beacon-host', input.beaconHost);
  if (input.beaconPort !== undefined)
    argv.push('--beacon-port', String(input.beaconPort));
  return argv;
}

export function validateResumeArgv(argv: string[]): {
  ok: boolean;
  reason?: string;
};
```

`validateResumeArgv` enforces Herdr's rules: argv[0] has no path separator (`/`, `\`); no element contains an apostrophe (`'`) or a control character (`/[\u0000-\u001f\u007f]/`); `argv.length <= 64`; total byte length `<= 8192`.

The plugin calls `buildResumeArgv` at register time (persona from `_runtime.persona`, overrides from the DI'd CLI options), validates it, and attaches it to the **first** state report. On validation failure: log (warn) and omit the resume argv while state reporting continues. `--session-id`/`--spawn-id`/`--swarm`/`--once`/`--output-json`/`--working-dir` are deliberately **omitted**.

---

## Step 9 — (tester) Tests: herdr plugin

**Files:** `drone-agent/test/herdr-plugin.test.ts`, `drone-agent/test/herdr-resume-argv.test.ts`.

- **Guards:** no report when `HERDR_ENV` unset; no report when `herdr.enabled === false`; no report for subagents; when inside Herdr but no swarm session id → no `report-agent` call, one `notice` on first `userMessage`, one `logger.warn`.
- **State transitions:** `userMessage` → `report('working')`; `roundComplete` → `report('idle')`; initial `idle` report sent on register.
- **Release:** `onShutdown` → `release-agent` once; `/clear` (`onSessionClear`) → **no** call.
- **Coalescing/seq:** while a report is in flight, a newer state supersedes and only the latest is sent; `--seq` strictly increases.
- **Error tolerance:** a failing `execFileAsync` (mock) does not throw and does not crash the host.
- **Resume argv:** builds `['drone-agent','--swarm.session-import',id, ...]`; includes persona/model/beacon only when provided; **never** includes `--session-id`/`--swarm`/`--once`; `validateResumeArgv` rejects a path-like argv[0], an apostrophe, >64 args, >8 KiB.
- **Reporter argv:** exact CLI shape for `report-agent` and `release-agent` (mock `execFileAsync`, assert args).

---

## Step 10 — (coder) Docs, ADR, and config-key registration

- **ADR:** `docs/adr/239-herdr-agent-integration.md` — records: external supervisor integration as a plugin; state fidelity (`idle`/`working` only, `blocked` deferred); session-scoped (swarm-only); resume-by-import, not continuation; the dotted-namespace plugin-flag facility (and its deferred full refactor); release-on-shutdown-only + Herdr's safety net; single-in-flight coalescing + monotonic seq; subagent skip. Add it to `docs/adr/index.md`.
- **Docs:** `docs/agents/herdr-plugin.md` — env contract, what is reported, the resume argv shape and its rules, config keys, `--debug herdr`, how to verify (`herdr agent list`, `herdr pane get`), and the documented limitations (no signal-trap release; new session id on resume).
- **`AGENTS.md`:** add `herdr` to the built-in plugin list and the plugin inventory counts; cross-link `docs/agents/herdr-plugin.md`.
- **`KNOWN_CONFIG_KEYS`:** add `'herdr'` (in the `config` plugin) so `config_set herdr.enabled` does not throw — _the wakelock landmine_.
- Update the project wiki page for `modules/drone-agent-plugins` (a `herdr` mention + ADR 239 link).
- If on a feature branch: commit the `.drone-agent` plan/memory with the change set (never to `main`).

---

## Step 11 — (reviewer) Review against this plan

Blunt review of the diff. Confirm: every new symbol is used (no dead code); no `any`/`eslint-disable`; no fluff comments (jsdoc or complex-process only); files < 750 lines; duplicated logic extracted (esp. `runSessionImport` shared by both callers); the guard order is exactly Step 7.3; the resume argv omits the forbidden flags; hooks never throw out (non-`onBeforePrompt` hook errors propagate — `plugin-engine.ts:1005-1027`). Report findings; the coder fixes them before Step 12.

---

## Step 12 — (tester/verifier) Final gate against the validation criteria

Run every item in **Validation criteria** below and report results. This step is mandatory and last.

---

## Validation criteria

**Automated (must all pass, zero errors):**

1. **LSP diagnostics are clean** for every changed/added file (both packages) — no errors, no warnings.
2. `pnpm -r run build` — succeeds. (Run **before** trusting dependent-package LSP after editing `drone-core` types, since dependents resolve `drone-core` from built `dist/`.)
3. `pnpm run lint` — succeeds with zero errors, zero warnings, **no `eslint-disable`**. Note: prettier reformats on success — re-read any file before editing it again.
4. `pnpm run typecheck` — succeeds.
5. `pnpm run test` (fast suite) — all pass, including the new tests from Steps 3, 6, and 9.
6. Coverage: every new unit (flag facility, `runSessionImport`, startup wiring, `initialEntries` seeding, herdr plugin guard/state/release/reporter, resume-argv builder+validator) has a dedicated test.
7. `pnpm test:integration` **at the verifier's discretion** (no integration surface changed, but run if touching shared startup paths is a concern).

**Behavioural (manual, in a real Herdr pane — Herdr ≥ 0.9.2, local v0.9.3):** 8. `HERDR_ENV=1` is present; `herdr agent list` shows an agent labelled per `herdr.agentLabel` after drone-agent starts with `herdr` enabled and swarm connected. 9. State flips: `working` while a turn runs, `idle` when it completes; `herdr pane get "$HERDR_PANE_ID"` shows the expected `agent_status` and an `agent_session` reference. 10. Finish notification: completing a turn raises a Herdr notification (once per completion; no duplicate/flicker from stale reports). 11. Resume round-trip: start `herdr --session herdr-test`, run drone-agent (swarm connected), `herdr session stop herdr-test`, restart it → the pane runs the reported resume command (`drone-agent --swarm.session-import <id> [--persona …]`), the import runs at startup **before** the first turn, and the terse import summary appears in the TUI log while the agent re-registers (a **new** swarm session id, importing the old transcript). 12. Exit: `/exit` (and TUI Ctrl-C) clear the pane's agent + resume command (`herdr pane get` shows no agent). A hard SIGKILL is cleared by Herdr's safety net within ~1–2 s. 13. Non-interference: with `herdr` disabled, or outside Herdr, or in a subagent, drone-agent behaves exactly as before and makes no Herdr calls. 14. `--swarm.session-import <id>` alone (no `--swarm`) starts in TUI mode, auto-enables swarm, and imports before the first turn.

**Documented limitations (must be recorded in `docs/agents/herdr-plugin.md`, not "fixed"):** 15. `blocked` is not reported (deferred; insertion point marked). 16. No signal-trap release outside `runSwarmListenMode`; Herdr's shell-prompt safety net is the fallback. 17. Resume is an import (new session id), not a continuation.

---

## ✅ STATUS: COMPLETE (2026-10-08, branch `feat/herdr-support`)

All 12 steps executed. **3743 tests pass, 0 fail (14 skipped); typecheck/`pnpm -r build` clean; LSP clean; feature files prettier-clean.**

### What shipped

- **`herdr` plugin** (`drone-agent/src/plugins/herdr/{index,reporter,resume-argv}.ts`) — opt-in (`defaultEnabled:false`, `swarm` optional dep, `herdr.{enabled,resumeCommand,agentLabel}` config). Reports `idle`/`working` (`userMessage`→working, `roundComplete`→idle; initial `idle` on load) via `$HERDR_BIN_PATH pane report-agent`; releases on `onShutdown`; inert unless `HERDR_ENV=1`; subagents skipped; monotonic `--seq` + single-in-flight coalescing; `--source` fixed to `drone-agent`; `--debug herdr` verbose; lazy one-shot warn when no swarm session id.
- **Resume by import** — `buildResumeArgv`/`validateResumeArgv`; argv `drone-agent --swarm.session-import <id> [--persona][--model][--beacon-host][--beacon-port]` (omits `--session-id`/`--spawn-id`/`--swarm`/`--once`/`--output-json`/`--working-dir`), attached to the first state report, validated against Herdr's rules.
- **Plugin CLI-flag facility** — `--<pluginId>.<flag>[=<value>]` → `CliOptions.pluginFlags` → `createDronePluginEngine({pluginFlags})` → `registration.getCliFlags()` (namespace stripped); namespacing plugin auto-enabled; unclaimed-namespace warning after `initialize()`; `_runtime.pluginFlags` parity.
- **Startup session-import** — `runSessionImport(deps, id, {from})` extracted from `/swarm-session import` (which is now a thin adapter); swarm offers `DroneSessionImportCapability`; `index.tsx` runs `--swarm.session-import` after `onSessionStart` and **before** the host mounts, buffering a terse summary seeded into the TUI via new `DroneTuiOptions.initialEntries` (`useChatLog(opts.initialEntries)`).
- **Config** — `DroneHerdrConfig` in `drone-core` (type + `DroneAgentConfig`/`Partial` + merge array + default + schema) and `KNOWN_CONFIG_KEYS` (`herdr.enabled/resumeCommand/agentLabel`). `shared/exec-async.ts` gained `timeoutMs`.
- **Docs** — ADR `docs/adr/239-herdr-agent-integration.md` (+ index row), `docs/agents/herdr-plugin.md`, `AGENTS.md` Specialized Subsystems entry, wiki `modules/drone-agent-plugins` row.

### Tests added
`cli-plugin-flags` 13; `session-import` (+`runSessionImport`) 19; `startup-import` 4; `app-initial-entries` 2; `herdr-plugin` 10; `herdr-resume-argv` 10; `session-command` (rewritten for delegation) 9.

### Deviations from the plan (with rationale)
1. **Added `src/startup-import.ts`** — extracted the startup-import block from `index.tsx` into `runStartupSessionImport(getCapability, logger, pluginFlags)` so it is unit-testable (the plan's startup-wiring test would otherwise require running `main()`).
2. **TUI seeding (D9)** — used `initialEntries` as planned; discovered `onSessionStart` runs *before* `createTui` mounts, so an emitted notice would be lost — the buffer+seed approach is required (matches plan Option A).
3. **`getCliFlags` is a REQUIRED member** of `DronePluginRegistration` (matching `getConfig`/`requestElicitation`), which required sweeping `getCliFlags: () => ({})` into 31 test mock registrations.
4. **Reporter internals** — replaced the plan's illustrative `seq === 1` check with an explicit `heldPane` flag so the resume command attaches to the first report regardless of seq numbering.
5. **Lint hazard** — `pnpm run lint` runs `prettier --write .` repo-wide and reformatted 277 **unrelated** files (213 ADRs, READMEs, pnpm-lock, memories) because the committed tree is not prettier-clean; all that churn was reverted and only feature files were formatted.

### Not done (per plan's documented limitations)
`blocked` reporting (deferred, `TODO(FIXME)` insertion point in the plugin); no signal-trap release (Herdr's safety net is the fallback); resume is an import (new session id); local-log-based import fallback when swarm is off.
