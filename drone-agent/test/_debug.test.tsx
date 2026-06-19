import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { useState } from 'react';
import { Text, Box, useInput } from 'ink';

describe('debug', () => {
  it('useInput receives enter (\\r)', async () => {
    function App() {
      const [text, setText] = useState('');
      useInput((input, key) => {
        if (key.return) {
          setText('enter');
        } else if (input) {
          setText(t => t + input);
        }
      });
      return (
        <Box>
          <Text>{text}</Text>
        </Box>
      );
    }
    const instance = render(<App />);
    await new Promise(r => setTimeout(r, 100));
    instance.stdin.write('a');
    instance.stdin.write('\r');
    await new Promise(r => setTimeout(r, 100));
    console.log('LAST FRAME:', JSON.stringify(instance.lastFrame()));
    expect(instance.lastFrame()).toBe('enter');
  });
});
