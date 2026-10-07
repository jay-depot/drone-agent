---
tags: [decision, codeql, security, hardening, suppression]
related: [modules/drone-beacon.md, modules/drone-coordinator.md, modules/drone-swarm-common.md, modules/drone-agent-plugins.md, decisions/117-tofu-fingerprint-pinning.md]
---

# 132. CodeQL Fix-Jam — Suppressions, Dead-Code Removal, and Length Guards

**Summary**: A batch of small CodeQL hardening fixes addressing several code-scanning alerts: reflected XSS suppressions (4), a no-op substring replacement removal, TLS suppression-comment syntax fix (`lgtm` → `codeql`), a workflow `permissions:` block, and a polynomial-regex length guard in wiki-storage.

## Context

GitHub CodeQL flagged several alerts across the monorepo. Investigation revealed two recurring themes:

1. **`// lgtm[rule-id]` comments do NOT suppress GitHub CodeQL alerts.** `lgtm[...]` is LGTM.com-only syntax (LGTM.com shut down Dec 2022). The correct, currently-supported inline suppression is `// codeql[rule-id]`, placed on the sink line or the line immediately before it. The rule ID must match exactly including the `js/` prefix — TypeScript is analyzed by the JS query suite, so there is no `ts/` variant. Suppression targets the sink location, not the source/intermediate lines; a comment in a JSDoc block far from the sink is ineffective. One comment per alert location. `// nosemgrep` is Semgrep-only (irrelevant); `paths-ignore` config is too coarse (blinds whole files); UI/API dismissal is not durable/source-controlled.

2. **Polynomial regexes on config/user-sourced strings are flagged as "uncontrolled data".** The minimal, behavior-preserving mitigation is a length cap on the input before the regex runs, rather than rewriting the regex or adding a suppression comment. This bounds the polynomial match to a fixed-size input.

## Decisions

### 1. Reflected XSS suppressions (4 alerts)

CodeQL flagged "Reflected cross site scripting" at 4 `return skill;` / `return persona;` statements in Fastify PUT handlers where request-body data flows back out in the JSON response. Data is trusted (single-user swarm); the consuming React web UI auto-escapes (zero `dangerouslySetInnerHTML`/`innerHTML` usages), so there is no real XSS sink. Added `// codeql[js/reflected-xss]` on the line immediately before each sink:

- `drone-coordinator/src/routes/skills.ts` → `return skill;`
- `drone-coordinator/src/routes/personas.ts` → `return persona;`
- `drone-beacon/src/routes/skills.ts` → `return skill;`
- `drone-beacon/src/routes/personas.ts` → `return persona;`

### 2. No-op substring replacement removal

CodeQL flagged `drone-agent/test/git-name-status.test.ts:40` — `.replace(/\t/g, '\t')` replaces a tab with a tab, a no-op. Removed the pointless `.replace(...)` call (dead code in a test). No behavior change.

### 3. TLS suppression-comment syntax fix

The existing `// lgtm[js/disabling-certificate-verification]` comments in `drone-beacon/src/coordinator-client.ts` did NOT suppress the CodeQL alert. Fixed:
- Removed the ineffective ` * lgtm[...]` line from the JSDoc block (far from the sink).
- Changed the correctly-placed `// lgtm[...]` (immediately before the sink `(options as https.RequestOptions).rejectUnauthorized = false;`) to `// codeql[js/disabling-certificate-verification]`.

### 4. Workflow permissions block

CodeQL flagged `.github/workflows/integration-test.yml` for missing a top-level `permissions:` block. GitHub Actions defaults to permissive permissions when none are declared. Added a least-privilege block:

```yaml
permissions:
  contents: read
  actions: write
```

- `contents: read` — required by `actions/checkout`.
- `actions: write` — required by `actions/upload-artifact` (the `Upload results` step).

### 5. Wiki-storage polynomial-regex length guard

CodeQL flagged `drone-swarm-common/src/wiki-storage.ts` — the regex `/\[\[([^\]]+)\]\]/g` in `extractWikiLinks()` as "Polynomial regular expression used on uncontrolled data". `content` (markdown page body) is user-supplied and flows into the regex from both `writePage()` and `lintPages()`. The regex is actually linear, but per project convention the minimal, behavior-preserving mitigation is a length cap on the input before the regex runs.

- Added `const MAX_WIKI_CONTENT_LENGTH = 1_000_000;` (1MB — generous, far beyond any real wiki page; purely a safety bound).
- `extractWikiLinks()` throws when content exceeds the limit.
- `writePage` keeps the throw (rejects the write).
- `lintPages` wraps the call in try/catch and `continue`s (skips link extraction for the oversized page) so lint degrades gracefully — lint has no "warnings" concept today (returns only `{ issues }`).

## Result

All 5 CodeQL alert classes addressed. Validation: LSP clean, `pnpm lint` clean, `pnpm -r run build` clean, fast test suite passes (1913 tests). After commit, re-running code scanning marks the alerts suppressed.

## Follow-up (recorded 2026-09-18)

The **`js/path-injection` sinks in `wiki-storage.ts`** (the four `pagePath` call sites plus `resolvePageScope`) were not part of this ADR's five classes, but were later cleared the same way — **in-source `// codeql[js/path-injection]` dismissals** on each sink, with the comment stating that `pagePath()` sanitizes the id to `[a-zA-Z0-9_-]` (dots become underscores, so `..` traversal is impossible). The `spawner.ts` `cwd:` sink got the same treatment (see [171-codeql-reenable-in-source-dismissal](171-codeql-reenable-in-source-dismissal.md)).

A companion planning document had proposed a **different** fix — a `MAX_PAGE_ID_LENGTH = 4096` length guard inside `pagePath()` (with over-length `readPage`/`deletePage` returning `null`/`false` gracefully), plus an over-length page-ID test suite. That approach was **not** implemented: `pagePath` has no length check and `wiki-storage.test.ts` has no over-length-ID tests. The sanitization argument made the guard redundant for the traversal class, and the in-source dismissal is what actually keeps scanning green. The spawner half of that plan *was* implemented as written (`MAX_WORKING_DIR_LENGTH = 4096` + throw + a new `spawner.test.ts`), because a *length* bound is the right control there — dots are legitimate in a directory path.

> Recorded because the plan memory `plan-codeql-uncontrolled-data-path-expression` was deleted from project memory after ingest; this note preserves the distinction between the planned `pagePath` guard (not done) and the shipping suppression (done).

## Related

- [drone-beacon](../../drone-beacon/) — coordinator-client.ts TLS suppression, routes/skills.ts + routes/personas.ts XSS suppressions
- [drone-coordinator](../../drone-coordinator/) — routes/skills.ts + routes/personas.ts XSS suppressions
- [drone-swarm-common](../../drone-swarm-common/) — wiki-storage.ts length guard
- [drone-agent-plugins](../../drone-agent/src/plugins/) — git plugin test no-op removal
- [117-tofu-fingerprint-pinning](117-tofu-fingerprint-pinning.md) — earlier CodeQL suppression work for TLS
