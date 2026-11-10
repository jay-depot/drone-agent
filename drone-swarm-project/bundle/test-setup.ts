import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import * as ReactDOM from 'react-dom';

(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { ReactDOM: typeof ReactDOM }).ReactDOM = ReactDOM;

afterEach(() => cleanup());
