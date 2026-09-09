                   \   /
               \    | |    /
                 \ (o o) /
      ____________(#####)____________    #####\   ######\  /#####\  ##\  ##  #######
     /    /   /   )     (   \   \    \   ######\  #######  #######  ###  ##  #######
    (__/____/__/_(#######)_\__\____\__)  ##  \##  ##  \##  ##/ \##  ###\ ##  ##
      (   /    /  )     (  \    \   )    ##   ##  ##  /##  ##   ##  ##\# ##  #####
       \___/_____(#######)_____\___/     ##   ##  ######/  ##   ##  ## #\##  #####
                / (     ) \              ##  /##  #####\   ##\ /##  ## \###  ##
              /    (###)    \            ######/  ##  \#\  #######  ##  ###  #######
                    ( )                  #####/   ##   \#\ \#####/  ##  \##  #######
                     V
                     |

# DRONE AGENT PLATFORM MONOREPO

The `drone` agent platform aims to be "the Arch of AI agents": minimalist out of the box, flexible, and capable of becoming a very intricate, customized and powerful, distributed system with the right know-how and effort.

## Architecture

- `drone-agent`: The coding agent at the core of the platform. It can be run as a "full-fat" AI coding agent with the obligatory Ink-based TUI, and can also be run in plain text output, or structured JSON output modes for easier use as a background or autonomous process. Out of the box, `drone-agent` comes with almost nothing enabled, but it should be just enough for you to ask it to help you get everything set up, including enabling the built-in plugins you want, possibly helping you code a few custom ones, and write your starting skills and personas (what other platforms call "agents").
- `drone-core`: Shared types, contracts, config defaults, and token estimation used by all other packages.
- `drone-beacon`: If `drone-agent` has the built-in "swarm" plugin enabled, it will expect to connect to a `drone-beacon` instance, which will typically be running as a service on the same host. The `drone-beacon` provides beacon-wide skills and personas, as well as a shared memory store, and a communication channel for agents to send messages to each other. The `drone-beacon` can optionally connect to a `drone-coordinator` instance for swarm-wide coordination — it works fully standalone without one.
- `drone-coordinator`: The `drone-coordinator` manages communication between `drone-beacon` instances, including cross-beacon message relay and broadcast. It also provides a web UI to monitor any running agents in the swarm, and task-manage them as well as interact with a coordinator management persona. The coordinator also provides swarm-wide personas, skills, and memory store.
- `drone-coordinator-ui`: A React + Vite + Tailwind web UI for the coordinator, served by the coordinator server.
- `drone-swarm-common`: Shared utilities for beacon and coordinator, including TLS certificate management, wiki filesystem storage, and database helpers.
- `drone-gateway` (in testing): A standalone service that can connect to chat APIs (Matrix, Discord, Slack, etc.) and relay messages into assigned personas in the swarm, launching new agent instances when needed to handle conversations. Currently in testing with Matrix adapter support.

## Current State

The `drone-agent`, `drone-beacon`, and `drone-coordinator` are all implemented and functional. The swarm mode is operational with agents connecting to beacons, and beacons coordinating through the coordinator. Cross-beacon messaging, shared session storage, swarm-wide insights and principles, and a swarm knowledge base (LLM Wiki) are all implemented. The gateway layer is in testing and the web UI is functional.

## Installation

Currently, installation is a little annoying, by design. The drone-agent tools are absolutely ready for use by anyone interested in helping develop it, but it's not quite there for public consumption yet. If you're interested in using it, you will need the following:

- node.js version 24.x or higher
- ollama (Even if you use another AI provider, we use this for running embedding models for semantic search locally)
- nomic-embed-text: `$ ollama pull nomic-embed-text:v1.5`
- tailscale or a similar service is recommended
- pnpm 11+

### Installation steps:

Before you start: Decide if you want to set up `swarm`, and if so, choose a coordinator host. If you only intend to run on a single machine, ever, but you want access to the swarm memory RAG on that one machine, you can run the coordinator locally. Otherwise, I recommend a VPS or a Raspberry Pi and a Tailscale network.

1. `$ git clone https://github.com/jay-depot/drone-agent.git`
2. `$ cd drone-agent`
3. `pnpm install && pnpm -r run build`
4. `cd drone-agent && npm link && cd ..` This puts the `drone-agent` binary in your PATH. If all you want is to use it stand-alone, you can stop here
5. `cd drone-beacon && npm link && cd ..` This adds `drone-beacon` to your PATH. If you want to set up a swarm, you will need to configure this to run on system startup for your OS of choice. For systemd-based Linux distributions, I recommend using a user-scoped systemd unit.
6. `cd drone-swarm && npm link && cd ..` This adds the `drone-swarm` utility to your PATH. This is optional except on your chosen coordinator host, where it will be used by your memory ingestion pipeline
7. `cd drone-coordinator && npm link && cd ..` This adds `drone-coordinator` to your PATH. This only needs to be done on your chosen coordinator host, and you will want to configure this to start automatically in the same way you did `drone-beacon`. Important: The coordinator needs a running beacon on the same host.
8. Configure everything (see below)

### Configuration

Config files live in `.drone-agent/config.json`. Config cascades from default → user (`~/.drone-agent/config.json`) → project (`.drone-agent/config.json` in your project root), with the project level taking highest precedence.

The quickest way to get configured is to simply run `drone-agent` in a new directory: when no user config exists yet, a first-run setup walks you through selecting a provider and model and writes `~/.drone-agent/config.json` for you. You can also run the bootstrap workflow explicitly with `drone-agent --workflow bootstrap__user --plugin bootstrap`.

Alternatively, you can write the user config manually. The minimum required config is an LLM provider with at least one model, and an `llm.active` entry pointing to it. The `apiKey` field supports `${ENV_VAR}` interpolation so you do not need to store secrets in the file.

**Anthropic (Claude):**

```json
{
  "llm": { "active": "anthropic/claude-sonnet-4-6" },
  "providers": {
    "anthropic": {
      "protocol": "anthropic",
      "apiKey": "${ANTHROPIC_API_KEY}",
      "models": {
        "claude-sonnet-4-6": {}
      }
    }
  },
  "enabledPlugins": [
    "startup",
    "config",
    "llm",
    "anthropic",
    "file",
    "exec",
    "git",
    "fetch",
    "search",
    "compaction",
    "log"
  ]
}
```

**OpenAI:**

```json
{
  "llm": { "active": "openai/gpt-4o" },
  "providers": {
    "openai": {
      "protocol": "openai",
      "apiKey": "${OPENAI_API_KEY}",
      "baseUrl": "https://api.openai.com/v1",
      "models": {
        "gpt-4o": {}
      }
    }
  },
  "enabledPlugins": [
    "startup",
    "config",
    "llm",
    "openai",
    "file",
    "exec",
    "git",
    "fetch",
    "search",
    "compaction",
    "log"
  ]
}
```

**OpenRouter** (gives access to many models through one API key):

```json
{
  "llm": { "active": "openrouter/anthropic/claude-sonnet-4-6" },
  "providers": {
    "openrouter": {
      "protocol": "openrouter",
      "apiKey": "${OPENROUTER_API_KEY}",
      "models": {
        "anthropic/claude-sonnet-4-6": {}
      }
    }
  },
  "enabledPlugins": [
    "startup",
    "config",
    "llm",
    "openrouter",
    "file",
    "exec",
    "git",
    "fetch",
    "search",
    "compaction",
    "log"
  ]
}
```

**Ollama** (local models, no API key needed, also supports *:cloud models through local ollama proxy):

```json
{
  "llm": { "active": "ollama/qwen2.5-coder:32b" },
  "providers": {
    "ollama": {
      "protocol": "ollama",
      "baseUrl": "http://localhost:11434",
      "models": {
        "qwen2.5-coder:32b": {},
        "glm-5.3-flash:cloud": {}
      }
    }
  },
  "enabledPlugins": [
    "startup",
    "config",
    "llm",
    "ollama",
    "file",
    "exec",
    "git",
    "fetch",
    "search",
    "compaction",
    "log"
  ]
}
```

The `enabledPlugins` list above is a reasonable baseline. Note that a non-empty `enabledPlugins` list replaces the default-enabled plugin set, so it must include the `llm` broker and the protocol plugin matching your provider entry's `protocol` field. See the plugin list in the Design Principles section for the full set of built-in plugins you can enable. The `config-library/` directory contains example configs, skills, macros, and personas to use as a starting point.

### Swarm Configuration

If you are running a swarm, you will need a `.drone-agent/config.json` on each machine that includes a `swarm` section pointing each beacon at the coordinator. See `docs/agents/swarm-plugin.md` for full configuration details.

## Design Principles

- Minimalist: The core agent should be as minimal as possible, with most of the functionality provided through plugins. This allows users to have a very lightweight agent if they want, and only add the functionality they need. More importantly, it means we're not opinionated about _how_ basic functionality gets done. `drone-agent` provides a rich set of built-in plugins: MCP client, LSP server connections, file operations, git tools, shell execution, HTTP fetch, text search, project memory, persona management, skills management, session logging, context compaction, TODO list management, subagent spawning, swarm coordination, macros, focus management, config management, self-improvement (insights/principles), prompt file injection, startup banner, and utility tools. Almost none of it is enabled by default though, because `drone-agent` should still work, even if you replace any of these components with one that better aligns with your needs or opinions.
- Model-centric: `drone-agent` doesn't come with hundreds of lines of built in system prompts. In fact by default it doesn't come with any, except the enabled tools. Turns out, the LLM can usually figure it out with just those, and skills/prompts are only really needed to fill in gaps, and those gaps usually need to be discovered.
- Project-first: `drone-agent` applies configuration in a layered cascade: **default → user → project** (last-write-wins per key, except `enabledPlugins` which is additive at the project level). When the swarm plugin is active, beacon and coordinator config values are injected as additional underlays via the `DroneConfigInjector` capability, not through the file-based config loader. Only the user level and below can specify loaded plugins, and project level plugins are added to user-level plugins, rather than replacing them. This allows projects to, for example, define the project-level memory system it wants to use, so that project memory could be meaningfully shared in version control.
- Single-user swarm: The swarm is designed to work with a single human, meaning that all agents in the swarm are expected to be working for the same user. If you are trying to set up coordination between multiple users, you would want to set up separate swarms for each user, and then have each set up to connect to an MCP server that is designed for multi-user coordination.

## Config Library

The `config-library/` directory contains a ready-made example agent setup: reusable skill `.md` files, macros, and personas that can be copied into your config directory (`~/.drone-agent/skills/`, `~/.drone-agent/macros/`, `~/.drone-agent/personas/`) and customized to fit your needs. See `config-library/README.md` for the plugin set this example assumes.
