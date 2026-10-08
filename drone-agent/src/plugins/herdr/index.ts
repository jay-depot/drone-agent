/**
 * Herdr plugin — reports drone-agent's idle/working state and its session
 * resume command to the Herdr terminal multiplexer, so the agent appears in
 * `herdr agent list`, raises finish notifications, and can be restored to the
 * same pane after a Herdr server restart.
 *
 * Herdr contract (https://herdr.dev/docs/add-herdr-support/): report only
 * when `HERDR_ENV=1` and the pane env vars are set; outside Herdr the plugin
 * is inert. The session is only reportable when the swarm plugin is enabled
 * and has a session id (we need one for the resume command). Reports are
 * best-effort and coalesced (see reporter.ts).
 */

import type { DebugFlagRegistry, DronePlugin } from 'drone-core';
import { createReporter, type HerdrReporter } from './reporter.js';
import { buildResumeArgv, validateResumeArgv } from './resume-argv.js';

type RuntimeInfo = {
  isSubagent?: boolean;
  persona?: string | null;
  debugFlags?: DebugFlagRegistry;
};

type SwarmCapability = {
  getBeaconUrl: () => string;
  getAgentId: () => string;
};

/** Herdr `--source` id: stable, unique, and never prefixed with `herdr:`. */
const SOURCE = 'drone-agent';

/**
 * Optional host-provided CLI overrides to carry into the resume command.
 * These mirror the invocation the agent was started with, so a restored pane
 * behaves the same.
 */
export type HerdrPluginDeps = {
  modelOverride?: string;
  beaconHost?: string;
  beaconPort?: number;
};

export function createHerdrPlugin(deps?: HerdrPluginDeps): DronePlugin {
  return {
    metadata: {
      id: 'herdr',
      name: 'Herdr',
      version: '0.1.0',
      description:
        'Reports agent state and session resume to the Herdr terminal multiplexer.',
      defaultEnabled: false,
      dependencies: [{ id: 'swarm', optional: true }],
    },
    register: async registration => {
      const config = registration.getConfig().herdr;
      if (!config.enabled) return;

      const paneId = process.env.HERDR_PANE_ID;
      const binPath = process.env.HERDR_BIN_PATH;
      if (process.env.HERDR_ENV !== '1' || !paneId || !binPath) {
        return;
      }

      const runtime = registration.request<RuntimeInfo>('runtime');
      // Subagents inherit HERDR_ENV and share the parent's pane; reporting
      // from them would clobber the parent's state.
      if (runtime?.isSubagent) return;

      const debug = runtime?.debugFlags?.isEnabled('herdr')
        ? (message: string) => registration.logger.info(`[herdr] ${message}`)
        : undefined;

      const swarm = registration.request<SwarmCapability>('swarm');
      const sessionId = swarm?.getAgentId();

      if (!sessionId) {
        // No swarm session id -> nothing to report or resume. Warn once, on
        // the first user turn (guaranteed post-mount, so the TUI shows it).
        let warned = false;
        registration.hooks.onConversationEvent(async event => {
          if (warned || event.kind !== 'userMessage') return;
          warned = true;
          const content =
            '[herdr: no swarm session id — not reporting to Herdr]';
          registration.logger.warn(content);
          registration.emitEvent({ kind: 'notice', content });
        });
        return;
      }

      const resumeArgv = buildResumeArgv({
        resumeCommand: config.resumeCommand,
        sessionId,
        personaId: runtime?.persona ?? null,
        modelOverride: deps?.modelOverride,
        beaconHost: deps?.beaconHost,
        beaconPort: deps?.beaconPort,
      });
      const resumeValidation = validateResumeArgv(resumeArgv);
      if (!resumeValidation.ok) {
        registration.logger.warn(
          `herdr: resume command rejected (${resumeValidation.reason}); reporting state without it.`
        );
      }

      const reporter: HerdrReporter = createReporter({
        binPath,
        paneId,
        source: SOURCE,
        agentLabel: config.agentLabel,
        sessionId,
        resumeArgv: resumeValidation.ok ? resumeArgv : undefined,
        debug,
      });

      // Initial idle report: also the first report that holds the pane, so
      // Herdr accepts the resume command attached to it.
      reporter.report('idle');

      registration.hooks.onConversationEvent(async event => {
        if (event.kind === 'userMessage') {
          reporter.report('working');
        } else if (event.kind === 'roundComplete') {
          reporter.report('idle');
        }
        // TODO(FIXME): report 'blocked' when an elicitation-awaiting event
        // lands (wrap engine.setElicitation) — deferred, see ADR 239.
      });

      registration.hooks.onShutdown(async () => {
        await reporter.release();
      });

      registration.registerHelp(
        'Herdr: reports agent state and session resume to the Herdr terminal multiplexer. Enable via the herdr plugin.'
      );
    },
  };
}
