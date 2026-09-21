import type { DroneImageContent } from 'drone-core';

/** Matches the default of `session.maxImagesPerMessage`. */
export const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20;

/** Marker for tool results (the model can re-invoke the tool with a selection). */
export const toolImageOmissionMarker = (omitted: number): string =>
  `[${omitted} additional images omitted. Request a narrower/range selection to retrieve them.]`;

/** Marker for user turns (the model must retrieve images itself). */
export const referenceImageOmissionMarker = (omitted: number): string =>
  `[${omitted} additional images omitted. Retrieve them individually if needed.]`;

/**
 * Enforce a kept-first-N image count cap. Returns the kept images (the input
 * array itself when nothing was dropped) and how many were omitted.
 */
export function capImages(
  images: DroneImageContent[],
  max: number
): { images: DroneImageContent[]; omitted: number } {
  if (images.length <= max) {
    return { images, omitted: 0 };
  }
  return { images: images.slice(0, max), omitted: images.length - max };
}
