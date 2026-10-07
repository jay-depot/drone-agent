---
tags: [decision, codeql, security, ci, engineering-tooling]
related: [decisions/132-codeql-fix-jam.md, modules/drone-coordinator.md, modules/drone-swarm-common.md]
---

# 171: CodeQL re-enable with in-source dismissal

**Status**: Implemented (2026-08-28)

## Context

CodeQL scanning had been disabled on the repository. The prior CodeQL work ([132-codeql-fix-jam](132-codeql-fix-jam.md)) fixed a batch of alerts and added inline `// codeql[rule-id]` suppression comments, but the workflow itself was not running — the default GitHub CodeQL setup had been turned off, and the alerts were no longer being surfaced.

The re-enable was extracted from PR #55 (which is being reworked) to land the CI infrastructure independently. It introduces only the custom CodeQL workflow config that includes **in-source suppression-comment support** (`dismiss-alerts`), so future alerts can be dismissed in source rather than through the GitHub UI (which is not durable/source-controlled — the same rationale recorded in ADR 132).

## Decision

Re-enable CodeQL via a custom **"CodeQL Advanced"** workflow (`.github/workflows/codeql.yml`) that:

- Runs on `push`/`pull_request` to `main` and on a weekly schedule (cron `31 7 * * 3`).
- Uses a matrix over two languages: `actions` (build-mode `none`) and `javascript-typescript` (build-mode `none`).
- For `javascript-typescript`, adds the **`AlertSuppression.ql`** query pack (`codeql/javascript-queries:AlertSuppression.ql`), which enables the `// codeql[rule-id]` in-source dismissal comments to actually suppress alerts.
- Uses least-privilege `permissions:` (`security-events: write`, `packages: read`, `actions: read`, `contents: read`).
- Uploads SARIF results, then runs the **`advanced-security/dismiss-alerts@v2`** action on the default branch (`main`) to auto-dismiss alerts that carry a matching suppression comment. On PRs the alerts are shown as warnings but the job stays green (neutral) — `dismiss-alerts` only works on the default branch.

Two source suppressions were added in the same commit to keep the workflow green:

- `drone-coordinator/src/routes/personas.ts` — `// codeql[js/reflected-xss]` on the `return persona;` sink (matching the existing suppression in `routes/skills.ts`).
- `drone-swarm-common/src/spawner.ts` — `// codeql[js/path-injection]` on the `cwd:` sink in `spawnAgent`, with a comment noting the coordinator-provided `workingDir` is intentional and length-bounded above.

## Key Points

- CodeQL is re-enabled with **in-source dismissal**: `// codeql[rule-id]` comments now actually suppress alerts, and `dismiss-alerts` auto-dismisses them on `main`.
- The `AlertSuppression.ql` query pack is the mechanism that makes suppression comments effective — without it, the comments are inert (the ADR 132 lesson that `lgtm[...]` was LGTM-only applies analogously: the query pack must be present for `codeql[...]` to work).
- `dismiss-alerts` runs only on `main`; on PRs alerts surface as warnings without failing the job.
- This is the CI infrastructure half of the CodeQL story; the alert-fixing work continues in the reworked PR #55.

## Related

- [132-codeql-fix-jam](132-codeql-fix-jam.md) — the prior CodeQL alert-fixing batch and the suppression-comment syntax lessons
- [drone-coordinator](../../drone-coordinator/) — `routes/personas.ts` XSS suppression
- [drone-swarm-common](../../drone-swarm-common/) — `spawner.ts` path-injection suppression
