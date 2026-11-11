import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectSelect } from './ProjectSelect';

const projects = [
  { id: 'p_1', name: 'Alpha', cardCount: 2 },
  { id: 'p_2', name: 'Beta', cardCount: 0 },
];

describe('ProjectSelect', () => {
  it('renders the projects and the sentinel last', () => {
    render(
      <ProjectSelect
        projects={projects}
        value="p_1"
        onChange={() => {}}
        onNewProject={() => {}}
      />
    );
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('Alpha');
    expect(options[options.length - 1]).toHaveTextContent('New Project…');
  });

  it('calls onNewProject and not onChange for the sentinel', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onNewProject = vi.fn();
    render(
      <ProjectSelect
        projects={projects}
        value="p_1"
        onChange={onChange}
        onNewProject={onNewProject}
      />
    );
    await user.selectOptions(screen.getByRole('combobox'), '__new_project__');
    expect(onNewProject).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('calls onChange for a real project', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ProjectSelect
        projects={projects}
        value="p_1"
        onChange={onChange}
        onNewProject={() => {}}
      />
    );
    await user.selectOptions(screen.getByRole('combobox'), 'p_2');
    expect(onChange).toHaveBeenCalledWith('p_2');
  });

  it('shows an inert placeholder when there are no projects', () => {
    render(
      <ProjectSelect
        projects={[]}
        value={undefined}
        onChange={() => {}}
        onNewProject={() => {}}
      />
    );
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('No projects yet');
    expect(options[0]).toBeDisabled();
    expect(options[options.length - 1]).toHaveTextContent('New Project…');
  });

  it('opens the modal from the sentinel when there are no projects', async () => {
    const user = userEvent.setup();
    const onNewProject = vi.fn();
    render(
      <ProjectSelect
        projects={[]}
        value={undefined}
        onChange={() => {}}
        onNewProject={onNewProject}
      />
    );
    await user.selectOptions(screen.getByRole('combobox'), '__new_project__');
    expect(onNewProject).toHaveBeenCalledTimes(1);
  });
});
