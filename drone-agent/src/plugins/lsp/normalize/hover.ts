import { isRecord } from '../../../shared/type-guards.js';

export function normalizeHoverContents(contents: unknown): string {
  if (typeof contents === 'string') {
    return contents;
  }

  if (Array.isArray(contents)) {
    return contents.map(normalizeHoverContents).filter(Boolean).join('\n\n');
  }

  if (isRecord(contents)) {
    if (typeof contents.value === 'string') {
      return contents.value;
    }
    if (
      typeof contents.language === 'string' &&
      typeof contents.value === 'string'
    ) {
      return `Language: ${contents.language}\n${contents.value}`;
    }
  }

  return '';
}
