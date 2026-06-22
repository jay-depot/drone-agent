import type {
  DronePersonaDefinition,
  DronePersonaProvider,
  DronePlugin,
  DronePromptFragment,
} from 'drone-core';
import { personaCreateWorkflow } from './wizard.js';

export type DronePersonaCapability = {
  getActivePersona: () => DronePersonaDefinition | null;
  getPersonas: () => DronePersonaDefinition[];
  selectPersona: (id: string | null) => void;
  onPersonaChange: (
    callback: (persona: DronePersonaDefinition | null) => void
  ) => void;
  /**
   * Reload persona files from disk. Called by the persona.create
   * workflow after writing a new file, and exposed so other plugins
   * (or tests) can force a refresh.
   */
  reloadPersonas: () => Promise<void>;
  /** Register a persona provider. Providers are sorted by precedence (ascending). */
  registerProvider: (provider: DronePersonaProvider) => void;
  /** Unregister a persona provider by id. */
  unregisterProvider: (providerId: string) => void;
};

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
    let activePersona: DronePersonaDefinition | null = null;
    const changeCallbacks: Array<
      (persona: DronePersonaDefinition | null) => void
    > = [];

    // ── Provider management ──────────────────────────────────────────
    function insertProviderSorted(provider: DronePersonaProvider): void {
      const idx = providers.findIndex(
        p => p.precedence > provider.precedence
      );
      if (idx === -1) {
        providers.push(provider);
      } else {
        providers.splice(idx, 0, provider);
      }
    }

    function removeProvider(providerId: string): void {
      const idx = providers.findIndex(p => p.id === providerId);
      if (idx !== -1) {
        providers.splice(idx, 1);
      }
    }

    // ── Merge helpers ───────────────────────────────────────────────
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

    // Dynamic prompt fragment that renders the active persona's override/fragments
    const personaFragment: DronePromptFragment = {
      key: 'persona',
      phase: 'header',
      render: async () => {
        if (!activePersona) return false;
        const parts: string[] = [];
        if (activePersona.systemPromptOverride) {
          parts.push(activePersona.systemPromptOverride);
        }
        if (
          activePersona.promptFragments &&
          activePersona.promptFragments.length > 0
        ) {
          parts.push(...activePersona.promptFragments);
        }
        return parts.length > 0 ? parts.join('\n\n') : false;
      },
    };

    registration.registerPromptFragment(personaFragment);

    function notifyChange(): void {
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
        insertProviderSorted(provider);
        registration.logger.info(
          `persona provider "${provider.id}" registered (precedence: ${provider.precedence})`
        );
      },
      unregisterProvider: (providerId: string) => {
        removeProvider(providerId);
        registration.logger.info(
          `persona provider "${providerId}" unregistered`
        );
      },
    };

    registration.offer(capability);

    // -----------------------------------------------------------------------
    // onPluginsLoaded — load personas and activate configured persona
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

      // Activate configured persona if set
      if (config.activePersona) {
        const activated = await activatePersona(config.activePersona);
        if (activated) {
          registration.logger.info(
            `active persona: ${activated.name} (${activated.id})`
          );
        } else {
          registration.logger.warn(
            `configured activePersona "${config.activePersona}" not found`
          );
        }
      }
    });

    // -----------------------------------------------------------------------
    // persona.list
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'list',
      description: 'List all available personas with their descriptions.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
      },
      execute: async () => {
        const all = getAllPersonas();
        return JSON.stringify(
          {
            activePersona: activePersona?.id ?? null,
            personas: all.map(p => ({
              id: p.id,
              name: p.name,
              description: p.description,
              hasOverride: !!p.systemPromptOverride,
              fragmentCount: p.promptFragments?.length ?? 0,
              uiColor: p.uiColor ?? null,
            })),
          },
          null,
          2
        );
      },
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
          throw new Error(
            `Unknown persona "${rawId}". Use persona.list to see available personas.`
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
    });

    // -----------------------------------------------------------------------
    // persona.current
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'current',
      description: 'Show the currently active persona.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
      },
      execute: async () => {
        if (!activePersona) {
          return JSON.stringify(
            { activePersona: null, message: 'No persona is currently active.' },
            null,
            2
          );
        }
        return JSON.stringify(
          {
            activePersona: activePersona.id,
            name: activePersona.name,
            description: activePersona.description,
            hasOverride: !!activePersona.systemPromptOverride,
            fragmentCount: activePersona.promptFragments?.length ?? 0,
            uiColor: activePersona.uiColor ?? null,
          },
          null,
          2
        );
      },
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
        const result = await registration.runWorkflow('persona.create', input);
        return (
          result.toolResult ??
          JSON.stringify({ ok: true, message: 'Workflow completed.' }, null, 2)
        );
      },
    });

    // -----------------------------------------------------------------------
    // persona.create workflow — same shape as the tool, but takes a
    // workflow context (with elicit, projectDir, config, requestCapability).
    // -----------------------------------------------------------------------
    registration.registerWorkflow(personaCreateWorkflow);

    // Help snippets surface in `/help` and the TUI help screen.
    registration.registerHelp(
      '/persona list         List available personas'
    );
    registration.registerHelp(
      '/persona create       Interactive wizard to author a new persona'
    );
    registration.registerHelp(
      '/persona select <id>  Switch active persona (or "none" to clear)'
    );
    registration.registerHelp(
      '/persona current      Show current persona'
    );

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
          ctx.logger.info(await ctx.engine.executeTool('persona.list', {}));
          return true;
        }

        if (subcommand === 'current') {
          ctx.logger.info(await ctx.engine.executeTool('persona.current', {}));
          return true;
        }

        if (subcommand === 'select') {
          const id = ctx.args.slice(1).join(' ');
          if (!id) {
            ctx.logger.warn(
              'Usage: /persona select <id> (or "none" to clear)'
            );
            return true;
          }
          ctx.logger.info(await ctx.engine.executeTool('persona.select', { id }));
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
          const result = await ctx.engine.runWorkflow('persona.create', {});
          if (result.toolResult) {
            ctx.logger.info(result.toolResult);
          }
          await ctx.engine.runHooks('onAfterToolCall');
          if (result.kickMessage && ctx.conversation && ctx.sessionManager) {
            // Re-enter the chat loop so the assistant can summarise.
            ctx.sessionManager.appendUserMessage(result.kickMessage);
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
