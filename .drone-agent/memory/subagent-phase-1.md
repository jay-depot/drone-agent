---
key: subagent-phase-1
tags:
  - subagents
  - phase-1
  - cli
  - detection
created: 2026-06-24T22:32:34.143Z
updated: 2026-06-24T22:32:34.143Z
---

# Phase 1: CLI + Detection — Detailed Plan

## Goal

Add CLI flags for subagent mode and persona selection, and create the subagent plugin that detects session mode and conditionally exposes tools.

---

## Step 1.1: Extend CLI Options (`src/cli.ts`)

Add to `CliOptions` type:

```typescript
export type CliOptions = {
  once: boolean;
  outputPlain: boolean;
  outputJson: boolean;
  modelOverride?: string;
  configDir?: string;
  pluginOverrides: string[];
  // NEW:
  subagentId?: string;   // If present, running as subagent
  persona?: string;       // Startup persona override
  // ...
};
```

Add parsing for new flags:

```typescript
} else if (arg === '--subagent-id' && i + 1 < argv.length) {
  options.subagentId = argv[++i];
} else if (arg === '--persona' && i + 1 < argv.length) {
  options.persona = argv[++i];
}
```

Also check env var fallback in `parseCliArgs`:

```typescript
// After parsing all args
options.subagentId ??= process.env.DRONE_SUBAGENT_ID;
options.persona ??= process.env.DRONE_PERSONA;
```

---

## Step 1.2: Pass CLI Options to Plugin Engine

Add to `CreateDronePluginEngineOptions`:

```typescript
type CreateDronePluginEngineOptions = {
  plugins: DronePlugin[];
  config: DroneAgentConfig;
  logger?: DroneLogger;
  // NEW:
  runtimeOptions?: {
    subagentId?: string;
    persona?: string;
  };
};
```

Then pass from `index.tsx`:

```typescript
const engine = createDronePluginEngine({
  plugins,
  config: resolvedConfig.config,
  logger,
  runtimeOptions: {
    subagentId: invocation.options.subagentId,
    persona: invocation.options.persona,
  },
});
```

---

## Step 1.3: Expose Runtime Options to Plugins

Add a capability that plugins can query. In plugin-engine.ts, register as a capability during init:

```typescript
offer: (capability) => {
  capabilities.set(plugin.metadata.id, capability);
  // NEW: also set a special 'runtime' capability
  capabilities.set('runtime', {
    subagentId: runtimeOptions?.subagentId,
    persona: runtimeOptions?.persona,
    isSubagent: !!runtimeOptions?.subagentId,
  });
},
```

---

## Step 1.4: Create Subagent Plugin Skeleton

Create `src/plugins/subagent/plugin.ts`:

```typescript
import type { DronePlugin } from 'drone-core';

export const subagentPlugin: DronePlugin = {
  metadata: {
    id: 'subagent',
    name: 'Subagent Dispatch',
    description: 'Enables dispatching subagents for parallel task execution',
    defaultEnabled: true,  // Always enabled to detect mode
  },
  
  async register(ctx) {
    // Get runtime options to determine mode
    const runtime = ctx.request<{
      subagentId?: string;
      persona?: string;
      isSubagent: boolean;
    }>('runtime');
    
    if (runtime?.isSubagent) {
      // === SUBAGENT MODE ===
      // Register only the return tool
      ctx.registerTool({
        name: 'subagent.return',
        description: 'Return the result to the parent agent',
        input: {
          result: { type: 'string', description: 'The result to send back' },
          error: { type: 'string', description: 'Optional error info', required: false },
        },
        execute: async (input) => {
          // Output JSON return event and exit
          const output = {
            type: 'return',
            result: input.result,
            error: input.error,
          };
          console.log(JSON.stringify(output));
          process.exit(0);
        },
      });
    } else {
      // === MAIN AGENT MODE ===
      // Register only the dispatch tool
      ctx.registerTool({
        name: 'subagent.dispatch',
        description: 'Launch a subagent to handle a task in parallel',
        input: {
          task: { type: 'string', description: 'The prompt to send to subagent' },
          persona: { type: 'string', description: 'Optional persona', required: false },
          timeout: { type: 'number', description: 'Timeout in ms', required: false },
        },
        execute: async (input) => {
          // TODO: Phase 2 implementation
          return JSON.stringify({ result: 'not implemented' });
        },
      });
    }
  },
};
```

Create `src/plugins/subagent/index.ts`:

```typescript
export { subagentPlugin } from './plugin.js';
```

---

## Step 1.5: Register Plugin

Add to `src/plugins/index.ts`:

```typescript
import { subagentPlugin } from './subagent/index.js';

// Add to staticBuiltInPlugins array
const staticBuiltInPlugins: DronePlugin[] = [
  subagentPlugin,  // NEW
  startupPlugin,
  // ... rest
];
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/cli.ts` | Add `--subagent-id`, `--persona` flags with env fallback |
| `src/runtime/plugin-engine.ts` | Accept `runtimeOptions` param, expose as capability |
| `src/index.tsx` | Pass CLI options to engine |
| `src/plugins/index.ts` | Register subagent plugin |
| `src/plugins/subagent/plugin.ts` | **Create** — conditional tool registration |
| `src/plugins/subagent/index.ts` | **Create** — export |

---

## Acceptance Criteria

1. ✅ `drone-agent --help` shows new `--subagent-id` and `--persona` flags
2. ✅ `DRONE_SUBAGENT_ID=x drone-agent` sets subagent mode (same for `DRONE_PERSONA`)
3. ✅ When running with `--subagent-id`, only `subagent.return` tool is available
4. ✅ When running without `--subagent-id`, only `subagent.dispatch` tool is available
5. ✅ Both modes can coexist in same session (main agent spawns subagent)