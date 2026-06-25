import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink';
import React from 'react';
import type { DroneAgentConfig, DroneLlmCapability } from 'drone-core';
import { ModelPicker } from './tui/components/ModelPicker.js';
import type { createConversationService } from './runtime/conversation-service.js';
import type { createDronePluginEngine } from './runtime/plugin-engine.js';
import type { createConsoleLogger } from 'drone-core';
import { createReadlineElicitation } from './elicitation.js';

export type CreateConsoleLogger = ReturnType<typeof createConsoleLogger>;
export type CreateConversationService = ReturnType<
  typeof createConversationService
>;
export type CreateDronePluginEngine = ReturnType<
  typeof createDronePluginEngine
>;

/**
 * Show the Ink-based model picker and resolve with the chosen model id.
 *
 * Used during the first-run flow when no user-level config exists. The
 * picker renders into the normal scrollback (no alt screen) and exits
 * cleanly on Enter or Esc, leaving the terminal in a state where the
 * chat TUI can mount on top without raw-mode collisions.
 */
export function pickModelInteractive(
  models: string[],
  current: string
): Promise<string> {
  return new Promise<string>(resolve => {
    let resolved = false;
    const finish = (model: string): void => {
      if (resolved) return;
      resolved = true;
      instance.unmount();
      resolve(model);
    };
    const instance = render(
      <ModelPicker models={models} current={current} onSelect={finish} />,
      { exitOnCtrlC: true }
    );
  });
}

/**
 * First-run setup: probe for available providers and ask the user which
 * one to use. Writes the user's choice to ~/.drone-agent/config.json.
 */
export async function runFirstRunSetup(
  llm: DroneLlmCapability,
  engine: CreateDronePluginEngine,
  conversation: CreateConversationService,
  logger: CreateConsoleLogger,
  config: DroneAgentConfig
): Promise<void> {
  const userConfigDir = path.join(os.homedir(), '.drone-agent');
  const userConfigFile = path.join(userConfigDir, 'config.json');

  // Probe for available providers
  const availableProviders: { id: string; label: string }[] = [];

  // Check if Ollama is reachable
  const ollamaCap = engine.getCapability<{
    listModels: () => Promise<string[]>;
  }>('ollama');
  if (ollamaCap) {
    try {
      const models = await ollamaCap.listModels();
      if (models.length > 0) {
        availableProviders.push({ id: 'ollama', label: 'Ollama (local)' });
      }
    } catch {
      // Ollama not reachable — don't add it
    }
  }

  // OpenRouter is always an option (user provides the key)
  availableProviders.push({ id: 'openrouter', label: 'OpenRouter (cloud)' });

  if (availableProviders.length === 0) {
    logger.warn(
      'No LLM providers available. Install Ollama (https://ollama.ai) or configure OpenRouter manually.'
    );
    return;
  }

  // Use the readline elicitation to ask the user
  const elicit = createReadlineElicitation();

  while (true) {
    const answers = await elicit.ask([
      {
        id: 'provider',
        prompt: 'Which LLM provider would you like to use?',
        choices: availableProviders.map(p => ({
          value: p.id,
          label: p.label,
        })),
        defaultValue: availableProviders[0].id,
      },
    ]);

    const chosenProvider = answers.provider;

    if (chosenProvider === 'ollama') {
      // Ollama flow: pick a model
      try {
        const ollamaCap2 = engine.getCapability<{
          listModels: () => Promise<string[]>;
        }>('ollama');
        if (!ollamaCap2) {
          logger.warn('Ollama capability not available.');
          continue;
        }
        const models = await ollamaCap2.listModels();
        if (models.length === 0) {
          logger.warn(
            'No Ollama models found. Pull a model first (e.g. "ollama pull llama3.1").'
          );
          continue;
        }

        const selectedModel = await pickModelInteractive(
          models,
          config.ollama.model
        );

        await mkdir(userConfigDir, { recursive: true });
        await writeFile(
          userConfigFile,
          JSON.stringify(
            {
              llm: { provider: 'ollama' },
              ollama: { model: selectedModel },
            },
            null,
            2
          ) + '\n'
        );

        logger.info(
          `Wrote ${userConfigFile} with Ollama model "${selectedModel}".`
        );
        conversation.setModel(selectedModel);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed to set up Ollama: ${msg}`);
        continue;
      }
    }

    if (chosenProvider === 'openrouter') {
      // OpenRouter flow: prompt for API key, pick a model
      const keyAnswers = await elicit.ask([
        {
          id: 'apiKey',
          prompt:
            'Enter your OpenRouter API key (it will be stored in config with env var interpolation):',
          freeform: true,
          placeholder: 'sk-or-v1-...',
          inputLabel: 'API key',
        },
      ]);

      const apiKey = keyAnswers.apiKey.trim();
      if (!apiKey) {
        logger.warn('API key is required for OpenRouter.');
        continue;
      }

      // Show curated default model list for selection
      const defaultModels = [
        { id: 'openai/gpt-4o', contextWindow: 128000 },
        { id: 'anthropic/claude-3.5-sonnet', contextWindow: 200000 },
        { id: 'google/gemini-2.0-flash-001', contextWindow: 1000000 },
        { id: 'mistralai/mistral-large-2411', contextWindow: 128000 },
        { id: 'meta-llama/llama-3.3-70b-instruct', contextWindow: 128000 },
      ];

      const modelAnswers = await elicit.ask([
        {
          id: 'model',
          prompt: 'Which model would you like to use as default?',
          choices: defaultModels.map(m => ({
            value: m.id,
            label: m.id,
          })),
          defaultValue: defaultModels[0].id,
        },
      ]);

      const selectedModel = modelAnswers.model;

      await mkdir(userConfigDir, { recursive: true });
      await writeFile(
        userConfigFile,
        JSON.stringify(
          {
            llm: { provider: 'openrouter' },
            openrouter: {
              apiKey: '${OPENROUTER_API_KEY}',
              defaultModel: selectedModel,
              baseUrl: 'https://openrouter.ai/api/v1',
              models: defaultModels,
            },
          },
          null,
          2
        ) + '\n'
      );

      // Set the env var for the current process
      process.env['OPENROUTER_API_KEY'] = apiKey;

      logger.info(
        `Wrote ${userConfigFile} with OpenRouter model "${selectedModel}".`
      );
      logger.info(
        'Set OPENROUTER_API_KEY in your environment or edit the config file directly.'
      );
      conversation.setModel(selectedModel);
      return;
    }

    // Unknown choice — loop back
    logger.warn('Unknown provider. Please choose again.');
  }
}
