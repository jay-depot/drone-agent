import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import WikiMarkdown from './wiki-markdown';

function renderMarkdown(content: string) {
  return render(
    <MemoryRouter>
      <WikiMarkdown>{content}</WikiMarkdown>
    </MemoryRouter>
  );
}

describe('WikiMarkdown', () => {
  it('renders a [[wikilink]] as an internal Link', () => {
    renderMarkdown('See [[deployment]] for details');
    const link = screen.getByRole('link', { name: 'deployment' });
    expect(link).toHaveAttribute('href', '/wiki/deployment');
  });

  it('renders a [[wikilink|alias]] using the alias as the label', () => {
    renderMarkdown('See [[deployment|Deploy Guide]]');
    const link = screen.getByRole('link', { name: 'Deploy Guide' });
    expect(link).toHaveAttribute('href', '/wiki/deployment');
  });

  it('renders an external link in a new tab with the hostname shown', () => {
    renderMarkdown('[OpenAI](https://openai.com)');
    const link = screen.getByRole('link', { name: /OpenAI/ });
    expect(link).toHaveAttribute('href', 'https://openai.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('(openai.com)')).toBeTruthy();
  });

  it('renders a /wiki/ markdown link as an internal Link', () => {
    renderMarkdown('[My Page](/wiki/my-page)');
    const link = screen.getByRole('link', { name: 'My Page' });
    expect(link).toHaveAttribute('href', '/wiki/my-page');
  });

  it('renders a GFM table', () => {
    renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
  });

  it('collapses a leading frontmatter block by default', () => {
    const content = [
      '---',
      'id: my-page',
      'title: My Page',
      'scope: coordinator',
      '---',
      '',
      '# Heading',
      '',
      'Body text.',
    ].join('\n');
    renderMarkdown(content);

    expect(screen.getByText('Metadata (YAML frontmatter)')).toBeTruthy();
    // The YAML body is hidden while collapsed.
    expect(screen.queryByText('id: my-page')).toBeNull();
    // The markdown body still renders.
    expect(screen.getByText('Body text.')).toBeTruthy();
  });

  it('reveals the raw YAML when the summary is clicked', async () => {
    const content = [
      '---',
      'id: my-page',
      'title: My Page',
      'scope: coordinator',
      '---',
      '',
      '# Heading',
    ].join('\n');
    renderMarkdown(content);

    const user = userEvent.setup();
    await user.click(screen.getByText('Metadata (YAML frontmatter)'));

    const pre = screen.getByText(/id: my-page/);
    expect(pre.textContent).toContain('title: My Page');
    expect(pre.textContent).toContain('scope: coordinator');
  });

  it('renders normally when there is no frontmatter block', () => {
    renderMarkdown('# Heading\n\nJust body text.');

    expect(screen.queryByText('Metadata (YAML frontmatter)')).toBeNull();
    expect(screen.getByText('Just body text.')).toBeTruthy();
  });
});
