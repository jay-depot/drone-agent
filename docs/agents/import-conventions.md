# Import Conventions (Monorepo Build & Type Gotchas)

Project insights last processed on and at: 2024-06-10 at 20:15 EDT.

Notes on import/extension conventions across the workspace. This topic currently documents a single gotcha and is expected to grow.

## `.js` (never `.jsx`) when importing a sibling `.tsx`

When a `.ts` file imports a sibling `.tsx` component, use the `.js` extension, **not** `.jsx`.

`tsc` emits `.js` files for `.tsx` sources and does **not** rewrite a `.jsx` import specifier, so at runtime the build fails with `ERR_MODULE_NOT_FOUND` on `X.jsx`.

The codebase's existing pattern confirms this — e.g. importing `tui/components/GitDiffBlock.tsx` as `.js`. This surfaced during the git-plugin overhaul, where 10 tool files imported their components as `.jsx` and the dist build was broken until they were switched to `.js`.

## See Also

- `AGENTS.md` — package layout and development commands
- `docs/agents/debug-flag.md`, `docs/agents/mcp-plugin.md` — related build/runtime topics
