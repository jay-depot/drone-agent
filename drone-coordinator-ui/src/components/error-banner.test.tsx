import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBanner } from './error-banner';

describe('ErrorBanner', () => {
  it('renders the message with an alert role', () => {
    render(<ErrorBanner message="load failed" />);
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('load failed');
  });

  it('applies the destructive banner styling', () => {
    render(<ErrorBanner message="styled" />);
    const banner = screen.getByRole('alert');
    expect(banner.className).toContain('bg-destructive/10');
    expect(banner.className).toContain('text-destructive');
  });

  it('renders nothing for an empty message', () => {
    const { container } = render(<ErrorBanner message="" />);
    expect(container).toBeEmptyDOMElement();
  });
});
