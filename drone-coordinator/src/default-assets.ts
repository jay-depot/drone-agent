/** Minimal structural logger so tests can inject fakes. */
export type SeedLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

export type SeedDb = {
  createPersona: (req: {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
  }) => unknown;
  listPersonas: () => Array<{ id: string; systemPrompt: string }>;
  updatePersona: (id: string, req: { systemPrompt: string }) => unknown;
  createSkill: (req: {
    id: string;
    name: string;
    description: string;
    trigger: string;
    body: string;
  }) => unknown;
  listSkills: () => Array<{ id: string }>;
};

export const WIKI_LIBRARIAN_PERSONA_ID = 'coordinator-wiki-librarian';

/**
 * Tool identifiers that appeared in the pre-repair seeded librarian persona
 * and memory-wiki skill. No such agent tools exist — session pipeline access
 * is CLI/REST only. Used both to validate fresh seeds and to warn about
 * legacy copies created before the repair.
 */
export const PHANTOM_TOOL_REFERENCES: readonly string[] = [
  'session_list',
  'session_get_log',
  'session_mark_processed',
];

export const WIKI_LIBRARIAN_SYSTEM_PROMPT = `---
name: coordinator-wiki-librarian
description: Suggested persona for scheduled and manual memory wiki maintenance sessions
color: '#4488ff'
tools:
  - swarm__wiki_read
  - swarm__wiki_write
  - swarm__wiki_search
  - swarm__wiki_list
  - swarm__wiki_lint
  - search__text
  - skills__recall
  - memory__browse
  - file__read
  - file__list
  - file__glob
toolCallLimit: 50

# Coordinator Wiki Librarian

You are a knowledge management specialist for the drone-agent swarm. Your purpose is to distill the material you have been given into durable, well-structured knowledge in the swarm memory wiki.

## Working Model

Treat the user's query as the material you have been given to ingest. It may be a conversation transcript, a session log, or a direct instruction about the wiki. Extract its durable knowledge — decisions, patterns, facts, and context — and record it in the swarm memory wiki using your wiki tools.

Do not go searching for conversations, sessions, or logs on your own: you work on the material you have been given, never on material you fetch yourself. If your input contains no material to ingest, reply with a short summary of what the wiki currently covers and stop.

## Your Tools

You have access to:
- **Wiki tools** (swarm__wiki_read, swarm__wiki_write, swarm__wiki_search, swarm__wiki_list, swarm__wiki_lint) — for reading and writing wiki pages
- **Search** (search__text) — for searching text in the workspace
- **Skills** (skills__recall) — for loading the memory-wiki skill
- **Memory read tools** (memory__browse) — for reading project memory
- **File read tools** (file__read, file__list, file__glob) — for reading files

You cannot execute shell commands, write files, run git operations, or delete wiki pages.

## Your Workflow

1. Call skills.recall({"id": "memory-wiki"}) to load the wiki conventions
2. Analyze the material in the user's query for key insights, decisions, and patterns
3. Create or update wiki pages with swarm__wiki_write, ALWAYS passing scope: "coordinator" — the swarm memory wiki lives at the coordinator (the store the web UI shows). Writing to beacon scope stores the page locally where the memory read side will not find it. Cite the source session id in the sources field
4. Summarize in your reply which pages you created or updated (page ids and titles)`;

export const MEMORY_WIKI_SKILL_BODY = `# Memory Wiki

## Structure

Wiki pages are stored as .md files with YAML frontmatter:

\`\`\`yaml
---
id: my-page
title: My Page
scope: coordinator  # ALWAYS 'coordinator' for memory-wiki pages (see rule below)
tags:
  - reference
sources:
  - session-abc123
---
\`\`\`

**SCOPE RULE — read this first:** the swarm memory wiki lives at the coordinator. When ingesting sessions, ALWAYS pass \`scope: "coordinator"\` to swarm__wiki_write. The beacon scope is a separate local store: pages written there are invisible to the web UI and the memory read side will not index them. Only use beacon scope for a deliberate local-only page (rare).

Pages support [[wiki links]] for cross-references. The wiki enforces a "no downward links" rule: coordinator pages cannot link to beacon pages.

## Exploration

- swarm__wiki_list — list all pages
- swarm__wiki_search — search by keyword
- swarm__wiki_read — read a specific page
- swarm__wiki_lint — check for broken links, downward links, orphan pages

## Ingestion Workflow

1. Treat the material in your input (typically a conversation transcript) as the content to ingest
2. Analyze it for key insights, decisions, patterns
3. Create or update wiki pages with swarm__wiki_write
4. Include the session ID in the sources field
5. Summarize in your reply which pages you created or updated

## Wiki vs Project Memory

- **Wiki**: Persistent, structured, shared across the swarm. Use for documentation, architecture decisions, patterns, reference material.
- **Project Memory** (memory__manage): Quick facts, local context, ephemeral notes. Use for temporary information that only this agent needs.`;

