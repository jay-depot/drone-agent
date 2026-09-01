import {
  insertSortedByPrecedence,
  removeById,
  insertWriterSorted,
  toToolResultContent,
} from 'drone-core';
import { PersonaListBlock } from '../../tui/components/PersonaListBlock.js';
import { PersonaSelectBlock } from '../../tui/components/PersonaSelectBlock.js';
import { PersonaCreateBlock } from '../../tui/components/PersonaCreateBlock.js';
import type {
  DronePersonaCapability,
  DronePersonaDefinition,
  DronePersonaProvider,
  DronePersonaWriter,
  DronePlugin,
  DronePromptFragment,
  DroneSkillDefinition,
  DroneToolDescriptor,
} from 'drone-core';
import { filterByGlobPatterns } from 'drone-core';
import { personaCreateWorkflow } from './wizard.js';

// Re-export capability type from drone-core for backward compatibility.
export type { DronePersonaCapability } from 'drone-core';

export const personaPlugin: DronePlugin = {
  metadata: {
    id: 'persona',
    name: 'Persona',
    version: '0.1.0',
    description:
      'Broker for persona providers. Manages active persona, selection, and persona management tools.',
    defaultEnabled: false,
  },
  register: async registration => {
    const config = registration.getConfig();

    const providers: DronePersonaProvider[] = [];
    const writers: DronePersonaWriter[] = [];
    let activePersona: DronePersonaDefinition | null = null;
    const changeCallbacks: Array<
      (persona: DronePersonaDefinition | null) => void
    > = [];

    // ── Merge helpers ─────────────────────────────────────────────────────
    function getAllPersonas(): DronePersonaDefinition[] {
      const seen = new Set<string>();
      const result: DronePersonaDefinition[] = [];
      // Iterate in precedence order (ascending). For duplicate ids,
      // the first (highest-priority) provider wins.
      for (const provider of providers) {
        for (const persona of provider.getPersonas()) {
          if (!seen.has(persona.id)) {
            seen.add(persona.id);
            result.push(persona);
          }
        }
      }
      return result;
    }

    function getPersonaById(id: string): DronePersonaDefinition | undefined {
      for (const provider of providers) {
        const persona = provider.getPersona(id);
        if (persona) return persona;
      }
      return undefined;
    }

    function expandPremountedCanonical(): string[] {
      if (!activePersona?.premountedTools) return [];
      const result: string[] = [];
      for (const [pluginId, toolNames] of Object.entries(
        activePersona.premountedTools
      )) {
        for (const toolName of toolNames) {
          result.push(`${pluginId}__${toolName}`);
        }
      }
      return result;
    }

    function allowedToolsMatches(canonical: string): boolean {
      if (!activePersona?.allowedTools) return false;
      const matched = filterByGlobPatterns(
        [canonical],
        activePersona.allowedTools
      );
      return matched.length > 0;
    }

    function applyToolPremount(): void {
      // Unmount all currently-mounted non-runtime tools.
      for (const tool of registration.listMountedTools()) {
        if (!tool.name.startsWith('runtime__')) {
          registration.unmountTool(tool.name);
        }
      }
      // Mount the active persona's premounted tools.
      const premount = activePersona?.premountedTools;
      if (!premount) return;
      for (const [pluginId, toolNames] of Object.entries(premount)) {
        for (const toolName of toolNames) {
          const canonical = `${pluginId}__${toolName}`;
          const def = registration.mountTool(canonical);
          if (!def) {
            registration.logger.warn(
              `premountedTools: unknown tool "${canonical}"`
            );
            continue;
          }
          if (def.defaultHidden && !allowedToolsMatches(canonical)) {
            registration.logger.warn(
              `premountedTools: "${canonical}" is defaultHidden and not in allowedTools; it will still be visible because premounted. Add it to allowedTools or remove the premount.`
            );
          }
        }
      }
    }

    function getFilteredTools(
      allTools: DroneToolDescriptor[]
    ): DroneToolDescriptor[] {
      const premountedNames = new Set(expandPremountedCanonical());
      if (!activePersona || !activePersona.allowedTools) {
        // No active persona, or persona without explicit allowedTools:
        // hide defaultHidden tools from the LLM.
        return allTools.filter(
          t => !t.defaultHidden || premountedNames.has(t.name)
        );
      }
      // Persona has explicit allowedTools: apply glob filtering.
      // The persona's patterns take full control - they can re-include
      // defaultHidden tools by explicitly naming them.
      const names = allTools.map(t => t.name);
      const filtered = filterByGlobPatterns(names, activePersona.allowedTools);
      const filteredSet = new Set(filtered);
      return allTools.filter(
        t => filteredSet.has(t.name) || premountedNames.has(t.name)
      );
    }
    function getFilteredSkills(
      allSkills: DroneSkillDefinition[]
    ): DroneSkillDefinition[] {
      if (!activePersona) {
        return allSkills;
      }

      // Separate persona-owned skills (always visible) from global skills
      const ownedSkills: DroneSkillDefinition[] = [];
      const globalSkills: DroneSkillDefinition[] = [];

      for (const skill of allSkills) {
        if (skill.personaId === activePersona.id) {
          ownedSkills.push(skill);
        } else {
          globalSkills.push(skill);
        }
      }

      // If no allowedSkills filter, return all global + owned
      if (!activePersona.allowedSkills) {
        return [...globalSkills, ...ownedSkills];
      }

      // Filter global skills by allowedSkills patterns
      const globalIds = globalSkills.map(s => s.id);
      const filteredIds = filterByGlobPatterns(
        globalIds,
        activePersona.allowedSkills
      );
      const filteredSet = new Set(filteredIds);
      const filteredGlobal = globalSkills.filter(s => filteredSet.has(s.id));

      return [...filteredGlobal, ...ownedSkills];
    }

    // Dynamic prompt fragment that renders the active persona's override/fragments
    const personaFragment: DronePromptFragment = {
      key: 'persona',
      phase: 'header',
      render: async () => {
        if (!activePersona) return false;
        const parts: string[] = [];
        if (activePersona.systemPromptOverride) {
          parts.push(`# [Persona brief: "${activePersona.name}"]`);
          parts.push(activePersona.systemPromptOverride);
        }
        if (
          activePersona.promptFragments &&
          activePersona.promptFragments.length > 0
        ) {
          parts.push('## Observe the following additional instructions:');
          activePersona.promptFragments.forEach(fragment => {
            parts.push(`- ${fragment}`);
          });
        }
        return parts.length > 0 ? parts.join('\n\n') : false;
      },
    };

    registration.registerPromptFragment(personaFragment);

    const availablePersonasFragment: DronePromptFragment = {
      key: 'personas-available',
      phase: 'header',
      render: async () => {
        const all = getAllPersonas();
        if (all.length === 0) return false;
        const parts: string[] = [];
        parts.push('# Available personas:');
        all.forEach(p => {
          parts.push(
            `- **${p.name} (${p.id})**${
              p.description ? `: ${p.description}` : ''
            }`
          );
        });
        return parts.join('\n');
      },
    };

    registration.registerPromptFragment(availablePersonasFragment);

    function notifyChange(): void {
      applyToolPremount();
      for (const cb of changeCallbacks) {
        cb(activePersona);
      }
    }

    async function activatePersona(
      id: string | null
    ): Promise<DronePersonaDefinition | null> {
      if (id === null) {
        activePersona = null;
        notifyChange();
        return null;
      }

      const found = getPersonaById(id);
      if (!found) {
        registration.logger.warn(
          `persona "${id}" not found in loaded personas.`
        );
        return null;
      }

      activePersona = found;
      notifyChange();
      return found;
    }

    // Capability offered to TUI and other plugins
    const capability: DronePersonaCapability = {
      getActivePersona: () => activePersona,
      getPersonas: () => getAllPersonas(),
      selectPersona: (id: string | null) => {
        activatePersona(id);
      },
      onPersonaChange: callback => {
        changeCallbacks.push(callback);
      },
      reloadPersonas: async () => {
        const previous = activePersona;
        for (const provider of providers) {
          await provider.reloadPersonas();
        }
        // Re-activate the previously active persona (if any) so the
        // activePersona reference still resolves to a current object.
        if (previous) {
          const stillExists = getPersonaById(previous.id);
          if (stillExists) {
            activePersona = stillExists;
          } else {
            activePersona = null;
          }
          notifyChange();
        }
        registration.logger.info(
          `reloaded personas from ${providers.length} provider(s)`
        );
      },
      registerProvider: (provider: DronePersonaProvider) => {
        insertSortedByPrecedence(providers, provider);
        registration.logger.info(
          `persona provider "${provider.id}" registered (precedence: ${provider.precedence})`
        );
      },
      unregisterProvider: (providerId: string) => {
        removeById(providers, providerId);
        registration.logger.info(
          `persona provider "${providerId}" unregistered`
        );
      },
      registerWriter: (writer: DronePersonaWriter) => {
        insertWriterSorted(writers, writer);
        registration.logger.info(
          `persona writer "${writer.id}" registered (scope: ${writer.scope})`
        );
      },
      unregisterWriter: (writerId: string) => {
        removeById(writers, writerId);
        registration.logger.info(`persona writer "${writerId}" unregistered`);
      },
      getWriters: () => [...writers],
      getFilteredTools: (allTools: DroneToolDescriptor[]) =>
        getFilteredTools(allTools),
      getFilteredSkills: (allSkills: DroneSkillDefinition[]) =>
        getFilteredSkills(allSkills),
    };

    registration.offer(capability);

    // -----------------------------------------------------------------------
    // onPluginsLoaded — load personas (activation moved to onSessionStart)
    // -----------------------------------------------------------------------
    registration.hooks.onPluginsLoaded(async () => {
      await capability.reloadPersonas();

      const all = getAllPersonas();
      if (all.length === 0) {
        registration.logger.info(
          'no persona files found (looked in ~/.drone-agent/personas/<name>/persona.md and .drone-agent/personas/<name>/persona.md)'
        );
        return;
      }

      registration.logger.info(
        `loaded ${all.length} persona(s): ${all.map(p => p.id).join(', ')}`
      );
    });

    // -----------------------------------------------------------------------
    // onSessionStart — activate configured/runtime persona
    // -----------------------------------------------------------------------
    registration.hooks.onSessionStart(async () => {
      // Determine which persona to activate: runtime option (--persona CLI flag)
      // takes precedence over config.activePersona
      let personaToActivate: string | null = null;

      // First check runtime options (from --persona CLI flag)
      const runtime = registration.request<{ persona?: string }>('runtime');
      if (runtime?.persona) {
        personaToActivate = runtime.persona;
      }

      // Fall back to config.activePersona if no runtime persona was specified
      if (!personaToActivate && config.activePersona) {
        personaToActivate = config.activePersona;
      }

      // Activate the determined persona
      if (personaToActivate) {
        const activated = await activatePersona(personaToActivate);
        if (activated) {
          registration.logger.info(
            `active persona: ${activated.name} (${activated.id})`
          );
        } else {
          registration.logger.warn(`persona "${personaToActivate}" not found`);
        }
      }
    });

    // -----------------------------------------------------------------------
    // persona.list
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'list',
      description:
        'List all available personas with their descriptions. ' +
        'Pass showCurrent=true to include the currently active persona in the response.',
      inputSchema: {
        type: 'object',
        properties: {
          showCurrent: {
            type: 'boolean',
            description:
              'If true, include the currently active persona in the response.',
          },
        },
        additionalProperties: false,
      },
      execute: async input => {
        const all = getAllPersonas();
        const response: Record<string, unknown> = {
          activePersona: activePersona?.id ?? null,
          personas: all.map(p => ({
            id: p.id,
            name: p.name,
            description: p.description,
            hasOverride: !!p.systemPromptOverride,
            fragmentCount: p.promptFragments?.length ?? 0,
            uiColor: p.uiColor ?? null,
            toolCallLimit: p.toolCallLimit ?? null,
          })),
        };

        if (input.showCurrent === true) {
          if (activePersona) {
            response.currentPersona = {
              id: activePersona.id,
              name: activePersona.name,
              description: activePersona.description,
              hasOverride: !!activePersona.systemPromptOverride,
              fragmentCount: activePersona.promptFragments?.length ?? 0,
              uiColor: activePersona.uiColor ?? null,
              toolCallLimit: activePersona.toolCallLimit ?? null,
            };
          } else {
            response.currentPersona = null;
          }
        }

        return JSON.stringify(response, null, 2);
      },
      renderComponent: state => PersonaListBlock({ state }),
    });

    // -----------------------------------------------------------------------
    // persona.select
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'select',
      description:
        'Switch the active persona by id. Use "none" to clear the active persona.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description:
              'Persona id to activate, or "none" to clear. Must be a loaded persona.',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      execute: async input => {
        const rawId =
          typeof input.id === 'string' ? input.id.trim().toLowerCase() : '';
        if (rawId === 'none' || rawId === '') {
          activePersona = null;
          notifyChange();
          return JSON.stringify(
            { activePersona: null, message: 'Persona cleared.' },
            null,
            2
          );
        }

        const found = getPersonaById(rawId);
        if (!found) {
          const all = getAllPersonas();
          return JSON.stringify(
            {
              error: true,
              message: `Unknown persona "${rawId}". Available personas: ${all.map(p => p.id).join(', ') || '(none)'}.`,
            },
            null,
            2
          );
        }

        activePersona = found;
        notifyChange();
        return JSON.stringify(
          {
            activePersona: found.id,
            name: found.name,
            uiColor: found.uiColor ?? null,
            message: `Switched to persona "${found.name}".`,
          },
          null,
          2
        );
      },
      renderComponent: state => PersonaSelectBlock({ state }),
    });

    // -----------------------------------------------------------------------
    // persona.create — delegates to the persona-create workflow so all
    // three entry points (tool call / slash command / --workflow CLI
    // flag) share one implementation.
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'create',
      description:
        'Interactively create a new persona .md file. Asks for scope, id, and description; has the LLM write the persona; validates and installs it.',
      inputSchema: personaCreateWorkflow.inputSchema ?? {
        type: 'object',
        additionalProperties: false,
      },
      execute: async input => {
        const result = await registration.runWorkflow('persona__create', input);
        return (
          result.toolResult ??
          JSON.stringify({ ok: true, message: 'Workflow completed.' }, null, 2)
        );
      },
      renderComponent: state => PersonaCreateBlock({ state }),
    });

    // -----------------------------------------------------------------------
    // persona.create workflow — same shape as the tool, but takes a
    // workflow context (with elicit, projectDir, config, requestCapability).
    // -----------------------------------------------------------------------
    registration.registerWorkflow(personaCreateWorkflow);

    // Help snippets surface in `/help` and the TUI help screen.
    registration.registerHelp('/persona list         List available personas');
    registration.registerHelp(
      '/persona create       Interactive wizard to author a new persona'
    );
    registration.registerHelp(
      '/persona select <id>  Switch active persona (or "none" to clear)'
    );
    registration.registerHelp('/persona current      Show current persona');

    // -----------------------------------------------------------------------
    // /persona slash command — handles all subcommands (list, current,
    // select, create) via the engine's slash command dispatch. Both
    // the CLI interactive loop and the TUI delegate to this handler
    // instead of hardcoding persona-specific logic.
    // -----------------------------------------------------------------------
    registration.registerSlashCommand({
      command: '/persona',
      description: 'Manage personas: list, create, select, current.',
      handler: async ctx => {
        const subcommand = ctx.args[0] ?? '';

        if (subcommand === 'list') {
          ctx.logger.info(
            toToolResultContent(
              await ctx.engine.executeTool('persona__list', {})
            )
          );
          return true;
        }

        if (subcommand === 'current') {
          ctx.logger.info(
            toToolResultContent(
              await ctx.engine.executeTool('persona__list', {
                showCurrent: true,
              })
            )
          );
          return true;
        }

        if (subcommand === 'select') {
          const id = ctx.args.slice(1).join(' ');
          if (!id) {
            ctx.logger.warn('Usage: /persona select <id> (or "none" to clear)');
            return true;
          }
          ctx.logger.info(
            toToolResultContent(
              await ctx.engine.executeTool('persona__select', { id })
            )
          );
          return true;
        }

        if (subcommand === 'create') {
          // Workflows that elicit the user need an interactive host.
          // In a non-interactive run (no host attached) runWorkflow
          // itself throws a clear error.
          if (!ctx.engine.runWorkflow) {
            ctx.logger.warn('Workflow API not available in this build.');
            return true;
          }
          await ctx.engine.runHooks('onBeforePrompt');
          const result = await ctx.engine.runWorkflow('persona__create', {});
          if (result.toolResult) {
            ctx.logger.info(result.toolResult);
          }
          await ctx.engine.runHooks('onAfterToolCall');
          if (result.kickMessage && ctx.conversation && ctx.sessionManager) {
            // Re-enter the chat loop so the assistant can summarise.
            await ctx.engine.runHooks('onBeforePrompt');
            const reply = await ctx.conversation.sendUserMessage(
              result.kickMessage
            );
            if (reply.length > 0) {
              ctx.logger.info(reply);
            }
            await ctx.engine.runHooks('onAfterToolCall');
          }
          return true;
        }

        ctx.logger.warn(
          'Unknown persona command. Try: /persona list, /persona create, /persona select <id>, /persona current'
        );
        return true;
      },
    });
  },
};
