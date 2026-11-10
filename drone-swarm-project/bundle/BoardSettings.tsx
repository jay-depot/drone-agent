import type { ActionReply, Column, Limits, Project } from './types';
import { action, apiNavigate } from './api';
import { ProjectSelect } from './ProjectSelect';
import { useProjects } from './useProjects';

export function BoardSettings() {
  const React = globalThis.React;
  const { projects, selected, setSelected, reload } = useProjects();
  const [project, setProject] = React.useState<Project | undefined>(undefined);
  const [limits, setLimits] = React.useState<Limits | undefined>(undefined);
  const [newColumn, setNewColumn] = React.useState('');

  const loadLimits = React.useCallback(() => {
    void action<ActionReply<{ limits: Limits }>>('limits.get').then(reply =>
      setLimits(reply.body?.limits)
    );
  }, []);

  const refresh = React.useCallback(() => {
    void reload();
    loadLimits();
  }, [reload, loadLimits]);

  React.useEffect(() => {
    loadLimits();
  }, [loadLimits]);

  React.useEffect(() => {
    if (!selected) {
      setProject(undefined);
      return;
    }
    void action<ActionReply<{ project: Project }>>('board.get', {
      projectId: selected,
    }).then(reply => setProject(reply.body?.project));
  }, [selected]);

  function addColumn(): void {
    const name = newColumn.trim();
    if (!name || !selected) return;
    void action('column.create', { projectId: selected, name }).then(() => {
      setNewColumn('');
      refresh();
    });
  }

  function deleteColumn(columnId: string): void {
    if (!selected) return;
    void action('column.delete', { projectId: selected, columnId }).then(
      refresh
    );
  }

  function saveLimits(patch: Partial<Limits>): void {
    void action<ActionReply<{ limits: Limits }>>('limits.set', patch).then(
      reply => setLimits(reply.body?.limits)
    );
  }

  const columns: Column[] = project
    ? [...project.columns].sort((a, b) => a.order - b.order)
    : [];

  return (
    <div className="dsp-settings">
      <header className="dsp-settings-header">
        <ProjectSelect
          projects={projects}
          value={selected}
          onChange={setSelected}
          onNewProject={() => apiNavigate('/board')}
        />
        <button onClick={refresh}>Refresh</button>
      </header>

      <section>
        <h3>Columns</h3>
        <ul className="dsp-column-list">
          {columns.map(column => (
            <li key={column.id}>
              {column.name}
              <button onClick={() => deleteColumn(column.id)}>Delete</button>
            </li>
          ))}
        </ul>
        <input
          placeholder="New column"
          value={newColumn}
          onChange={event => setNewColumn(event.target.value)}
        />
        <button onClick={addColumn}>Add column</button>
      </section>

      <section>
        <h3>Limits</h3>
        {limits ? (
          <div>
            <label>
              Max concurrent
              <input
                type="number"
                value={limits.maxConcurrentSessions}
                onChange={event =>
                  saveLimits({
                    maxConcurrentSessions: Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              Max daily
              <input
                type="number"
                value={limits.maxDailySessions}
                onChange={event =>
                  saveLimits({ maxDailySessions: Number(event.target.value) })
                }
              />
            </label>
          </div>
        ) : null}
      </section>
    </div>
  );
}
