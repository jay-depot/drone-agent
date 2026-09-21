# Reference Expansion (`@` references)

drone-agent expands `@` references inside user messages before they become
session turns. This lets you pull a file's contents or a skill's body into a
prompt without spending a tool call.

## Grammar

| Form                           | Meaning                                                          |
| ------------------------------ | ---------------------------------------------------------------- |
| `@src/foo.ts`                  | Insert the file's contents (bare path resolves against the CWD). |
| `@~/notes.md`                  | `~/` expands to your home directory.                             |
| `@/etc/hosts`, `@./x`, `@../x` | Absolute and relative paths.                                     |
| `@{path with spaces.md}`       | Braced form for paths containing whitespace.                     |
| `@src/`                        | A directory expands to a recursive, name-only listing.           |
| `@*.ts`                        | A glob expands to the matching files (capped at 30).             |
| `@skill:code-review`           | Insert a skill's body (see below).                               |
| `\@`                           | A literal `@` (the backslash is removed).                        |

Recognition rules:

- `@` starts a reference only at the start of the message or after whitespace,
  so mid-word `@` (`user@host`) is left untouched.
- `@skill:` is the only reserved namespace kind. Any other `@<kind>:<value>`
  (e.g. `@a:b.ts`) is treated as a **file path**.
- A reference that does not resolve is left literal. A notice is emitted only
  when the token looks like a path (contains `/` or `.`), so prose handles like
  `@dev` stay quiet.

## What gets inserted

The user's prose is preserved verbatim (including the `@token` as a readable
anchor). Resolved references are appended once, in order, under a trailer:

````
<prose verbatim>

--- Referenced content ---
### @src/foo.ts
```ts
<contents>
````

### @skill:code-review

<skill body>
```

A successful file expansion emits a receipt as a `notice` event
(`[expanded @src/foo.ts (120 lines, 4.2 KB)]`), shown by the TUI and the plain
handler; the TUI also logs the raw `> …` line separately. A glob emits one
aggregate line instead of one per file: `[expanded @*.ts (30 files, 120.4 KB)]`
(singular `file` for one; a `, N skipped` suffix when binary/budget drops
matches). A `notice` is emitted for problems too: `[unresolved reference: @…]`,
`[skipped binary: @…]`, and `[expansion budget exceeded; @… not included]`.
Notices are forwarded by every host that has a notice seam: the TUI, the plain
handler, and the NDJSON streams of JSON listen mode and swarm listen mode.

## Limits

- Per file: 2000 lines / 256 KB, truncated with a `[… truncated]` note.
- Binary files (a NUL byte in the first 8000 bytes) are skipped with a notice.
- Directories list at most 500 entries; a total-expansion budget bounds one
  message across all references.
- Identical resolved paths are deduplicated.

## Where expansion happens

Expansion runs in the conversation service, so **every host** behaves
identically: the TUI, plain readline (`--output-plain`), JSON listen mode, the
swarm WS, workflow `ctx.agent` steps, and `/steer`. It is applied at the three
direct-append sites:

- `sendUserMessage` (direct prompts),
- `drainPendingEntries('append')` (deferred/busy text),
- the mid-round steering loop (`/steer`).

The `'own-round'` drain re-enters `sendUserMessage`, so it is covered indirectly
and never double-expands.

The expander **defaults to the engine's `reference` capability**, resolved lazily
at each append site (the capability is seeded during engine initialization,
after the conversation service is constructed, so it must be looked up per
call). A host therefore never has to wire expansion: it is on by default in
every host because the capability is seeded before plugin registration. A host
supplies `expandUserMessage` only to override the default (the tests do this,
and an unregistered `reference` capability falls back to identity).

Macro **chat-prompt** steps expand (they route through `sendUserMessage`).
Slash-command arguments — macro **slash** steps, `/exec`, `/tool` — are **never**
expanded.

## The `skill:` namespace

The skills plugin registers the `skill` kind on the `reference` capability, so
`@skill:<id>` inserts the enhancer-applied skill body (the same path
`skills__recall` uses). Skills match case-insensitively. An unknown id yields
`[unknown skill: <id>]`; if the skills plugin is not enabled, `@skill:` yields
`[skill references unavailable: skill plugin not enabled]`.

The `reference` capability is seeded by the engine before plugin registration,
so future kinds (`@persona:`, `@url:`, …) can register without touching the
runtime.

## Tab completion

The TUI completes references and slash commands. Press **Tab** to open the menu
(there is no auto-open). The menu shows:

- slash commands when the caret is in a leading `/` token,
- skills when the token starts with `@skill:`,
- files and directories when the token starts with `@`.

Navigation: **Up/Down** or **Shift+Tab** move; **Enter** or **Tab** accept;
**Esc** closes. Accepting a directory appends `/` and reopens the menu; files
and skills append a space. Matching is case-insensitive prefix matching
(directories first, dotfiles hidden unless the prefix starts with `.`).

## Deferred

- Image references (`@pic.png`) that attach via the vision path — the
  `images[]` field exists in the expansion contract and is threaded through
  `appendUserMessage`; the follow-up adds MIME detection in the file resolver.
- Non-TUI tab completion (plain readline and JSON hosts get expansion but no
  completion menu).
