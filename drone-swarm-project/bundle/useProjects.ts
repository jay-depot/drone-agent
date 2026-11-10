import type { ActionReply, ProjectSummary } from './types';
import { action } from './api';

/** The sentinel option value that opens the New Project modal. */
export const NEW_PROJECT_VALUE = '__new_project__';

export interface UseProjects {
  projects: ProjectSummary[];
  selected: string | undefined;
  setSelected: (id: string | undefined) => void;
  reload: () => Promise<ProjectSummary[]>;
}

/**
 * Load the project list and keep the selected project.
 *
 * The selection rule keeps the current project. It selects the first project
 * only when nothing is selected. So a reload does not change the selection.
 */
export function useProjects(): UseProjects {
  const React = globalThis.React;
  const [projects, setProjects] = React.useState<ProjectSummary[]>([]);
  const [selected, setSelected] = React.useState<string | undefined>(undefined);

  const reload = React.useCallback((): Promise<ProjectSummary[]> => {
    return action<ActionReply<{ projects: ProjectSummary[] }>>(
      'project.list'
    ).then(reply => {
      const list = reply.body?.projects ?? [];
      setProjects(list);
      setSelected(current => current ?? list[0]?.id);
      return list;
    });
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  return { projects, selected, setSelected, reload };
}
