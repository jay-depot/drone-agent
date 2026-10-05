import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixClient } from 'matrix-js-sdk';
import { MatrixServiceAdapter } from '../src/adapters/matrix.js';

/**
 * These tests load the real matrix-js-sdk (no module mock). The mocked suite
 * in matrix-adapter.test.ts asserts only that `initRustCrypto` is invoked; it
 * cannot observe what the real call does. On Node, a real `initRustCrypto()`
 * on the SDK's default IndexedDB store panics inside the WASM module and
 * aborts the process (exit code 1) — an abort no `try`/`catch` can intercept.
 * This suite reproduces the deployment conditions that the mock hid.
 */
describe('MatrixServiceAdapter against the real matrix-js-sdk', () => {
  let adapter: MatrixServiceAdapter | undefined;

  afterEach(async () => {
    await adapter?.stop();
    adapter = undefined;
    vi.restoreAllMocks();
  });

  it('starts without aborting and never initializes crypto when encryption is unset', async () => {
    const spy = vi.spyOn(MatrixClient.prototype, 'initRustCrypto');
    adapter = new MatrixServiceAdapter('matrix-real-1', {
      homeserverUrl: 'https://example.invalid',
      accessToken: 'test-token',
      userId: '@bot:example.invalid',
      deviceId: 'DRONEGW',
    });

    await expect(adapter.start()).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  }, 30000);

  it('starts without aborting and never initializes crypto when encryption is false', async () => {
    const spy = vi.spyOn(MatrixClient.prototype, 'initRustCrypto');
    adapter = new MatrixServiceAdapter('matrix-real-2', {
      homeserverUrl: 'https://example.invalid',
      accessToken: 'test-token',
      userId: '@bot:example.invalid',
      deviceId: 'DRONEGW',
      encryption: false,
    });

    await expect(adapter.start()).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  }, 30000);

  it('initializes crypto on the in-memory store when encryption is true', async () => {
    const spy = vi.spyOn(MatrixClient.prototype, 'initRustCrypto');
    adapter = new MatrixServiceAdapter('matrix-real-3', {
      homeserverUrl: 'https://example.invalid',
      accessToken: 'test-token',
      userId: '@bot:example.invalid',
      deviceId: 'DRONEGW',
      encryption: true,
    });

    await expect(adapter.start()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith({ useIndexedDB: false });
  }, 30000);
});
