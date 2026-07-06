---
key: large-file-splitting-plan
tags:
  []
created: 2026-07-06T22:56:06.469Z
updated: 2026-07-06T22:56:06.469Z
---

# Plan: Split Large Files Across drone-agent

## Summary
Split 10 large files (1,100–2,100 lines each) into smaller, focused modules. Three tiers of priority.

## Tier 1: swarm/index.ts (1,385 lines)

### Structure
```
drone-agent/src/plugins/swarm/
  index.ts           ← barrel re-export + createSwarmPlugin() factory (keep ~100 lines)
  context.ts         ← SwarmContext interface + factory (shared state object)
  config.ts          ← SwarmConfig, BeaconConfigInjector, constants
  providers.ts       ← Persona/skill providers and writers
  websocket.ts       ← WebSocket client (connect, send, subscribe, etc.)
  tools-message.ts   ← swarm_message tool
  tools-wiki.ts      ← wiki_read/write/search/list/delete/lint tools
  tools-coordinator.ts ← coordinator spawn/info tools
  hooks.ts           ← Lifecycle hooks (onPluginsLoaded, onBeforePrompt, etc.)
  heartbeat.ts       ← Heartbeat interval + shutdown
```

### Key Design Decision
The factory closure currently shares state via `let` variables. To extract modules, we create a `SwarmContext` interface that bundles all shared state, and each module function receives it as a parameter.

```ts
// context.ts
export interface SwarmContext {
  baseUrl: string;
  sessionId: string;
  registration: DronePluginRegistration;
  beaconPersonas: Map<string, DronePersonaDefinition>;
  coordinatorPersonas: Map<string, DronePersonaDefinition>;
  beaconSkills: Map<string, DroneSkillDefinition>;
  coordinatorSkills: Map<string, DroneSkillDefinition>;
  eventBuffer: Array<{...}>;
  currentCorrelationId: string | null;
  ws: WebSocket | null;
  shuttingDown: boolean;
  logger: DroneLogger;
}
```

### Steps
1. Create `context.ts` with `SwarmContext` interface and `createSwarmContext()` factory
2. Create `config.ts` — extract `BeaconConfigInjector` class, `SwarmConfig` interface, constants
3. Create `providers.ts` — extract 4 provider objects + 4 writer objects
4. Create `websocket.ts` — extract WebSocket client functions
5. Create `tools-message.ts` — extract `swarm_message` tool definition
6. Create `tools-wiki.ts` — extract 6 wiki tool definitions
7. Create `tools-coordinator.ts` — extract coordinator spawn/info tools
8. Create `hooks.ts` — extract lifecycle hooks
9. Create `heartbeat.ts` — extract heartbeat interval + shutdown
10. Rewrite `index.ts` to import from modules and wire everything together

## Tier 2: beacon/db.ts (1,294) + coordinator/db.ts (1,707)

### Shared CRUD Helper (drone-swarm-common)
```ts
// drone-swarm-common/src/db-helpers.ts
export function getRow<T>(db: () => Database.Database, table: string, id: string): T | undefined
export function listRows<T>(db: () => Database.Database, table: string, options?: {
  filter?: string;      // e.g. "WHERE scope = ?"
  params?: unknown[];   // e.g. ['local']
  orderBy?: string;     // e.g. "name ASC"
  transform?: (row: unknown) => T;  // for row-to-object mapping
}): T[]
export function deleteRow(db: () => Database.Database, table: string, id: string): boolean
export function createRow<T extends Record<string, unknown>>(
  db: () => Database.Database, table: string, data: T, logMsg?: string
): T
export function updateRow<T extends Record<string, unknown>>(
  db: () => Database.Database, table: string, id: string,
  data: Partial<T>, existing: T, logMsg?: string
): T | undefined
```

