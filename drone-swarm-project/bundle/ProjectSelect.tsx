import type { ProjectSummary } from './types';
import { NEW_PROJECT_VALUE } from './useProjects';

export interface ProjectSelectProps {
  projects: ProjectSummary[];
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  onNewProject: () => void;
  /** Show the card count next to each project name. */
  showCount?: boolean;
  className?: string;
}

/**
 * The project dropdown, with the `New Project…` sentinel.
 *
 * The select is controlled. A pick of the sentinel calls `onNewProject` and
 * does not call `onChange`. So the sentinel value never becomes the selection.
 */
export function ProjectSelect(props: ProjectSelectProps) {
  const React = globalThis.React;
  const { projects, value, onChange, onNewProject, showCount, className } =
    props;

  function onSelect(next: string): void {
    if (next === NEW_PROJECT_VALUE) {
      onNewProject();
      return;
    }
    onChange(next || undefined);
  }

  return (
    <select
      className={className}
      value={value ?? ''}
      onChange={event => onSelect(event.target.value)}
    >
      {projects.map(item => (
        <option key={item.id} value={item.id}>
          {showCount ? `${item.name} (${item.cardCount})` : item.name}
        </option>
      ))}
      <option value={NEW_PROJECT_VALUE}>New Project…</option>
    </select>
  );
}
