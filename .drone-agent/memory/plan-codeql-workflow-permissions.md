---
key: plan-codeql-workflow-permissions
tags: []
created: 2026-08-14T18:47:10.086Z
updated: 2026-08-14T18:47:10.086Z
---

# Plan: CodeQL — "Workflow does not contain permissions"

## Summary

CodeQL flags `.github/workflows/integration-test.yml` for missing a top-level `permissions:` block. GitHub Actions defaults to permissive permissions when none are declared; adding an explicit least-privilege `permissions:` block is the documented hardening fix.

## What the workflow needs

The workflow has two jobs:

- **`unit-tests`** — `actions/checkout`, `pnpm/action-setup`, `actions/setup-node`, install/typecheck/test/lint. Needs `contents: read` (checkout).
- **`integration-tests`** — `actions/checkout`, `docker/setup-buildx-action`, docker build/run, `actions/upload-artifact`. Needs `contents: read` (checkout) and `actions: write` (upload-artifact).

## Steps

1. `.github/workflows/integration-test.yml` — add a top-level `permissions:` block (after the `on:` block, before `jobs:`):
   ```yaml
   permissions:
     contents: read
     actions: write
   ```
   - `contents: read` — required by `actions/checkout`.
   - `actions: write` — required by `actions/upload-artifact` (the `Upload results` step).
   - This is the minimal set; nothing else in the workflow writes to the repo or needs elevated scope.
2. No behavior change, no tests needed (config-only change).
3. Validation: LSP zero errors (YAML LSP is connected); `pnpm -r run lint` zero errors; `pnpm -r run build` zero errors; fast test suite passes. (These are unaffected by a workflow change, but run the standard gates.)
4. After commit, re-run code scanning — the alert will be marked suppressed.

## Files touched

- .github/workflows/integration-test.yml

## Notes

- Only one workflow file exists in the repo, so this single block clears the alert.
- If a future workflow needs write access to the repo (e.g. pushing tags, opening PRs), that job would need its own `permissions:` override — but none of the current jobs do.
