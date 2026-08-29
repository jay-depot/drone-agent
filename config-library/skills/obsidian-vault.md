---
name: obsidian-vault
description: 'Navigate, update, and maintain an obsidian vault'
recall:
  - you need to interact with information in an obsidian vault
model-invocation: true
---
# Obsidian-vault

## Overview

This skill covers how to navigate, update, and maintain an Obsidian vault. Obsidian is a markdown-based personal knowledge management app that stores notes as plain `.md` files on disk. Its superpower is **linking**: notes connect to each other via wikilinks (`[[...]]`), forming a graph of knowledge that is more powerful than a folder hierarchy alone.

When you need to read, create, edit, or reorganize notes in an Obsidian vault, use this skill. It covers the linking system, folder organization strategies, YAML frontmatter, tags, and maintenance best practices.

## Instructions

### 1. Understanding the Vault

An Obsidian vault is simply a directory on disk containing `.md` files (and optionally attachments, templates, etc.). There is no database — every note is a plain markdown file. This means you can read, write, and manipulate vault files with standard file tools (`file.read`, `file.write`, `file.glob`, `search.text`).

### 2. Links (Wikilinks) — The Core Concept

Obsidian uses **wikilinks** (double-bracket syntax) as its primary internal linking mechanism. Links are how you connect ideas, create navigation, and build a knowledge graph.

#### Basic Wikilink Syntax

| Syntax | Description | Example |
|--------|-------------|---------|
| `[[Note Name]]` | Link to a note by filename (no extension needed) | `[[Project Alpha]]` |
| `[[Note Name\|Display Text]]` | Link with custom display text (pipe syntax) | `[[Atomic Habits\|James Clear – Atomic Habits]]` |
| `[[Note Name#Heading]]` | Link to a specific heading within a note | `[[Project Alpha#Timeline]]` |
| `[[Note Name#^block-id]]` | Link to a specific block (paragraph, list item, quote) | `[[Note^my-block]]` |
| `[[Note Name#Heading\|Display]]` | Combined: heading + custom display | `[[Project Alpha#Timeline\|View Timeline]]` |

#### How to Follow Links

- **In the Obsidian app**: Click a `[[wikilink]]` to navigate to the target note. Ctrl/Cmd+Click opens in a new pane.
- **In markdown on disk**: Wikilinks are Obsidian-specific syntax. Standard markdown editors will not render them as clickable links. To follow a link programmatically:
  1. Parse the wikilink: extract the note name between `[[` and `]]` (or `[[` and `|` if a pipe is present).
  2. Resolve the filename: Obsidian matches by filename (case-insensitive). Look for a `.md` file whose name matches (e.g., `Project Alpha.md`).
  3. If a heading is specified (after `#`), search the target file for that heading line.
  4. If a block ID is specified (after `#^`), search the target file for `^block-id` at the end of a paragraph or on its own line after a block.

#### Wikilinks vs. Markdown Links

| Feature | Wikilink `[[...]]` | Markdown `[text](url)` |
|---------|-------------------|----------------------|
| Primary use | Internal vault notes | External URLs |
| Refactoring | Automatic (Obsidian tracks renames) | Manual updates required |
| Anchors | Supports headings and blocks | Supports headings (standard) |
| Interoperability | Obsidian-only | Works in any markdown viewer |

#### Aliases

Notes can have **aliases** defined in YAML frontmatter, which makes them discoverable by alternate names when typing `[[`:

```yaml
---
aliases: [Atomic Habits, AH, James Clear Book]
---
```

Typing `[[AH]]` will then autocomplete to this note.

#### Embedding (Transclusion)

Prefix a wikilink with `!` to embed the content inline rather than just linking:

- `![[Note Name]]` — embeds the full note content
- `![[Note Name#Heading]]` — embeds a specific section
- `![[image.png]]` — displays an image inline

### 3. YAML Frontmatter (Properties)

Every note can have YAML frontmatter at the top (between `---` delimiters) for metadata:

```yaml
---
title: My Note
tags: [project, active]
aliases: [Alternate Name]
created: 2026-06-28
status: draft
---
```

Common frontmatter fields:
- `tags` — cross-cutting labels (can also use inline `#tag` in the body)
- `aliases` — alternate names for wikilink resolution
- `created` / `modified` — timestamps
- `status` — e.g., draft, review, done

### 4. Tags

Tags are used for cross-cutting organization — they answer "what is this about?" while folders answer "where does this live?".

- Inline tags: `#tag-name` anywhere in the note body
- YAML tags: `tags: [tag1, tag2]` in frontmatter
- Nested tags: `#project/active`, `#status/draft` (Obsidian treats the `/` as hierarchy)

