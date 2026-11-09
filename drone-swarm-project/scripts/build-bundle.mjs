import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist/bundle', { recursive: true });
await build({
  entryPoints: ['bundle/index.tsx'],
  outfile: 'dist/bundle/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'transform',
  jsxFactory: 'globalThis.React.createElement',
  jsxFragment: 'globalThis.React.Fragment',
  external: ['react', 'react-dom'],
});
await copyFile('bundle/styles.css', 'dist/bundle/style.css');
console.log('bundle written to dist/bundle/');
