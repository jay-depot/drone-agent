---
key: todo-slash-commands-plan
tags:
  - todo
  - slash-commands
  - plugin
  - implementation-plan
created: 2026-06-26T05:23:44.732Z
updated: 2026-06-26T05:23:44.732Z
---

## Slash-Commands for `todo` Plugin — Implementation Plan

### 1. Current State

The existing `todo` plugin (`drone-agent/src/plugins/todo.ts`) provides:

- **`manage_list` tool** with actions: `add_item`, `mark_in_progress`, `mark_completed`, `remove_item`, `list_items`, `clear_completed`, `replace_list`
- **In-memory storage** (items lost on session end)
- **Status types**: `pending`, `in_progress`, `completed`
- **Auto-generated IDs** (sequential integers starting from 1)

### 2. Proposed Slash Commands

| Command       | Description            | Arguments                                                              |
| ------------- | ---------------------- | ---------------------------------------------------------------------- | ----------- | -------------------- |
| `/todo show`  | Display all todo items | Optional: `--status pending                                            | in_progress | completed` to filter |
| `/todo clear` | Remove items           | Optional: item ID to clear specific item, or `all` to clear everything |
| `/todo add`   | Add a new item         | Optional: description text (prompts if not provided)                   |

### 3. Implementation Details

#### 3.1 `/todo show`

- **Behavior**: Lists all items with ID, status, and title
- **Filtering**: `--status <status>` flag to filter by status
- **Output**: Uses existing `formatTodoList()` helper, or enhanced version with status filtering

#### 3.2 `/todo clear [NUMBER|"all"]`

- **Behavior**:
  - No argument → clear completed items only (safer default)
  - `NUMBER` → clear specific item by ID
  - `all` → clear all items (with confirmation prompt)
- **Implementation**: Reuse existing `clear_completed` and `remove_item` tool actions via `engine.executeTool()`

#### 3.3 `/todo add ["Description"]`

- **Behavior**:
  - With description → add immediately
  - Without description → show prompt hint
- **Implementation**: Reuse existing `add_item` tool action

### 4. Edge Cases to Handle

| Scenario                               | Handling                                                              |
| -------------------------------------- | --------------------------------------------------------------------- | ---------- | --------- | ----- |
| Invalid item ID in `/todo clear <id>`  | Show error: "Item #N not found"                                       |
| No items to show                       | Display: "No todo items yet. Use /todo add <description> to add one." |
| Empty description in `/todo add`       | Show usage hint                                                       |
| `/todo clear all` without confirmation | Show warning, require second confirmation                             |
| Unknown subcommand                     | Show help: "Usage: /todo show                                         | add <desc> | clear [id | all]" |

### 5. Help Text Registration

```
/todo show           Show all todo items
/todo show --status <status>  Filter by status
/todo add <desc>     Add a new todo item
/todo clear [id|all] Clear items (default: completed)
```

### 6. Files to Modify

| File                              | Changes                                                 |
| --------------------------------- | ------------------------------------------------------- |
| `drone-agent/src/plugins/todo.ts` | Add slash command registration in `register()` function |

### 7. Optional Enhancements (Future)

- **Persistence**: Add file-based storage (JSON in `.drone-agent/` directory)
- **Status shortcuts**: `/todo pending <id>`, `/todo done <id>` as aliases
- **Interactive prompts**: Use TUI dialog for `/todo add` without description
- **Undo support**: Track removed items for undo capability
