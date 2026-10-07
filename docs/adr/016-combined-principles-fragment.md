---
tags: [decision]
related: [self-improvement.md]
---

# ADR 016: Combined Principles Prompt Fragment

**Status**: Accepted (2026-06-27)

## Context

The self-improvement plugin had separate prompt fragments for persona principles and project principles, but they weren't rendering correctly. A combined, organized format was needed.

## Decision

Replace the existing `persona-principles` fragment with a new combined `principles` fragment that renders both project and persona principles in a structured format.

## Rationale

- **Single source**: One fragment renders all principles
- **Organized**: Two headings ("## Current Project" and "## Current Persona") with subheadings per category
- **Conditional**: Fragment returns `false` when no principles exist (no empty sections)
- **Skill principles excluded**: Skill principles remain in recall result only, not in system prompt

## Implementation

- Combined fragment scans `.drone-agent/principles/project/` for project principles
- Reads active persona principles from `.drone-agent/personas/{id}/principles/`
- Formats with two top-level headings and category subheadings
- Fragment returns `false` when no principles exist

## Consequences

- All principles rendered in a single, organized prompt fragment
- Project and persona principles clearly separated
- No empty sections when principles don't exist
- Skill principles stay in recall context only

## Related

- [[self-improvement]] — Self-improvement system
