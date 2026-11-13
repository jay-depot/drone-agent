---
key: followup-adr-index-duplicate-rows-and-missing-entries
tags:
  - followup
  - docs
  - adr
  - integrity
  - index
created: 2026-11-09T22:44:12.845Z
updated: 2026-11-09T22:44:12.845Z
---

# Followup — `docs/adr/index.md` has duplicated rows, missing entries, and misplaced frontmatter

**Found**: 2026-11-09, during `plan-fix-extension-registry-navigation-teardown` (ADR 273).

## Problem

`docs/adr/index.md` does not match the ADR directory. As of 2026-11-09:

- **Row count ≠ file count**: 294 rows vs 272 files (295 vs 273 after ADR 273).
  This is pre-existing — at `8fb54725^` it was 293 rows vs 271 files, i.e. broken
  before ADR 273 and before ADR 272.
- **27 duplicated ADR numbers**: 171, 172, 176, 177, 178, 179, 180, 181, 182,
  183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197,
  217, 218, 219. Most appear twice (once in an early unsorted block, once later);
  some bodies differ between the two copies (e.g. 176, 178–181, 187, 189–196).
- **5 ADRs with no row at all**: 239-herdr-agent-integration,
  249-gateway-portable-context-continuity-and-outbound-ledger,
  250-gateway-surface-modes, 255-mcp-swarm-http-transport-and-tokens,
  266-pure-insertion-ambiguity.
- **Misplaced frontmatter**: a YAML frontmatter block (`---` … `tags`/`related`
  … `---`) sits at lines ~6–10, i.e. AFTER the first 5 rows, not at the top.
- **Stray second table header**: a second `| Page | … |` header + separator
  around line 76, splitting the table.

## Impact

Any "row count == file count" integrity check fails. The ADR index is the
canonical decision catalog, so duplicates and omissions degrade discoverability
and make automated integrity checks unusable.

## Suggested repair (dedicated pass)

1. Parse all rows; key by ADR number.
2. For each duplicated number, keep the copy whose body is more complete /
   current; drop the other.
3. Add a row for each of the 5 missing ADRs (239, 249, 250, 255, 266).
4. Move the frontmatter block to the very top of the file.
5. Remove the stray second `| Page |` header + separator; merge into one table.
6. Verify: `ls docs/adr | grep -E '^[0-9]{3}-' | wc -l` == `grep -c '^| \[' docs/adr/index.md`,
   no duplicate numbers, no prose/blank gap above the first row.

This is a docs-only change; do it on a docs branch and keep the repair separate
from feature work.
