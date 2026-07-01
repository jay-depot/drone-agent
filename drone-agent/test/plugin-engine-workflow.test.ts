import { describe, expect, it } from 'vitest';
import { createDefaultAgentConfig, type DroneElicitation } from 'drone-core';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { createTestPlugin } from './helpers.js';

const noopEl: DroneElicitation = {
  ask: async () => ({}),
};

describe('plugin-engine workflow registry', () => {
  it('runs a workflow and returns its result shape', async () => {
    const workflowPlugin = createTestPlugin({
      id: 'wf',
      workflows: [
        {
          name: 'hello',
          description: 'says hello',
          run: async () => ({ kickMessage: 'hi', toolResult: '{"ok":true}' }),
        },
      ],
    });
    const engine = createDronePluginEngine({
      plugins: [workflowPlugin],
      config: createDefaultAgentConfig(),
    });
    engine.setElicitation(noopEl);
    await engine.initialize();

    const result = await engine.runWorkflow('wf__hello', {});
    expect(result.kickMessage).toBe('hi');
    expect(result.toolResult).toBe('{"ok":true}');
  });

  it('allows the same workflow short-name in different plugins', async () => {
    // Same `name: 'do'` in different plugins is fine — workflows are
    // namespaced by plugin id, matching tools.
    const a = createTestPlugin({
      id: 'a',
      workflows: [
        {
          name: 'do',
          description: 'a__do',
          run: async () => ({ toolResult: '"a"' }),
        },
      ],
    });
    const b = createTestPlugin({
      id: 'b',
      workflows: [
        {
          name: 'do',
          description: 'b__do',
          run: async () => ({ toolResult: '"b"' }),
        },
      ],
    });
    const engine = createDronePluginEngine({
      plugins: [a, b],
      config: createDefaultAgentConfig(),
    });
    await engine.initialize();
    engine.setElicitation(noopEl);
    expect((await engine.runWorkflow('a__do', {})).toolResult).toBe('"a"');
    expect((await engine.runWorkflow('b__do', {})).toolResult).toBe('"b"');
  });

  it('throws on unknown workflow name', async () => {
    const engine = createDronePluginEngine({
      plugins: [],
      config: createDefaultAgentConfig(),
    });
    await engine.initialize();
    engine.setElicitation(noopEl);
    await expect(engine.runWorkflow('nope.missing', {})).rejects.toThrow(
      /Unknown workflow/
    );
  });

  it('throws when no elicitation is set', async () => {
    const plugin = createTestPlugin({
      id: 'wf',
      workflows: [{ name: 'x', description: 'x', run: async () => ({}) }],
    });
    const engine = createDronePluginEngine({
      plugins: [plugin],
      config: createDefaultAgentConfig(),
    });
    await engine.initialize();
    // No setElicitation call.
    await expect(engine.runWorkflow('wf__x', {})).rejects.toThrow(
      /did not provide an interactive capability/
    );
  });
});

describe('plugin-engine workflow normalization', () => {
  async function runReturning(
    raw: import('drone-core').DroneWorkflowRunReturn
  ): Promise<import('drone-core').DroneWorkflowResult> {
    const plugin = createTestPlugin({
      id: 'wf',
      workflows: [
        {
          name: 'x',
          description: 'x',
          run: async () => raw,
        },
      ],
    });
    const engine = createDronePluginEngine({
      plugins: [plugin],
      config: createDefaultAgentConfig(),
    });
    await engine.initialize();
    engine.setElicitation(noopEl);
    return engine.runWorkflow('wf__x', {});
  }

  it('passes through result objects with kickMessage and toolResult', async () => {
    const result = (await runReturning({
      kickMessage: 'k',
      toolResult: 't',
    })) as { kickMessage?: string; toolResult?: string };
    expect(result.kickMessage).toBe('k');
    expect(result.toolResult).toBe('t');
  });

  it('passes through result objects with only kickMessage', async () => {
    const result = (await runReturning({ kickMessage: 'k' })) as {
      kickMessage?: string;
      toolResult?: string;
    };
    expect(result.kickMessage).toBe('k');
    expect(result.toolResult).toBeUndefined();
  });

  it('passes through result objects with only toolResult', async () => {
    const result = (await runReturning({ toolResult: 't' })) as {
      kickMessage?: string;
      toolResult?: string;
    };
    expect(result.kickMessage).toBeUndefined();
    expect(result.toolResult).toBe('t');
  });

  it('wraps a string return as toolResult', async () => {
    const result = (await runReturning('just a string')) as {
      kickMessage?: string;
      toolResult?: string;
    };
    expect(result.toolResult).toBe('just a string');
    expect(result.kickMessage).toBeUndefined();
  });

  it('serializes a plain object return as JSON toolResult', async () => {
    const result = (await runReturning({ ok: true, count: 3 })) as {
      toolResult?: string;
    };
    expect(result.toolResult).toBe(JSON.stringify({ ok: true, count: 3 }));
  });

  it('returns empty object for void / undefined', async () => {
    const v = await runReturning(undefined as unknown as undefined);
    expect(v).toEqual({ toolResult: '{}' });
  });
});

