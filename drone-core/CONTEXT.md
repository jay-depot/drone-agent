# drone-core

Shared types, contracts, config defaults, and token estimation for all drone packages. The foundation package that every other package depends on.

## Language

**Config Layer**:
One level in the config cascade (default, user, project, beacon, coordinator). Each layer is a `.drone-agent/config.json` file or an injected underlay.
_Avoid_: Config level, config tier

**Capability**:
An API that one plugin offers to other plugins via `registration.offer()` / `registration.request()`. Examples: `DroneConfigCapability`, `DroneSelfImprovementCapability`, `DronePrinciplesCapability`.
_Avoid_: Plugin API, service, feature

**Provider**:
A source of identity assets (personas or skills). Providers are sorted by precedence; lower number wins for conflicts. Examples: `persona-provider-project`, `skill-provider-user`, swarm beacon/coordinator providers.
_Avoid_: Source, store, backend

**Storage Engine**:
A registered handler for reading/writing insights or principles to a specific backend. The self-improvement broker delegates to the owning provider's storage engine.
_Avoid_: Storage backend, persistence layer
