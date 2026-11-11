import type { ActionReply, Card, MoveRecord, Project } from './types';
import { action, uiErrors } from './api';
import { Button } from './Button';

function columnName(project: Project, columnId: string): string {
  const found = project.columns.find(column => column.id === columnId);
  return found?.name ?? columnId;
}

function historyLine(project: Project, record: MoveRecord): string {
  const from = record.fromColumnId
    ? columnName(project, record.fromColumnId)
    : 'new';
  const to = columnName(project, record.toColumnId);
  const when = new Date(record.at).toLocaleString();
  return `${record.actor} · ${from} → ${to} · ${when}`;
}

export function CardModal(props: {
  project: Project;
  card: Card;
  onClose: () => void;
  onSaved: () => void;
}) {
  const React = globalThis.React;
  const { project, card, onClose, onSaved } = props;
  const [title, setTitle] = React.useState(card.title);
  const [description, setDescription] = React.useState(card.description ?? '');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>(undefined);

  React.useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function save(): void {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    void action<ActionReply<{ card: Card }>>('card.update', {
      projectId: project.id,
      cardId: card.id,
      title,
      description,
    })
      .then(reply => {
        if (!reply.ok) {
          const body = reply.body as { error?: string } | undefined;
          const message = body?.error ?? `Update failed (HTTP ${reply.status})`;
          setError(message);
          uiErrors().show(message);
          return;
        }
        onSaved();
      })
      .catch((err: unknown) => setError(uiErrors().fromThrown(err)))
      .finally(() => setSaving(false));
  }

  const history = card.history ?? [];

  return (
    <div className="dsp-modal-backdrop" onClick={onClose}>
      <div className="dsp-modal" onClick={event => event.stopPropagation()}>
        <header className="dsp-modal-header">
          <h2>Card</h2>
          <Button onClick={onClose}>Close</Button>
        </header>

        <label className="dsp-field">
          Title
          <input
            className="dsp-input"
            value={title}
            onChange={event => setTitle(event.target.value)}
          />
        </label>

        <label className="dsp-field">
          Description
          <textarea
            className="dsp-input"
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
        </label>

        {error ? <p className="dsp-error">{error}</p> : null}

        <div className="dsp-modal-actions">
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>

        <section className="dsp-card-meta">
          <h3>Details</h3>
          <dl>
            <dt>Status</dt>
            <dd>{card.sessionStatus ?? 'idle'}</dd>
            <dt>Column</dt>
            <dd>{columnName(project, card.columnId)}</dd>
            <dt>Session</dt>
            <dd>{card.sessionId ?? 'none'}</dd>
          </dl>
        </section>

        <section className="dsp-card-history">
          <h3>History</h3>
          {history.length === 0 ? (
            <p>No moves recorded.</p>
          ) : (
            <ul>
              {[...history].reverse().map((record, index) => (
                <li key={index}>{historyLine(project, record)}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
