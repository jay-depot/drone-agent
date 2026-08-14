/**
 * Set a value at a dot-notation path in a nested object, creating
 * intermediate objects as needed. Mutates the input object.
 */
export function deepSet(
  obj: Record<string, unknown>,
  keyPath: string,
  value: unknown
): void {
  const parts = keyPath.split('.');
  for (const part of parts) {
    if (part.length === 0) {
      throw new Error('Invalid config key path segment: empty');
    }
  }
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (
      part === '__proto__' ||
      part === 'constructor' ||
      part === 'prototype'
    ) {
      throw new Error(`Unsafe config key path segment: "${part}"`);
    }
    if (typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const finalPart = parts[parts.length - 1];
  if (
    finalPart === '__proto__' ||
    finalPart === 'constructor' ||
    finalPart === 'prototype'
  ) {
    throw new Error(`Unsafe config key path segment: "${finalPart}"`);
  }
  current[finalPart] = value;
}
