import { registerContextCommand } from './context-command.js';
import {
  DroneLlmError,
  parseModelSelection,
  type DiscoveredModel,
  type DroneContextWindowInfo,
  type DroneLlmCapability,
  type DroneLlmProvider,
  type DronePlugin,
  type DroneReasoningLevel,
  type DroneSlashCommandContext,
  type LlmProtocolDriver,
} from 'drone-core';

const VALID_REASONING_LEVELS: DroneReasoningLevel[] = [
  'off',
  'low',
  'medium',
  'high',
  'max',
];

const DISCOVERY_TTL_MS = 60_000;

type ProviderInstance = {
  providerId: string;
  provider: DroneLlmProvider;
  driver: LlmProtocolDriver;
};

type ModelListing = {
  /** Canonical full-form ids: `<providerId>/<modelLocalId>`. */
  fullIds: string[];
  /** Grouped by provider for display. */
  byProvider: Map<string, string[]>;
  discovered: Map<string, DiscoveredModel>;
};

export const llmPlugin: DronePlugin = {
  metadata: {
    id: 'llm',
    name: 'LLM Provider Broker',
    version: '0.2.0',
    description:
      'Broker for LLM protocol drivers. Instantiates one provider per config.providers entry and manages <providerId>/<model> selection.',
    defaultEnabled: true,
    dependencies: [],
  },
  register: async registration => {
    const drivers = new Map<string, LlmProtocolDriver>();
    const instances = new Map<string, ProviderInstance>();
    let currentModel = '';
    let activeProviderId = '';
    let reasoningLevel: DroneReasoningLevel | undefined;
    let discoveryCache:
      | {
          listing: ModelListing;
          fetchedAt: number;
        }
      | undefined;

    function instantiateProvider(
      providerId: string
    ): ProviderInstance | undefined {
      const config = registration.getConfig();
      const entry = config.providers[providerId];
      if (!entry) {
        return undefined;
      }
      const driver = drivers.get(entry.protocol);
      if (!driver) {
        registration.logger.warn(
          `Provider "${providerId}" uses protocol "${entry.protocol}" but no driver with that protocol id is registered. Enabled protocol plugins: ${[...drivers.keys()].join(', ') || '(none)'}.`
        );
        return undefined;
      }
      const instance: ProviderInstance = {
        providerId,
        provider: driver.createProvider(entry),
        driver,
      };
      instances.set(providerId, instance);
      return instance;
    }

    function getInstance(providerId: string): ProviderInstance | undefined {
      return instances.get(providerId) ?? instantiateProvider(providerId);
    }

    // ── Hybrid model listing: declared ⊕ discovered, declared wins ──
    async function buildModelListing(force = false): Promise<ModelListing> {
      if (
        !force &&
        discoveryCache &&
        Date.now() - discoveryCache.fetchedAt < DISCOVERY_TTL_MS
      ) {
        return discoveryCache.listing;
      }

      const config = registration.getConfig();
      const byProvider = new Map<string, string[]>();
      const discovered = new Map<string, DiscoveredModel>();

      for (const [providerId, entry] of Object.entries(config.providers)) {
        const declaredKeys = Object.keys(entry.models ?? {});
        const driver = drivers.get(entry.protocol);
        let discoveredModels: DiscoveredModel[] = [];
        if (driver?.discoverModels) {
          try {
            discoveredModels = await driver.discoverModels(entry);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            registration.logger.warn(
              `Model discovery failed for provider "${providerId}" (non-fatal, using declared models): ${message}`
            );
          }
        }

        for (const model of discoveredModels) {
          discovered.set(`${providerId}/${model.id}`, model);
        }

        const merged = new Set<string>([
          ...discoveredModels.map(m => m.id),
          ...declaredKeys,
        ]);
        byProvider.set(providerId, [...merged].sort());
      }

      const listing: ModelListing = {
        fullIds: [...byProvider.entries()].flatMap(([providerId, models]) =>
          models.map(model => `${providerId}/${model}`)
        ),
        byProvider,
        discovered,
      };
      discoveryCache = { listing, fetchedAt: Date.now() };
      return listing;
    }

    function invalidateDiscovery(): void {
      discoveryCache = undefined;
    }

    /**
     * Effective parameters = provider.parameters ⊕ model.parameters,
     * shallow (model wins per key). Aliased entries inherit the base
     * entry's parameters first. Caller-supplied request parameters
     * (currently none — future session knobs) win over both.
     */
    function mergeEffectiveParameters(
      providerId: string,
      fullId: string,
      requestParameters?: Record<string, unknown>
    ): Record<string, unknown> {
      const config = registration.getConfig();
      const providerEntry = config.providers[providerId];
      const metadata = resolveModelMetadata(fullId);
      return {
        ...(providerEntry?.parameters ?? {}),
        ...(metadata.parameters ?? {}),
        ...(requestParameters ?? {}),
      };
    }

    const contextWindowProvenanceLogged = new Set<string>();

    /**
     * Resolve the context window for a provider instance using the same
     * precedence as every other model attribute: declared ⊕ discovered
     * catalog data first (`source: 'metadata'`), then the driver's live
     * probe (`'provider'`/`'default'`), finally the session-config fallback
     * (`'config'`). Provenance is logged once per model so mis-sized windows
     * are diagnosable from the log alone.
     */
    async function resolveActiveContextWindow(
      instance: ProviderInstance,
      requestedModel?: string
    ): Promise<DroneContextWindowInfo> {
      const localModel = requestedModel || currentModel;
      const fullId = `${instance.providerId}/${localModel}`;
      const metadata = resolveModelMetadata(fullId);
      let resolved: DroneContextWindowInfo;
      if (metadata.contextWindow !== undefined) {
        resolved = {
          model: fullId,
          contextWindowTokens: metadata.contextWindow,
          source: 'metadata',
        };
      } else {
        const effective = mergeEffectiveParameters(instance.providerId, fullId);
        const probed = await instance.provider.getContextWindowInfo?.({
          model: metadata.model ?? localModel,
          parameters: effective,
          extra:
            registration.getConfig().providers[instance.providerId]?.extra ??
            {},
        });
        resolved = probed
          ? { ...probed, model: fullId }
          : {
              model: fullId,
              contextWindowTokens:
                registration.getConfig().session.contextWindowTokens,
              source: 'config',
            };
      }
      if (!contextWindowProvenanceLogged.has(fullId)) {
        contextWindowProvenanceLogged.add(fullId);
        registration.logger.info(
          `Context window for ${fullId}: ${resolved.contextWindowTokens} tokens (source: ${resolved.source})`
        );
      }
      return resolved;
    }

    /**
     * Known keys (driver parameterSchema) pass silently; unknown keys are
     * warned about once per request but still sent.
     */
    function warnUnknownParameters(
      instance: ProviderInstance,
      effective: Record<string, unknown>
    ): void {
      const known = new Set(
        Object.keys(instance.driver.parameterSchema?.parameters ?? {})
      );
      for (const key of Object.keys(effective)) {
        if (!known.has(key)) {
          registration.logger.warn(
            `Provider "${instance.providerId}": parameter "${key}" is not in the ${instance.driver.protocolId} schema; sending it anyway.`
          );
        }
      }
    }

    /** Resolve metadata for a full-form selection: declared > discovered > undefined. */
    function resolveModelMetadata(fullId: string): {
      contextWindow?: number;
      maxOutputTokens?: number;
      hasVision?: boolean;
      supportsTools?: boolean;
      reasoningLevel?: DroneReasoningLevel;
      parameters?: Record<string, unknown>;
      model?: string;
    } {
      const selection = parseModelSelection(fullId);
      if (!selection) {
        return {};
      }
      const config = registration.getConfig();
      const entry = config.providers[selection.providerId];
      const declared = entry?.models?.[selection.modelLocalId];

      // One-level alias: own entry > alias base entry.
      let base: typeof declared;
      if (declared?.model && entry?.models?.[declared.model]) {
        base = entry.models[declared.model];
      }

      const discoveredMeta = discoveryCache?.listing.discovered.get(fullId);

      return {
        contextWindow:
          declared?.contextWindow ??
          base?.contextWindow ??
          discoveredMeta?.contextWindow,
        maxOutputTokens:
          declared?.maxOutputTokens ??
          base?.maxOutputTokens ??
          discoveredMeta?.maxOutputTokens,
        hasVision:
          declared?.hasVision ??
          base?.hasVision ??
          discoveredMeta?.hasVision ??
          false,
        supportsTools:
          declared?.supportsTools ??
          base?.supportsTools ??
          discoveredMeta?.supportsTools ??
          true,
        reasoningLevel: declared?.reasoningLevel ?? base?.reasoningLevel,
        parameters: {
          ...(base?.parameters ?? {}),
          ...(declared?.parameters ?? {}),
        },
        model: declared?.model ?? selection.modelLocalId,
      };
    }

    // ── Capability ──────────────────────────────────────────────────────
    const capability: DroneLlmCapability = {
      registerDriver: driver => {
        drivers.set(driver.protocolId, driver);
        registration.logger.info(
          `LLM protocol driver registered: ${driver.protocolId}`
        );
        // Late driver arrival: instantiate any configured providers waiting
        // on this protocol. Activation waits for onPluginsLoaded so a
        // partial driver set never wins the llm.active race.
        const config = registration.getConfig();
        for (const [providerId, entry] of Object.entries(config.providers)) {
          if (
            entry.protocol === driver.protocolId &&
            !instances.has(providerId)
          ) {
            instantiateProvider(providerId);
          }
        }
      },
      getActiveProvider: () => {
        const instance = getInstance(activeProviderId);
        if (!instance) {
          throw new Error(
            'No active LLM provider. Ensure a providers config entry exists and its protocol plugin is enabled.'
          );
        }
        // Broker-enriched view of the provider: chat() fills the additive
        // DroneChatRequest fields (effective parameters, resolved metadata)
        // before delegating. Single interception point — wire contract intact.
        const inner = instance.provider;
        return {
          chat: async request => {
            const fullId = `${instance.providerId}/${request.model}`;
            const metadata = resolveModelMetadata(fullId);
            const effectiveParameters = mergeEffectiveParameters(
              instance.providerId,
              fullId,
              request.parameters
            );
            warnUnknownParameters(instance, effectiveParameters);
            try {
              return await inner.chat({
                ...request,
                parameters: effectiveParameters,
                extra: {
                  ...(registration.getConfig().providers[instance.providerId]
                    ?.extra ?? {}),
                },
                maxOutputTokens:
                  request.maxOutputTokens ?? metadata.maxOutputTokens,
                hasVision: request.hasVision ?? metadata.hasVision,
              });
            } catch (error) {
              if (error instanceof DroneLlmError && !error.providerId) {
                error.providerId = instance.providerId;
              }
              throw error;
            }
          },
          getContextWindowInfo: ({ model }) =>
            resolveActiveContextWindow(instance, model),
          supportsImagesInToolResults: inner.supportsImagesInToolResults,
        };
      },
      getActiveProviderId: () => activeProviderId,
      getAvailableProviders: () =>
        Object.entries(registration.getConfig().providers).map(
          ([id, entry]) => ({
            id,
            precedence: entry.protocol === 'ollama' ? 0 : 1,
          })
        ),
      activateProvider: (providerId: string) => {
        const instance = getInstance(providerId);
        if (!instance) {
          throw new Error(
            `LLM provider "${providerId}" is not available (unconfigured or its protocol driver is missing).`
          );
        }
        const previousProvider = activeProviderId;
        activeProviderId = providerId;
        const selection = parseModelSelection(currentModel);
        const keepModel =
          selection?.providerId === providerId
            ? selection.modelLocalId
            : undefined;
        const config = registration.getConfig();
        const models = config.providers[providerId]?.models ?? {};
        currentModel = keepModel ?? Object.keys(models)[0] ?? '';
        if (previousProvider !== providerId) {
          invalidateDiscovery();
        }
      },
      getModel: () => currentModel,
      setModel: (model: string) => {
        // Full-form selections (<provider>/<model>) switch providers when
        // needed; bare ids set within the active provider as before.
        if (model.includes('/')) {
          const selection = parseModelSelection(model);
          if (selection && getInstance(selection.providerId)) {
            if (selection.providerId !== activeProviderId) {
              activateFull(selection.providerId, selection.modelLocalId);
              return;
            }
            currentModel = selection.modelLocalId;
            return;
          }
        }
        currentModel = model;
      },
      getReasoningLevel: () => reasoningLevel,
      setReasoningLevel: (level: DroneReasoningLevel | undefined) => {
        reasoningLevel = level;
      },
      listModels: async () => {
        const listing = await buildModelListing();
        return listing.fullIds;
      },
      hasVision: (model: string) => {
        const fullId = model.includes('/')
          ? model
          : `${activeProviderId}/${model}`;
        return resolveModelMetadata(fullId).hasVision ?? false;
      },
      registerProvider: provider => {
        // Legacy path — retained for the migration window. Wraps the
        // registration as a synthetic provider instance.
        const providerId = provider.id;
        const legacyProvider: ProviderInstance = {
          providerId,
          provider: provider.getProvider(),
          driver: {
            protocolId: `legacy:${providerId}`,
            createProvider: () => provider.getProvider(),
            parameterSchema: { parameters: {} },
          },
        };
        instances.set(providerId, legacyProvider);
        registration.logger.info(
          `LLM provider "${providerId}" registered via legacy registerProvider (deprecated)`
        );
        if (!activeProviderId) {
          const config = registration.getConfig();
          if (config.llm.provider === providerId) {
            activeProviderId = providerId;
            currentModel = provider.getDefaultModel();
          }
        }
      },
      unregisterProvider: (providerId: string) => {
        instances.delete(providerId);
        registration.logger.info(`LLM provider "${providerId}" unregistered`);
      },
    };
    registration.offer(capability);

    function maybeAutoActivate(): void {
      if (activeProviderId) {
        return;
      }
      const config = registration.getConfig();
      const active = config.llm.active;
      if (active) {
        const selection = parseModelSelection(active);
        if (selection && getInstance(selection.providerId)) {
          activateFull(selection.providerId, selection.modelLocalId);
          registration.logger.info(
            `LLM provider activated: "${activeProviderId}" (model: ${currentModel})`
          );
          return;
        }
      }
      // Fallback: first configured provider that has a driver.
      for (const providerId of Object.keys(config.providers)) {
        if (getInstance(providerId)) {
          activateFull(providerId, '');
          registration.logger.warn(
            `llm.active "${active ?? '(unset)'}" could not be activated; fell back to "${providerId}"`
          );
          return;
        }
      }
      if (Object.keys(config.providers).length > 0) {
        registration.logger.warn(
          'No LLM provider could be activated (missing protocol drivers?). The agent will not be able to chat.'
        );
      }
    }

    function activateFull(providerId: string, modelLocalId: string): void {
      const instance = getInstance(providerId)!;
      activeProviderId = instance.providerId;
      if (modelLocalId) {
        currentModel = modelLocalId;
      } else {
        const config = registration.getConfig();
        const models = config.providers[providerId]?.models ?? {};
        currentModel = Object.keys(models)[0] ?? '';
      }
    }

    // ── onPluginsLoaded: activate from llm.active ─────────────────────
    registration.hooks.onPluginsLoaded(async () => {
      maybeAutoActivate();
      if (activeProviderId) {
        // Warm the discovery cache so the first /model listing is instant.
        void buildModelListing().catch(() => {
          // Non-fatal — listing recomputes on demand.
        });
      }
    });

    // ── /model slash command ──────────────────────────────────────────
    registerModelCommand(registration, {
      capability,
      listModels: () => buildModelListing(),
      resolveMetadata: resolveModelMetadata,
    });

    // ── /reasoning slash command ──────────────────────────────────────
    registerReasoningCommand(registration, capability);

    // ── /context slash command ────────────────────────────────────────
    registerContextCommand(registration, capability);

    // ── Help snippets ─────────────────────────────────────────────────
    registration.registerHelp(
      '/model [provider/model]  List models or switch (bare id = active provider)'
    );
    registration.registerHelp(
      '/model --once <provider/model>  Switch without persisting'
    );
    registration.registerHelp(
      '/reasoning [level]    Show or set reasoning level (off/low/medium/high/max)'
    );
    registration.registerHelp(
      '/reasoning --raw <v>  Set reasoning level to a provider-specific raw value'
    );
    registration.registerHelp(
      '/context              Show resolved context window, provenance, and usage'
    );
  },
};

