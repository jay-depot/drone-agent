import { describe, expect, it } from 'vitest';

import { indexFingerprint } from '../../src/embedding/fingerprint.js';

describe('indexFingerprint', () => {
  it('joins the identity parts with colons', () => {
    expect(
      indexFingerprint({
        modelId: 'nomic-embed-text-v1.5',
        dimensions: 768,
        backend: 'onnx',
        dtype: 'q8',
      })
    ).toBe('nomic-embed-text-v1.5:768:onnx:q8');
  });

  it('changes when any identity part changes', () => {
    const base = {
      modelId: 'nomic-embed-text-v1.5',
      dimensions: 768,
      backend: 'onnx',
      dtype: 'q8',
    };
    const variants = [
      { ...base, modelId: 'other' },
      { ...base, dimensions: 1024 },
      { ...base, backend: 'ollama' },
      { ...base, dtype: 'fp32' },
    ];
    const fingerprints = new Set([
      indexFingerprint(base),
      ...variants.map(variant => indexFingerprint(variant)),
    ]);
    expect(fingerprints.size).toBe(variants.length + 1);
  });
});
