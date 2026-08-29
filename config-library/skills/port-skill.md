---
name: port-skill
description: Port a skill from any framework to drone-agent
recall:
  - port skill
  - port a skill
  - porting skill
  - convert skill
  - adapt skill
---

# Port Skills to drone-agent

Port a skill from any source framework or repository to drone-agent.

## Before you start

1. **Understand the source skill**: Read the source skill thoroughly. Note:
   - `name` — the skill identifier
   - `description` — what it does
   - Invocation method — how it's triggered (slash command, auto-invoke, etc.)
   - Body — the actual prompt/instructions

2. **Check for dependencies**: Many skills reference or invoke other skills. Find and fetch those too:
   - Check for skill references by name or slug
   - Look for chained skill calls

3. **Find supporting files**: Some skills reference additional docs or templates:
   - Context formats, templates, glossaries
   - Check the source folder for any `*.md` or config files

## Understand drone-agent's skill system

### Structure

Skills live in `~/.drone-agent/skills/` as `.md` files with this format:

```yaml
---
name: skill-id
description: One-line description
recall:
  - 'trigger phrase 1'
  - 'trigger phrase 2'
---
# Skill body (markdown)
```

- **`name`** — skill identifier (slugified)
- **`description`** — shown in `/skills list`
- **`recall`** — conditions that trigger the skill
- **Body** — markdown injected when recalled

### User invocation

drone-agent uses **macros** for custom slash commands (`/command`). Macros are defined in `~/.drone-agent/macros/`.

If the source skill has user-invocation (like slash commands), create a macro to invoke it.

### Memory system

drone-agent has a `memory` system for persistent key-value storage. Use this for:

- Glossary terms
- Project context
- Cross-session state

### Personas vs skills

- **Personas** — affect the agent's tone/role (defined in `~/.drone-agent/personas/`)
- **Skills** — hold reusable discipline/prompts

Don't create a persona unless the skill fundamentally changes how the agent behaves. Most skills should remain skills.

## Porting patterns

### 1:1 port

Most skills map directly:

```
Source skill file  →  drone-agent skill file
Skill body         →  Skill body (markdown)
```

### Combining skills

If the source skill composes multiple skills:

- Option A: Create one skill with all the logic
- Option B: Create separate skills and have them reference each other

For drone-agent, Option A is simpler since recall conditions can be broad.

### Adapting to drone-agent specifics

Replace framework-specific references:

| Source Framework | drone-agent                 |
| ---------------- | --------------------------- |
| Slash commands   | macros or recall conditions |
| Context files    | `memory.store()`            |
| External docs    | Create in project as needed |
| Model invocation | Use recall conditions       |

### Handling different skill formats

If the source uses a different format (JSON, YAML, code-based), convert to the markdown YAML format drone-agent uses.

## The port process

### Step 1: Analyze

For the target skill, answer:

1. What does it do? (1-2 sentence pitch)
2. How is it invoked? (user, model, or both)
3. What does it reference (other skills, files)?
4. What state does it maintain?

### Step 2: Design

Map to drone-agent:

1. What should the `recall` conditions be?
2. Does it need a macro for user invocation?
3. Does it need the memory system?
4. Should it be one skill or multiple?

### Step 3: Implement

1. Create the skill file
2. If needed, create a macro file
3. Test by invoking the skill

### Step 4: Document

Add a note in the skill body explaining:

- Source skill and URL (if applicable)
- Any adaptations made
- How to invoke it

## Tips

- **Recall conditions**: Make them specific enough to avoid false matches, but broad enough to catch the skill when needed
- **Test thoroughly**: Invoke the skill in different contexts to ensure it works as expected
- **Keep it simple**: Start with a 1:1 port, then refine as needed
- **Preserve intent**: The goal is to replicate the skill's behavior, not necessarily its exact implementation
