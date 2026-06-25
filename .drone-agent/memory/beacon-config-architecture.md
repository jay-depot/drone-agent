---
key: beacon-config-architecture
tags:
  - beacon
  - config
  - architecture
  - hook
  - injector
  - underlay
  - swarm
  - plan
created: 2026-06-25T03:58:34.666Z
updated: 2026-06-25T03:58:34.666Z
---

# Beacon Config Override - Architecture Plan

## Core Principle: Underlay, Not Overlay

Config operates on **"most local wins"** basis. Therefore:
- **Beacon config = underlay** (applied first, provides defaults)
- **Agent config = overlay** (applied second, wins for conflicts)

```
Final Config = System Defaults → Coordinator → Beacon (underlay) → Agent (overlay)
```

## Config Hook System

### 1. Core Hook Interface

```typescript
interface ConfigInjector {
  /** Unique identifier for this injector */
  id: string;
  
  /** Priority (lower = runs first = underlay) */
  priority: number;
  
  /** Inject config values that will be merged as underlay */
  inject(): Promise<Record<string, unknown>>;
  
  /** Optional: watch for config changes and react */
  onConfigChanged?(key: string, value: unknown): void;
}
```

### 2. Hook Registration

```typescript
interface ConfigSystem {
  /** Register a config injector */
  registerInjector(injector: ConfigInjector): void;
  
  /** Unregister a config injector */
  unregisterInjector(id: string): void;
  
  /** Get all registered injectors (sorted by priority) */
  getInjectors(): ConfigInjector[];
}
```

### 3. Config Merge Pipeline

```typescript
async function buildConfig(): Promise<ResolvedConfig> {
  // 1. Load system defaults
  let config = await loadSystemDefaults();
  
  // 2. Apply coordinator config (if connected)
  config = merge(config, await coordinatorConfig);
  
  // 3. Apply injectors (sorted by priority, lower first)
  const injectors = configSystem.getInjectors();
  for (const injector of injectors) {
    const injected = await injector.inject();
    config = merge(config, injected); // underlay: injected underlays existing
  }
  
  // 4. Apply local agent config (wins for conflicts)
  config = merge(config, agentLocalConfig);
  
  return config;
}
```

### 4. Merge Function (Underlay Logic)

```typescript
function merge(base: Config, underlay: Config): Config {
  // Underlay provides defaults; base values win
  return {
    ...underlay,
    ...base,
  };
}
```

## Beacon Integration (Swarm Plugin)

### 1. BeaconConfigInjector

```typescript
class BeaconConfigInjector implements ConfigInjector {
  id = 'beacon';
  priority = 50; // runs after coordinator (0-100 range), before agent (100+)
  
  private beaconUrl: string;
  private cachedConfig: Record<string, unknown> = {};
  
  constructor(beaconUrl: string) {
    this.beaconUrl = beaconUrl;
  }
  
  async inject(): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(`${this.beaconUrl}/config`);
      const entries = await response.json();
      
      // Parse JSON values and cache
      this.cachedConfig = {};
      for (const entry of entries) {
        this.cachedConfig[entry.key] = JSON.parse(entry.value);
      }
      
      return this.cachedConfig;
    } catch (error) {
      // On failure, return cached config if available
      return this.cachedConfig;
    }
  }
  
  onConfigChanged?(key: string, value: unknown): void {
    // Notify agent of beacon-driven config changes
    eventBus.emit('config:beacon-update', { key, value });
  }
}
```

### 2. Plugin Integration

```typescript
class SwarmPlugin {
  private beaconInjector: BeaconConfigInjector;
  
  async connect(beaconUrl: string): Promise<void> {
    // Register beacon as config injector
    this.beaconInjector = new BeaconConfigInjector(beaconUrl);
    configSystem.registerInjector(this.beaconInjector);
    
    // Initial config load
    await configSystem.rebuild();
  }
  
  disconnect(): void {
    configSystem.unregisterInjector(this.beaconInjector.id);
  }
}
```

## Architecture Components

### Files to Modify

1. **`config/system.ts`** — Add injector registry and pipeline
2. **`config/types.ts`** — Add `ConfigInjector` interface
3. **`plugins/swarm/index.ts`** — Implement `BeaconConfigInjector`
4. **`beacon/routes/config.ts`** — Add REST endpoints (from spec)

### New Files

1. **`config/injectors/beacon.ts`** — Reusable beacon injector class
2. **`config/injectors/coordinator.ts`** — Future: coordinator injector

## Priority Order

| Injector | Priority | Purpose |
|----------|----------|---------|
| System Defaults | 0 | Baseline |
| Coordinator | 50 | Org-wide defaults |
| **Beacon** | **75** | **Host-specific defaults (underlay)** |
| Agent Local | 100 | User/project config (wins) |

## Reconnection Handling

- Beacon config cached on disconnect
- On reconnect, re-fetch and trigger config rebuild
- Agent notified of changes via `config:beacon-update` event

## Implementation Order

1. **Phase 1**: Add hook system to config (injector registry, pipeline)
2. **Phase 2**: Add beacon REST endpoints (from original spec)
3. **Phase 3**: Implement `BeaconConfigInjector` in swarm plugin
4. **Phase 4**: Add event notification for config changes
5. **Phase 5**: Handle reconnection edge cases