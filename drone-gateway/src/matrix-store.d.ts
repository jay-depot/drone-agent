/**
 * Ambient type declarations for matrix-js-sdk internal store modules.
 *
 * matrix-js-sdk v34 does not expose IndexedDBStore or MemoryStore through
 * its public type declarations. The JS files exist at these paths at runtime,
 * but TypeScript's NodeNext module resolution cannot resolve the subpath
 * imports because the SDK lacks an "exports" map and the .d.ts files use
 * internal relative imports.
 *
 * These declarations provide just enough type information for the dynamic
 * import() in the Matrix adapter's getStore() function.
 */

declare module 'matrix-js-sdk/lib/store/indexeddb' {
  export class IndexedDBStore {
    constructor(path: string);
    // Minimal interface — we only construct and pass to createClient
  }
}

declare module 'matrix-js-sdk/lib/store/memory' {
  export class MemoryStore {
    constructor();
    // Minimal interface — we only construct and pass to createClient
  }
}
