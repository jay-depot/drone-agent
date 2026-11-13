---
key: plan-wikilinks-in-code-regions
tags:
  - plan
  - swarm-wiki
  - drone-common
  - drone-swarm-common
  - drone-coordinator-ui
  - wikilinks
  - code-regions
  - ADR-279
created: 2026-11-13T23:43:51.122Z
updated: 2026-11-13T23:43:51.122Z
---

# Plan — `[[wikilinks]]` inside code regions are not links

**Status**: Ready for execution. NOT yet started.
**Executor**: persona `code`. One reviewer pass at the end (Step 11).
**Depends on**: nothing. This plan is self-contained.

---

## 1. Summary — what and why

The swarm memory wiki finds `[[links]]` everywhere in a page body. After this plan, a link inside a **code region** is not a link. A code region is a fenced block or an inline code span.

Two surfaces must obey the same rule:

1. **The coordinator web view.**
2. **The wiki lint and storage tools.**

The plan adds one new package, **`drone-common`**. It has **no dependencies** and runs in a browser and in node. Both surfaces call **one** function in this package. So the two surfaces cannot drift apart.

**This plan does NOT rename any package.** `drone-core`, `drone-swarm-common`, and `drone-extension-ui-types` keep their names. (A rename was considered and rejected — see §9.)

### Why

The wiki lint reports a "broken link" for text inside a code block. That report is **false** — the text is an example, not a link. The same false data reaches three other places:

- The page `linkCount` (the `has links` filter, and the Word Count column in the UI table).
- The graph-view edges.
- The write-time "no downward links" check.

The web view shows the same text as a clickable link, so the reader sees a link that does not exist.

One rule must serve both surfaces. Two copies of one rule drift apart in silence — each copy has its own tests, so only an edit to one copy reveals the divergence. So the rule lives in **one function, in one package, with one test suite**.

---

## 2. Decisions (locked with the user)

- **D1 — Scope is "everywhere".** The rule applies to `lintPages` (broken links, downward links, orphans), `buildGraph` edges, `readPage`/`listPages` `linkCount`, **and** `writePage`'s downward-link rejection. All four agree. A coordinator page whose *only* downward link is inside a code block is no longer rejected on write — correct, because it was never a link.
- **D2 — "Code" means fenced blocks AND inline spans.** A reader treats `` `x` `` and a fenced `x` the same way: literal text. If one were a link and the other not, the lint would disagree with the reader's eye.
- **D3 — Fences: backtick and tilde.** ```` ``` ```` and `~~~` are identical in CommonMark, and both appear in wiki pages.
- **D4 — CommonMark fence rules.** A closing fence must be at least as long as its opening fence. An unterminated fence runs to the end of the document.
- **D5 — Indented (4-space) code blocks are OUT OF SCOPE.** They are rare in these pages, ambiguous with list indentation, and getting them wrong risks swallowing real prose.
- **D6 — An unmatched backtick run stays literal text.** CommonMark behaviour, and it avoids swallowing real links after a stray backtick.
- **D7 — Agent-side page lookup by name is unchanged.** The beacon's keyword/vector index and `swarm__wiki_read` resolve by page id, not by parsing links. A `[[foo]]` in a code block stays findable by name. The user explicitly approved this.
- **D8 — One new package, `drone-common`.** Zero dependencies, isomorphic (browser-safe). Not `drone-ui-common`: the **node** lint would then import a package named "ui", which is the same dishonest naming this plan exists to fix.
- **D9 — One public function.** `transformOutsideCodeRegions(markdown, fn)`. See §3.
- **D10 — No raw-range export now.** Do not also export `findCodeRegions()`. The user's words: *"expanding into C is fine if there's ever an actual use."* Record that sentence in the code comment.
- **D11 — `drone-core` keeps its name.** 516 import sites; the name is accurate. `drone-common` and `drone-core` are near-synonyms, and that is an **accepted wart**. The naming rule (§4) is documented so it is not re-litigated.
- **D12 — `drone-extension-ui-types` keeps its name.** "Extension" is load-bearing — it is the *extension bundle* contract, not general UI types.
- **D13 — `drone-common` does NOT absorb the two existing UI-boundary duplications now.** `splitFrontmatter` (`wiki-frontmatter.ts` duplicates `wiki-storage.ts`) and the three fragment constants (`fragments.ts` duplicates `drone-swarm-common`). Unrelated to this fix; a separate follow-up plan.

---

## 3. The rule and the public API

A **code region** is:

- A fenced block, opened by three or more backticks (```` ``` ````) or tildes (`~~~`).
- An inline code span (one or more backticks, closed by a run of the **same** length).

