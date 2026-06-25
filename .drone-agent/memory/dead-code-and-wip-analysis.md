---
key: dead-code-and-wip-analysis
tags:
  - analysis
  - dead-code
  - wip
  - cleanup
created: 2026-06-25T07:06:58.698Z
updated: 2026-06-25T07:06:58.698Z
---

# Dead Code and WIP Feature Analysis

## Summary

Analysis of LSP hints (unused variables, unreachable code) sorted into WIP features vs pure dead code.

---

## 🔧 WIP Features (Likely Intended for Future Use)

These are intentionally unused - prepared for future phases of the swarm architecture.

| File | Variable | Context | Evidence |
|------|----------|---------|----------|
| `drone-agent/src/plugins/swarm/index.ts` | `randomUUID` | Imported but not used | The swarm plugin has partial implementation. The roadmap mentions beacon-level config override is TODO, and there's a `BeaconConfigInjector` class that may need UUIDs later for cache keys or request IDs |
| `drone-agent/src/plugins/index.ts` | `createSwarmPlugin`, `SwarmConfig` | Exported but not used in index | These are exported for programmatic use but the main plugin uses the default export. The swarm feature is in use but this export pattern is prepared for future |
| `drone-agent/src/plugins/self-improvement/index.ts` | `InsightFile`, `PrinciplesFile` | Types declared but not used | Self-improvement is partially implemented (Phase 1 complete per roadmap), but principles/insights sync to coordinator is TODO. These types may be needed when Phase 3-5 are implemented |
| `drone-agent/src/plugins/self-improvement/index.ts` | `principlesDir` | Declared but unused | Same as above - principles directory handling is prepared but not wired up yet |
| `drone-agent/src/plugins/lsp/server.ts` | `language` | Declared in unused branch | LSP server has fallback handling for language detection that's not currently reached |
| `drone-agent/src/plugins/compaction/index.ts` | Async hint on line 24 | May become async | The compaction function may need async capabilities in the future |
| `drone-agent/src/first-run.tsx` | `React`, `llm` | Unused imports/params | First-run setup is likely being enhanced - React for future UI components, llm for provider probing |
| `drone-beacon/src/routes.ts` | `reply`, `spawnRecord`, `request` | Multiple unused variables | Phase 2 of beacon has TODOs - inter-agent messaging and agent spawn execution are not fully implemented. These are likely prepared for those features |

---

## 🗑️ Pure Dead Code (Can Be Cleaned Up)

These are unused variables that serve no purpose and can be removed.

| File | Variable | Line | Action |
|------|----------|------|--------|
| `drone-agent/src/interactive.ts` | `logger` | 82 | Dead code - parameter declared but never used |
| `drone-agent/src/interactive.ts` | `options` | 162 | Dead code - parameter declared but never used |
| `drone-agent/src/plugins/macros/parser.ts` | `match` | 182, 202 | Dead code - two unused variables in parser branches |
| `drone-agent/src/tui/components/Markdown.tsx` | `Lexer` | 13 | Dead code - imported but not used |
| `drone-agent/src/tui/components/Markdown.tsx` | `i` | 100 | Dead code - unused loop variable |
| `drone-beacon/src/ws-server.ts` | `intervalHours` | 297 | Dead code - declared but never used |
| `drone-coordinator/src/db.ts` | `randomUUID` | 1 | Dead code - imported but never used |
| `drone-agent/src/plugins/subagent/plugin.ts` | Unreachable code | 62 | Dead code - the return is after exit, never reached |

---

## 📝 Test Files (Low Priority)

Most hints in test files (~28) are unused imports that test frameworks require. These are common and usually intentional - kept for reference or potential future test coverage.

---

## Counts

- **WIP Features**: ~12 hints - intentionally unused code prepared for future phases
- **Dead Code**: ~8 hints in main code - can be cleaned up
- **Test files**: ~28 hints - low priority

---

## References

- See `roadmap` memory for Phase 1-5 details
- See `drone-swarm-plugin-for-alice` memory for swarm plugin design notes
- Self-improvement TODOs: Push to coordinator on session end, sync knowledge from coordinator
- Beacon TODOs: Inter-agent messaging, agent spawn execution, memory store, event log