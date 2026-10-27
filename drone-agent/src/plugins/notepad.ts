import {
  DRONE_PORTABLE_CONTEXT_CAPABILITY_ID,
  type DronePlugin,
} from 'drone-core';
import { registerPortableContextContributor } from '../shared/portable-context-contributor.js';
import { NotepadBlock } from '../tui/components/NotepadBlock.js';
import { applyEditToBody } from '../shared/patch-applier/edit-body.js';

/** Recovery hint appended to notepad edit patch failures. */
const NOTEPAD_EDIT_RECOVERY_TIP =
  'Tip: the current notepad is included in the system prompt above; correct the diff against its exact contents and try again.';

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
    dependencies: [
      { id: DRONE_PORTABLE_CONTEXT_CAPABILITY_ID, optional: true },
    ],
  },
  register: async registration => {
    const state: NotepadState = {
      currentNotepad: null,
    };

    registerPortableContextContributor(registration, {
      id: 'notepad',
      export: () => ({ currentNotepad: state.currentNotepad }),
      import: data => {
        const restored = data as { currentNotepad?: string | null };
        state.currentNotepad = restored.currentNotepad ?? null;
      },
    });

    registration.registerPromptFragment({
      key: 'notepad-static',
      phase: 'header',
      render: async () => {
        return `# Session Notepad\n\nUse the \`notepad__*\` tools to maintain compact working memory for the current session. This is useful for temporary constraints, intermediate facts, and open tasks that should remain visible while working through a complex problem.`;
      },
    });

    registration.registerPromptFragment({
      key: 'notepad-current',
      phase: 'footer',
      render: async () => {
        if (!state.currentNotepad) {
          return false;
        }
        return `# Session Notepad\n\n===\n\n${state.currentNotepad}\n\n===`;
      },
    });

    registration.registerTool({
      name: 'manage',
      description:
        'Manage the session notepad. Use action="set" to replace contents, ' +
        'action="append" to add text, action="edit" to apply a unified diff ' +
        'to the current contents, action="clear" to empty it. ' +
        'The notepad is included in the system prompt and persists for the session.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['set', 'clear', 'append', 'edit'],
            description:
              'What to do: set (replace), clear (empty), append (add to end), edit (apply a unified diff).',
          },
          content: {
            type: 'string',
            description: 'Text content (required for set and append).',
          },
          diff: {
            type: 'string',
            description:
              'Unified diff patch applied to the current notepad contents ' +
              '(required for edit). The @@ hunk header is optional; a ' +
              'headerless patch parses as one hunk and must contain -/+ change lines.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async input => {
        const action = input.action as string;

        if (
          action !== 'set' &&
          action !== 'clear' &&
          action !== 'append' &&
          action !== 'edit'
        ) {
          return JSON.stringify({
            success: false,
            error: 'notepad action must be set, clear, append, or edit.',
          });
        }

        if (action === 'clear') {
          state.currentNotepad = null;
          return JSON.stringify({ success: true });
        }

        if (action === 'edit') {
          if (
            typeof input.diff !== 'string' ||
            input.diff.trim().length === 0
          ) {
            return JSON.stringify({
              success: false,
              error: 'notepad edit requires a non-empty diff.',
            });
          }
          if (state.currentNotepad === null) {
            return JSON.stringify({
              success: false,
              error: 'Cannot edit: the notepad is empty.',
            });
          }
          const outcome = applyEditToBody(state.currentNotepad, input.diff, {
            label: 'notepad',
            toolName: 'notepad.manage edit',
            targetNoun: 'notepad',
            recoveryTip: NOTEPAD_EDIT_RECOVERY_TIP,
          });
          if (outcome.status === 'none-applied') {
            return JSON.stringify({ success: false, error: outcome.error });
          }
          state.currentNotepad = outcome.value;
          if (outcome.partialFailureMessage) {
            return JSON.stringify({
              success: false,
              error: outcome.partialFailureMessage,
            });
          }
          return JSON.stringify({
            success: true,
            summary: outcome.summary,
            diff: outcome.diff,
          });
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
