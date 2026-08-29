---
name: tmux
description: 'How and when to use tmux'
recall:
  - background processes
  - testing TUIs 
  - monitoring logs
  - async processes
model-invocation: true
---

# Tmux

## Overview

Tmux (terminal multiplexer) allows you to run multiple terminal sessions in a single window, detach/reattach sessions, split panes, and manage persistent shell sessions. Use tmux when you need persistent terminals that survive SSH disconnections, need to run multiple processes side-by-side, or want to monitor log output while working in another pane.

## Instructions

### Session Management

1. **Start a new named session**: `tmux new -s <session-name>`
2. **Detach from session**: use `tmux detach`
3. **Reattach to session**: `tmux attach -t <session-name>` or `tmux a -t <session-name>`
4. **List sessions**: `tmux ls`
5. **Kill a session**: `tmux kill-session -t <session-name>`

### Window Management (within a session)

- **New window**: `Ctrl-b` `c`
- **Switch windows**: `Ctrl-b` `n` (next), `Ctrl-b` `p` (previous), `Ctrl-b` `<number>` (specific window)
- **Rename window**: `Ctrl-b` `,`
- **Kill window**: `Ctrl-b` `&`

### Pane Management (split windows)

- **Split horizontally** (top/bottom): `Ctrl-b` `"` 
- **Split vertically** (left/right): `Ctrl-b` `%`
- **Navigate panes**: `Ctrl-b` `<arrow keys>`
- **Resize panes**: `Ctrl-b` `Ctrl-<arrow>`
- **Close pane**: `Ctrl-b` `x` (confirm with `y`)

### Monitoring and Logging

- **Split horizontally and tail a log**: `Ctrl-b` `"`, then `tail -f <logfile>`
- **Watch command output**: Use `watch -n <seconds> "<command>"` in a pane
- **Scroll/copy mode**: `Ctrl-b` `[`, then use arrow keys, `Space` to start selection, `Enter` to copy, `q` to exit

### Practical Patterns

**Pattern 1: Run a long-lived process**
```bash
tmux new -s mytask -d 'python manage.py migrate'
# Later: tmux attach -t mytask
```

**Pattern 2: Development workflow**
```bash
tmux new -s dev
# Window 1: editor (vim/nano)
# Window 2: test runner (pytest -w)
# Window 3: server (python app.py)
```

**Pattern 3: Monitor logs while working**
```bash
# Split vertically, left side for work, right side for logs
Ctrl-b %  # split
Ctrl-b <arrow>  # move to new pane
tail -f app.log
```

**Pattern 4: Background process with logging**
```bash
tmux new -d -s backup 'tar czf /backup.tar.gz /important && echo "Done" | tee -a backup.log'
```

## Examples

- **User says**: "I need to run a server that stays running after I disconnect"
  - **Action**: Create a tmux session: `tmux new -s server -d 'python server.py'`

- **User says**: "I want to watch log output while testing"
  - **Action**: Split the terminal: `Ctrl-b %`, then `tail -f logs/test.log` in one pane

- **User says**: "I'm SSH'ing into a remote machine and need to run multiple commands"
  - **Action**: Use tmux sessions that persist across disconnections

- **User says**: "I need to test a TUI that requires a real terminal"
  - **Action**: Run the TUI inside tmux to ensure proper terminal emulation