The package exports exactly one function:

```ts
transformOutsideCodeRegions(markdown: string, fn: (text: string) => string): string
```

It splits the document into code and non-code runs, applies `fn` to the non-code runs only, and rejoins. **Code runs come back byte-for-byte** — the web view must keep rendering its code blocks.

Both consumers pass a different `fn`:

| Consumer | `fn` |
|---|---|
| Lint / storage | collects `[[targets]]` into an array, returns the text unchanged |
| Web view | the existing wikilink → markdown-link rewriter |

`segmentCodeRegions` (the splitter) stays **module-private**. There is no consumer for raw ranges today.

---

## 4. Package inventory after this plan

| Package | Runtime deps | Runs in browser? | Role |
|---|---|---|---|
| `drone-core` | `@sinclair/typebox` | No (`node:fs`, `process.platform`) | Shared base contracts |
| **`drone-common`** | **none** | **Yes** | Shared dependency-free logic |
| `drone-swarm-common` | drone-core, better-sqlite3, ws, @huggingface/transformers | No | Swarm infrastructure |
| `drone-extension-ui-types` | none (types only) | Yes | Extension-bundle contract |

**Naming rule (document this; do not re-litigate).** `drone-common` has **no dependencies** and runs **anywhere**. `drone-core` is **node-only** and holds shared contracts. They are not versions of each other.

Why the UI cannot import the other two: `drone-core/src/utils.ts` imports `node:fs/promises` and reads `process.platform`; `drone-swarm-common` pulls better-sqlite3, ws, and onnx. Neither bundles in Vite. `drone-extension-ui-types` is safe only because it is types-only (erased at runtime).

---

## 5. Files

### New

- `drone-common/package.json`
- `drone-common/tsconfig.json`
- `drone-common/src/index.ts`
- `drone-common/src/code-regions.ts`
- `drone-common/test/code-regions.test.ts`
- `docs/adr/279-wikilinks-not-links-in-code.md`

### Changed

- `pnpm-workspace.yaml`, `pnpm-lock.yaml` (regenerated, not hand-edited)
- `vitest.config.ts` (alias + `test.include` + `test.coverage.include`)
- `tsconfig.test.json` (include globs)
- `drone-swarm-common/package.json`, `drone-swarm-common/tsconfig.json`, `drone-swarm-common/src/wiki-storage.ts`
- `drone-swarm-common/test/wiki-storage.test.ts`
- `drone-coordinator-ui/package.json`, `drone-coordinator-ui/vite.config.ts`, `drone-coordinator-ui/vitest.config.ts`
- `drone-coordinator-ui/src/lib/wiki-links.ts`, `drone-coordinator-ui/src/lib/wiki-links.test.ts`
- `drone-coordinator-ui/src/components/wiki-markdown.test.tsx`
- `docker/drone-agent.Dockerfile`, `docker/drone-beacon.Dockerfile`, `docker/drone-coordinator.Dockerfile`, `docker/test-runner.Dockerfile`
- `AGENTS.md`, `README.md`, `CONTEXT-MAP.md`
- `drone-coordinator/src/default-assets.ts`

---

## 6. Order of work and dependencies

- **Steps 1–3** create the package and its tests. Step 2 needs Step 1. Step 3 needs Step 2.
- **Step 4** registers the package in the workspace. Needs Steps 1–3.
- **Steps 5–6** change the lint path and test it. Need Step 4.
- **Steps 7–8** change the web view and test it. Need Step 4. Independent of Steps 5–6.
- **Step 9** updates the docs. Needs the code to be final.
- **Step 10** updates the Dockerfiles. Needs Step 1 (the directory must exist).
- **Step 11** is the final check. Needs everything.

Run `pnpm build` after Step 4 and after each of Steps 5 and 7.

---

## Step 1 — Create the `drone-common` package [agent: code]

**New file**: `drone-common/package.json`

```json
{
  "name": "drone-common",
  "version": "1.0.0",
  "description": "Shared dependency-free code that runs in a browser and in node.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "private": true,
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --pretty false",
    "clean": "rm -rf dist tsconfig.tsbuildinfo"
  }
}
```

