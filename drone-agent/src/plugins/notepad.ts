import type { DronePlugin, DroneSlashCommandContext } from 'drone-core';

type NotepadState = {
  currentNotepad: string | null;
};

export const notepadPlugin: DronePlugin = {
  metadata: {
    id: 'notepad',
    name: 'Notepad',
    version: '0.1.0',
    description:
      'Maintains a session notepad that is included in the system prompt.',
    defaultEnabled: false,
  },
  register: async registration => {
    const state: NotepadState = {
      currentNotepad: null,
    };

    registration.registerPromptFragment({
      key: 'notepad-current',
      phase: 'header',
      render: async () => {
        if (!state.currentNotepad) {
          return '';
        }
        return `# Your Notepad\n\n${state.currentNotepad}\n\n===\n\nUse notepad__* tools to manage your notepad.`;
      },
    });

    registration.registerTool({
      name: 'notepad__set',
      description: 'Set the contents of the notepad.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string' },
        },
        required: ['content'],
      },

      execute: async input => {
        if (typeof input.content !== 'string') {
          return JSON.stringify({ success: false, error: 'Missing content' });
        }
        const content = input.content.trim();
        state.currentNotepad = content;
        return JSON.stringify({ success: true });
      },
    });

    registration.registerTool({
      name: 'notepad__clear',
      description: 'Clear the contents of the notepad.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      execute: async () => {
        state.currentNotepad = null;
        return JSON.stringify({ success: true });
      },
    });

    registration.registerTool({
      name: 'notepad__append',
      description: 'Append text to the contents of the notepad.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string' },
        },
        required: ['content'],
      },
      execute: async input => {
        if (typeof input.content !== 'string') {
          return JSON.stringify({ success: false, error: 'Missing content' });
        }
        const content = input.content.trim();
        if (!state.currentNotepad) {
          state.currentNotepad = content;
        } else {
          state.currentNotepad += '\n' + content;
        }
        return JSON.stringify({ success: true });
      },
    });
  },
};
