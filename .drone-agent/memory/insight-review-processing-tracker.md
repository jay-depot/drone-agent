---
key: insight-review-processing-tracker
tags:
  - insight-review
  - self-improvement
created: 2026-08-11T00:12:15.612Z
updated: 2026-11-13T19:48:24.786Z
---

Track which self-improvement insights have been reviewed/discussed in theme-review sessions, since no automated tracking feature exists yet. Session of 2026-08-10: reviewed all project/persona/skill insights for recurring themes. Outcomes by theme:

1. apply_diff reliability -> PROMOTED to principle "fix the tool rather than route around it" (stale literal complaints dropped; reliability fell off after 07-19/20 rewrite).
2. Mock/call-site sweeping -> PROMOTED to principle (LSP find-references + grep sweep).
3. Racy TUI test barriers -> PROMOTED to principle (waitUntilFrame content-aware polling).
4. Parallel tool-execution races on shared state -> PROMOTED to principle (per-key mutex + tmp/rename atomic writes).
5. list/mount pattern -> NOT promoted (done-deal decisions; also the 07-13 "defaultHidden redundant" insight was a lie/regression later fixed - treat with skepticism).
6. Build/package resolution footguns -> PROMOTED (pnpm -r run build after drone-core type edits). FOLLOW-UP DONE: the .jsx-vs-.js sibling import gotcha was written to docs/agents/import-conventions.md (new topic awaiting expansion).
7. plan persona boundary -> NOT promoted (already fixed by updating the plan persona definition itself).
   All 7 themes from the initial list are now dispositioned. NOTE: several insights are stale post-rewrite or describe one-off gotchas; when the tracking feature is implemented, replace this memory with structured per-insight state.

--- Session of 2026-11-13 (second theme review) ---
Scope: all project-target insights (~400 read across project/drone-agent (306) plus the thematic
buckets: testing, tooling, file-apply-diff, workflow, tui, architecture, mcp, drone-gateway,
ci-pipeline, drone-beacon, drone-coordinator, documentation, and ~20 small one-entry targets).
Evidence span 2026-06-22 to 2026-11-13.

CORRECTION to the 2026-08-11 record: the claim that apply_diff reliability complaints "fell off
completely" after the 2026-07-19/20 fuzz rewrite is FALSE. Complaints continued and recurred:
07-21, 08-11, 08-22, 09-04, 09-07, 09-19, 09-20, 10-05, 10-06, 10-07, 10-16, 10-20, 10-26,
11-02, 11-11. The rewrite fixed the OLD failure class (context/whitespace mismatch). A DIFFERENT
class persists: hunk lands in the wrong place, applies twice, merges with a neighbour, or reports
success while writing nothing. Principle 1's text was corrected in the principle file.

Themes reviewed -> PROMOTED (5 new principles, all under project target drone-agent):
 2. Verify the write; the build is truth, the LSP is not -> PROMOTED.
 3. A test that a mock satisfies proves nothing -> PROMOTED.
 4. One rule, one implementation (sibling paths drift) -> PROMOTED.
 5. A gate that covers nothing still reports green -> PROMOTED.
 6. Dead seams + stale docs claim behaviour the code lacks -> PROMOTED (merged themes 5 and 6).

NOT promoted (with reasons):
 1. apply_diff misbehaviour -> no new principle; the existing principle 1 already covers it as
    a "fix the tool" case. Only its stale evidence note needed correcting (done).
 7. Trust decisions from a message field instead of the transport -> NOT promoted (no new
    principle needed; covered by the existing "sweep every consumer" principle plus review).
 Weaker themes, left as insights: put the invariant at one chokepoint; do not call an aggregate
 inside a per-item loop; the insight/record tool breaks on this host (needs a bug, not a principle).

Methodology notes for the next pass: the 306-entry drone-agent bucket plus the thematic buckets
together are the corpus; several themes are only visible ACROSS buckets (e.g. the mock-test theme
lives mostly in `testing`, the gate theme mostly in `ci-pipeline`). A single-bucket read would
have missed both. The "one rule, one implementation" theme is the strongest new signal and
overlaps the existing principle 2 (sweep every consumer) without duplicating it.