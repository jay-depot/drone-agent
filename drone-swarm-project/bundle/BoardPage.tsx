import type {
  ActionReply,
  Card,
  Column,
  Project,
  ProjectSummary,
} from './types';
import { action } from './api';
import { QueueModal } from './QueueModal';

const POLL_MS = 3000;

function statusClass(card: Card): string {
  return `dsp-pill dsp-pill-${card.sessionStatus ?? 'idle'}`;
}

export function BoardPage() {
  const React = globalThis.React;
  const [projects, setProjects] = React.useState<ProjectSummary[]>([]);
  const [selected, setSelected] = React.useState<string | undefined>(undefined);
  const [project, setProject] = React.useState<Project | undefined>(undefined);
  const [queueOpen, setQueueOpen] = React.useState(false);
  const dragCard = React.useRef<string | undefined>(undefined);

  const loadProjects = React.useCallback(() => {
    return action<ActionReply<{ projects: ProjectSummary[] }>>(
      'project.list'
    ).then(reply => {
      const list = reply.body?.projects ?? [];
      setProjects(list);
      setSelected(current => current ?? list[0]?.id);
      return list;
    });
  }, []);

  const loadBoard = React.useCallback((projectId: string | undefined) => {
    if (!projectId) {
      setProject(undefined);
      return Promise.resolve();
    }
    return action<ActionReply<{ project: Project }>>('board.get', {
      projectId,
    }).then(reply => setProject(reply.body?.project));
  }, []);

  React.useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  React.useEffect(() => {
    void loadBoard(selected);
    const timer = setInterval(() => void loadBoard(selected), POLL_MS);
    return () => clearInterval(timer);
  }, [selected, loadBoard]);

  function onDrop(columnId: string): void {
    const cardId = dragCard.current;
    dragCard.current = undefined;
    if (!cardId || !selected) return;
    void action('card.move', {
      projectId: selected,
      cardId,
      toColumnId: columnId,
    }).then(() => loadBoard(selected));
  }

  const columns: Column[] = project
    ? [...project.columns].sort((a, b) => a.order - b.order)
    : [];

  return (
    <div className="dsp-board">
      <header className="dsp-board-header">
        <select
          value={selected ?? ''}
          onChange={event => setSelected(event.target.value || undefined)}
        >
          {projects.map(item => (
            <option key={item.id} value={item.id}>
              {item.name} ({item.cardCount})
            </option>
          ))}
        </select>
        <button onClick={() => setQueueOpen(true)}>Queue</button>
      </header>

      <div className="dsp-columns">
        {columns.map(column => (
          <div
            key={column.id}
            className="dsp-column"
            onDragOver={event => event.preventDefault()}
            onDrop={() => onDrop(column.id)}
          >
            <h3>{column.name}</h3>
            {(project?.cards ?? [])
              .filter(card => card.columnId === column.id)
              .sort((a, b) => a.position - b.position)
              .map(card => (
                <div
                  key={card.id}
                  className="dsp-card"
                  draggable
                  onDragStart={() => {
                    dragCard.current = card.id;
                  }}
                >
                  <div className="dsp-card-title">{card.title}</div>
                  <span className={statusClass(card)}>
                    {card.sessionStatus ?? 'idle'}
                  </span>
                </div>
              ))}
          </div>
        ))}
      </div>

      {queueOpen ? <QueueModal onClose={() => setQueueOpen(false)} /> : null}
    </div>
  );
}
