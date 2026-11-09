import type { Automation, Card, Job, Project } from './board-types.js';
import { CAPABILITIES } from './capabilities.js';
import { newJobId } from './ids.js';
import { renderPrompt, selectAutomations } from './automations.js';
import type {
  ExtensionNodeHandlers,
  InvokeCtx,
  InvokeResult,
} from 'drone-swarm-common';
import type { Scheduler } from './scheduler.js';
import type { BoardStore } from './store/board-store.js';
import type { SchedulerStore } from './store/scheduler-store.js';

export interface HandlerDeps {
  board: BoardStore;
  scheduler: Scheduler;
  store: SchedulerStore;
  settings: { injectToolsIntoAllSessions: boolean };
}

function asRecord(params: unknown): Record<string, unknown> {
  return (params ?? {}) as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function findCapability(name: string) {
  return CAPABILITIES.find(capability => capability.name === name);
}

/**
 * Build the action/tool handlers. Both routes share `dispatch`: the tier guard,
 * the card-bound default resolution, the store operation, and the enqueue of
 * any matching automation.
 */
export function makeHandlers(
  deps: HandlerDeps
): Pick<ExtensionNodeHandlers, 'onInvokeAction' | 'onInvokeTool'> {
  const { board, scheduler, store } = deps;

  async function resolveCardBinding(
    capability: string,
    params: Record<string, unknown>,
    ctx: InvokeCtx
  ): Promise<{ projectId?: string; cardId?: string }> {
    if (!capability.startsWith('card.')) return {};
    let projectId = asString(params.projectId);
    let cardId = asString(params.cardId);
    if (!cardId && ctx.sessionId) {
      cardId = board.getCardIdForSession(ctx.sessionId);
    }
    if (cardId && !projectId) {
      projectId = board.getCardProjectId(cardId);
    }
    return { projectId, cardId };
  }

  async function enqueueForMove(
    project: Project,
    card: Card,
    fromColumnId: string | null,
    toColumnId: string
  ): Promise<void> {
    const destination = project.columns.find(
      column => column.id === toColumnId
    );
    if (!destination) return;
    const matches = selectAutomations(project, fromColumnId, toColumnId);
    for (const automation of matches) {
      const job: Job = {
        id: newJobId(),
        projectId: project.id,
        cardId: card.id,
        ruleId: automation.id,
        prompt: renderPrompt(automation.then.promptTemplate, {
          card,
          column: destination,
          project,
        }),
        state: 'queued',
        createdAt: Date.now(),
      };
      await scheduler.enqueue(job);
    }
  }

  async function dispatch(
    capability: string,
    rawParams: unknown,
    ctx: InvokeCtx
  ): Promise<InvokeResult> {
    const cap = findCapability(capability);
    if (!cap) {
      return { ok: false, status: 404, body: { error: 'Unknown capability' } };
    }
    if (cap.exposed === 'ui' && ctx.caller !== 'ui') {
      return {
        ok: false,
        status: 403,
        body: { error: 'CAPABILITY_NOT_AGENT_CALLABLE' },
      };
    }

    const params = asRecord(rawParams);
    const binding = await resolveCardBinding(capability, params, ctx);
    const projectId = binding.projectId ?? asString(params.projectId);
    const cardId = binding.cardId ?? asString(params.cardId);

    switch (capability) {
      case 'project.list':
        return {
          ok: true,
          status: 200,
          body: { projects: await board.listProjects() },
        };
      case 'board.get': {
        if (!projectId) return badRequest('projectId is required');
        const project = await board.getProject(projectId);
        if (!project) return notFound('project');
        return { ok: true, status: 200, body: { project } };
      }
      case 'card.get': {
        if (!cardId) return badRequest('cardId is required');
        const found = await board.getCard(cardId);
        if (!found) return notFound('card');
        return {
          ok: true,
          status: 200,
          body: { card: found.card, project: found.project },
        };
      }
      case 'card.create': {
        if (!projectId) return badRequest('projectId is required');
        const title = asString(params.title);
        if (!title) return badRequest('title is required');
        const card = await board.createCard({
          projectId,
          title,
          description: asString(params.description),
          columnId: asString(params.columnId),
          actor: ctx.caller === 'ui' ? 'user' : 'agent',
        });
        if (!card) return badRequest('could not create card');
        const project = await board.getProject(projectId);
        if (project) {
          await enqueueForMove(project, card, null, card.columnId);
        }
        return { ok: true, status: 200, body: { card } };
      }
      case 'card.update': {
        if (!projectId || !cardId) return badRequest('cardId is required');
        const card = await board.updateCard({
          projectId,
          cardId,
          title: asString(params.title),
          description: asString(params.description),
        });
        if (!card) return notFound('card');
        return { ok: true, status: 200, body: { card } };
      }
      case 'card.move': {
        if (!projectId || !cardId) return badRequest('cardId is required');
        const toColumnId = asString(params.toColumnId);
        if (!toColumnId) return badRequest('toColumnId is required');
        const moved = await board.moveCard({
          projectId,
          cardId,
          toColumnId,
          position: asNumber(params.position),
          actor: ctx.caller === 'ui' ? 'user' : 'agent',
        });
        if (!moved) return notFound('card or column');
        const project = await board.getProject(projectId);
        if (project) {
          await enqueueForMove(
            project,
            moved.card,
            moved.fromColumnId,
            toColumnId
          );
        }
        return { ok: true, status: 200, body: { card: moved.card } };
      }
      case 'project.create': {
        const name = asString(params.name);
        if (!name) return badRequest('name is required');
        const project = await board.createProject({
          name,
          defaultBeaconId: asString(params.defaultBeaconId),
          defaultWorkingDir: asString(params.defaultWorkingDir),
        });
        return { ok: true, status: 200, body: { project } };
      }
      case 'project.update': {
        if (!projectId) return badRequest('projectId is required');
        const project = await board.updateProject(projectId, {
          name: asString(params.name),
          defaultBeaconId: asString(params.defaultBeaconId),
          defaultWorkingDir: asString(params.defaultWorkingDir),
        });
        if (!project) return notFound('project');
        return { ok: true, status: 200, body: { project } };
      }
      case 'project.delete': {
        if (!projectId) return badRequest('projectId is required');
        const deleted = await board.deleteProject(projectId);
        if (!deleted) return notFound('project');
        return { ok: true, status: 200, body: { deleted: true } };
      }
      case 'column.list': {
        if (!projectId) return badRequest('projectId is required');
        const project = await board.getProject(projectId);
        if (!project) return notFound('project');
        return { ok: true, status: 200, body: { columns: project.columns } };
      }
      case 'column.create': {
        if (!projectId) return badRequest('projectId is required');
        const name = asString(params.name);
        if (!name) return badRequest('name is required');
        const column = await board.addColumn({ projectId, name });
        if (!column) return notFound('project');
        return { ok: true, status: 200, body: { column } };
      }
      case 'column.update': {
        if (!projectId) return badRequest('projectId is required');
        const columnId = asString(params.columnId);
        if (!columnId) return badRequest('columnId is required');
        const column = await board.updateColumn({
          projectId,
          columnId,
          name: asString(params.name),
          order: asNumber(params.order),
        });
        if (!column) return notFound('column');
        return { ok: true, status: 200, body: { column } };
      }
      case 'column.reorder': {
        if (!projectId) return badRequest('projectId is required');
        const columnIds = Array.isArray(params.columnIds)
          ? (params.columnIds as unknown[]).map(String)
          : [];
        for (let order = 0; order < columnIds.length; order++) {
          await board.updateColumn({
            projectId,
            columnId: columnIds[order]!,
            order,
          });
        }
        const project = await board.getProject(projectId);
        if (!project) return notFound('project');
        return { ok: true, status: 200, body: { columns: project.columns } };
      }
      case 'column.delete': {
        if (!projectId) return badRequest('projectId is required');
        const columnId = asString(params.columnId);
        if (!columnId) return badRequest('columnId is required');
        const deleted = await board.deleteColumn({ projectId, columnId });
        if (!deleted) return badRequest('column not deletable');
        return { ok: true, status: 200, body: { deleted: true } };
      }
      case 'automation.list': {
        if (!projectId) return badRequest('projectId is required');
        return {
          ok: true,
          status: 200,
          body: { automations: await board.listAutomations(projectId) },
        };
      }
      case 'automation.create': {
        if (!projectId) return badRequest('projectId is required');
        const automation = parseAutomation(params);
        if (!automation) return badRequest('invalid automation');
        const created = await board.createAutomation({ projectId, automation });
        if (!created) return badRequest('invalid automation');
        return { ok: true, status: 200, body: { automation: created } };
      }
      case 'automation.update': {
        if (!projectId) return badRequest('projectId is required');
        const automationId = asString(params.automationId);
        if (!automationId) return badRequest('automationId is required');
        const patch = asRecord(params.patch) as Partial<Omit<Automation, 'id'>>;
        const updated = await board.updateAutomation({
          projectId,
          automationId,
          patch,
        });
        if (!updated) return badRequest('invalid automation update');
        return { ok: true, status: 200, body: { automation: updated } };
      }
      case 'automation.delete': {
        if (!projectId) return badRequest('projectId is required');
        const automationId = asString(params.automationId);
        if (!automationId) return badRequest('automationId is required');
        const deleted = await board.deleteAutomation({
          projectId,
          automationId,
        });
        if (!deleted) return notFound('automation');
        return { ok: true, status: 200, body: { deleted: true } };
      }
      case 'queue.list':
        return {
          ok: true,
          status: 200,
          body: { jobs: await store.listJobs() },
        };
      case 'queue.retry': {
        const jobId = asString(params.jobId);
        if (!jobId) return badRequest('jobId is required');
        const jobs = await store.listJobs();
        const job = jobs.find(candidate => candidate.id === jobId);
        if (!job) return notFound('job');
        const updated = await store.updateJob(jobId, {
          state: 'queued',
          startedAt: undefined,
          endedAt: undefined,
          error: undefined,
        });
        await scheduler.tick();
        return { ok: true, status: 200, body: { job: updated } };
      }
      case 'queue.cancel': {
        const jobId = asString(params.jobId);
        if (!jobId) return badRequest('jobId is required');
        const updated = await store.updateJob(jobId, {
          state: 'cancelled',
          endedAt: Date.now(),
        });
        if (!updated) return notFound('job');
        return { ok: true, status: 200, body: { job: updated } };
      }
      case 'limits.get':
        return {
          ok: true,
          status: 200,
          body: { limits: await store.getLimits() },
        };
      case 'limits.set': {
        const limits = await store.setLimits({
          maxConcurrentSessions: asNumber(params.maxConcurrentSessions),
          maxDailySessions: asNumber(params.maxDailySessions),
        });
        return { ok: true, status: 200, body: { limits } };
      }
      default:
        return {
          ok: false,
          status: 404,
          body: { error: 'Unknown capability' },
        };
    }
  }

  function badRequest(message: string): InvokeResult {
    return { ok: false, status: 400, body: { error: message } };
  }

  function notFound(what: string): InvokeResult {
    return { ok: false, status: 404, body: { error: `${what} not found` } };
  }

  return {
    onInvokeAction: (capability, params, ctx) =>
      dispatch(capability, params, { ...ctx, caller: 'ui' }),
    onInvokeTool: (capability, params, ctx) =>
      dispatch(capability, params, { ...ctx, caller: 'agent' }),
  };
}

function parseAutomation(
  params: Record<string, unknown>
): Omit<Automation, 'id'> | undefined {
  const name = asString(params.name);
  const when = asRecord(params.when);
  const then = asRecord(params.then);
  const from = asString(when.from);
  const to = asString(when.to);
  const personaId = asString(then.personaId);
  const promptTemplate = asString(then.promptTemplate);
  if (!name || !from || !to || !personaId || !promptTemplate) return undefined;
  return {
    name,
    enabled: params.enabled === undefined ? true : Boolean(params.enabled),
    when: { from, to },
    then: {
      action: 'launch-session',
      personaId,
      ...(asString(then.model) ? { model: asString(then.model) } : {}),
      promptTemplate,
    },
  };
}