### Beacon Structure
```
drone-beacon/src/db/
  index.ts        ← barrel re-export
  init.ts         ← initDatabase(), getDatabase(), closeDatabase()
  personas.ts     ← createPersona, getPersona, listPersonas, updatePersona, deletePersona, upsertPersonaFromCoordinator
  skills.ts       ← createSkill, getSkill, listSkills, updateSkill, deleteSkill, upsertSkillFromCoordinator
  agents.ts       ← registerAgent, getAgent, listAgents, updateAgentActivity, unregisterAgent
  memory.ts       ← createMemory, getMemory, getMemoryByKey, listMemories, updateMemory, deleteMemory, cleanupExpiredMemories, isMemoryExpired
  messages.ts     ← createMessage, getMessage, listMessagesForAgent, listMessagesByChannel, markMessageDelivered, cleanupOldMessages
  spawns.ts       ← createSpawn, getSpawn, listSpawns, updateSpawnStatus, deleteSpawn, getSpawnByAgentId
  config.ts       ← createBeaconConfig, getBeaconConfig, listBeaconConfig, updateBeaconConfig, deleteBeaconConfig
  event-log.ts    ← createEventLog, getEventLog, listEventLogs, cleanupOldEventLogs
  knowledge.ts    ← cacheKnowledge, getCachedKnowledge, listCachedKnowledge, clearKnowledgeCache, replaceKnowledgeCache
  insights.ts     ← createInsight, listInsights, getInsight, deleteInsight
  principles.ts   ← createPrinciple, listPrinciples, getPrinciple, deletePrinciple
```

### Coordinator Structure
```
drone-coordinator/src/db/
  index.ts
  init.ts
  personas.ts
  skills.ts
  beacons.ts
  beacon-trust.ts
  beacon-sessions.ts
  knowledge.ts
  swarm-sessions.ts
  agent-locations.ts
  insights.ts
  principles.ts
  web-token.ts
  tool-definitions.ts
```

### Steps
1. Create `drone-swarm-common/src/db-helpers.ts` with generic CRUD helpers
2. Create `drone-beacon/src/db/` directory with entity files
3. Update `drone-beacon/src/db/index.ts` to re-export all
4. Update all beacon route files to import from `../db/index.js` (or `../db/personas.js` etc.)
5. Repeat for coordinator

## Tier 3a: LSP Plugin (tools.ts 1,230 + normalize.ts 1,153 + server.ts 1,108)

### tools.ts → tools/ directory
Group related tool factories:
```
drone-agent/src/plugins/lsp/tools/
  index.ts           ← barrel re-export
  diagnostics.ts     ← createGetDiagnosticsTool
  navigation.ts      ← createHoverTool, createGoToDefinitionTool, createFindReferencesTool, createImplementationTool, createTypeDefinitionTool
  symbols.ts         ← createDocumentSymbolsTool, createWorkspaceSymbolTool
  editing.ts         ← createCodeActionTool, createRenameTool, createFormattingTool
  completion.ts      ← createSignatureHelpTool, createCompletionTool
  hierarchy.ts       ← createCallHierarchyIncomingTool, createCallHierarchyOutgoingTool
  status.ts          ← createServerStatusTool
```

### normalize.ts → normalize/ directory
```
drone-agent/src/plugins/lsp/normalize/
  index.ts           ← barrel re-export
  types.ts           ← all Lsp* and Normalized* types
  uri.ts             ← toFileUri, fromFileUri
  range.ts           ← normalizeLspRange, normalizeLspLocation
  hover.ts           ← normalizeHoverContents
  symbols.ts         ← symbol kind tables, formatSymbolKind, flattenDocumentSymbols, normalizeWorkspaceSymbols
  signature-help.ts  ← normalizeSignatureHelp
  completion.ts      ← normalizeCompletionItems
  workspace-edit.ts  ← normalizeTextEdits, normalizeWorkspaceEdit, normalizeCodeActions
  call-hierarchy.ts  ← normalizeCallHierarchyItem, normalizeCallHierarchyCalls
  helpers.ts         ← normalizeSeverity, normalizeMarkupContent, estimateTokenCount, sortDiagnostics, truncateWorkspaceEdit
```

