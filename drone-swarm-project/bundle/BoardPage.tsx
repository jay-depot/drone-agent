import type { ActionReply, Card, Column, Project } from './types';
import { action } from './api';
import { QueueModal } from './QueueModal';
import { CardModal } from './CardModal';
import { ProjectModal } from './ProjectModal';
import { ProjectSelect } from './ProjectSelect';
import { useProjects } from './useProjects';
import { Button } from './Button';

const POLL_MS = 3000;

function statusClass(card: Card): string {
  return `dsp-pill dsp-pill-${card.sessionStatus ?? 'idle'}`;
}

export function BoardPage() {
  const React = globalThis.React;
  const { projects, selected, setSelected, reload } = useProjects();
  const [project, setProject] = React.useState<Project | undefined>(undefined);
  const [queueOpen, setQueueOpen] = React.useState(false);
  const [modal, setModal] = React.useState<
    { mode: 'create' } | { mode: 'edit' } | undefined
  >(undefined);
  const dragCard = React.useRef<string | undefined>(undefined);
  const [openCardId, setOpenCardId] = React.useState<string | undefined>(
    undefined
  );
  const didDrag = React.useRef(false);

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
        <h1 className="dsp-title">
          {projects.find(item => item.id === selected)?.name ?? 'Board'}
        </h1>
        <div className="dsp-header-controls">
          <ProjectSelect
            projects={projects}
            value={selected}
            onChange={setSelected}
            onNewProject={() => setModal({ mode: 'create' })}
            showCount
          />
          <Button
            disabled={!selected || !project}
            onClick={() => setModal({ mode: 'edit' })}
          >
            Edit Project
          </Button>
          <Button onClick={() => setQueueOpen(true)}>Queue</Button>
        </div>
      </header>

      <div
        className={
          projects.length === 0
            ? 'dsp-columns dsp-columns-empty'
            : 'dsp-columns'
        }
      >
        {projects.length === 0 ? (
          <div className="dsp-empty-hint">
            <p>No projects yet.</p>
            <Button onClick={() => setModal({ mode: 'create' })}>
              New Project
            </Button>
          </div>
        ) : null}
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
                    didDrag.current = true;
                    dragCard.current = card.id;
                  }}
                  onDragEnd={() => {
                    setTimeout(() => {
                      didDrag.current = false;
                    }, 0);
                  }}
                  onClick={() => {
                    if (didDrag.current) return;
                    setOpenCardId(card.id);
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
      {modal ? (
        <ProjectModal
          mode={modal.mode}
          project={modal.mode === 'edit' ? project : undefined}
          onClose={() => setModal(undefined)}
          onSaved={saved => {
            setModal(undefined);
            void reload().then(() => setSelected(saved.id));
          }}
        />
      ) : null}
      {openCardId
        ? (() => {
            const card = project?.cards.find(c => c.id === openCardId);
            return card && project ? (
              <CardModal
                project={project}
                card={card}
                onClose={() => setOpenCardId(undefined)}
                onSaved={() => {
                  setOpenCardId(undefined);
                  void loadBoard(selected);
                }}
              />
            ) : null;
          })()
        : null}
    </div>
  );
}