**New file**: `drone-common/tsconfig.json`

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "types": []
  },
  "include": ["src/**/*.ts"]
}
```

`"types": []` is load-bearing. The base config sets `types: ["node"]`, which lets `node:fs` typecheck. An empty list makes any `node:` import a **compile error**. So the "runs in a browser" claim is enforced by the compiler, not by a comment. (Validation criterion 10 proves this bites.)

**New file**: `drone-common/src/index.ts`

```ts
export { transformOutsideCodeRegions } from './code-regions.js';
```

---

## Step 2 — Implement the rule [agent: code]

**New file**: `drone-common/src/code-regions.ts`

```ts
/**
 * One run of markdown text. `code` marks a code region.
 */
type CodeSegment = { code: boolean; text: string };

/** An opening fence: up to 3 spaces, then 3+ backticks or tildes. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** A closing fence: up to 3 spaces, then 3+ backticks or tildes, then only space. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** Length of the run of `text[index]` that starts at `index`. */
function runLengthAt(text: string, index: number): number {
  const ch = text[index];
  let n = 0;
  while (text[index + n] === ch) n++;
  return n;
}

/** Index of the next run of exactly `length` copies of `ch`, or -1. */
function findRunOfLength(
  text: string,
  from: number,
  ch: string,
  length: number
): number {
  let i = from;
  while (i < text.length) {
    if (text[i] !== ch) {
      i++;
      continue;
    }
    const n = runLengthAt(text, i);
    if (n === length) return i;
    i += n;
  }
  return -1;
}

/** Split one non-fence run into text and inline-code segments. */
function splitInlineCode(text: string): CodeSegment[] {
  const out: CodeSegment[] = [];
  let plainStart = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    const open = runLengthAt(text, i);
    const close = findRunOfLength(text, i + open, '`', open);
    if (close === -1) {
      i += open;
      continue;
    }
    if (i > plainStart) {
      out.push({ code: false, text: text.slice(plainStart, i) });
    }
    out.push({ code: true, text: text.slice(i, close + open) });
    i = close + open;
    plainStart = i;
  }
  if (plainStart < text.length) {
    out.push({ code: false, text: text.slice(plainStart) });
  }
  return out;
}

/**
 * Split markdown into code and non-code runs.
 *
 * Code runs are fenced blocks (backtick or tilde) and inline code spans.
 * An unterminated fence runs to the end of the document.
 * A backtick run with no matching closer stays literal text.
 */
function segmentCodeRegions(markdown: string): CodeSegment[] {
  const out: CodeSegment[] = [];
  const lines = markdown.split('\n');
  let open: { char: string; length: number } | null = null;
  let text = '';
  let code = '';

  const flushText = () => {
    if (text.length === 0) return;
    out.push(...splitInlineCode(text));
    text = '';
  };
  const flushCode = () => {
    if (code.length === 0) return;
    out.push({ code: true, text: code });
    code = '';
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const eol = i < lines.length - 1 ? '\n' : '';

    if (open) {
      code += raw + eol;
      const close = FENCE_CLOSE.exec(raw);
      if (close && close[1][0] === open.char && close[1].length >= open.length) {
        flushCode();
        open = null;
      }
      continue;
    }

    const openMatch = FENCE_OPEN.exec(raw);
    if (openMatch) {
      flushText();
      open = { char: openMatch[1][0], length: openMatch[1].length };
      code += raw + eol;
      continue;
    }

    text += raw + eol;
  }

  flushText();
  flushCode();
  return out;
}

/**
 * Apply `fn` to every non-code run of `markdown`.
 *
 * Code runs are returned unchanged, byte for byte. A caller that renders the
 * result therefore keeps its code blocks intact.
 *
 * The rule lives here and nowhere else, so the node lint and the browser view
 * cannot disagree. If a caller ever needs the raw ranges, add a second export
 * then; there is no such caller today.
 */