// ── Slash command wiring (kept out of register() for file-size discipline) ──

type ModelCommandDeps = {
  capability: DroneLlmCapability;
  listModels: () => Promise<{
    fullIds: string[];
    byProvider: Map<string, string[]>;
  }>;
  resolveMetadata: (fullId: string) => { hasVision?: boolean };
};

function registerModelCommand(
  registration: Parameters<DronePlugin['register']>[0],
  deps: ModelCommandDeps
): void {
  registration.registerSlashCommand({
    command: '/model',
    description:
      'List models or switch. /model <provider/model> persists to user config; /model --once <pick> switches for this invocation only.',
    handler: async ctx => {
      const llm = ctx.engine.getCapability<DroneLlmCapability>('llm');
      if (!llm) {
        ctx.logger.warn('LLM broker capability not available.');
        return true;
      }

      const args = ctx.args;

      const onceIdx = args.indexOf('--once');
      const once = onceIdx !== -1;
      const pickTokens =
        onceIdx !== -1 ? args.filter((_, idx) => idx !== onceIdx) : args;
      const pick = pickTokens.join(' ');

      // No argument: read-only browse grouped by provider
      if (pick.length === 0) {
        try {
          const listing = await deps.listModels();
          const current = `${llm.getActiveProviderId()}/${llm.getModel()}`;
          const lines: string[] = [];
          for (const [providerId, models] of listing.byProvider) {
            lines.push(`${providerId}:`);
            for (const model of models) {
              const fullId = `${providerId}/${model}`;
              const hasVision = (await llm.hasVision?.(fullId)) ?? false;
              const visionTag = hasVision ? ' [vision]' : '';
              lines.push(
                fullId === current
                  ? `  * ${fullId}${visionTag} (current)`
                  : `    ${fullId}${visionTag}`
              );
            }
          }
          ctx.logger.info(
            `Available models:\n${lines.join('\n')}\n\nUse /model <provider/model> to switch (persists), or /model --once <provider/model> for this session only.`
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.warn(`Failed to list models: ${msg}`);
        }
        return true;
      }

      // Switch model — bare ids resolve against the active provider.
      const target = pick.includes('/')
        ? pick
        : `${llm.getActiveProviderId()}/${pick}`;
      const selection = parseModelSelection(target);
      if (!selection) {
        ctx.logger.warn(
          `Invalid model selection "${pick}". Use <provider>/<model>.`
        );
        return true;
      }

      try {
        const available = await deps.listModels();
        const providerModels = available.byProvider.get(selection.providerId);
        if (
          !providerModels ||
          !providerModels.includes(selection.modelLocalId)
        ) {
          throw new Error(
            `Model "${target}" is not available. Use bare /model to list.`
          );
        }

        llm.activateProvider(selection.providerId);
        llm.setModel(selection.modelLocalId);
        if (ctx.conversation) {
          ctx.conversation.setModel(target);
        }
        ctx.logger.info(
          once
            ? `Switched to ${target} (session only — not persisted)`
            : `Switched to ${target}`
        );

        if (!once) {
          await persistActiveModel(ctx, target);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`Failed to switch model: ${msg}`);
      }
      return true;
    },
  });
}

async function persistActiveModel(
  ctx: DroneSlashCommandContext,
  target: string
): Promise<void> {
  const configCap = ctx.engine.getCapability<{
    setValue: (
      scope: 'project' | 'user',
      key: string,
      value: unknown
    ) => Promise<void>;
  }>('config');
  if (!configCap) {
    ctx.logger.warn(
      `Config capability unavailable — set llm.active to "${target}" manually to persist.`
    );
    return;
  }
  try {
    await configCap.setValue('user', 'llm.active', target);
    ctx.logger.info(`Persisted llm.active="${target}" to user config.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(`Failed to persist llm.active: ${msg}`);
  }
}

function registerReasoningCommand(
  registration: Parameters<DronePlugin['register']>[0],
  llm: DroneLlmCapability
): void {
  registration.registerSlashCommand({
    command: '/reasoning',
    description:
      'Show or set reasoning level. Levels: off, low, medium, high, max. Use --raw <value> to pass through unvalidated.',
    handler: async ctx => {
      if (!ctx.conversation) {
        ctx.logger.warn(
          'Conversation service not available — cannot set reasoning level.'
        );
        return true;
      }

      const args = ctx.args;

      const rawIdx = args.indexOf('--raw');
      if (rawIdx !== -1 && rawIdx + 1 < args.length) {
        const rawValue = args[rawIdx + 1];
        llm.setReasoningLevel(rawValue as DroneReasoningLevel);
        ctx.conversation.setReasoningLevel(rawValue as DroneReasoningLevel);
        ctx.logger.info(`Reasoning level set to raw: ${rawValue}`);
        return true;
      }

      const saveIdx = args.indexOf('--save');
      const levelTokens =
        saveIdx !== -1
          ? args.filter((_, idx) => idx !== saveIdx && idx !== saveIdx + 1)
          : args;
      const levelArg = levelTokens.join(' ');

      if (levelArg.length === 0) {
        const current = llm.getReasoningLevel();
        const levelDisplay = current ?? '(provider default)';
        ctx.logger.info(
          `Current reasoning level: ${levelDisplay}\n` +
            `Available levels: ${VALID_REASONING_LEVELS.join(', ')}\n` +
            `Use /reasoning <level> to set, /reasoning --raw <value> for provider-specific values.`
        );
        return true;
      }

      const isValidLevel = VALID_REASONING_LEVELS.includes(
        levelArg as DroneReasoningLevel
      );
      if (!isValidLevel) {
        ctx.logger.warn(
          `Invalid reasoning level "${levelArg}". Valid levels: ${VALID_REASONING_LEVELS.join(', ')}`
        );
        return true;
      }

      const newLevel = levelArg as DroneReasoningLevel;
      llm.setReasoningLevel(newLevel);
      ctx.conversation.setReasoningLevel(newLevel);

      ctx.logger.info(`Reasoning level set to: ${newLevel}`);

      if (saveIdx !== -1) {
        ctx.logger.info(
          `To persist, run: /config set llm.reasoningLevel ${newLevel} --scope user`
        );
      }

      return true;
    },
  });
}
