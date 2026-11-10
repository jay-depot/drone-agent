import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectModal } from './ProjectModal';
import { setApi } from './api';
import type { Project } from './types';

function installApi(options: {
  beacons?: unknown[];
  extensions?: unknown[];
  actionReply?: unknown;
}) {
  const fetchImpl = vi.fn(async (path: string, _init?: RequestInit) => {
    if (String(path).endsWith('/api/beacons')) {
      return {
        ok: true,
        json: async () => options.beacons ?? [],
      } as unknown as Response;
    }
    if (String(path).endsWith('/api/extensions')) {
      return {
        ok: true,
        json: async () => options.extensions ?? [],
      } as unknown as Response;
    }
    return {
      ok: true,
      json: async () => options.actionReply ?? { ok: true, body: {} },
    } as unknown as Response;
  });
  setApi({
    registerComponent: () => () => {},
    registerRoute: () => () => {},
    fetch: fetchImpl as unknown as typeof fetch,
    navigate: () => {},
    ui: {
      errors: {
        show: vi.fn(),
        fromResponse: vi.fn(async () => 'x'),
        fromThrown: vi.fn(() => 'thrown'),
      },
    },
  });
  return fetchImpl;
}

const expandedProject: Project = {
  id: 'p_1',
  name: 'Alpha',
  columns: [],
  cards: [],
  defaultBeaconId: 'b_gone',
  defaultWorkingDir: '/srv/gone',
};

describe('ProjectModal', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates a project with the selected beacon and root', async () => {
    const user = userEvent.setup();
    const fetchImpl = installApi({
      beacons: [
        {
          id: 'b_1',
          name: 'Beacon One',
          connected: true,
          spawnRoots: ['/srv/a'],
          defaultSpawnRoot: '/srv/a',
        },
      ],
      actionReply: { ok: true, body: { project: { id: 'p_new', name: 'X' } } },
    });
    const onSaved = vi.fn();
    render(<ProjectModal mode="create" onClose={() => {}} onSaved={onSaved} />);
    await user.type(screen.getByLabelText('Name'), 'Gamma');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const call = fetchImpl.mock.calls.find(call =>
      String(call[0]).includes('project.create')
    );
    const sent = JSON.parse(String((call![1] as RequestInit).body));
    expect(sent.params.name).toBe('Gamma');
    expect(sent.params.defaultBeaconId).toBe('b_1');
    expect(sent.params.defaultWorkingDir).toBe('/srv/a');
  });

  it('removes extension nodes from the beacon picker', async () => {
    installApi({
      beacons: [
        { id: 'b_ext', name: 'Ext', connected: true, spawnRoots: [] },
        { id: 'b_1', name: 'Beacon One', connected: true, spawnRoots: [] },
      ],
      extensions: [{ nodeId: 'b_ext', connected: true, isExtension: true }],
    });
    render(
      <ProjectModal mode="create" onClose={() => {}} onSaved={() => {}} />
    );
    expect(
      await screen.findByRole('option', { name: 'Beacon One' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Ext' })).toBeNull();
  });

  it('shows a stored offline beacon in edit mode', async () => {
    installApi({ beacons: [], extensions: [] });
    render(
      <ProjectModal
        mode="edit"
        project={expandedProject}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );
    expect(
      await screen.findByRole('option', { name: 'b_gone (offline)' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: '/srv/gone' })
    ).toBeInTheDocument();
  });

  it('sends project.update with projectId in edit mode', async () => {
    const user = userEvent.setup();
    const fetchImpl = installApi({
      beacons: [],
      actionReply: { ok: true, body: { project: expandedProject } },
    });
    const onSaved = vi.fn();
    render(
      <ProjectModal
        mode="edit"
        project={expandedProject}
        onClose={() => {}}
        onSaved={onSaved}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const call = fetchImpl.mock.calls.find(call =>
      String(call[0]).includes('project.update')
    );
    const sent = JSON.parse(String((call![1] as RequestInit).body));
    expect(sent.params.projectId).toBe('p_1');
  });

  it('shows an inline error and stays open on failure', async () => {
    const user = userEvent.setup();
    installApi({
      beacons: [],
      actionReply: { ok: false, status: 400, body: { error: 'bad name' } },
    });
    const onSaved = vi.fn();
    render(<ProjectModal mode="create" onClose={() => {}} onSaved={onSaved} />);
    await user.type(screen.getByLabelText('Name'), 'Z');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('bad name')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
