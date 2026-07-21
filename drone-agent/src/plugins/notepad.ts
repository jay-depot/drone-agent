import type { DronePlugin } from 'drone-core';
import { NotepadBlock } from '../tui/components/NotepadBlock.js';

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
        return (
          `# Your Session Notepad\n\n===\n\n${state.currentNotepad}\n\n===\n\nUse notepad__* ` +
          `tools to manage your notepad. Your notepad persists for the duration of this ` +
          `session. It is useful for keeping track of complex tasks, instructions or other ` +
          `information you want to temporarily elevate above conversational "noise".\n`
        );
      },
    });

    registration.registerTool({
      name: 'manage',
      description:
        'Manage the session notepad. Use action="set" to replace contents, ' +
        'action="append" to add text, action="clear" to empty it. ' +
        'The notepad is included in the system prompt and persists for the session.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['set', 'clear', 'append'],
            description:
              'What to do: set (replace), clear (empty), append (add to end).',
          },
          content: {
            type: 'string',
            description: 'Text content (required for set and append).',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async input => {
        const action = input.action as string;

        if (action === 'clear') {
          state.currentNotepad = null;
          return JSON.stringify({ success: true });
        }

        if (typeof input.content !== 'string') {
          return JSON.stringify({ success: false, error: 'Missing content' });
        }

        const content = input.content.trim();

        if (action === 'set') {
          state.currentNotepad = content;
        } else if (action === 'append') {
          if (!state.currentNotepad) {
            state.currentNotepad = content;
          } else {
            state.currentNotepad += '\n' + content;
          }
        }

        return JSON.stringify({ success: true });
      },
      renderComponent: state => NotepadBlock({ state }),
    });
  },
};
