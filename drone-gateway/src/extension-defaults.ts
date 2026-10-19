/**
 * Defaults for the gateway's swarm extension node. The extension is enabled by
 * `coordinatorUrl` presence alone; these values fill the absent `swarmExtension`
 * block.
 */
export const DEFAULT_GATEWAY_EXTENSION_ID = 'drone-gateway';
export const DEFAULT_GATEWAY_EXTENSION_NAME = 'Drone Gateway';
export const DEFAULT_EXTENSION_DATA_DIR_NAME = 'extension';
export const DEFAULT_EXTENSION_REQUEST_TIMEOUT_MS = 15_000;
