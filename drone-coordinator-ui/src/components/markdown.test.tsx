import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Markdown from './markdown';

describe('Markdown (base component)', () => {
  it('renders paragraphs and headings', () => {
    render(<Markdown>{'# Title\n\nSome paragraph.'}</Markdown>);
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Some paragraph.')).toBeInTheDocument();
  });

  it('renders GFM tables', () => {
    render(<Markdown>{'| a | b |\n| - | - |\n| 1 | 2 |'}</Markdown>);
    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('opens external links in a new tab with the hostname', () => {
    render(<Markdown>{'[click](https://example.com/x)'}</Markdown>);
    const link = screen.getByText('click').closest('a');
    expect(link).toHaveAttribute('href', 'https://example.com/x');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('(example.com)')).toBeInTheDocument();
  });

  it('renders inline code without block styling', () => {
    render(<Markdown>{'use `foo()` here'}</Markdown>);
    const code = screen.getByText('foo()');
    expect(code.tagName).toBe('CODE');
    expect(code.className).not.toContain('block');
  });
});
