import type { ActionReply, Card } from './types';
import { action, uiErrors } from './api';
import { Modal } from './Modal';
import { Button } from './Button';

export interface CardCreateModalProps {
  projectId: string;
  columnId: string;
  columnName: string;
  onClose: () => void;
  onCreated: (card: Card) => void;
}

/**
 * The new-card modal.
 *
 * The target column is fixed: it is the column whose "Add card" button opened
 * this modal. The column name is read-only text. There is no column picker.
 */
export function CardCreateModal(props: CardCreateModalProps) {
  const React = globalThis.React;
  const { projectId, columnId, columnName, onClose, onCreated } = props;
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>(undefined);

  function create(): void {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(undefined);
    void action<ActionReply<{ card: Card }>>('card.create', {
      projectId,
      columnId,
      title: trimmed,
      description,
    })
      .then(reply => {
        const created = reply.body?.card;
        if (!reply.ok || !created) {
          const body = reply.body as { error?: string } | undefined;
          const message = body?.error ?? `Create failed (HTTP ${reply.status})`;
          setError(message);
          uiErrors().show(message);
          return;
        }
        onCreated(created);
      })
      .catch((err: unknown) => setError(uiErrors().fromThrown(err)))
      .finally(() => setSaving(false));
  }

  return (
    <Modal title="New card" onClose={onClose}>
      <p className="dsp-muted">Column: {columnName}</p>

      <label className="dsp-field">
        Title
        <input
          className="dsp-input"
          autoFocus
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
        <Button
          variant="primary"
          onClick={create}
          disabled={saving || !title.trim()}
        >
          {saving ? 'Saving…' : 'Create'}
        </Button>
      </div>
    </Modal>
  );
}
