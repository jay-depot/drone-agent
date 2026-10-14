/**
 * Minimal JSON-Schema-subset validator for extension capability `paramSchema`
 * enforcement. Supports the constructs extension authors actually use in a
 * capability catalog: `type`, `required`, `properties`, and `items`. Anything
 * unrecognised is ignored (advisory), so an author can use richer schemas
 * without the coordinator rejecting params it does not understand.
 */

export type JsonSchema = Record<string, unknown>;

type JsonType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

function jsonTypeOf(value: unknown): JsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as JsonType;
}

function matchesType(value: unknown, type: JsonType): boolean {
  if (type === 'integer') {
    return typeof value === 'number' && Number.isInteger(value);
  }
  if (type === 'number') {
    return typeof value === 'number';
  }
  return jsonTypeOf(value) === type;
}

function typeList(schema: JsonSchema): JsonType[] {
  const t = schema.type;
  if (typeof t === 'string') return [t as JsonType];
  if (Array.isArray(t)) return t.filter(x => typeof x === 'string') as JsonType[];
  return [];
}

/**
 * Validate `value` against a schema. Returns an array of human-readable
 * errors; an empty array means the value is valid. Paths are dotted (e.g.
 * `params.q`).
 */
export function validateJsonSchema(
  value: unknown,
  schema: JsonSchema,
  path = 'params'
): string[] {
  const errors: string[] = [];
  const types = typeList(schema);
  if (types.length > 0 && !types.some(t => matchesType(value, t))) {
    errors.push(`${path}: expected ${types.join('|')}`);
    return errors;
  }

  if (schema.type === 'object' || schema.properties !== undefined) {
    if (jsonTypeOf(value) !== 'object') {
      errors.push(`${path}: expected object`);
      return errors;
    }
    const obj = value as Record<string, unknown>;
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && !(key in obj)) {
          errors.push(`${path}.${key}: required`);
        }
      }
    }
    const props = schema.properties;
    if (props && typeof props === 'object') {
      for (const [key, sub] of Object.entries(props as Record<string, unknown>)) {
        if (key in obj && sub && typeof sub === 'object') {
          errors.push(
            ...validateJsonSchema(obj[key], sub as JsonSchema, `${path}.${key}`)
          );
        }
      }
    }
  }

  if ((schema.type === 'array' || schema.items !== undefined) && Array.isArray(value)) {
    const items = schema.items;
    if (items && typeof items === 'object') {
      value.forEach((item, i) => {
        errors.push(
          ...validateJsonSchema(item, items as JsonSchema, `${path}[${i}]`)
        );
      });
    }
  }

  return errors;
}
