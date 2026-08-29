---
key: plan-swarm-prompt-fragments-exploration
tags:
  - plan
  - swarm
  - prompt-fragments
  - exploration
created: 2026-08-29T14:53:17.934Z
updated: 2026-08-29T15:20:19.959Z
---

# Swarm Prompt Fragments — Planning Session (2026-08-29)

Feature: beacon + coordinator push system prompt fragments to specific sessions (targeted) or broadcast to all sessions.

## Verified architecture facts (with paths)
- `DronePromptFragment` drone-core/src/plugin-system.ts:41-44 `{ key, phase:'header'|'footer', render:()=>Promise<string|false> }`; registered plugin-engine.ts:512-521 (`<pluginId>.<key>` unique); re-rendered EVERY round via engine.renderPromptFragments() (plugin-engine.ts:868-876); false/empty filtered out.
- System prompt assembly per round: createContextBudgetService (runtime/context-budget-service.ts:140-157) = [config.systemPrompt, runtimeFlags.render()?, ...fragment messages]; conversation-service.ts:380 + :829 rebuild each round.
- RuntimeFlagRegistry (drone-core/runtime-flags.ts) = flat KV; SystemReminderQueue (runtime/system-reminders.ts) = 8-max one-shot non-persisted. Both wrong for standing content.
- Agent→beacon WS (plugins/swarm/websocket.ts) `/ws?agentId=<sessionId>`; beacon ws-server.ts Map<agentId,conn> + channel subs; unread-delivery-on-reconnect + 24h cleanup; sendToAgent/sendToChannel server helpers.
- agentId == swarm.sessionId (default agent-<ts>); spawner persists spawns.agent_id (beacon/spawner.ts) so stable ids exist server-side for spawned agents.
- Personas/skills precedent: beacon stores `scope` ('local'|'coordinator'), coordinator assets shadow beacon (PRECEDENCE_COORDINATOR=4000, config-types.ts:39), beacon proxies `?scope=coordinator`, beacon sync loop pulls coordinator assets on DEFAULT_SYNC_INTERVAL_MINUTES interval gated by coordinatorTrusted().
- Beacon REST families in routes/: agents, channels, config, events, insights, memory, messages, personas, principles, search, skills, spawn, sync, wiki.
- drone-swarm CLI: dual route dialects (flat beacon routes today; /api coordinator later).
- DroneConversationEvent: `notice` kind EXISTS (yellow TUI). New kinds need theme+app.tsx work. roundComplete = precedent for silent control signal.
- emitEvent passed to plugins via createBuiltInPlugins context (compaction/index.ts:26,207 pattern).
- DroneConfigInjector registry: registered by swarm plugin but NO verified consumer applies inject() into effective config — treat as (possibly) unwired.
- Coordinator↔beacon reverse-channel WS (wiki) NOT in code; coordinator→beacon today = plain HTTP. Persistent-WS rework branch exists separately (out of scope here).
- Project standards: fragments need top-level `# Heading`; LSP sạch + pnpm lint + pnpm -r build + pnpm test; swarm integration tests run only in provisioned Docker swarm.

## Locked decisions (user-confirmed)
1. **Authoring/asset model**: stored addressed DB asset (not fire-and-forget). Operator-first via REST + CLI; agent-tool + pipeline authors work "by construction" later. RAG = future consumer; programmatic path must genuinely work.
2. **Set semantics**: caller-chosen stable id upsert (idempotent replace) + TTL backstop. No replacements-sets/generations in v1.
3. **Agent injection**: swarm plugin registers TWO seed fragments `swarm.fragments.header`/`.footer` (phase header/footer), render() reads in-memory Map, returns false when empty. Freshness = beacon WS push (`fragment` msg type) + full resync on WS connect (GET /fragments?target=<agentId> + current broadcast set). No network in render().
4. **Target identity**: agentId. Accept-and-queue for unknown ids (spawn-aware). Orphans via TTL + list/delete. Broadcast = sentinel target value in same table.
5. **Broadcast semantics**: live current-set; keyed upsert/delete; pushes + resync; NO default TTL (persistent swarm banner wanted) but max count + max payload; targeted fragments get 24h default TTL unless explicit expiresAt (provisional numbers, tunable in beacon config; user unsure of final values — DEFERRED to implementation).
6. **Coordinator scope v1**: sync-interval propagation beacon←coordinator (swept into coming persistent-WS rework later). Coordinator-scoped fragments shadow beacon-scoped same-id (persona precedent scope='coordinator'). Coordinator changes in v1 minimal (pull-serving; optional read endpoints only). Authoring v1 = beacon REST only.
7. **Authoring surface v1**: beacon REST + minimal drone-swarm CLI verbs (list/set/delete). NO agent-side tool in v1.
8. **Observability**: reuse `notice` event kind on fragment add/remove/update (no new event kind/theme work). /systemprompt already exposes content.

## Plan-level implementation choices I (planner) will make unless pushed back
- render format: header block under `# Swarm Fragments`, footer block under `# Swarm Directives`; per-fragment bodies joined blank-line separated (ids not injected into prompt in v1... revisit in plan).
- Beacon `fragments` table + db/fragments.ts; WS msg type `fragment` on beacon ws-server; resync delivery on WS connect; sync loop extension for coordinator-scoped mirror; CLI group `drone-swarm fragments`.
- Tests: unit (db + routes + ws + agent render/resync) in existing suites (coordinator-sync pattern for integration in Docker swarm).