import type { ActionReply, Project } from './types';
import { action, uiErrors } from './api';
import { loadPickerBeacons, type PickerBeacon } from './beacons';
import { Modal } from './Modal';
import { Button } from './Button';

export interface ProjectModalProps {
  mode: 'create' | 'edit';
  /** The project to edit. Required in edit mode. */
  project?: Project;
  onClose: () => void;
  onSaved: (project: Project) => void;
}

const NONE = '';

export function ProjectModal(props: ProjectModalProps) {
  const React = globalThis.React;
  const { mode, project, onClose, onSaved } = props;

  const [name, setName] = React.useState(project?.name ?? '');
  const [beacons, setBeacons] = React.useState<PickerBeacon[]>([]);
  const [beaconId, setBeaconId] = React.useState(
    project?.defaultBeaconId ?? NONE
  );
  const [workingDir, setWorkingDir] = React.useState(
    project?.defaultWorkingDir ?? NONE
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>(undefined);

  React.useEffect(() => {
    let cancelled = false;
    void loadPickerBeacons()
      .then(list => {
        if (cancelled) return;
        setBeacons(list);
        setBeaconId(current => {
          if (current) return current;
          return mode === 'create' ? (list[0]?.id ?? NONE) : NONE;
        });
        setWorkingDir(current => {
          if (current) return current;
          if (mode !== 'create') return NONE;
          const first = list[0];
          return first?.defaultSpawnRoot ?? first?.spawnRoots[0] ?? NONE;
        });
      })
      .catch(() => {
        if (!cancelled) setBeacons([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  const beaconOptions: PickerBeacon[] = [...beacons];
  if (beaconId && !beaconOptions.some(beacon => beacon.id === beaconId)) {
    beaconOptions.push({
      id: beaconId,
      name: `${beaconId} (offline)`,
      spawnRoots: [],
    });
  }

  const activeBeacon = beaconOptions.find(beacon => beacon.id === beaconId);
  const rootOptions: string[] = [...(activeBeacon?.spawnRoots ?? [])];
  if (workingDir && !rootOptions.includes(workingDir)) {
    rootOptions.push(workingDir);
  }

  function onBeaconChange(nextId: string): void {
    setBeaconId(nextId);
    if (
      project &&
      nextId === project.defaultBeaconId &&
      project.defaultWorkingDir
    ) {
      setWorkingDir(project.defaultWorkingDir);
      return;
    }
    const next = beaconOptions.find(beacon => beacon.id === nextId);
    setWorkingDir(next?.defaultSpawnRoot ?? next?.spawnRoots[0] ?? NONE);
  }

  function save(): void {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(undefined);
    const params: Record<string, unknown> = {
      name: trimmed,
      defaultBeaconId: beaconId || undefined,
      defaultWorkingDir: workingDir || undefined,
    };
    if (mode === 'edit' && project) params.projectId = project.id;
    const capability = mode === 'edit' ? 'project.update' : 'project.create';

    void action<ActionReply<{ project: Project }>>(capability, params)
      .then(reply => {
        const saved = reply.body?.project;
        if (!reply.ok || !saved) {
          const body = reply.body as { error?: string } | undefined;
          const message = body?.error ?? `Save failed (HTTP ${reply.status})`;
          setError(message);
          uiErrors().show(message);
          return;
        }
        onSaved(saved);
      })
      .catch((err: unknown) => setError(uiErrors().fromThrown(err)))
      .finally(() => setSaving(false));
  }

  const title = mode === 'edit' ? 'Edit Project' : 'New Project';
  const submitLabel = mode === 'edit' ? 'Save' : 'Create';

  return (
    <Modal title={title} onClose={onClose}>
      <label className="dsp-field">
        Name
        <input
          className="dsp-input"
          value={name}
          onChange={event => setName(event.target.value)}
        />
      </label>

      <label className="dsp-field">
        Beacon
        <select
          className="dsp-select"
          value={beaconId}
          onChange={event => onBeaconChange(event.target.value)}
        >
          <option value={NONE}>None</option>
          {beaconOptions.map(beacon => (
            <option key={beacon.id} value={beacon.id}>
              {beacon.name}
            </option>
          ))}
        </select>
      </label>

      <label className="dsp-field">
        Working directory
        <select
          className="dsp-select"
          value={workingDir}
          onChange={event => setWorkingDir(event.target.value)}
        >
          <option value={NONE}>None</option>
          {rootOptions.map(root => (
            <option key={root} value={root}>
              {root}
            </option>
          ))}
        </select>
      </label>

      {error ? <p className="dsp-error">{error}</p> : null}

      <div className="dsp-modal-actions">
        <Button
          variant="primary"
          onClick={save}
          disabled={saving || !name.trim()}
        >
          {saving ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </Modal>
  );
}