export function transformOutsideCodeRegions(
  markdown: string,
  fn: (text: string) => string
): string {
  return segmentCodeRegions(markdown)
    .map(segment => (segment.code ? segment.text : fn(segment.text)))
    .join('');
}
```

**Do NOT export `segmentCodeRegions`.** There is no consumer for raw ranges.

---

## Step 3 — Test the rule [agent: tester]

**New file**: `drone-common/test/code-regions.test.ts`

Call only the public function. Use a marker function to make code regions visible:

```ts
const mark = (text: string) => `«${text}»`;
```

Cover **every** case:

1. Plain text — the whole string is marked.
2. Backtick fence — the fence lines and the body are **not** marked.
3. Tilde fence — same.
4. A closing fence **longer** than the opening fence closes the block.
5. A closing fence **shorter** than the opening fence does **not** close the block; the fence runs to the end.
6. An unterminated fence runs to the end.
7. An inline span (`` `x` ``) is not marked; the text around it is.
8. A double-backtick span (`` ``x`` ``) is not marked.
9. An unmatched backtick run stays literal **and is marked as text**.
10. Mixed: a real link outside a code block is marked; the code block is not.
11. A fence marker inside an inline span is not a fence.
12. An empty document returns an empty string.
13. Idempotence: an `fn` that returns its input yields the input exactly.

---

## Step 4 — Register the package [agent: code]

1. Add `- drone-common` to `pnpm-workspace.yaml`.
2. In `vitest.config.ts`, add to `resolve.alias`:
   `'drone-common': path.join(rootDir, 'drone-common/src/index.ts')`
3. In `vitest.config.ts`, add `'drone-common/test/**/*.test.ts'` to `test.include`, and `'drone-common/src/**/*.ts'` to `test.coverage.include`.
4. In `tsconfig.test.json`, add `"drone-common/src/**/*.ts"` and `"drone-common/test/**/*.ts"` to `include`.
5. Run `pnpm install` to regenerate `pnpm-lock.yaml`.
6. Run `pnpm build` and `pnpm test` to confirm the package builds and its tests pass.

---

## Step 5 — Use the rule in the lint path [agent: code]

1. `drone-swarm-common/package.json`: add `"drone-common": "workspace:*"`.
2. `drone-swarm-common/tsconfig.json`: add `{ "path": "../drone-common" }` to `references`.
3. `drone-swarm-common/src/wiki-storage.ts`: add the import, then replace the **body** of `extractWikiLinks` (it is private; keep it private).

```ts
import { transformOutsideCodeRegions } from 'drone-common';

function extractWikiLinks(content: string): string[] {
  if (content.length > MAX_WIKI_CONTENT_LENGTH) {
    throw new Error(
      `Wiki content exceeds maximum allowed length of ${MAX_WIKI_CONTENT_LENGTH} characters`
    );
  }

  const links: string[] = [];
  transformOutsideCodeRegions(content, text => {
    const regex = /\[\[([^\]]+)\]\]/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      links.push(match[1].trim());
    }
    return text;
  });
  return links;
}
```

**Two things to keep exactly as written.**

- **Keep the length guard where it is.** It is the CodeQL mitigation from ADR 132.
- **Keep the regex INSIDE `fn`.** A module-level `g` regex keeps `lastIndex` state between calls, and `fn` runs once per non-code run.

**Do not change any caller.** `extractWikiLinks` stays private. All four consumers get the fix at once:

- `writePage` (the downward-link check)
- `readPage` (`linkCount`)
- `lintPages` (broken links, downward links, orphans)
- `buildGraph` (edges)

---

## Step 6 — Test the lint path [agent: tester]

Add these cases to `drone-swarm-common/test/wiki-storage.test.ts`:

1. **Lint:** a page with `See [[missing-page]]` **inside a fenced block** produces **no** `broken-link` issue.
2. **Lint:** a page with a real `[[missing-page]]` **outside** code produces a `broken-link` issue. *This case proves case 1 is not passing for the wrong reason.*
3. **`linkCount`:** a body with one real link and one link in a code block reports `linkCount === 1`.
4. **`buildGraph`:** a page with a link in a code block produces **no** edge and **no** `exists:false` placeholder node.
5. **`writePage`:** a coordinator page whose **only** downward link is inside a code block is written successfully.
6. **`writePage`:** a coordinator page with a real downward link **outside** code is rejected.

---

## Step 7 — Use the rule in the web view [agent: code]

1. `drone-coordinator-ui/package.json`: add `"drone-common": "workspace:*"`.
2. `drone-coordinator-ui/vite.config.ts`: add to `resolve.alias`:
   `'drone-common': path.resolve(__dirname, '../drone-common/src/index.ts')`
3. `drone-coordinator-ui/vitest.config.ts`: add the same alias.
   *Both are needed. Vite can also resolve `drone-common` through the workspace symlink to `dist/`, but that needs a prior build; the alias makes the dev server and the build work without one.*
4. `drone-coordinator-ui/src/lib/wiki-links.ts`: keep `WIKILINK_RE` and `escapeLabel`; replace `preprocessWikiLinks`:

```ts
import { transformOutsideCodeRegions } from 'drone-common';

