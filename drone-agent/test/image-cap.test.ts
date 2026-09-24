import { describe, expect, it } from 'vitest';
import type { DroneImageContent } from 'drone-core';
import {
  DEFAULT_MAX_IMAGES_PER_MESSAGE,
  capImages,
  referenceImageOmissionMarker,
  toolImageOmissionMarker,
} from '../src/runtime/image-cap.js';

const imgs = (n: number): DroneImageContent[] =>
  Array.from({ length: n }, (_, i) => ({
    mimeType: 'image/png',
    data: `data-${i}`,
  }));

describe('DEFAULT_MAX_IMAGES_PER_MESSAGE', () => {
  it('matches the session.maxImagesPerMessage default', () => {
    expect(DEFAULT_MAX_IMAGES_PER_MESSAGE).toBe(20);
  });
});

describe('capImages', () => {
  it('returns the same array when under the cap', () => {
    const input = imgs(3);
    const result = capImages(input, DEFAULT_MAX_IMAGES_PER_MESSAGE);
    expect(result.images).toBe(input);
    expect(result.omitted).toBe(0);
  });

  it('returns the same array when exactly at the cap', () => {
    const input = imgs(DEFAULT_MAX_IMAGES_PER_MESSAGE);
    const result = capImages(input, DEFAULT_MAX_IMAGES_PER_MESSAGE);
    expect(result.images).toBe(input);
    expect(result.omitted).toBe(0);
  });

  it('keeps the first N and reports the omitted count when over the cap', () => {
    const input = imgs(25);
    const result = capImages(input, DEFAULT_MAX_IMAGES_PER_MESSAGE);
    expect(result.images).toHaveLength(DEFAULT_MAX_IMAGES_PER_MESSAGE);
    expect(result.images).toEqual(
      input.slice(0, DEFAULT_MAX_IMAGES_PER_MESSAGE)
    );
    expect(result.omitted).toBe(5);
  });

  it('handles a zero cap', () => {
    const result = capImages(imgs(2), 0);
    expect(result.images).toEqual([]);
    expect(result.omitted).toBe(2);
  });
});

describe('omission markers', () => {
  it('formats the tool-result marker (byte-identical to the pre-refactor string)', () => {
    expect(toolImageOmissionMarker(5)).toBe(
      '[5 additional images omitted. Request a narrower/range selection to retrieve them.]'
    );
  });

  it('formats the reference marker', () => {
    expect(referenceImageOmissionMarker(5)).toBe(
      '[5 additional images omitted. Retrieve them individually if needed.]'
    );
  });

  it('keeps both markers distinct', () => {
    expect(toolImageOmissionMarker(1)).not.toBe(
      referenceImageOmissionMarker(1)
    );
  });
});
