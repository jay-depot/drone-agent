/**
 * Return the first field name whose value is not a non-empty string,
 * or undefined when all listed fields are present.
 */
export function firstMissingString(
  params: Record<string, unknown>,
  fields: readonly string[]
): string | undefined {
  for (const field of fields) {
    const value = params[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return field;
    }
  }
  return undefined;
}
