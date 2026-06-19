import type {
  DronePersonaDefinition,
  DronePlugin,
  DronePromptFragment,
} from 'drone-core';
import { loadPersonas } from './loader.js';
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
};

export const personaPlugin: DronePlugin = {
  metadata: {
    id: 'persona',
    name: 'Persona',
    version: '0.1.0',
    description:
      'Manage named personas that customize system prompts and behavior.',
    defaultEnabled: false,
  },
  register: async registration => {
    const config = registration.getConfig();
    const projectDir = process.cwd();

    let personas = new Map<string, DronePersonaDefinition>();
    let activePersona: DronePersonaDefinition | null = null;
    const changeCallbacks: Array<
      (persona: DronePersonaDefinition | null) => void
    > = [];

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

      const found = personas.get(id);
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
      getPersonas: () => Array.from(personas.values()),
      selectPersona: (id: string | null) => {
        activatePersona(id);
      },
      onPersonaChange: callback => {
        changeCallbacks.push(callback);
      },
      reloadPersonas: async () => {
        const previous = activePersona;
        personas = await loadPersonas(projectDir);
        // Re-activate the previously active persona (if any) so the
        // activePersona reference still resolves to a current object.
        // If the previously active persona no longer exists, fall
        // back to clearing the active persona.
        if (previous) {
          const stillExists = personas.get(previous.id);
          if (stillExists) {
            activePersona = stillExists;
          } else {
            activePersona = null;
            notifyChange();
          }
        }
        registration.logger.info(
          `reloaded ${personas.size} persona(s)`
        );
      },
    };

    registration.offer(capability);

    // -----------------------------------------------------------------------
    // onPluginsLoaded — load personas and activate configured persona
    // -----------------------------------------------------------------------
    registration.hooks.onPluginsLoaded(async () => {
      await capability.reloadPersonas();

      if (personas.size === 0) {
        registration.logger.info(
          'no persona files found (looked in ~/.drone-agent/personas/ and .drone-agent/personas/)'
        );
        return;
      }

      registration.logger.info(
        `loaded ${personas.size} persona(s): ${Array.from(personas.keys()).join(', ')}`
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
        const all = Array.from(personas.values());
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

        const found = personas.get(rawId);
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

    // Help snippet surfaces in `/help` and the TUI help screen.
    registration.registerHelp(
      '/persona create       Interactive wizard to author a new persona'
    );
  },
};
