# drone-swarm-project — Context

The kanban board swarm extension. It owns a board and turns card movements into
agent sessions. This page is a **glossary only**.

## Terms

- **Project** — A namespace. It owns ordered columns, a collection of cards, and
  the automations that act on them. It is not bound to a single beacon or
  working directory; it carries defaults that automations inherit.
- **Column** — An ordered stage within a project (seeded Todo / In Progress /
  Done). Moving a card between columns is a transition.
- **Card** — A unit of work on the board. It has a title, an optional
  description, a column, a position, and a movement history. It may carry the
  id of the session that worked on it.
- **Transition** — A move from one column to another. Card creation counts as a
  transition from "no column" into the first column.
- **Automation** — A per-project rule keyed on a transition pair
  (`when.from` → `when.to`, `*` allowed on one side). When its transition
  matches, it enqueues a job.
- **Job** — One queued or started spawn. It moves through
  `queued → running → done | failed | cancelled`.
- **Queue** — The node's list of jobs, drained under the speed limits.
- **Speed limits** — `maxConcurrentSessions` and `maxDailySessions`. They pace
  the starts; they do not gate who may move a card.
- **Card-bound session** — A session launched by an automation. Its
  `extensionHint` names its card, so the card tools default to that card.
