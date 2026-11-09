/**
 * `drone-swarm-project` — a kanban board swarm extension.
 *
 * Runs as a long-lived daemon: it connects to the coordinator as an extension
 * node (declaring a capability catalog + a front-end bundle) and owns the
 * board. Moving a card between columns can match an automation, which enqueues
 * a paced spawn job; the scheduler starts jobs under the node's speed limits.
 *
 * Config via env (prefix `DRONE_SWARM_PROJECT_`) and `--pre-approval-token-path`.
 */

import {
  createExtensionNode,
  redeemPreApprovalToken,
  type ExtensionNode,
} from 'drone-swarm-common';
import type { Job, Project } from './board-types.js';
import { CAPABILITIES } from './capabilities.js';
import { BUNDLE, buildBundleFiles } from './bundle.js';
import { resolveConfig, type ProjectConfig } from './config.js';
import { makeHandlers } from './handlers.js';
import { Scheduler } from './scheduler.js';
import { ReconcileTracker } from './scheduler-reconcile.js';
import { makeSessionHandlers } from './session-events.js';
import { spawnSession, instructSession } from './spawn.js';
import { createJsonStore } from './store/json-store.js';

export interface StartedService {
  node: ExtensionNode;
  scheduler: Scheduler;
  stop: () => Promise<void>;
}

function automationFor(project: Project, job: Job) {
  return project.automations.find(automation => automation.id === job.ruleId);
}

/**
 * Start the extension node, the JSON store, and the scheduler. Returns a stop
 * function that tears them all down.
 */
export async function startProjectService(
  cfg: ProjectConfig = resolveConfig()
): Promise<StartedService> {
  const store = await createJsonStore(cfg.dataDir, {
    maxConcurrentSessions: cfg.maxConcurrentSessions,
    maxDailySessions: cfg.maxDailySessions,
  });

  const settings = { injectToolsIntoAllSessions: cfg.injectToolsIntoAllSessions };
  const coordinatorFetch = fetch;

  const scheduler = new Scheduler({
    store,
    board: store,
    spawn: async (job: Job, project: Project) => {
      const automation = automationFor(project, job);
      if (!project.defaultBeaconId) {
        throw new Error(
          `project ${project.id} has no defaultBeaconId; cannot spawn`
        );
      }
      return spawnSession(
        { fetch: coordinatorFetch, coordinatorUrl: cfg.coordinatorUrl },
        {
          targetBeaconId: project.defaultBeaconId,
          personaId: automation?.then.personaId ?? 'code',
          ...(automation?.then.model ? { model: automation.then.model } : {}),
          ...(project.defaultWorkingDir
            ? { workingDir: project.defaultWorkingDir }
            : {}),
          extensionHint: `drone-swarm-project:card:${job.cardId}`,
        }
      );
    },
  });

  const reconcile = new ReconcileTracker({
    onSettle: async staleJobIds => {
      await scheduler.reconcile(staleJobIds);
    },
  });

  let node!: ExtensionNode;
  node = await createExtensionNode({
    coordinatorUrl: cfg.coordinatorUrl,
    dataDir: cfg.dataDir,
    id: cfg.id,
    name: 'drone-swarm-project',
    capabilities: CAPABILITIES,
    handlers: {
      ...makeHandlers({ board: store, scheduler, store, settings }),
      ...makeSessionHandlers({
        store,
        board: store,
        getNode: () => node,
        instruct: (sessionId, content) =>
          instructSession(
            { fetch: coordinatorFetch, coordinatorUrl: cfg.coordinatorUrl },
            { sessionId, content }
          ),
        settings,
        reconcile,
        scheduler,
      }),
    },
  });

  try {
    await node.uploadBundle({
      name: BUNDLE.name,
      version: BUNDLE.version,
      files: await buildBundleFiles(),
    });
  } catch {
    // Non-fatal: the bundle is a UI nicety, not a protocol requirement.
  }

  const jobs = await store.listJobs();
  reconcile.seed(
    jobs.filter(job => job.state === 'running').map(job => job.id)
  );
  reconcile.armSettle();

  scheduler.start();

  return {
    node,
    scheduler,
    stop: async () => {
      scheduler.stop();
      reconcile.stop();
      await node.stop();
    },
  };
}

/** Process entry point. */
export async function main(): Promise<void> {
  const config = resolveConfig();
  if (config.preApprovalTokenPath) {
    try {
      await redeemPreApprovalToken({
        coordinatorUrl: config.coordinatorUrl,
        dataDir: config.dataDir,
        id: config.id,
        name: config.id,
        tokenPath: config.preApprovalTokenPath,
      });
    } catch (err) {
      console.error(
        `Pre-approval failed: ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(1);
    }
    console.log('Pre-approval complete. Exiting.');
    return;
  }
  await startProjectService(config);
}