### server.ts → partial split
The factory closure pattern makes full extraction harder. Strategy:
- Extract module-level helpers (pathExists, workspaceHasMarkers, etc.) to `server/helpers.ts`
- Leave the factory closure as-is for now (it's well-organized internally)
- Future: consider converting `createServerManager` to a class

## Tier 3b: self-improvement/index.ts (1,113 lines)

```
drone-agent/src/plugins/self-improvement/
  index.ts           ← barrel + plugin registration
  constants.ts       ← CONFIG_DIR, INSIGHTS_SUBDIR, PRINCIPLES_SUBDIR
  validation.ts      ← VALID_TARGET_TYPES, isValidTargetType, validateTarget, resolveTargetScope, resolveBaseDir
  paths.ts           ← resolveInsightPaths, resolvePrinciplePaths
  io.ts              ← readJsonArray, scanJsonDir
  file-engine.ts     ← createFileInsightEngine, createFilePrincipleEngine
  capability.ts      ← resolveInsightEngine, resolvePrincipleEngine, DroneSelfImprovementCapability
  prompt-fragment.ts ← insight-targets prompt fragment
  tools/
    insight.ts       ← self-improvement__insight tool
    insights-list.ts ← self-improvement__insights-list tool
    insights-recall.ts ← self-improvement__insights-recall tool
    principles-store.ts ← self-improvement__principles-store tool
    principles-list.ts ← self-improvement__principles-list tool
    principles-recall.ts ← self-improvement__principles-recall tool
    principles-delete.ts ← self-improvement__principles-delete tool
```

## Tier 3c: migration-service.ts (1,145 lines)

```
drone-agent/src/runtime/migration/
  index.ts           ← barrel + public API (listAllAssets, migrateAsset, batchMigrate, resolveBeaconAddress)
  types.ts           ← AssetType, LocalScope, SwarmScope, MigrateScope, MigrateOptions, AssetInfo, MigrateResult
  helpers.ts         ← getProjectDir, getUserDir, getLocalBaseDir, getBeaconUrl, getConfigBeaconHost, getConfigBeaconPort
  paths.ts           ← getPersonaDir, getPersonaFilePath, getSkillsDir, getSkillFilePath, getInsightsDir, getPrinciplesDir
  listing.ts         ← listLocalPersonas, listLocalSkills, listLocalInsights, listLocalPrinciples, listBeaconAssets
  beacon-client.ts   ← getBeaconEndpoint, getBeaconItemEndpoint, fetchBeaconAsset, postBeaconAsset, putBeaconAsset, deleteBeaconAsset
  frontmatter.ts     ← extractFrontmatterField
  backup.ts          ← backupAsset
  promote.ts         ← promoteAsset
  demote.ts          ← demoteAsset
  wiki.ts            ← migrateWikiPage
```

## Tier 3d: Test Files

### coordinator/test/routes.test.ts (2,096 lines)
```
drone-coordinator/test/routes/
  health.test.ts
  personas.test.ts
  skills.test.ts
  beacons.test.ts
  knowledge.test.ts
  swarm.test.ts
  messages.test.ts
  insights.test.ts
  principles.test.ts
  spawn.test.ts
  edge-cases.test.ts
```

### drone-agent/test/self-improvement.test.ts (1,607 lines)
```
drone-agent/test/self-improvement/
  setup.ts
  insight.test.ts
  project-insights.test.ts
  prompt-fragment.test.ts
  tool-registration.test.ts
  insights-list.test.ts
  principles.test.ts
```

## Validation Criteria
- [ ] `pnpm typecheck` passes with zero errors
- [ ] `pnpm test` passes with all 1,213 tests
- [ ] All existing imports updated to point to new module paths
- [ ] No functionality changes — pure structural refactoring