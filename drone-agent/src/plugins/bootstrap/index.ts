import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DroneAgentConfig, DronePlugin, DroneWorkflow } from 'drone-core';
import { detectProject } from './project-detect.js';
import { createSwarmMemoryWorkflow } from './swarm-memory.js';

type DroneConfigCapability = {
  getConfig: () => DroneAgentConfig;
  getLayers: () => Promise<unknown>;
  setValue: (
    scope: 'project' | 'user',
    key: string,
    value: unknown
  ) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Plugin metadata
// ---------------------------------------------------------------------------

export const bootstrapPlugin: DronePlugin = {
  metadata: {
    id: 'bootstrap',
    name: 'Bootstrap',
    version: '0.2.0',
    description:
      'Project setup and plugin configuration workflows. Use with --plugin bootstrap to enable.',
    defaultEnabled: false,
  },
  register: async registration => {
    // -----------------------------------------------------------------------
    // bootstrap.analyze
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'analyze',
      description:
        'Analyze the current project directory and return detected language, framework, build system, and suggested plugins to enable.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Optional project path to analyze. Defaults to current working directory.',
          },
        },
        additionalProperties: false,
      },
      execute: async input => {
        const cwd =
          typeof input.path === 'string' && input.path.trim().length > 0
            ? path.resolve(input.path.trim())
            : process.cwd();
        const analysis = await detectProject(cwd);
        return JSON.stringify(analysis, null, 2);
      },
    });

    // -----------------------------------------------------------------------
    // bootstrap.project workflow
    // -----------------------------------------------------------------------
    const projectWorkflow: DroneWorkflow = {
      name: 'project',
      description:
        'Analyze the current project directory and interactively set up recommended plugins. Writes enabledPlugins to project config and enables them immediately.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Optional project path to analyze. Defaults to current working directory.',
          },
        },
        additionalProperties: false,
      },
      run: async (input, ctx) => {
        const cwd =
          typeof input.path === 'string' &&
          (input.path as string).trim().length > 0
            ? path.resolve((input.path as string).trim())
            : process.cwd();

        const analysis = await detectProject(cwd);

        // Show what we detected
        const detected: string[] = [];
        if (analysis.language) detected.push(`Language: ${analysis.language}`);
        if (analysis.framework)
          detected.push(`Framework: ${analysis.framework}`);
        if (analysis.buildSystem)
          detected.push(`Build system: ${analysis.buildSystem}`);
        if (analysis.hasGit) detected.push('Git repository detected');
        if (analysis.hasLspConfig) detected.push('LSP configuration detected');
        if (analysis.hasDroneConfig)
          detected.push('Existing drone-agent config');
        if (analysis.hasAgentsMd) detected.push('AGENTS.md found');

        const detectionSummary =
          detected.length > 0
            ? detected.join('\n')
            : 'No project indicators detected.';

        // Build the list of suggested plugins with descriptions
        const pluginDescriptions: Record<string, string> = {
          git: 'Git operations (status, diff, log, commit)',
          lsp: 'Language Server Protocol integration (diagnostics, hover, go-to-definition)',
          file: 'File system operations (read, write, list, apply-diff)',
          search: 'Text search with ripgrep',
          exec: 'Shell command execution',
          memory: 'Project-level memory store (opt-in)',
          selfImprovement: 'Self-improvement insights (opt-in)',
          todo: 'Todo list management (opt-in)',
        };

        // Always recommend file and search as base
        const basePlugins = ['file', 'search'];
        const suggested = [
          ...new Set([...basePlugins, ...analysis.suggestedPlugins]),
        ];

        const pluginChoices = suggested.map(id => ({
          value: id,
          label: pluginDescriptions[id] ?? id,
        }));

        // Ask the user which plugins to enable
        const answers = await ctx.elicit.ask([
          {
            id: 'plugins',
            prompt: `Project analysis for ${analysis.cwd}:\n\n${detectionSummary}\n\nWhich plugins would you like to enable?`,
            choices: pluginChoices,
            defaultValue: suggested.join(','),
          },
        ]);

        const selectedPluginIds = (answers.plugins as string)
          .split(',')
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0);

        if (selectedPluginIds.length === 0) {
          return {
            toolResult: JSON.stringify(
              { ok: true, message: 'No plugins selected.' },
              null,
              2
            ),
          };
        }

        // Write enabledPlugins to project config
        const config = ctx.config as DroneAgentConfig;
        const existingEnabled = [...config.enabledPlugins];
        const merged = [...new Set([...existingEnabled, ...selectedPluginIds])];

        // Use config capability if available, otherwise write directly
        const configCap =
          ctx.requestCapability<DroneConfigCapability>('config');
        if (configCap) {
          await configCap.setValue('project', 'enabledPlugins', merged);
        } else {
          // Fallback: write config directly
          const configDir = path.join(cwd, '.drone-agent');
          const configPath = path.join(configDir, 'config.json');
          await mkdir(configDir, { recursive: true });
          await writeFile(
            configPath,
            JSON.stringify({ enabledPlugins: merged }, null, 2) + '\n',
            'utf-8'
          );
        }

        // Enable plugins immediately in this session
        const enabledResults: string[] = [];
        for (const pluginId of selectedPluginIds) {
          const result = await ctx.enablePlugin(pluginId);
          enabledResults.push(
            `${pluginId}: ${result ? 'enabled' : 'not found'}`
          );
        }

        const summaryLines = [
          `Bootstrap project setup complete for ${analysis.cwd}`,
          '',
          'Enabled plugins:',
          ...enabledResults.map(r => `  - ${r}`),
          '',
          'Project config written to .drone-agent/config.json.',
          '',
          'The newly enabled plugins are now available. You can start using them right away.',
        ];

        return {
          toolResult: JSON.stringify(
            {
              ok: true,
              enabledPlugins: selectedPluginIds,
            },
            null,
            2
          ),
          kickMessage: summaryLines.join('\n'),
        };
      },
    };

    registration.registerWorkflow(projectWorkflow);

    // -----------------------------------------------------------------------
    // bootstrap.user workflow
    // -----------------------------------------------------------------------
    const userWorkflow: DroneWorkflow = {
      name: 'user',
      description:
        'Set up user-level drone-agent configuration: choose an LLM provider and default model.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      run: async (_input, ctx) => {
        // Check if user config already exists
        const userConfigDir = path.join(os.homedir(), '.drone-agent');
        const userConfigPath = path.join(userConfigDir, 'config.json');
        let hasExistingConfig = false;
        try {
          await access(userConfigPath, fsConstants.F_OK);
          hasExistingConfig = true;
        } catch {
          // No existing config — good to proceed
        }

        // Probe for available providers
        const availableProviders: { id: string; label: string }[] = [];

        const ollamaCap = ctx.requestCapability<{
          driver: {
            discoverModels?: (config: {
              baseUrl?: string;
            }) => Promise<Array<{ id: string }>>;
          };
        }>('ollama');

        if (ollamaCap?.driver.discoverModels) {
          try {
            const models = (await ollamaCap.driver.discoverModels({})).map(
              m => m.id
            );
            if (models.length > 0) {
              availableProviders.push({
                id: 'ollama',
                label: `Ollama (local, ${models.length} model(s) available)`,
              });
            } else {
              availableProviders.push({
                id: 'ollama',
                label: 'Ollama (local, no models pulled yet)',
              });
            }
          } catch {
            availableProviders.push({ id: 'ollama', label: 'Ollama (local)' });
          }
        }

        availableProviders.push({
          id: 'openai',
          label: 'OpenAI (cloud)',
        });

        availableProviders.push({
          id: 'anthropic',
          label: 'Anthropic (cloud)',
        });

        availableProviders.push({
          id: 'openrouter',
          label: 'OpenRouter (cloud)',
        });

        if (availableProviders.length === 0) {
          return {
            toolResult: JSON.stringify(
              {
                ok: false,
                message:
                  'No LLM providers available. Install Ollama or configure OpenAI/Anthropic/OpenRouter.',
              },
              null,
              2
            ),
          };
        }

        // Ask the user which provider to use
        const providerAnswer = await ctx.elicit.ask([
          {
            id: 'provider',
            prompt: hasExistingConfig
              ? 'You already have a user-level config. Which LLM provider would you like to configure?'
              : 'Which LLM provider would you like to use?',
            choices: availableProviders.map(p => ({
              value: p.id,
              label: p.label,
            })),
            defaultValue: availableProviders[0].id,
          },
        ]);

        const chosenProvider = providerAnswer.provider as string;

        // Ollama flow: pick a model
        if (chosenProvider === 'ollama') {
          const models = ollamaCap?.driver.discoverModels
            ? (await ollamaCap.driver.discoverModels({})).map(m => m.id)
            : [];
          if (models.length === 0) {
            const msgAnswer = await ctx.elicit.ask([
              {
                id: 'model',
                prompt:
                  'No Ollama models found. Enter the model name to use (or press Enter for default):',
                freeform: true,
                placeholder: 'e.g. llama3.1',
                defaultValue: 'llama3.1',
              },
            ]);
            const selectedModel = (msgAnswer.model as string) || 'llama3.1';
            await writeUserConfig(userConfigPath, {
              llm: { active: `ollama/${selectedModel}` },
              providers: {
                ollama: {
                  protocol: 'ollama',
                  baseUrl: 'http://127.0.0.1:11434',
                  models: { [selectedModel]: {} },
                },
              },
            });
            // Enable ollama plugin if not already enabled
            await ctx.enablePlugin('ollama');
            return {
              toolResult: JSON.stringify(
                { ok: true, provider: 'ollama', model: selectedModel },
                null,
                2
              ),
              kickMessage: `User configuration set up with Ollama (model: ${selectedModel}).\nConfig written to ${userConfigPath}.`,
            };
          }

          const modelAnswer = await ctx.elicit.ask([
            {
              id: 'model',
              prompt: 'Available Ollama models:',
              choices: models.map(m => ({ value: m, label: m })),
              defaultValue: models[0],
            },
          ]);

          const selectedModel = modelAnswer.model as string;
          await writeUserConfig(userConfigPath, {
            llm: { active: `ollama/${selectedModel}` },
            providers: {
              ollama: {
                protocol: 'ollama',
                baseUrl: 'http://127.0.0.1:11434',
                models: { [selectedModel]: {} },
              },
            },
          });
          await ctx.enablePlugin('ollama');
          return {
            toolResult: JSON.stringify(
              { ok: true, provider: 'ollama', model: selectedModel },
              null,
              2
            ),
            kickMessage: `User configuration set up with Ollama (model: ${selectedModel}).\nConfig written to ${userConfigPath}.`,
          };
        }

        // OpenAI flow
        if (chosenProvider === 'openai') {
          const keyAnswer = await ctx.elicit.ask([
            {
              id: 'apiKey',
              prompt:
                'Enter your OpenAI API key (it will be stored with env var interpolation):',
              freeform: true,
              placeholder: 'sk-...',
              inputLabel: 'API key',
            },
          ]);

          const apiKey = (keyAnswer.apiKey as string).trim();
          if (!apiKey) {
            return {
              toolResult: JSON.stringify(
                { ok: false, message: 'API key is required for OpenAI.' },
                null,
                2
              ),
            };
          }

          const modelAnswer = await ctx.elicit.ask([
            {
              id: 'model',
              prompt: 'Which model would you like as default?',
              choices: [
                { value: 'gpt-4o', label: 'GPT-4o' },
                { value: 'gpt-4.1', label: 'GPT-4.1' },
                { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
              ],
              defaultValue: 'gpt-4o',
            },
          ]);

          const selectedModel = modelAnswer.model as string;
          await writeUserConfig(userConfigPath, {
            llm: { active: `openai/${selectedModel}` },
            providers: {
              openai: {
                protocol: 'openai',
                apiKey: '${OPENAI_API_KEY}',
                baseUrl: 'https://api.openai.com/v1',
                models: { [selectedModel]: {} },
              },
            },
          });

          process.env['OPENAI_API_KEY'] = apiKey;

          await ctx.enablePlugin('openai');
          return {
            toolResult: JSON.stringify(
              { ok: true, provider: 'openai', model: selectedModel },
              null,
              2
            ),
            kickMessage: `User configuration set up with OpenAI (model: ${selectedModel}).\nConfig written to ${userConfigPath}.\nSet OPENAI_API_KEY in your environment.`,
          };
        }

        // Anthropic flow
        if (chosenProvider === 'anthropic') {
          const keyAnswer = await ctx.elicit.ask([
            {
              id: 'apiKey',
              prompt:
                'Enter your Anthropic API key (it will be stored with env var interpolation):',
              freeform: true,
              placeholder: 'sk-ant-...',
              inputLabel: 'API key',
            },
          ]);

          const apiKey = (keyAnswer.apiKey as string).trim();
          if (!apiKey) {
            return {
              toolResult: JSON.stringify(
                { ok: false, message: 'API key is required for Anthropic.' },
                null,
                2
              ),
            };
          }

          const modelAnswer = await ctx.elicit.ask([
            {
              id: 'model',
              prompt: 'Which model would you like as default?',
              choices: [
                { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
                { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
                { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
              ],
              defaultValue: 'claude-sonnet-4-6',
            },
          ]);

          const selectedModel = modelAnswer.model as string;
          await writeUserConfig(userConfigPath, {
            llm: { active: `anthropic/${selectedModel}` },
            providers: {
              anthropic: {
                protocol: 'anthropic',
                apiKey: '${ANTHROPIC_API_KEY}',
                baseUrl: 'https://api.anthropic.com',
                apiVersion: '2023-06-01',
                models: { [selectedModel]: {} },
              },
            },
          });

          process.env['ANTHROPIC_API_KEY'] = apiKey;

          await ctx.enablePlugin('anthropic');
          return {
            toolResult: JSON.stringify(
              { ok: true, provider: 'anthropic', model: selectedModel },
              null,
              2
            ),
            kickMessage: `User configuration set up with Anthropic (model: ${selectedModel}).\nConfig written to ${userConfigPath}.\nSet ANTHROPIC_API_KEY in your environment.`,
          };
        }

        // OpenRouter flow
        if (chosenProvider === 'openrouter') {
          const keyAnswer = await ctx.elicit.ask([
            {
              id: 'apiKey',
              prompt:
                'Enter your OpenRouter API key (it will be stored with env var interpolation):',
              freeform: true,
              placeholder: 'sk-or-v1-...',
              inputLabel: 'API key',
            },
          ]);

          const apiKey = (keyAnswer.apiKey as string).trim();
          if (!apiKey) {
            return {
              toolResult: JSON.stringify(
                { ok: false, message: 'API key is required for OpenRouter.' },
                null,
                2
              ),
            };
          }

          const modelAnswer = await ctx.elicit.ask([
            {
              id: 'model',
              prompt: 'Which model would you like as default?',
              choices: [
                { value: 'openai/gpt-4o', label: 'GPT-4o' },
                {
                  value: 'anthropic/claude-3.5-sonnet',
                  label: 'Claude 3.5 Sonnet',
                },
                {
                  value: 'google/gemini-2.0-flash-001',
                  label: 'Gemini 2.0 Flash',
                },
              ],
              defaultValue: 'openai/gpt-4o',
            },
          ]);

          const selectedModel = modelAnswer.model as string;
          // OpenRouter upstream ids contain slashes; keeping the full id
          // as the local key preserves <provider>/<full-id> selection form.
          await writeUserConfig(userConfigPath, {
            llm: { active: `openrouter/${selectedModel}` },
            providers: {
              openrouter: {
                protocol: 'openrouter',
                apiKey: '${OPENROUTER_API_KEY}',
                baseUrl: 'https://openrouter.ai/api/v1',
                models: { [selectedModel]: {} },
              },
            },
          });

          // Set the env var for the current process
          process.env['OPENROUTER_API_KEY'] = apiKey;

          await ctx.enablePlugin('openrouter');
          return {
            toolResult: JSON.stringify(
              { ok: true, provider: 'openrouter', model: selectedModel },
              null,
              2
            ),
            kickMessage: `User configuration set up with OpenRouter (model: ${selectedModel}).\nConfig written to ${userConfigPath}.\nSet OPENROUTER_API_KEY in your environment.`,
          };
        }

        return {
          toolResult: JSON.stringify(
            { ok: false, message: `Unknown provider: ${chosenProvider}` },
            null,
            2
          ),
        };
      },
    };

    registration.registerWorkflow(userWorkflow);

    registration.registerWorkflow(createSwarmMemoryWorkflow());
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeUserConfig(
  filePath: string,
  config: Record<string, unknown>
): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}