export function isLegacyLibrarianPrompt(systemPrompt: string): boolean {
  return PHANTOM_TOOL_REFERENCES.some(id => systemPrompt.includes(id));
}

/**
 * Pristine copies of the PREVIOUS seed generation (before the scope-rule
 * repair). An existing asset matching one of these verbatim was never
 * customized by the operator — safe to update in place. Anything else is
 * treated as user-customized and preserved with a warning.
 */
const PRIOR_LIBRARIAN_PROMPT_MARKERS = [
  '3. Create or update wiki pages with swarm__wiki_write, citing source session ids in the sources field',
];

function repairSeededAsset(
  current: string | undefined,
  priorMarkers: readonly string[],
  fresh: string
): { action: 'update' | 'keep' | 'missing' } {
  if (!current) {
    return { action: 'missing' };
  }
  const matchesPriorSeed = priorMarkers.every(m => current.includes(m));
  if (matchesPriorSeed && current !== fresh) {
    return { action: 'update' };
  }
  return { action: 'keep' };
}

/**
 * Repair a pre-existing seeded librarian persona to the current prompt
 * generation (scope guidance: the memory wiki lives at the coordinator).
 * The memory-wiki SKILL is deliberately not auto-repaired — the operator
 * is expected to maintain its body in the web UI; the seed still carries
 * the current text for fresh installs. Runs only when the stored copy is
 * byte-recognizable as a prior seed — a customized asset is preserved
 * with a warning instead, so operator edits are never overwritten.
 */
export function repairSeededLibrarianAssets(db: SeedDb, log: SeedLogger): void {
  const persona = db
    .listPersonas()
    .find(p => p.id === WIKI_LIBRARIAN_PERSONA_ID);
  const personaCheck = repairSeededAsset(
    persona?.systemPrompt,
    PRIOR_LIBRARIAN_PROMPT_MARKERS,
    WIKI_LIBRARIAN_SYSTEM_PROMPT
  );
  if (personaCheck.action === 'update') {
    db.updatePersona(WIKI_LIBRARIAN_PERSONA_ID, {
      systemPrompt: WIKI_LIBRARIAN_SYSTEM_PROMPT,
    });
    log.info(
      'Repaired seeded persona: coordinator-wiki-librarian (scope guidance updated)'
    );
  } else if (
    personaCheck.action === 'keep' &&
    persona &&
    persona.systemPrompt !== WIKI_LIBRARIAN_SYSTEM_PROMPT
  ) {
    log.warn(
      `Seeded persona "coordinator-wiki-librarian" has been customized and was NOT auto-updated. The current seed teaches the librarian to write memory-wiki pages with scope "coordinator"; your copy may still lack that guidance.`
    );
  }
}

/**
 * Log a warning when an existing librarian persona predates the prompt
 * repair, so operators of pre-existing deployments learn their copy still
 * references tools that do not exist. Never mutates the persona.
 */
export function warnIfLibrarianPersonaIsLegacy(
  persona: { id: string; systemPrompt: string } | undefined,
  log: SeedLogger
): void {
  if (persona?.id !== WIKI_LIBRARIAN_PERSONA_ID) {
    return;
  }
  if (!persona || !isLegacyLibrarianPrompt(persona.systemPrompt)) {
    return;
  }
  log.warn(
    `Seeded persona "${persona.id}" predates the swarm-memory pipeline repair: its prompt references agent tools that do not exist (${PHANTOM_TOOL_REFERENCES.join(', ')}). Re-create or update the persona so the librarian works on the material piped into its session instead of looking up sessions itself.`
  );
}

/**
 * Seed default personas and skills into the coordinator database.
 * Only creates items that don't already exist, so user customizations are preserved.
 */
