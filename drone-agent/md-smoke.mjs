import React from 'react';
import { render } from 'ink';
import { Markdown } from './dist/tui/components/Markdown.js';

// Long unbroken STRING literal (green) must hard-split mid-span.
// Also a long unbroken comment (italic-only).
const code = [
  'const s = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";',
  '// BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
].join('\n');
const md = '```ts\n' + code + '\n```';

render(React.createElement(Markdown, null, md));
setTimeout(() => process.exit(0), 2500);
