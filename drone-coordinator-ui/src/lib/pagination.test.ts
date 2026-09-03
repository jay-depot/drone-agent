import { describe, it, expect } from 'vitest';
import { paginationRange } from './pagination';

describe('paginationRange', () => {
  it('shows a full middle page as a range', () => {
    expect(paginationRange(12, 12, 95)).toBe('13-24 of 95');
  });

  it('shows the first page starting at 1', () => {
    expect(paginationRange(0, 12, 95)).toBe('1-12 of 95');
  });

  it('clips the end at the total on the last page', () => {
    expect(paginationRange(84, 12, 95)).toBe('85-95 of 95');
  });

  it('shows a single item as a single range', () => {
    expect(paginationRange(12, 12, 13)).toBe('13 of 13');
  });

  it('handles zero total', () => {
    expect(paginationRange(0, 12, 0)).toBe('0 of 0');
  });

  it('clips a start beyond the total to the total', () => {
    expect(paginationRange(100, 12, 95)).toBe('95 of 95');
  });
});
