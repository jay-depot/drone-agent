---
key: prompt-file-plugin-plan
tags:
  - plan
  - prompt-file
  - plugin
created: 2026-06-22T19:57:07.987Z
updated: 2026-06-22T19:57:07.987Z
---

# Prompt-File Plugin — Implementation Plan

## Overview
A new plugin `prompt-file` (disabled by default) that reads markdown files from configurable paths and injects their content as system prompt fragments. Supports traversal characters: `~/` (user home), `./` (CWD), `..?/` (CWD or any parent until match). File lists are additive across config layers.

## Dependencies & Order
1. **Step 1**: Add `promptFile` config types to `drone-core` (types + merge logic)
2. **Step 2**: Add `promptFile` parsing to `drone-agent/src/runtime/config.ts`
3. **Step 3**: Create the plugin at `drone-agent/src/plugins/prompt-file/index.ts`
4. **Step 4**: Register the plugin in `drone-agent/src/plugins/index.ts`
5. **Step 5**: Add tests for path resolution
6. **Step 6**: Add tests for config parsing
7. **Step 7**: Add tests for the plugin itself

## Detailed Steps

### Step 1: Add config types to drone-core

**File**: `drone-core/src/index.ts`

1a. Add a new type `DronePromptFileConfig`:
```ts
export type DronePromptFileConfig = {
  enabled: boolean;
  files: string[];
};
```

1b. Add `promptFile` to `DroneAgentConfig`:
```ts
export type DroneAgentConfig = {
  // ... existing fields ...
  promptFile: DronePromptFileConfig;
};
```

1c. Add `promptFile` to `PartialDroneAgentConfig`:
```ts
export type PartialDroneAgentConfig = Partial<{
  // ... existing fields ...
  promptFile: Partial<DronePromptFileConfig>;
}>;
```

1d. Add default in `createDefaultAgentConfig()`:
```ts
promptFile: {
  enabled: false,
  files: [],
},
```

1e. Add merge logic in `applyAgentConfigLayer()` — **additive** for `files`:
```ts
promptFile: layer.promptFile
  ? {
      ...baseConfig.promptFile,
      ...layer.promptFile,
      files: layer.promptFile.files
        ? [...baseConfig.promptFile.files, ...layer.promptFile.files]
        : baseConfig.promptFile.files,
    }
  : baseConfig.promptFile,
```

### Step 2: Add config parsing to config.ts

**File**: `drone-agent/src/runtime/config.ts`

In `parsePartialConfig()`, add a new block after the `log` block:

```ts
if ('promptFile' in raw) {
  if (!isRecord(raw.promptFile)) {
    throw new Error(
      `Invalid config in ${source}: promptFile must be an object.`
    );
  }

  const promptFile: PartialDroneAgentConfig['promptFile'] = {};

  if ('enabled' in raw.promptFile) {
    if (typeof raw.promptFile.enabled !== 'boolean') {
      throw new Error(
        `Invalid config in ${source}: promptFile.enabled must be a boolean.`
      );
    }
    promptFile.enabled = raw.promptFile.enabled;
  }

  if ('files' in raw.promptFile) {
    if (!isStringArray(raw.promptFile.files)) {
      throw new Error(
        `Invalid config in ${source}: promptFile.files must be an array of strings.`
      );
    }
    promptFile.files = raw.promptFile.files;
  }

  parsed.promptFile = promptFile;
}
```

### Step 3: Create the plugin

**File**: `drone-agent/src/plugins/prompt-file/index.ts`

The plugin should:
- Be `defaultEnabled: false`
- Have no dependencies
- On `onPluginsLoaded` hook: read the configured files, resolve paths, read content, register a prompt fragment
- The path resolution logic:
  - `~/foo.md` → `path.join(os.homedir(), 'foo.md')`
  - `./foo.md` → `path.join(process.cwd(), 'foo.md')`
  - `..?/foo.md` → walk up from CWD, checking each parent for `foo.md`, return first match or null
- If a file doesn't exist, log a warning and skip it
- If multiple files are found, concatenate them with clear separators in the prompt fragment
- Register a single prompt fragment with key `prompt-file-content` and phase `header`

