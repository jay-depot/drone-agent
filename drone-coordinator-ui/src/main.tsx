import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import App from './App';
import './index.css';

// Front-end extension bundles are same-origin ESM modules that externalize
// react/react-dom; expose the host's React on globalThis so a bundle uses the
// SAME React instance as the app (hooks/context stay valid).
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { ReactDOM: typeof ReactDOM }).ReactDOM = ReactDOM;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
