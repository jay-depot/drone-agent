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
        return `# Session Notepad\n\n===\n\n${state.currentNotepad}\n\n===\n\nUse the \`notepad__*\` tools to maintain a "working memory" for the current session. This is ideal for tracking complex constraints, temporary variables, or specific notes that should remain visible above the conversational noise. Refer to this notepad to maintain continuity during complex multi-step tasks.`;
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
