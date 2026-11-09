import type {
  ActionReply,
  Column,
  Limits,
  Project,
  ProjectSummary,
} from './types';
import { action } from './api';

export function BoardSettings() {
  const React = globalThis.React;
  const [projects, setProjects] = React.useState<ProjectSummary[]>([]);
  const [selected, setSelected] = React.useState<string | undefined>(undefined);
  const [project, setProject] = React.useState<Project | undefined>(undefined);
  const [limits, setLimits] = React.useState<Limits | undefined>(undefined);
  const [newColumn, setNewColumn] = React.useState('');

  const refresh = React.useCallback(() => {
    void action<ActionReply<{ projects: ProjectSummary[] }>>(
      'project.list'
    ).then(reply => {
      const list = reply.body?.projects ?? [];
      setProjects(list);
      setSelected(current => current ?? list[0]?.id);
    });
    void action<ActionReply<{ limits: Limits }>>('limits.get').then(reply =>
      setLimits(reply.body?.limits)
    );
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

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
        <select
          value={selected ?? ''}
          onChange={event => setSelected(event.target.value || undefined)}
        >
          {projects.map(item => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
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