export function preprocessWikiLinks(content: string): string {
  return transformOutsideCodeRegions(content, text =>
    text.replace(WIKILINK_RE, (_match, target: string, alias?: string) => {
      const href = `/wiki/${encodeURIComponent(target.trim())}`;
      const label = escapeLabel((alias ?? target).trim());
      return `[${label}](${href})`;
    })
  );
}
```

**Do not change `wiki-markdown.tsx`.** It already calls `preprocessWikiLinks(body)`.

---

## Step 8 — Test the web view [agent: tester]

Add to `drone-coordinator-ui/src/lib/wiki-links.test.ts`:

- `` 'Use `[[x]]` here' `` is unchanged.
- A fenced block containing `[[x]]` is unchanged.
- A real link outside a code block is still rewritten.
- One document with a link outside **and** a link inside: only the outside one is rewritten.

Add to `drone-coordinator-ui/src/components/wiki-markdown.test.tsx`:

- Render `` 'See `[[deployment]]` for details' ``. Assert `screen.queryByRole('link')` is null, and the text `[[deployment]]` is present.

---

## Step 9 — Update the docs [agent: code]

1. **`drone-coordinator/src/default-assets.ts`** — in `MEMORY_WIKI_SKILL_BODY`, extend the cross-reference sentence: "A link inside a code block or an inline code span is not a link."
2. **`AGENTS.md`** — add a row for `drone-common/` to the package table.
3. **`README.md`** — add a bullet for `drone-common`.
4. **`CONTEXT-MAP.md`** — add a row for `drone-common` and a relationship line.
5. **New ADR**: `docs/adr/279-wikilinks-not-links-in-code.md`. Record: the problem; the one-function decision; the `drone-common` package and the naming rule from §4; the code-region rules; the rejected alternatives (§9); the graph-view consequence; and the out-of-scope items (§10).
6. Add a row for ADR 279 to `docs/adr/index.md`. **Known pre-existing defect:** the index has duplicate and missing rows, tracked as project memory `followup-adr-index-duplicate-rows-and-missing-entries`. Add only the 279 row; do not repair the index here.

**Do NOT rewrite `docs/adr/**` history or swarm wiki pages.** Those are historical records.

---

## Step 10 — Update the Dockerfiles [agent: code]

Add `COPY drone-common ./drone-common` to the **build stage** of all four:

- `docker/drone-agent.Dockerfile`
- `docker/drone-beacon.Dockerfile`
- `docker/drone-coordinator.Dockerfile`
- `docker/test-runner.Dockerfile`

Add `COPY --from=builder /app/drone-common ./drone-common` to the **runtime stage** of `drone-beacon.Dockerfile` and `drone-coordinator.Dockerfile`, next to the existing `drone-core` and `drone-swarm-common` lines.

*The build-stage copy is mandatory for all four. `pnpm-workspace.yaml` names a directory the build context must contain, or `pnpm install --frozen-lockfile` fails.*

**Note for the reviewer:** `docker/drone-agent.Dockerfile` copies `drone-core` to its runtime stage but **not** `drone-swarm-common`, although `drone-agent` imports `drone-swarm-common`. That is a pre-existing gap. **Do not fix it in this plan.** Log it as an insight.

---

## Step 11 — Check the work against the validation criteria [agent: reviewer]

Run every item in §7. Then do the two revert-and-restore proofs (items 7 and 8) and the browser-safety proof (item 10).

---

## 7. Validation criteria

All of these must pass.

1. **LSP** — no errors and no warnings on every touched file.
2. **Build** — `pnpm -r run build` exits 0.
3. **Typecheck** — `pnpm typecheck` exits 0.
4. **Lint** — `pnpm lint` exits 0. *(Prettier reformats files, so re-read every file before a later edit.)*
5. **Fast test suite** — `pnpm test` exits 0.
6. **UI tests** — `pnpm --filter drone-coordinator-ui test` exits 0.
7. **The lint gate bites** — revert the `extractWikiLinks` change. The new `wiki-storage.test.ts` cases **fail**. Restore it. They pass. *(Use file backups in `/tmp`. Do NOT use `git stash` — on this host a `git stash push` with a non-matching pathspec exits 0 and stashes nothing, and a chained `stash pop` then grabs the wrong stash.)*
8. **The web gate bites** — revert the `preprocessWikiLinks` change. The new `wiki-links.test.ts` cases **fail**. Restore it. They pass.
9. **Graph** — the Step 6 `buildGraph` case passes. A link in a code block produces no edge and no placeholder node.
10. **Browser safety** — `drone-common` compiles with `"types": []`. Add a `node:` import to `code-regions.ts` and confirm the build **fails**. Remove it.
11. **Docker** — `pnpm docker:build` exits 0.
12. **No regression** — every existing `wiki-storage.test.ts` and `wiki-links.test.ts` case still passes.
13. **Docs** — `docs/adr/279-wikilinks-not-links-in-code.md` exists, and `docs/adr/index.md` links to it.
14. **Memory committed** — the plan memory and any insights are committed on a feature branch, not `main`.

---

## 8. Graph view — covered, and why (verified, not assumed)

The graph gets the fix for free. The chain has one source of edges, and it is the function this plan changes:

| Layer | File | Role |
|---|---|---|
| Data | `drone-swarm-common/src/wiki-storage.ts` → `buildGraph()` | calls `extractWikiLinks(page.content)` per page |
| Route | `drone-coordinator/src/routes/wiki.ts` → `GET /wiki/graph` | returns `buildGraph()` |
| Hook | `drone-coordinator-ui/src/hooks/use-wiki-graph.ts` | fetches `/api/wiki/graph` |
| View | `drone-coordinator-ui/src/components/wiki-graph.tsx` + `lib/wiki-graph-utils.ts` | consumes the edges |

`wiki-graph.tsx` was searched for `[[`, `wikilink`, and `Markdown`: **zero matches**. It does not parse markdown at all — it only draws edges it is handed.

**"Free" means the behaviour is fixed. It does not mean it is tested.** Hence the explicit `buildGraph` regression test in Step 6 (case 4) and validation item 9.

---

## 9. Alternatives considered and rejected

- **Duplicate the function in both packages.** Cheaper now, and it matches local precedent (`wiki-frontmatter.ts`, `fragments.ts`). Rejected: it re-creates the exact failure mode the single-shared-function principle exists to prevent — two copies of one rule, each with its own tests, drifting in silence.
- **Put the rule in `drone-core`.** Rejected: `drone-core` is not browser-safe (`utils.ts` imports `node:fs/promises` and reads `process.platform`). Making it safe means splitting that file — a bigger blast radius than a new package.
- **Name the new package `drone-ui-common`.** Rejected: the **node** lint would import a package named "ui". That is the dishonest naming this plan exists to fix.
- **Export `findCodeRegions()` (raw ranges) instead of, or beside, the transform.** Rejected: each consumer would then write its own offset-filter loop — the drift risk again. The user approved expanding to it **if a real use appears**.
- **Handle 4-space indented code blocks.** Rejected: rare, ambiguous with list indentation, and a wrong guess swallows real prose.
- **Rename `drone-core` → `drone-agent-common`.** Rejected by the user: 516 import sites, and the name is accurate. The `drone-core`/`drone-common` near-synonym is an accepted wart, documented in §4.

---

## 10. Out of scope

- **4-space indented code blocks.**
- **Folding `splitFrontmatter` and the fragment constants into `drone-common`.** A separate follow-up plan.
- **Renaming any package.**
- **Fixing `docker/drone-agent.Dockerfile`'s missing `drone-swarm-common` runtime copy.** Log as an insight.
- **Repairing the `docs/adr/index.md` duplicate rows.** Tracked as a separate followup.
- **Changing how the agent looks up a page by name.** Explicitly approved as-is.

---

## 11. Executor notes (rough edges known in advance)

1. **`apply_diff` on `wiki-storage.ts`.** The change zone (`extractWikiLinks`) is distinctive, so a targeted diff should work. If it does not, fall back to a full `file__write` rewrite (the ADR 275 precedent).
2. **The vitest alias is required for the UI.** `drone-extension-ui-types` needs no alias because it is types-only and erased at runtime. `drone-common` is a **real runtime import**, so it does.
3. **`pnpm-lock.yaml` is regenerated by `pnpm install`.** Never hand-edit it.
4. **Prettier reformats after lint.** Re-read files before a later edit.
5. **Verify each edit landed.** A tool can report success and write nothing. After each change, search the file for the new text.
