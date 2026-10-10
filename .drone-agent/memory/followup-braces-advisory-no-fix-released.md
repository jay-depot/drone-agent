---
key: followup-braces-advisory-no-fix-released
tags: []
created: 2026-10-09T02:00:30.414Z
updated: 2026-10-09T02:00:30.414Z
---

drone-agent: GHSA-vfj7-8cjw-p6xm (braces <=3.0.3, stack-exhaustion DoS via deeply nested patterns) has NO fixed release yet — advisory floor 3.0.4, registry latest still 3.0.3 (checked 2026-10-09). Covered in the audit gate via `auditConfig.ignoreGhsas` in pnpm-workspace.yaml. Followup: when braces@3.0.4+ ships, remove the ignoreGhsas entry, remove the braces comment block, add `braces: ^3.0.4` to overrides (parent micromatch@4.0.8 declares ^3.0.3 so re-resolution alone may not lift it), pnpm install, verify `pnpm audit` reports zero. Related: memory drone-agent-dependabot-pnpm-overrides-rollup.
