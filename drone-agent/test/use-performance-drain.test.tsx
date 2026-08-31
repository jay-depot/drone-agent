import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { usePerformanceDrain } from '../src/tui/hooks/usePerformanceDrain.js';

function Harness({ intervalMs }: { intervalMs: number }) {
  usePerformanceDrain(intervalMs);
  return null;
}

describe('usePerformanceDrain', () => {
  afterEach(() => {
    performance.clearMeasures();
  });

  function seedMeasures(n: number): void {
    for (let i = 0; i < n; i++) {
      performance.mark(`m-${i}`);
      performance.measure(`m-${i}`, `m-${i}`);
    }
  }

  it('drains the measure buffer when it crosses the cap (100k)', async () => {
    // The hook's interval ticks at `intervalMs`; render it, then fill the
    // global buffer past its internal cap and wait for the next tick.
    render(<Harness intervalMs={100} />);
    seedMeasures(100_001);
    expect(performance.getEntriesByType('measure').length).toBe(100_001);

    // Interval ticks at 100ms; poll up to 2s.
    const deadline = Date.now() + 2000;
    while (
      performance.getEntriesByType('measure').length > 0 &&
      Date.now() < deadline
    ) {
      await new Promise(r => setTimeout(r, 25));
    }
    expect(performance.getEntriesByType('measure').length).toBe(0);
  }, 5000);

  it('leaves the buffer alone while under the cap', async () => {
    render(<Harness intervalMs={20} />);
    seedMeasures(50);

    await new Promise(r => setTimeout(r, 80));

    expect(performance.getEntriesByType('measure').length).toBe(50);
  });
});
