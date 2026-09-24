export { createReferenceCapability } from './capability.js';
export { tokenizeText } from './parse.js';
export type { TextToken, ReferenceToken } from './parse.js';
export {
  resolveFileReference,
  resolveReferencePath,
  MAX_LINES,
  MAX_BYTES,
  MAX_DIR_ENTRIES,
  MAX_GLOB_MATCHES,
} from './file-kinds.js';
export type { ExpansionBudget, ReferenceLimits } from './file-kinds.js';
