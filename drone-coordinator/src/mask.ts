/**
 * Mask a secret config value for read endpoints: `••••` + last 4 chars of the
 * raw value. Nested JSON provider entries get their `apiKey` field masked too;
 * scalar values are masked directly. A value that is entirely a `${VAR}`
 * template is preserved verbatim — a template is not itself a secret, and
 * masking it would corrupt the entry before the receiver (agent) interpolates
 * it from its own environment at session-apply time. Templates embedded
 * mid-string are still masked.
 */
export function maskSecretValue(value: string): string {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const copy: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (
          (k === 'apiKey' || k === 'api_key' || k.endsWith('Key')) &&
          typeof v === 'string'
        ) {
          copy[k] = maskScalar(v);
        } else {
          copy[k] = v;
        }
      }
      return JSON.stringify(copy);
    }
  } catch {
    // Not JSON — fall through to scalar masking.
  }
  return maskScalar(value);
}

export function maskScalar(raw: string): string {
  const trimmed = raw.trim();
  // Whole-value ${VAR} templates must survive masking round-trips intact:
  // the beacon stores the masked value verbatim as a swarm-scope row and the
  // agent underlay consumes it as-is.
  if (/^\$\{[^}]+\}$/.test(trimmed)) {
    return raw;
  }
  if (trimmed.length <= 4) {
    return '••••';
  }
  return `••••${trimmed.slice(-4)}`;
}