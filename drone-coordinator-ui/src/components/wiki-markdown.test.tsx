import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
