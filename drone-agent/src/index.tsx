import { createConsoleLogger, type DroneLlmCapability } from 'drone-core';
import { stdout as output } from 'node:process';
import { createBuiltInPlugins } from './plugins/index.js';
import {
  discoverExternalPlugins,
  promptForPluginTrust,
} from './plugins/external-loader.js';
import { createTui } from './tui/index.js';
import { createConversationService } from './runtime/conversation-service.js';
import { createContextBudgetService } from './runtime/context-budget-service.js';
import { loadAgentConfig } from './runtime/config.js';
import {
  createDronePluginEngine,
  getDefaultEnabledPluginIds,
} from './runtime/plugin-engine.js';
import { createSessionManager } from './runtime/session-manager.js';

import { parseCliArgs } from './cli.js';
import { makePlainOutputEventHandler } from './output-handlers.js';
import { createReadlineElicitation } from './elicitation.js';
import { runFirstRunSetup } from './first-run.js';
import {
  runInteractiveLoop,
  runJsonMode,
  runJsonListenMode,
  getLlmCapability,
} from './interactive.js';
import { runMigrate } from './migrate.js';

async function main(): Promise<void> {
  const logger = createConsoleLogger('drone-agent');
  const invocation = parseCliArgs(process.argv.slice(2));

  const resolvedConfig = await loadAgentConfig(process.cwd(), {
    configDir: invocation.options.configDir,
  });

  // Handle migrate subcommand early (no engine needed)
  if (invocation.kind === 'migrate') {
    await runMigrate(invocation.migrateOptions, invocation.options.configDir);
    return;
  }

  const model =
    invocation.options.modelOverride ?? resolvedConfig.config.ollama.model;
  const sessionManager = createSessionManager();

  // The budget service needs renderPromptFragments from the engine, but the
  // engine is only constructable once we have the full plugin list. Use a
  // deferred getter to break the cycle.
  const engineRef: {
    current: ReturnType<typeof createDronePluginEngine> | undefined;
  } = {
    current: undefined,
  };
  const getEngine = (): ReturnType<typeof createDronePluginEngine> => {
    if (!engineRef.current) {
      throw new Error('engine accessed before init.');
    }
    return engineRef.current;
  };

  // Create the budget service with a lazy renderPromptFragments getter.
  // The getProvider and getModel are also lazy — they resolve through the
  // LLM broker once the engine is initialized.
  const budgetService = createContextBudgetService({
    config: resolvedConfig.config,
    renderPromptFragments: () => getEngine().renderPromptFragments(),
    getProvider: () => {
      const llm = getEngine().getCapability<DroneLlmCapability>('llm');
      if (!llm) {
        throw new Error('LLM provider broker is not available.');
      }
      return llm.getActiveProvider();
    },
    getModel: () => {
      const llm = getEngine().getCapability<DroneLlmCapability>('llm');
      if (!llm) {
        return model;
      }
      return llm.getModel();
    },
  });
  const builtInPlugins = createBuiltInPlugins({
    budgetService,
    sessionManager,
    getModel: () => {
      const llm = getEngine().getCapability<DroneLlmCapability>('llm');
      if (!llm) {
        return model;
      }
      return llm.getModel();
    },
    getProvider: () => {
      const llm = getEngine().getCapability<DroneLlmCapability>('llm');
      if (!llm) {
        throw new Error('LLM provider broker is not available.');
      }
      return llm.getActiveProvider();
    },
    emitEvent: event => {
      try {
        getEngine().runConversationEventHooks(event);
      } catch {
        // Non-fatal — compaction events are best-effort for TUI visibility.
      }
    },
  });

  // ── External plugin discovery ───────────────────────────────────────
  // Discover plugins from user and project scope directories.
  // User plugins are loaded silently. Project plugins are checked against
  // the trust file; trusted ones are loaded, untrusted ones are skipped,
  // and unknown ones are deferred for prompting after elicitation is set up.
  const { userPlugins, projectPlugins, deferredProjectPlugins } =
    await discoverExternalPlugins(process.cwd(), invocation.options.configDir);

  if (userPlugins.length > 0) {
    logger.info(`discovered ${userPlugins.length} user external plugin(s)`);
  }
  if (projectPlugins.length > 0) {
    logger.info(
      `discovered ${projectPlugins.length} trusted project external plugin(s)`
    );
  }
  if (deferredProjectPlugins.length > 0) {
    logger.info(
      `discovered ${deferredProjectPlugins.length} project external plugin(s) requiring trust`
    );
  }

  // Combine all plugins: built-in + user external + trusted project external
  const allPlugins = [...builtInPlugins, ...userPlugins, ...projectPlugins];

  // ── Plugin overrides from --plugin flag ─────────────────────────────
  // Merge --plugin overrides into the config's enabledPlugins so that
  // plugins specified on the CLI are enabled for this session. If
  // enabledPlugins is empty (default), compute the default set first,
  // then add the overrides. If it's non-empty (explicit config), just
  // append the overrides.
  if (invocation.options.pluginOverrides.length > 0) {
    if (resolvedConfig.config.enabledPlugins.length === 0) {
      // Compute the default set: all required or defaultEnabled plugins.
      const defaultIds = getDefaultEnabledPluginIds(allPlugins);
      resolvedConfig.config.enabledPlugins = [
        ...defaultIds,
        ...invocation.options.pluginOverrides,
      ];
    } else {
      // Config already specifies enabledPlugins — append overrides.
      resolvedConfig.config.enabledPlugins = [
        ...resolvedConfig.config.enabledPlugins,
        ...invocation.options.pluginOverrides,
      ];
    }
  }
  const engine = createDronePluginEngine({
    plugins: allPlugins,
    config: resolvedConfig.config,
    logger,
    runtimeOptions: {
      subagentId: invocation.options.subagentId,
      persona: invocation.options.persona,
    },
  });
  engineRef.current = engine;
  const conversation = createConversationService({
    engine,
    config: resolvedConfig.config,
    logger,
    sessionManager,
    budgetService,
    // When the tool iteration limit is reached and the config allows
    // prompting, ask the user whether to continue. The elicitation
    // capability is set lazily (by the TUI App on mount, or by the
    // readline host in plain-output mode), so we resolve it at call
    // time via engine.getElicitation().
    onToolIterationLimitReached: resolvedConfig.config.session
      .promptOnToolIterationLimit
      ? async (current, max) => {
          const elicit = engine.getElicitation();
          if (!elicit) return false; // non-interactive → abort
          const answers = await elicit.ask([
            {
              id: 'continue',
              prompt: `Tool call depth reached ${current}/${max}. Continue the session?`,
              choices: [
                { value: 'yes', label: 'Yes, continue' },
                { value: 'no', label: 'No, stop' },
              ],
              defaultValue: 'no',
            },
          ]);
          return answers.continue === 'yes';
        }
      : undefined,
    // When the same tool keeps failing, prompt the user to continue or stop.
    onStuckErrorThresholdReached: async (toolName, errorCode, failureCount) => {
      const elicit = engine.getElicitation();
      if (!elicit) return false; // non-interactive → abort
      const codeSuffix = errorCode ? ` (${errorCode})` : '';
      const answers = await elicit.ask([
        {
          id: 'continue',
          prompt: `Tool ${toolName}${codeSuffix} failed ${failureCount} times in a row. Continue anyway?`,
          choices: [
            { value: 'yes', label: 'Yes, continue' },
            { value: 'no', label: 'No, stop' },
          ],
          defaultValue: 'no',
        },
      ]);
      return answers.continue === 'yes';
    },
  });
  const registeredPlugins = await engine.initialize();

  // ── Elicitation wiring ──────────────────────────────────────────────
  // In plain-output mode we attach the readline-backed elicitation
  // immediately. In TUI mode the App constructs its own elicitation
  // capability; we wire it just before `createTui({...})` further down
  // so the App has its UI handlers registered. In non-interactive
  // modes (e.g. `--once`, workflow runs from non-interactive shells)
  // we deliberately leave the capability unset so plugins that try to
  // elicit get a clean "host is non-interactive" error rather than a
  // hanging readline.
  if (invocation.kind === 'default' && invocation.options.outputPlain) {
    engine.setElicitation(createReadlineElicitation());
  }

  await engine.runHooks('onPluginsLoaded');
  await engine.runHooks('onSessionStart');

  // ── Deferred project plugin trust prompting ──────────────────────────
  // After elicitation is set up, prompt the user for any project-scope
  // plugins that have no trust decision yet. In non-interactive modes
  // (--once, --output-json), deferred plugins are silently skipped.
  if (deferredProjectPlugins.length > 0) {
    const elicit = engine.getElicitation();
    if (elicit) {
      for (const { plugin, dirPath } of deferredProjectPlugins) {
        const result = await promptForPluginTrust(
          plugin,
          dirPath,
          process.cwd(),
          elicit
        );
        if (result === 'trusted') {
          await engine.addExternalPlugin(plugin);
          logger.info(
            `trusted and loaded project plugin: ${plugin.metadata.id}`
          );
        } else if (result === 'untrusted') {
          logger.info(`project plugin marked untrusted: ${plugin.metadata.id}`);
        } else {
          logger.info(`project plugin skipped: ${plugin.metadata.id}`);
        }
      }
    } else {
      // Non-interactive mode — skip deferred plugins silently.
      for (const { plugin } of deferredProjectPlugins) {
        logger.info(
          `skipping deferred project plugin (non-interactive): ${plugin.metadata.id}`
        );
      }
    }
  }

  // ── First-run setup ──────────────────────────────────────────────────
  // If no user-level config exists, probe for available providers and ask
  // the user which one to use.
  const hasUserLayer = resolvedConfig.layers.some(l => l.scope === 'user');
  if (!hasUserLayer && !invocation.options.modelOverride) {
    const llm = getLlmCapability(engine);
    if (llm) {
      await runFirstRunSetup(
        engine,
        conversation,
        logger,
        resolvedConfig.config,
        getDefaultEnabledPluginIds(allPlugins)
      );
    }
  }

  const activeModel = conversation.getModel();
  const activeProviderId =
    getLlmCapability(engine)?.getActiveProviderId() ?? 'unknown';
  logger.info(`registered plugins: ${registeredPlugins.length}`);
  logger.info(`registered tools: ${engine.getRegisteredToolCount()}`);
  logger.info(
    `config layers: ${resolvedConfig.layers.map(layer => layer.scope).join(', ')}`
  );
  logger.info(`llm provider: ${activeProviderId}`);
  logger.info(`model: ${activeModel}`);

  if (invocation.kind === 'chat') {
    await engine.runHooks('onBeforePrompt');
    const plainHandler = makePlainOutputEventHandler();
    const response = await conversation.sendUserMessage(
      invocation.prompt,
      plainHandler
    );
    // The handler deliberately suppresses assistantMessage events to avoid
    // double-printing; render the final reply here.
    output.write(`${response}\n`);
    await engine.runHooks('onAfterToolCall');
  } else if (invocation.kind === 'workflow') {
    // For workflow runs we always need elicitation. If we're in plain
    // mode the capability is already set; otherwise (e.g. someone ran
    // `--workflow` without `--plain-output`) attach the readline
    // elicitation here so the wizard can prompt.
    if (!engine.getElicitation()) {
      engine.setElicitation(createReadlineElicitation());
    }
    const { pluginId, workflowName, args } = invocation.options.workflow;
    const canonicalName = `${pluginId}__${workflowName}`;
    await engine.runHooks('onBeforePrompt');
    const result = await engine.runWorkflow(canonicalName, args);
    if (result.toolResult) {
      logger.info(result.toolResult);
    }
    await engine.runHooks('onAfterToolCall');

    if (result.kickMessage) {
      // The workflow wants the agent to react to its completion. Inject
      // the message as a synthetic user turn and re-enter the chat loop
      // so the assistant can summarise the result.
      sessionManager.appendUserMessage(result.kickMessage);
      await engine.runHooks('onBeforePrompt');
      const plainHandler = makePlainOutputEventHandler();
      const reply = await conversation.sendUserMessage(
        result.kickMessage,
        plainHandler
      );
      output.write(`${reply}\n`);
      await engine.runHooks('onAfterToolCall');
    }
  } else if (invocation.kind === 'default' && invocation.options.once) {
    // === Subagent mode: --once (+ optionally --output-json) ===
    // Run JSON mode if --output-json: read kickoff from stdin, output NDJSON
    if (invocation.options.outputJson) {
      await runJsonMode(conversation, engine);
    } else {
      // --once without --output-json: run a single tool
      const selectedTool = engine.getTool('startup__status');
      if (!selectedTool) {
        throw new Error('Startup status tool is unavailable.');
      }
      await engine.runHooks('onBeforePrompt');
      const result = await selectedTool.execute({});
      logger.info(result);
      await engine.runHooks('onAfterToolCall');
    }
  } else if (invocation.kind === 'default' && !invocation.options.once) {
    if (invocation.options.outputJson) {
      // JSON listen mode: read chat events from stdin, emit NDJSON events
      await runJsonListenMode(conversation, engine);
    } else if (invocation.options.outputPlain) {
      await runInteractiveLoop(conversation, engine, logger, sessionManager);
    } else {
      // TUI mode: defer elicitation wiring to the App (it constructs a
      // TUI-flavoured capability that draws prompts into the chat log).
      // The App reads `engine.getElicitation()` indirectly through its
      // own state — see tui/app.tsx for the construction site.
      const tui = createTui({
        engine,
        conversation,
        model,
        logger,
      });
      await tui.waitUntilExit();
    }
  } else {
    const selectedTool =
      invocation.kind === 'tool'
        ? engine.getTool(invocation.toolName)
        : engine.getTool('startup__status');
    if (!selectedTool) {
      throw new Error(
        invocation.kind === 'tool'
          ? `Unknown tool: ${invocation.toolName}`
          : 'Startup status tool is unavailable.'
      );
    }

    await engine.runHooks('onBeforePrompt');
    const result =
      invocation.kind === 'tool'
        ? await engine.executeTool(invocation.toolName, invocation.input)
        : await selectedTool.execute({});
    logger.info(result);
    await engine.runHooks('onAfterToolCall');
  }

  await engine.runHooks('onShutdown');
}

// Exported for tests
/** @internal */
export { parseCliArgs as parseCliInvocation };
/** @internal */
export { createReadlineElicitation };

main().catch(error => {
  const logger = createConsoleLogger('drone-agent');
  logger.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error)
  );
  process.exitCode = 1;
});
