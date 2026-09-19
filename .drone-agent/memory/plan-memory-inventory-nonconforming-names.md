---
key: plan-memory-inventory-nonconforming-names
tags:
  - audit
  - plan
  - convention
created: 2026-09-19T00:34:17.502Z
updated: 2026-09-19T00:34:17.502Z
---

Plan-document inventory / naming audit (2026-09-18). There are 12 `plan-*.md` memories plus 6 plan documents under OTHER names: slash-commands-during-work-fix (tagged `plan`, "# Plan:" heading + Steps/Validation criteria), fix-swarm-config-underlay-rebuild (tagged `plan`, "# PLAN —" + Steps/Validation status), fix-swarm-wiki-write-error-masking (tagged `plan`, "# PLAN —" + Steps/Validation criteria), conversation-assembly-cleanup ("# Plan:" heading, tags: []), image-content-refactor-v2 (tagged `plan`; completed-change record, not step-wise), mcp-resource-block-future-plan (tagged `plan`; future-work note, not step-wise). Plus seed-receiver-side-env-var-interpolation is a plan SEED (consumed). Consequence: a filename-prefix scan for `plan-*` misses 6 plan documents; a `plan` tag scan misses conversation-assembly-cleanup, plan-codeql-uncontrolled-data-path-expression, plan-lsp-symbolic-resolution-improvements, and plan-coordinator-config-ui-and-secret-handling (all have `tags: []`). Only plan-integration-test-beacon-isolation carries frontmatter `status: completed`; every other finished plan records completion in the body ("## Status — COMPLETE", "# EXECUTED ...", "COMPLETED (date)"). Plan-adjacent (not plans): roadmap, swarm-memory-phase-2-backlog, llm-provider-future-work, db-refactoring-phase-2, db-migrations-system-deferred, memory-wiki-browser-improvements (explicitly "ready-to-plan" backlog).
