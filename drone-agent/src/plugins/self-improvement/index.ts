import type {
  DronePersonaCapability,
  DronePlugin,
  DroneSkillsCapability,
} from 'drone-core';
import {
  createFileInsightEngine,
  createFilePrincipleEngine,
} from './file-engine.js';
import { createSelfImprovementCapability } from './capability.js';
import { renderInsightTargetsFragment } from './prompt-fragment.js';
import { renderPrinciplesFragment } from './principles-fragment.js';
import { createInsightTool } from './tools/insight.js';
import { createInsightsListTool } from './tools/insights-list.js';
import { createInsightsRecallTool } from './tools/insights-recall.js';
import { createPrinciplesStoreTool } from './tools/principles-store.js';
import { createPrinciplesListTool } from './tools/principles-list.js';
import { createPrinciplesRecallTool } from './tools/principles-recall.js';
import { createPrinciplesDeleteTool } from './tools/principles-delete.js';

export const selfImprovementPlugin: DronePlugin = {
  metadata: {
    id: 'self-improvement',
    name: 'Self-Improvement',
    version: '0.1.0',
    description:
      'Records agent insights about personas, skills, or the project for later promotion into improvements. ' +
      'Also manages derived principles that are injected into persona prompts and skill recall results.',
    defaultEnabled: false,
    dependencies: [
      { id: 'persona', optional: true },
      { id: 'skills', optional: true },
    ],
  },
  register: async registration => {
    const projectDir = process.cwd();
    const personaCap = () =>
      registration.request<DronePersonaCapability>('persona');
    const skillsCap = () =>
      registration.request<DroneSkillsCapability>('skills');

    // Default file-based engines for local-scoped targets
    const defaultInsightEngine = createFileInsightEngine(
      'self-improvement-default',
      projectDir,
      personaCap,
      skillsCap
    );
    const defaultPrincipleEngine = createFilePrincipleEngine(
      'self-improvement-default',
      projectDir,
      personaCap,
      skillsCap
    );

    // ── Offer DroneSelfImprovementCapability ──────────────────────────
    const selfImprovementCapability = createSelfImprovementCapability(
      registration.logger,
      defaultInsightEngine,
      defaultPrincipleEngine,
      personaCap,
      skillsCap
    );

    registration.offer(selfImprovementCapability);

    // ── Prompt fragment: insight-targets (header) ─────────────────────
    registration.registerPromptFragment({
      key: 'insight-targets',
      phase: 'header',
      render: async () => renderInsightTargetsFragment(personaCap()),
    });

    // ── Tools ─────────────────────────────────────────────────────────
    registration.registerTool(
      createInsightTool(personaCap, skillsCap, defaultInsightEngine)
    );
    registration.registerTool(createInsightsListTool(defaultInsightEngine));
    registration.registerTool(
      createInsightsRecallTool(personaCap, skillsCap, defaultInsightEngine)
    );
    registration.registerTool(
      createPrinciplesStoreTool(personaCap, skillsCap, defaultPrincipleEngine)
    );
    registration.registerTool(createPrinciplesListTool(defaultPrincipleEngine));
    registration.registerTool(
      createPrinciplesRecallTool(personaCap, skillsCap, defaultPrincipleEngine)
    );
    registration.registerTool(
      createPrinciplesDeleteTool(personaCap, skillsCap, defaultPrincipleEngine)
    );

    // ── Prompt fragment: principles (footer) ──────────────────────────
    registration.registerPromptFragment({
      key: 'principles',
      phase: 'footer',
      render: async () =>
        renderPrinciplesFragment(
          projectDir,
          personaCap(),
          defaultPrincipleEngine
        ),
    });

    // ── onPluginsLoaded: register recall enhancer + log status ──────
    registration.hooks.onPluginsLoaded(async () => {
      const sCap = skillsCap();
      if (sCap?.onRecall) {
        sCap.onRecall(async (id, body) => {
          const principles = await selfImprovementCapability.getPrinciples(
            'skill',
            id
          );
          if (principles.length === 0) return body;
          const lines = ['\n## Principles'];
          for (const p of principles) {
            lines.push('- ' + p.principle);
          }
          return body + lines.join('\n');
        });
      }

      registration.logger.info(
        'self-improvement plugin ready (broker mode: routes to provider-registered storage engines; ' +
          'defaults to file-based storage in .drone-agent/insights/ and .drone-agent/principles/)'
      );
    });
  },
};