```ts
import { readFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DronePlugin } from 'drone-core';

function resolvePromptFilePath(filePattern: string): string | null {
  if (filePattern.startsWith('~/')) {
    return path.join(os.homedir(), filePattern.slice(2));
  }

  if (filePattern.startsWith('./')) {
    const resolved = path.join(process.cwd(), filePattern.slice(2));
    return resolved; // caller checks existence
  }

  if (filePattern.startsWith('..?/')) {
    const relativePath = filePattern.slice(4);
    let currentDir = path.resolve(process.cwd());
    while (true) {
      const candidate = path.join(currentDir, relativePath);
      try {
        access(candidate, fsConstants.F_OK);
        return candidate;
      } catch {
        const parent = path.dirname(currentDir);
        if (parent === currentDir) return null; // reached root
        currentDir = parent;
      }
    }
  }

  // No prefix — treat as relative to CWD
  return path.resolve(process.cwd(), filePattern);
}

async function readFileContent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export const promptFilePlugin: DronePlugin = {
  metadata: {
    id: 'prompt-file',
    name: 'Prompt File',
    version: '0.1.0',
    description:
      'Reads markdown files from configured paths and injects their content as system prompt fragments. Supports ~/ (home), ./ (CWD), and ..?/ (walk up) path prefixes.',
    defaultEnabled: false,
  },
  register: async (registration) => {
    registration.hooks.onPluginsLoaded(async () => {
      const config = registration.getConfig().promptFile;
      if (!config.enabled) {
        registration.logger.info('prompt-file plugin disabled by config');
        return;
      }

      if (config.files.length === 0) {
        registration.logger.info('prompt-file enabled but no files configured');
        return;
      }

      const contents: string[] = [];
      for (const pattern of config.files) {
        const resolvedPath = resolvePromptFilePath(pattern);
        if (!resolvedPath) {
          registration.logger.warn(
            `prompt-file: could not resolve path pattern "${pattern}"`
          );
          continue;
        }

        const content = await readFileContent(resolvedPath);
        if (content === null) {
          registration.logger.warn(
            `prompt-file: file not found or unreadable: ${resolvedPath} (from pattern "${pattern}")`
          );
          continue;
        }

        registration.logger.info(
          `prompt-file: loaded ${resolvedPath} (${content.length} chars)`
        );
        contents.push(
          `--- ${resolvedPath} ---\n${content}`
        );
      }

      if (contents.length === 0) {
        registration.logger.warn(
          'prompt-file: no files could be loaded from the configured patterns'
        );
        return;
      }

      registration.registerPromptFragment({
        key: 'prompt-file-content',
        phase: 'header',
        render: async () => contents.join('\n\n'),
      });
    });
  },
};
```

### Step 4: Register the plugin

**File**: `drone-agent/src/plugins/index.ts`

Add import:
```ts
import { promptFilePlugin } from './prompt-file/index.js';
```

Add to `staticBuiltInPlugins` array:
```ts
const staticBuiltInPlugins: DronePlugin[] = [
  // ... existing ...
  promptFilePlugin,
];
```

### Step 5: Tests for path resolution

**File**: `drone-agent/test/prompt-file.test.ts`

Test cases:
- `~/` resolves to home directory
- `./` resolves to CWD
- `..?/` walks up from CWD
- `..?/` returns null when not found in any parent
- No prefix treated as relative to CWD
- File not found returns null
- File found returns content

### Step 6: Tests for config parsing

Add to `config.test.ts`:
- `promptFile` with `enabled: true` and `files: ["..?/AGENTS.md"]`
- `promptFile` with invalid `files` type
- `promptFile` with invalid `enabled` type
- Additive merge: user config has `["~/foo.md"]`, project config has `["..?/bar.md"]`, result should be `["~/foo.md", "..?/bar.md"]`

### Step 7: Tests for the plugin

**File**: `drone-agent/test/prompt-file.test.ts` (extend)

Test cases:
- Plugin registers a prompt fragment when files are found
- Plugin skips when disabled
- Plugin warns when files are not found
- Plugin concatenates multiple files