describe('plugin-engine workflow context', () => {
  it('passes elicit, projectDir, config, and requestCapability to the workflow', async () => {
    let captured: unknown = null;
    const plugin = createTestPlugin({
      id: 'wf',
      workflows: [
        {
          name: 'capture',
          description: 'capture ctx',
          run: async (_args, ctx) => {
            captured = {
              elicit: typeof ctx.elicit?.ask === 'function',
              projectDir: ctx.projectDir,
              hasConfig: !!ctx.config,
              requestCapability: typeof ctx.requestCapability === 'function',
            };
            return { toolResult: '{}' };
          },
        },
      ],
    });
    const engine = createDronePluginEngine({
      plugins: [plugin],
      config: createDefaultAgentConfig(),
    });
    await engine.initialize();
    engine.setElicitation(noopEl);
    await engine.runWorkflow('wf__capture', {});
    expect(captured).toEqual({
      elicit: true,
      projectDir: process.cwd(),
      hasConfig: true,
      requestCapability: true,
    });
  });

  it('requestCapability resolves capabilities offered by other plugins', async () => {
    let sawProvider = false;
    const providerPlugin = createTestPlugin({
      id: 'ollama',
      capability: { provider: { chat: async () => ({ message: 'x' }) } },
    });
    const workflowPlugin = createTestPlugin({
      id: 'wf',
      dependencies: [{ id: 'ollama' }],
      workflows: [
        {
          name: 'use-ollama',
          description: 'use ollama',
          run: async (_args, ctx) => {
            const cap = ctx.requestCapability<{
              provider: { chat: () => Promise<{ message: string }> };
            }>('ollama');
            if (cap?.provider) {
              sawProvider = true;
            }
            return {};
          },
        },
      ],
    });
    const engine = createDronePluginEngine({
      plugins: [providerPlugin, workflowPlugin],
      config: createDefaultAgentConfig(),
    });
    await engine.initialize();
    engine.setElicitation(noopEl);
    await engine.runWorkflow('wf__use-ollama', {});
    expect(sawProvider).toBe(true);
  });

  it('forwards args to the workflow run function', async () => {
    let receivedArgs: Record<string, unknown> | null = null;
    const plugin = createTestPlugin({
      id: 'wf',
      workflows: [
        {
          name: 'echo',
          description: 'echo args',
          run: async args => {
            receivedArgs = args;
            return {};
          },
        },
      ],
    });
    const engine = createDronePluginEngine({
      plugins: [plugin],
      config: createDefaultAgentConfig(),
    });
    await engine.initialize();
    engine.setElicitation(noopEl);
    await engine.runWorkflow('wf__echo', { scope: 'project', id: 'reviewer' });
    expect(receivedArgs).toEqual({ scope: 'project', id: 'reviewer' });
  });
});

describe('plugin-engine setElicitation / getElicitation', () => {
  it('setElicitation stores the capability; getElicitation returns it', async () => {
    const engine = createDronePluginEngine({
      plugins: [],
      config: createDefaultAgentConfig(),
    });
    await engine.initialize();
    expect(engine.getElicitation()).toBeUndefined();
    engine.setElicitation(noopEl);
    expect(engine.getElicitation()).toBe(noopEl);
    engine.setElicitation(undefined);
    expect(engine.getElicitation()).toBeUndefined();
  });

  it('registration.requestElicitation returns the host-set capability', async () => {
    let beforeInit: unknown = undefined;
    const observed: { viaRegistration?: unknown; viaCtx?: unknown } = {};
    const observer = createTestPlugin({
      id: 'observer',
      register: async registration => {
        // Capture at register time (before setElicitation is called).
        beforeInit = registration.requestElicitation();
        registration.registerWorkflow({
          name: 'peek',
          description: 'peek',
          run: async (_args, ctx) => {
            // Capture at workflow run time (after setElicitation).
            observed.viaRegistration = registration.requestElicitation();
            observed.viaCtx = ctx.elicit;
            return {};
          },
        });
      },
    });
    const engine = createDronePluginEngine({
      plugins: [observer],
      config: createDefaultAgentConfig(),
    });
    await engine.initialize();
    expect(beforeInit).toBeUndefined();
    engine.setElicitation(noopEl);
    await engine.runWorkflow('observer__peek', {});
    expect(observed.viaRegistration).toBe(noopEl);
    expect(observed.viaCtx).toBe(noopEl);
  });
});
