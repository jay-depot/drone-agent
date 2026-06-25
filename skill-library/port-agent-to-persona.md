---
name: port-agent-to-persona
description: Convert an agent definition or configuration from another framework into a drone-agent persona
recall:
  - port to persona
  - convert to persona
  - agent to persona
  - import agent
  - convert agent
  - import persona
  - from claude agent
  - from opencode agent
  - from pi agent
  - from codex agent
---

# Convert Agent to Persona

Convert an agent definition or configuration from any source into a drone-agent persona.

## Before you start

1. **Understand the source agent**: Identify what makes this agent distinct:
   - Role/name — what identity does it have?
   - Personality — tone, communication style
   - Capabilities — what can it do?
   - Instructions — core behaviors and rules

2. **Determine if a persona is needed**: Not every agent needs a persona. Create one only if:
   - The agent has a distinct personality or voice
   - It changes how the agent communicates/responds
   - It provides a consistent role identity
   - It justifies a separate knowledge base or skill set

   Otherwise, consider making it a skill instead.

3. **Check for supporting docs**: Some agents reference:
   - System prompts
   - Configuration files
   - Instruction sets

## Understand drone-agent's persona system

### Structure

Personas live in `~/.drone-agent/personas/` as `.md` files with this format:

```yaml
---
name: persona-id
description: One-line description of the persona's role
fragments:
  - 'instruction fragment 1'
  - 'instruction fragment 2'
---
# Body: Persona instructions (markdown)
```

- **`name`** — persona identifier
- **`description`** — shown in `/personas list`
- **`fragments`** — instruction fragments that shape the agent's behavior - Placed in a different system message than the main body. Optional, but useful if you need certain behaviors or procedures emphasized or restated.
- **Body** — instructions that shape the agent's behavior

### Activation

Personas are activated via `/persona select [name]` or autonomously by tool call if the agent determines the user context requires it or the user has requested it. They can also be activated by a command line argument or environment variable if the agent is being run in a non-interactive context.

### Personas vs skills

- **Personas** — affect the agent's tone, role, and fundamental behavior
- **Skills** — hold reusable discipline/prompts

A persona changes _who_ the agent is. A skill changes _what_ the agent can do.

## Porting patterns

### 1:1 port

Most agent definitions map directly:

```
Source agent file  →  drone-agent persona file
System prompt      →  Persona body
```

### Extracting from a full agent config

If the source is a complete agent definition with multiple parts:

1. Extract the core identity/personality instructions
2. Move capabilities to skills if needed
3. Keep role and communication style in the persona

### Adapting to drone-agent specifics

Replace source-specific references:

| Source Framework | drone-agent                 |
| ---------------- | --------------------------- |
| System prompt    | Persona body                |
| Agent config     | Split into persona + skills |
| Prompt templates | Skills or macros            |
| Capabilities     | Skills                      |
| Behavior rules   | Persona fragments           |

## The port process

### Step 1: Analyze

For the source agent, answer:

1. What role/identity/job does it have?
2. What personality traits should persist, if any?
3. What capabilities are tied to identity vs. separate skills?
4. How should it be invoked?

### Step 2: Design

Map to drone-agent:

1. What should the persona's name and description be?
2. What instructions define its identity?
3. Should capabilities become separate skills?
4. How should it be activated?

### Step 3: Implement

1. Create the persona file
2. Create supporting skills if needed
3. Test by activating the persona

### Step 4: Document

Add a note in the persona body explaining:

- Source agent and URL (if applicable)
- Any adaptations made
- How to activate it

## Tips

- **Keep it focused**: A persona should define _who_, not _what_. Complex capabilities belong in skills.
- **Test communication**: Suggest the user activate the persona and verify it communicates as expected
- **Iterate**: It's okay to adjust the persona instructions after testing
- **Preserve identity**: The goal is to maintain the agent's distinct voice and role
