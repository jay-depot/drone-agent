/**
 * drone-swarm-project end-to-end smoke test (provisioned swarm only).
 *
 * Starts the kanban extension against a real coordinator, asserts the
 * capability catalog round-trips through `/api/extensions`, that a
 * `project.create` action round-trips, and that a card create + move enqueues a
 * job visible via `queue.list`.
 *
 * Skipped unless RUN_INTEGRATION_TESTS=true and an explicit
 * DRONE_SWARM_PROJECT_COORDINATOR_URL is provided (never touches a user's local
 * coordinator). Run `pnpm --filter drone-swarm-project run build` first so the
 * bundle exists.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startProjectService } from '../src/index.js';

const COORDINATOR_URL = process.env.DRONE_SWARM_PROJECT_COORDINATOR_URL ?? '';
const shouldSkip =
  process.env.RUN_INTEGRATION_TESTS !== 'true' || COORDINATOR_URL === '';

async function action<T>(name: string, params: Record<string, unknown>) {
  const res = await fetch(
    `${COORDINATOR_URL}/api/extensions/drone-swarm-project/actions/${name}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params }),
    }
  );
  return (await res.json()) as { ok: boolean; status?: number; body?: T };
}

describe.skipIf(shouldSkip)('drone-swarm-project end-to-end', () => {
  let dataDir = '';
  let stop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'dsp-it-'));
    const started = await startProjectService({
      coordinatorUrl: COORDINATOR_URL,
      dataDir,
      id: 'drone-swarm-project',
      injectToolsIntoAllSessions: true,
      maxConcurrentSessions: 1,
      maxDailySessions: 12,
    });
    stop = started.stop;
  }, 30000);

  afterAll(async () => {
    await stop?.();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('appears in the coordinator extension listing with its catalog', async () => {
    let rows: Array<{ nodeId: string; capabilities: Array<{ name: string }> }> =
      [];
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${COORDINATOR_URL}/api/extensions`);
      if (res.ok) {
        rows = (await res.json()) as typeof rows;
        if (rows.some(r => r.nodeId === 'drone-swarm-project')) break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    const self = rows.find(r => r.nodeId === 'drone-swarm-project');
    expect(self).toBeDefined();
    expect(self!.capabilities.map(c => c.name)).toContain('card.move');
    expect(self!.capabilities.map(c => c.name)).toContain('limits.set');
  });

  it('round-trips a project.create action', async () => {
    const reply = await action<{ project: { id: string; columns: unknown[] } }>(
      'project.create',
      { name: 'Integration Project' }
    );
    expect(reply.ok).toBe(true);
    expect(reply.body?.project.columns).toHaveLength(3);
  });

  it('enqueues a job when a card moves to a matching column', async () => {
    const created = await action<{
      project: { id: string; columns: Array<{ id: string; name: string }> };
    }>('project.create', { name: 'Queue Project' });
    const project = created.body!.project;
    const done = project.columns.find(c => c.name === 'Done')!;

    await action('automation.create', {
      projectId: project.id,
      name: 'to done',
      when: { from: '*', to: done.id },
      then: {
        action: 'launch-session',
        personaId: 'code',
        promptTemplate: 'Work on {{card.title}}',
      },
    });

    const card = await action<{ card: { id: string } }>('card.create', {
      projectId: project.id,
      title: 'Smoke card',
    });
    await action('card.move', {
      projectId: project.id,
      cardId: card.body!.card.id,
      toColumnId: done.id,
    });

    const queue = await action<{
      jobs: Array<{ cardId: string; state: string }>;
    }>('queue.list', {});
    expect(queue.body!.jobs.some(j => j.cardId === card.body!.card.id)).toBe(
      true
    );
  });
});
