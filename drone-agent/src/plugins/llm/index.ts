import type {
  DroneLlmCapability,
  DroneLlmProviderRegistration,
  DronePlugin,
} from 'drone-core';

export const llmPlugin: DronePlugin = {
  metadata: {
    id: 'llm',
    name: 'LLM Provider Broker',
    version: '0.1.0',
    description:
      'Broker for LLM provider plugins (ollama, openrouter, etc.). Manages provider selection and the /model command.',
    defaultEnabled: true,
    dependencies: [],
  },
  register: async registration => {
    const providers: DroneLlmProviderRegistration[] = [];
    let currentModel: string = '';
    let activeProviderId: string = '';

    // ── Provider management ──────────────────────────────────────────
    function insertProviderSorted(
      provider: DroneLlmProviderRegistration
    ): void {
      const idx = providers.findIndex(p => p.precedence > provider.precedence);
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

    function getAvailableProviders(): Array<{ id: string; precedence: number }> {
      return providers.map(provider => ({
        id: provider.id,
        precedence: provider.precedence,
      }));
    }

    function getActiveProviderRegistration():
      | DroneLlmProviderRegistration
      | undefined {
      return providers.find(p => p.id === activeProviderId);
    }

    // ── Activate a provider by id ─────────────────────────────────────
    function activateProvider(providerId: string): void {
      const reg = providers.find(p => p.id === providerId);
      if (!reg) {
        throw new Error(
          `LLM provider "${providerId}" is not registered. Available: ${providers.map(p => p.id).join(', ')}`
        );
      }
      activeProviderId = providerId;
      currentModel = reg.getDefaultModel();
    }

    // ── Offer capability to other plugins ─────────────────────────────
    const capability: DroneLlmCapability = {
      getActiveProvider: () => {
        const reg = getActiveProviderRegistration();
        if (!reg) {
          throw new Error(
            'No active LLM provider. Ensure at least one provider plugin (e.g. ollama) is enabled.'
          );
        }
        return reg.getProvider();
      },
      getActiveProviderId: () => activeProviderId,
      getAvailableProviders,
      activateProvider: (providerId: string) => {
        activateProvider(providerId);
      },
      getModel: () => currentModel,
      setModel: (model: string) => {
        currentModel = model;
      },
      listModels: async () => {
        const reg = getActiveProviderRegistration();
        if (!reg) {
          return [];
        }
        return reg.listModels();
      },
      registerProvider: (provider: DroneLlmProviderRegistration) => {
        insertProviderSorted(provider);
        registration.logger.info(
          `LLM provider "${provider.id}" registered (precedence: ${provider.precedence})`
        );

        // Auto-activate if no provider is active yet, or if this provider
        // matches the configured default.
        const config = registration.getConfig();
        if (!activeProviderId) {
          if (config.llm.provider === provider.id) {
            activateProvider(provider.id);
          }
        }
      },
      unregisterProvider: (providerId: string) => {
        removeProvider(providerId);
        registration.logger.info(`LLM provider "${providerId}" unregistered`);
      },
    };
    registration.offer(capability);

    // ── onPluginsLoaded: activate the configured provider ─────────────
    registration.hooks.onPluginsLoaded(async () => {
      const config = registration.getConfig();
      const configuredProvider = config.llm.provider;

      // If the configured provider is already registered, activate it.
      const existing = providers.find(p => p.id === configuredProvider);
      if (existing) {
        activateProvider(existing.id);
        registration.logger.info(
          `LLM provider activated: "${activeProviderId}" (model: ${currentModel})`
        );
      } else if (providers.length > 0) {
        // Fall back to the first registered provider.
        activateProvider(providers[0].id);
        registration.logger.info(
          `Configured provider "${configuredProvider}" not found; activated "${activeProviderId}" instead`
        );
      } else {
        registration.logger.warn(
          'No LLM provider plugins are registered. The agent will not be able to chat.'
        );
      }
    });

    // ── /model slash command ──────────────────────────────────────────
    registration.registerSlashCommand({
      command: '/model',
      description:
        'List models or switch model. Use --provider <id> to switch provider.',
      handler: async ctx => {
        if (!ctx.conversation) {
          ctx.logger.warn(
            'Conversation service not available — cannot list or switch models.'
          );
          return true;
        }

        const llm = ctx.engine.getCapability<DroneLlmCapability>('llm');
        if (!llm) {
          ctx.logger.warn('LLM broker capability not available.');
          return true;
        }

        const args = ctx.args;

        // Check for --provider flag
        const providerIdx = args.indexOf('--provider');
        let modelTokens = args;
        if (providerIdx !== -1 && providerIdx + 1 < args.length) {
          const providerId = args[providerIdx + 1];
          modelTokens = args.filter((_, idx) => idx !== providerIdx && idx !== providerIdx + 1);
          try {
            llm.activateProvider(providerId);
            const defaultModel = llm.getModel();
            ctx.conversation.setModel(defaultModel);
            ctx.logger.info(
              `Switched provider: ${providerId} (default model: ${defaultModel})`
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.logger.warn(`Failed to switch provider: ${msg}`);
            return true;
          }
        }

        const rest = modelTokens.join(' ');

        // No argument: list models
        if (rest.length === 0) {
          try {
            const models = await llm.listModels();
            const current = llm.getModel();
            const providerId = llm.getActiveProviderId();
            const providers = llm
              .getAvailableProviders()
              .map(provider => provider.id)
              .join(', ');
            const lines = models.map(m =>
              m === current ? `  * ${m} (current)` : `    ${m}`
            );
            ctx.logger.info(
              `Provider: ${providerId}\nRegistered providers: ${providers}\nAvailable models:\n${lines.join('\n')}`
            );
            ctx.logger.info(`\nUse /model <name> to switch.`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.logger.warn(`Failed to list models: ${msg}`);
          }
          return true;
        }

        // Has argument: switch model
        const modelName = rest;
        try {
          const available = await llm.listModels();
          if (!available.includes(modelName)) {
            throw new Error(
              `Model "${modelName}" is not available on provider "${llm.getActiveProviderId()}". Available: ${available.join(', ')}`
            );
          }
          llm.setModel(modelName);
          ctx.conversation.setModel(modelName);
          ctx.logger.info(`Switched to model: ${modelName}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.warn(`Failed to switch model: ${msg}`);
        }
        return true;
      },
    });

    // ── Help snippets ─────────────────────────────────────────────────
    registration.registerHelp(
      '/model [name]         List models or switch model'
    );
    registration.registerHelp(
      '/model --provider <id> [name]  Switch provider, optionally set model'
    );
  },
};