### 5. Folder Organization Strategies

Obsidian vaults can be organized in many ways. The most common approaches:

#### PARA Method (Tiago Forte)
```
📁 1 - Projects      ← Active work with deadlines
📁 2 - Areas         ← Ongoing responsibilities (health, finance, etc.)
📁 3 - Resources     ← Reference material (books, articles, ideas)
📁 4 - Archives      ← Completed/inactive items
📄 Home.md           ← Main index (Map of Content)
```

#### Zettelkasten (for researchers/writers)
```
📁 00 - Inbox              ← Unprocessed notes
📁 10 - Literature Notes   ← Summaries of what you read
📁 20 - Permanent Notes    ← Your own atomic ideas
📁 30 - Projects           ← Active work
📁 40 - Index              ← Maps of Content
```

#### Recommended Hybrid
```
📁 00 - Inbox        ← Capture everything here first
📁 01 - Projects     ← Active work with deadlines
📁 02 - Areas        ← Ongoing life domains
📁 03 - Notes        ← Permanent atomic ideas
📁 04 - Resources    ← Reference material
📁 05 - Templates    ← Note templates
📁 06 - Attachments  ← Images, PDFs, files
📁 07 - Archive      ← Completed/inactive
📄 Home.md           ← Main index (MOC)
```

**Key principle**: Prefer links over deep folder nesting. A flat structure with rich links is more flexible than a deep hierarchy. Use Maps of Content (MOC) — index notes that link to related notes — as navigation hubs.

### 6. Maintenance Best Practices

#### Regular Tasks
- **Process the inbox weekly**: File, link, or delete each note in the inbox folder.
- **Review backlinks**: Check the backlinks of hub notes to discover forgotten connections.
- **Prune dead links**: Notes that link to non-existent files (shown in red in Obsidian) should either be created or the link removed.
- **Check for orphans**: Notes with no incoming links may need to be connected or archived.

#### Naming Conventions
- Use descriptive filenames: `Project Alpha - Q2 Review.md` not `Note1.md`
- Avoid problematic characters: `# ^ | : %` (they have special meaning in Obsidian syntax)
- Use date prefixes for time-based notes: `2026-06-28 Daily Log.md`
- Keep filenames short enough to type in `[[wikilinks]]` but descriptive enough to identify

#### Settings to Verify
- **Automatically update internal links**: Enable in Settings → Files & Links. This keeps wikilinks valid when files are renamed or moved.
- **New link format**: Wikilink (default) or Markdown. Use Markdown if syncing with GitHub or publishing to static sites.
- **Default attachment folder**: Set to `Attachments/` or `06 - Attachments/` to keep media organized.

#### Vault Health Checks
- Run `file.glob` with `**/*.md` to list all notes and check for naming consistency.
- Use `search.text` to find broken wikilinks (patterns like `[[NonExistentNote]]` that don't resolve to any `.md` file).
- Check for duplicate filenames (Obsidian resolves by filename, so duplicates cause ambiguity).
- Ensure YAML frontmatter is valid (proper `---` delimiters, correct indentation).

## Examples

### Example 1: Reading and following links in a vault

Given a note `Home.md` containing:
```markdown
# Home

Welcome to my vault. Key areas:
- [[Project Alpha]] — the main project
- [[Health Log]] — fitness tracking
- See [[Resources#Books]] for reading list
```

To follow the link `[[Project Alpha]]`:
1. Extract the target: `Project Alpha`
2. Find the file: look for `Project Alpha.md` in the vault directory
3. Read it with `file.read`

To follow `[[Resources#Books]]`:
1. Extract the target note: `Resources`
2. Extract the heading: `Books`
3. Read `Resources.md` and search for the `## Books` heading

### Example 2: Creating a new linked note

To create a new note and link it from an existing one:
1. Write the new file: `file.write` to `Project Alpha.md`
2. Add a wikilink in the source note: edit the file to include `[[Project Alpha]]`
3. Optionally add aliases in the new note's frontmatter for discoverability

### Example 3: Checking vault health

```bash
# List all markdown files
find /path/to/vault -name '*.md'

# Find notes with no incoming links (potential orphans)
# Search for each note's filename in wikilink format across all files
```

### Example 4: Restructuring without breaking links

When moving or renaming a note:
- Working outside of Obsidian, after renaming a file, search for all `[[OldName]]` patterns and replace them with `[[NewName]]`.
- Markdown links `[text](path)` are NOT automatically updated — they must be fixed manually.
