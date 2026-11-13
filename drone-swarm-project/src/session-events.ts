import type { DroneSessionEndedEvent, DroneSessionSnapshot } from 'drone-core';
import type { ExtensionNode, ExtensionNodeHandlers } from 'drone-swarm-common';
import type { Card, Project } from './board-types.js';
import { CARD_TOOL_CAPABILITIES } from './capabilities.js';
import type { ReconcileTracker } from './scheduler-reconcile.js';
import type { Scheduler } from './scheduler.js';
import type { BoardStore } from './store/board-store.js';
import type { SchedulerStore } from './store/scheduler-store.js';

const HINT_PATTERN = /^drone-swarm-project:card:(.+)$/;

/** Parse the card id out of an `extensionHint`, when it matches. */
export function parseCardHint(hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  const match = HINT_PATTERN.exec(hint);
  return match?.[1];
}

/** The one-time fragment injected into a card-bound session. */
export function cardBindingFragment(card: Card, project: Project): string {
  return [
    '# Bound card',
    '',
    `You are working on card **${card.title}** in project **${project.name}** (card id \`${card.id}\`).`,
    'When the work is done, move the card to its next column with `card_move`.',
  ].join('\n');
}

export interface SessionHandlerDeps {
  store: SchedulerStore;
  board: BoardStore;
  /** Resolves the node lazily: handlers are built before the node exists. */
  getNode: () => ExtensionNode;
  instruct: (sessionId: string, content: string) => Promise<boolean>;
  settings: { injectToolsIntoAllSessions: boolean };
  reconcile: ReconcileTracker;
  scheduler: Scheduler;
}

/**
 * Build the session lifecycle handlers. On start the handler confirms a
 * matching spawn job, sends its instruction, and injects the card tools (and
 * the card-binding fragment for a card-bound session). On end it closes the
 * job and frees the slot.
 */
export function makeSessionHandlers(
  deps: SessionHandlerDeps
): Pick<ExtensionNodeHandlers, 'onSessionStarted' | 'onSessionEnded'> {
  const { store, board, getNode, instruct, settings, reconcile, scheduler } =
    deps;

  async function onSessionStarted(
    snapshot: DroneSessionSnapshot
  ): Promise<void> {
    const parsedCardId = parseCardHint(snapshot.extensionHint);

    const jobs = await store.listJobs();
    const job =
      jobs.find(candidate => candidate.agentId === snapshot.sessionId) ??
      jobs.find(
        candidate =>
          candidate.state === 'running' &&
          parsedCardId !== undefined &&
          candidate.cardId === parsedCardId
      );

    if (job) {
      await store.updateJob(job.id, {
        sessionId: snapshot.sessionId,
        instructionSent: true,
      });
      const found = await board.getCard(job.cardId);
      if (found) {
        await board.setCardSession({
          projectId: found.project.id,
          cardId: found.card.id,
          sessionId: snapshot.sessionId,
          spawnId: job.spawnId,
          sessionStatus: 'running',
        });
      }
      reconcile.confirm(job.id);
      void instruct(snapshot.sessionId, job.prompt);
    }

    if (snapshot.isSubagent) return;

    if (settings.injectToolsIntoAllSessions) {
      getNode().injectTools({
        target: snapshot.sessionId,
        capabilities: CARD_TOOL_CAPABILITIES,
      });
    }

    if (parsedCardId) {
      const found = await board.getCard(parsedCardId);
      if (found) {
        getNode().injectFragment({
          target: snapshot.sessionId,
          id: 'card-binding',
          content: cardBindingFragment(found.card, found.project),
        });
      }
    }
  }

  async function onSessionEnded(event: DroneSessionEndedEvent): Promise<void> {
    const jobs = await store.listJobs();
    const job = jobs.find(
      candidate =>
        candidate.sessionId === event.sessionId && candidate.state === 'running'
    );
    if (!job) return;
    await store.updateJob(job.id, { state: 'done', endedAt: Date.now() });
    const found = await board.getCard(job.cardId);
    if (found) {
      await board.setCardSession({
        projectId: found.project.id,
        cardId: found.card.id,
        sessionStatus: 'ended',
      });
    }
    await scheduler.tick();
  }

  return { onSessionStarted, onSessionEnded };
}
