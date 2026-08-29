import { registerContextCommand } from './context-command.js';
import {
  DroneLlmError,
  parseModelSelection,
  resolveConfiguredReasoningLevel,
  type DiscoveredModel,
  type DroneChatMessage,
  type DroneContextWindowInfo,
  type DroneImageContent,
  type DroneLlmCapability,
  type DroneLlmProvider,
  type DronePlugin,
  type DroneReasoningLevel,
  type DroneResolvedModelRole,
  type DroneSlashCommandContext,
  type LlmProtocolDriver,
} from 'drone-core';
import {
  DEFAULT_RETRY_CONFIG,
  withBoundedSilentRetry,
} from '../../runtime/llm-retry.js';

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

    // Broker precedence: lower number = higher priority. Currently ollama
    // (local, free) outranks remote providers. Used to order the D8 breadth
    // fallback and the getAvailableProviders listing.
    function providerPrecedence(providerId: string): number {
      const entry = registration.getConfig().providers[providerId];
      return entry?.protocol === 'ollama' ? 0 : 1;
    }

    // Broker-enriched view of a provider instance: chat() fills the additive
    // DroneChatRequest fields (effective parameters, resolved metadata) before
    // delegating. Single interception point — wire contract intact. Used by the
    // active provider AND any model-role-resolved provider.
    function enrichProvider(instance: ProviderInstance): DroneLlmProvider {
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
    }

    // Session-lifetime dedup for role-resolution warnings/announcements, so a
    // broken role (or a role that diverges from active) is logged once, not on
    // every call.
    const warnedFallbackRoles = new Set<string>();
    const announcedRoleDivergence = new Set<string>();

    function activeFallback(): DroneResolvedModelRole {
      const instance = getInstance(activeProviderId);
      if (!instance) {
        throw new Error(
          'No active LLM provider. Ensure a providers config entry exists and its protocol plugin is enabled.'
        );
      }
      return {
        provider: enrichProvider(instance),
        providerId: activeProviderId,
        model: currentModel,
      };
    }

    /**
     * Resolve a named model role per `llm.modelRoles`. Stateless: never mutates
     * the active selection and emits no events. Unset/unknown/broken roles fall
     * back to the active selection with a one-time-per-role warning.
     */
    function resolveModelForRoleImpl(role: string): DroneResolvedModelRole {
      const config = registration.getConfig();
      const raw = config.llm?.modelRoles?.[role];
      if (!raw) {
        return activeFallback();
      }
      const selection = parseModelSelection(raw);
      const instance = selection && getInstance(selection.providerId);
      if (!selection || !instance) {
        if (!warnedFallbackRoles.has(role)) {
          warnedFallbackRoles.add(role);
          registration.logger.warn(
            `Model role "${role}" (${raw}) could not be resolved; falling back to the active selection.`
          );
        }
        return activeFallback();
      }
      if (
        instance.providerId !== activeProviderId ||
        selection.modelLocalId !== currentModel
      ) {
        if (!announcedRoleDivergence.has(role)) {
          announcedRoleDivergence.add(role);
          registration.logger.info(
            `Model role "${role}" resolved to ${instance.providerId}/${selection.modelLocalId} (differs from active ${activeProviderId}/${currentModel}).`
          );
        }
      }
      return {
        provider: enrichProvider(instance),
        providerId: instance.providerId,
        model: selection.modelLocalId,
        reasoningLevel: resolveConfiguredReasoningLevel(config, selection),
      };
    }

    // Session-lifetime dedup for describer-resolution warnings, so a missing
    // vision-capable describer is logged once, not on every describe call.
    const warnedNoDescriber = new Set<string>();

    /**
     * Resolve a vision-capable describer selection per the D8 fallback chain:
     *   1. configured `image_describer` if vision-capable
     *   2. active selection if vision-capable
     *   3. same provider entry as the pinned describer: any vision-capable
     *      model under that exact `config.providers.<id>`
     *   4. breadth: any configured+instantiated vision-capable model in
     *      broker precedence order
     *   5. none → warn + skip (lazy/idempotent so a later model change can retry)
     * Returns undefined when no vision-capable model is available.
     */
    function resolveDescriber(): DroneResolvedModelRole | undefined {
      const config = registration.getConfig();
      const pinnedRaw = config.llm?.modelRoles?.['image_describer'];

      // 1. Pinned image_describer if vision-capable.
      if (pinnedRaw) {
        const pinned = parseModelSelection(pinnedRaw);
        const pinnedInstance = pinned && getInstance(pinned.providerId);
        if (pinned && pinnedInstance) {
          const fullId = `${pinned.providerId}/${pinned.modelLocalId}`;
          if (resolveModelMetadata(fullId).hasVision) {
            return {
              provider: enrichProvider(pinnedInstance),
              providerId: pinned.providerId,
              model: pinned.modelLocalId,
              reasoningLevel: resolveConfiguredReasoningLevel(config, pinned),
            };
          }
        }
      }

      // 2. Active selection if vision-capable.
      const activeInstance = getInstance(activeProviderId);
      if (activeInstance && currentModel) {
        const activeFullId = `${activeProviderId}/${currentModel}`;
        if (resolveModelMetadata(activeFullId).hasVision) {
          return {
            provider: enrichProvider(activeInstance),
            providerId: activeProviderId,
            model: currentModel,
          };
        }
      }

      // 3. Same provider entry as the pinned describer: any vision-capable
      //    model under that exact `config.providers.<id>`.
      if (pinnedRaw) {
        const pinned = parseModelSelection(pinnedRaw);
        if (pinned) {
          const entry = config.providers[pinned.providerId];
          const pinnedInstance = getInstance(pinned.providerId);
          if (entry && pinnedInstance) {
            for (const modelId of Object.keys(entry.models ?? {})) {
              const fullId = `${pinned.providerId}/${modelId}`;
              if (resolveModelMetadata(fullId).hasVision) {
                return {
                  provider: enrichProvider(pinnedInstance),
                  providerId: pinned.providerId,
                  model: modelId,
                  reasoningLevel: resolveConfiguredReasoningLevel(config, {
                    providerId: pinned.providerId,
                    modelLocalId: modelId,
                  }),
                };
              }
            }
          }
        }
      }

      // 4. Breadth: any configured+instantiated vision-capable model in
      //    broker precedence order.
      const providerIds = Object.keys(config.providers).sort(
        (a, b) => providerPrecedence(a) - providerPrecedence(b)
      );
      for (const providerId of providerIds) {
        const entry = config.providers[providerId];
        const instance = getInstance(providerId);
        if (!instance) continue;
        for (const modelId of Object.keys(entry.models ?? {})) {
          const fullId = `${providerId}/${modelId}`;
          if (resolveModelMetadata(fullId).hasVision) {
            return {
              provider: enrichProvider(instance),
              providerId,
              model: modelId,
              reasoningLevel: resolveConfiguredReasoningLevel(config, {
                providerId,
                modelLocalId: modelId,
              }),
            };
          }
        }
      }

      // 5. None → warn + skip.
      if (!warnedNoDescriber.has('image_describer')) {
        warnedNoDescriber.add('image_describer');
        registration.logger.warn(
          'No vision-capable model is available to describe images (image_describer role unset or no vision-capable model configured). Images will be sent as-is.'
        );
      }
      return undefined;
    }

    const DESCRIBER_SYSTEM_PROMPT =
      'You are an image describer. Describe the image in detail, focusing on the visual content, layout, text, and any notable elements. Be concise but complete.';

    /**
     * Describe images that lack descriptions, using the resolved describer
     * model. Skips already-described images. Fails open: on describer failure
     * or timeout, images are returned unchanged (idempotent — a later call
     * can retry).
     */
    async function describeImagesImpl(
      images: DroneImageContent[]
    ): Promise<DroneImageContent[]> {
      const undescribed = images.filter(img => !img.description);
      if (undescribed.length === 0) {
        return images;
      }
      const describer = resolveDescriber();
      if (!describer) {
        return images;
      }

      // D10: borrow T1 only — bounded silent auto-retry honoring session.retry
      // backoff (same policy as the main loop's runWithRetry T1 branch). No T2
      // (no user prompting for background artifact work); the outer ~60s
      // timeout in the caller is the hard cap.
      const retry = registration.getConfig().session.retry;
      const describerRetryConfig = {
        maxRetries: retry?.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries,
        maxWaitMs: retry?.maxWaitMs ?? DEFAULT_RETRY_CONFIG.maxWaitMs,
        backoffBaseMs:
          retry?.backoffBaseMs ?? DEFAULT_RETRY_CONFIG.backoffBaseMs,
        backoffFactor:
          retry?.backoffFactor ?? DEFAULT_RETRY_CONFIG.backoffFactor,
      };

      const result = [...images];
      for (const img of undescribed) {
        const idx = result.indexOf(img);
        try {
          const response = await withBoundedSilentRetry(
            async () =>
              describer.provider.chat({
                model: describer.model,
                reasoningLevel: describer.reasoningLevel,
                messages: [
                  { role: 'system', content: DESCRIBER_SYSTEM_PROMPT },
                  {
                    role: 'user',
                    content: 'Describe this image:',
                    images: [img],
                  },
                ],
              }),
            describerRetryConfig
          );
          const description = response.message?.trim();
          if (description && idx !== -1) {
            result[idx] = { ...img, description };
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          registration.logger.warn(
            `Image description failed (non-fatal, image sent as-is): ${message}`
          );
        }
      }
      return result;
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
        return enrichProvider(instance);
      },
      resolveModelForRole: resolveModelForRoleImpl,
      getActiveProviderId: () => activeProviderId,
      getAvailableProviders: () =>
        Object.keys(registration.getConfig().providers).map(id => ({
          id,
          precedence: providerPrecedence(id),
        })),
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
      describeImages: describeImagesImpl,
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