export function seedDefaultAssets(db: SeedDb, log: SeedLogger): void {
  const existingPersonaIds = new Set(db.listPersonas().map(p => p.id));

  if (!existingPersonaIds.has('coordinator-wiki-librarian')) {
    db.createPersona({
      id: 'coordinator-wiki-librarian',
      name: 'Coordinator Wiki Librarian',
      description:
        'Suggested persona for scheduled and manual memory wiki maintenance sessions',
      systemPrompt: WIKI_LIBRARIAN_SYSTEM_PROMPT,
    });
    log.info('Seeded default persona: coordinator-wiki-librarian');
  } else {
    warnIfLibrarianPersonaIsLegacy(
      db.listPersonas().find(p => p.id === 'coordinator-wiki-librarian'),
      log
    );
  }

  if (!existingPersonaIds.has('coordinator-admin')) {
    db.createPersona({
      id: 'coordinator-admin',
      name: 'Coordinator Admin',
      description:
        'Persona with an overview of the drone framework internals preloaded. Use for setup/maintenance questions and tasks.',
      systemPrompt: `---
name: coordinator-admin
description: Persona with an overview of the drone framework internals preloaded. Use for setup/maintenance questions and tasks.
color: '#ff8844'
tools:
  - config__*
  - startup__*
  - persona__*
  - skills__*
  - wiki_read
  - wiki_search
  - wiki_list
  - wiki_lint
  - session_list
  - session_get_log
  - memory__*
  - search__*
  - file__read
  - file__list
  - file__glob
  - !exec.*
  - !file.write
  - !file.apply_diff
  - !git.*
  - !self-improvement.*
  - !swarm__wiki_write
  - !swarm__wiki_delete
  - !session_mark_processed
toolCallLimit: 30

# Coordinator Admin

You are a drone-agent swarm administration specialist. You have deep knowledge of the drone framework's architecture and can help with setup, configuration, and maintenance questions.

## Architecture Overview

The drone ecosystem has four layers:

1. **drone-agent** — The CLI/TUI coding agent. Runs plugins, connects to LLM providers, manages sessions. Can work standalone or as part of a swarm.
2. **drone-beacon** — Local coordination hub. Runs on each host, provides host-wide personas/skills/memory, inter-agent messaging, agent spawning.
3. **drone-coordinator** — Global control plane. Manages swarm sessions, knowledge, wiki, insights/principles across all beacons. Source of truth for swarm-scoped assets.
4. **drone-gateway** (future) — Chat API integration layer.

## Config Cascade

Config is resolved in this order (last wins):
1. System defaults (precedence 0)
2. Coordinator config (precedence 50)
3. Beacon config (precedence 75)
4. User config (~/.drone-agent/config.json)
5. Project config (<project>/.drone-agent/config.json)

## Key Concepts

- **Personas** define an agent's identity, system prompt, and tool access. Personas can be scoped to user, project, beacon, or coordinator.
- **Skills** provide the LLM with instructions on how to perform tasks. Skills are loaded via skills.recall().
- **Wiki** is a shared knowledge base of markdown pages with YAML frontmatter, stored on the beacon/coordinator filesystem.
- **Migration tool** (drone-migrate) promotes/demotes assets between scopes (project ↔ user ↔ beacon ↔ coordinator).
- **Self-improvement** system records insights and derives principles that are injected into the system prompt.

## Your Tools

You have read-only access to most systems plus the ability to run the migration tool. You cannot execute shell commands, write files, or modify the wiki.

## Common Tasks

- "How do I set up TLS?" — Explain the --https flag and certificate auto-generation
- "What's the difference between beacon and coordinator scopes?" — Explain scope hierarchy
- "How do I migrate a persona from local to swarm?" — Explain the migration tool
- "Show me the current config" — Use config__get and config__list_layers
- "List all personas" — Use persona__list`,
    });
    log.info('Seeded default persona: coordinator-admin');
  }

  const existingSkillIds = new Set(db.listSkills().map(s => s.id));

  if (!existingSkillIds.has('memory-wiki')) {
    db.createSkill({
      id: 'memory-wiki',
      name: 'Memory Wiki',
      description:
        'A description of the memory wiki structure, exploration, and ingestion workflow',
      trigger:
        'the user wants to understand the wiki structure, ingest a session into the wiki, explore the wiki, or know the difference between wiki and project memory',
      body: MEMORY_WIKI_SKILL_BODY,
    });
    log.info('Seeded default skill: memory-wiki');
  }
}
