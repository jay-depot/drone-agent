---
key: plan-file-apply-diff-tui-cosmetic
tags:
  - plan
  - tui
  - file__apply_diff
created: 2026-07-19T20:30:51.633Z
updated: 2026-07-19T20:30:51.633Z
---

Plan: cosmetic TUI change for file__apply_diff. Wire renderComponent into registerTool in file.ts. Create component using state.scheme (Ink, red/green). Line-numbered diff snippet format. Only for file__apply_diff TUI display. Validation: LSP pass, lint/build pass, tests pass.