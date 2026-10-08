---
tags: [decision]
related:
  [
    broker-provider.md,
    identity-assets.md,
    entities/Persona.md,
    entities/Skill.md,
  ]
---

# ADR 029: Dynamic Writer Registration for Persona and Skills Creation

**Status**: Accepted (2026-06-30)

## Context

The `persona__create` and `skills__create` workflows had two hard-coded scope choices (`'project'` and `'user'`) in their `askScope` functions, and wrote directly to the filesystem. The swarm plugin already registered read-side providers for beacon and coordinator scopes, but the creation workflows didn't know about them — so users couldn't create personas or skills directly on the beacon or coordinator through the wizard.

## Decision

Add a **writer registration** mechanism to the `DronePersonaCapability` and `DroneSkillsCapability` interfaces. Each provider plugin (project, user, swarm) registers a writer alongside its existing read provider. The creation workflows query the capability for available writers and present them dynamically, delegating the actual write to the selected writer.

## Design

### New Types

Two new types in `drone-core/src/provider-types.ts`:

- `DronePersonaWriter` — has `id`, `scope`, `label`, `exists(id)`, and `writePersona(id, content)` methods
- `DroneSkillWriter` — has `id`, `scope`, `label`, `exists(id)`, and `writeSkill(id, content)` methods

The `exists` method allows the wizard to check for existing assets before calling the LLM, supporting the overwrite-confirmation flow.

### Capability Extensions

Both `DronePersonaCapability` and `DroneSkillsCapability` gained three new methods:

- `registerWriter(writer)` — register a writer (sorted by scope order)
- `unregisterWriter(writerId)` — unregister a writer by id
- `getWriters()` — return all registered writers

### Writer Implementations

| Provider Plugin            | Writer Scope  | Storage Backend                                                                         |
| -------------------------- | ------------- | --------------------------------------------------------------------------------------- |
| `persona-provider-project` | `project`     | Filesystem: `.drone-agent/personas/<id>/persona.md`                                     |
| `persona-provider-user`    | `user`        | Filesystem: `~/.drone-agent/personas/<id>/persona.md`                                   |
| `skill-provider-project`   | `project`     | Filesystem: `.drone-agent/skills/<id>.md`                                               |
| `skill-provider-user`      | `user`        | Filesystem: `~/.drone-agent/skills/<id>.md`                                             |
| `swarm` (beacon)           | `beacon`      | HTTP POST to `{beaconUrl}/personas` or `{beaconUrl}/skills`                             |
| `swarm` (coordinator)      | `coordinator` | HTTP POST to `{beaconUrl}/personas` or `{beaconUrl}/skills` with `scope: 'coordinator'` |

### Wizard Changes

Both wizards now:

1. Resolve the broker capability via `requestCapability`
2. Call `cap.getWriters()` to discover available scopes
3. Build elicit choices dynamically from writer labels
4. Delegate the actual write to the selected writer's `writePersona`/`writeSkill` method
5. Use `writer.exists()` for overwrite checks instead of direct filesystem access

## Rationale

- **No kludges**: The existing provider registration pattern was extended symmetrically with writers — same registration/unregistration lifecycle, same sorted ordering
- **Backward compatible**: When only project and user providers are enabled, the wizard shows exactly the same two choices as before
- **Swarm-ready**: When the swarm plugin is enabled, beacon and coordinator scopes appear automatically without any changes to the wizard code
- **Separation of concerns**: Writers are owned by the same plugins that own the storage — the wizard doesn't need to know about filesystem paths or HTTP endpoints

## Consequences

- Provider plugins now register both a provider (read) and a writer (write) with the broker
- The wizard no longer imports `node:fs/promises` or `node:os` directly — all filesystem access is through writers
- The `inputSchema` `scope` field description now says "One of: project, user, beacon, coordinator" instead of just "project or user"
- The `PersonaCreateInput` and `SkillsCreateInput` types broadened `scope` from `'project' | 'user'` to `string`
- The wizard throws a clear error if no writers are registered (e.g., no provider plugin enabled)

## Related

- broker-provider — The broker + provider pattern that this extends
- identity-assets — Personas and skills as identity assets
- [Persona](../../drone-core/src/domain-types.ts) — Persona definition and creation
- [Skill](../../drone-core/src/domain-types.ts) — Skill definition and creation
