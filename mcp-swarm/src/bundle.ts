/**
 * The reference front-end bundle shipped by `mcp-swarm`.
 *
 * A tiny status panel that exercises the coordinator UI's front-end plugin
 * system (P2): it registers a component into the `topology-page` region and
 * exposes a route. React is shared via `globalThis.React` (the coordinator UI
 * installs it before loading bundles), so the bundle does not bundle React.
 *
 * The contents are embedded as string constants so the package needs no
 * separate static-asset pipeline; they are uploaded as base64 at startup.
 */

export const STATUS_PANEL_INDEX_JS = `export default {
  regions: {
    'topology-page': function StatusPanel() {
      const React = globalThis.React;
      const [status, setStatus] = React.useState(null);
      React.useEffect(function () {
        fetch('/api/extensions')
          .then(function (r) { return r.json(); })
          .then(function (rows) {
            const self = rows.find(function (e) { return e.nodeId === 'mcp-swarm'; });
            setStatus(self || null);
          })
          .catch(function () { setStatus(null); });
      }, []);
      if (!status) return React.createElement('div', { style: { padding: 8, opacity: 0.7 } }, 'mcp-swarm: offline');
      return React.createElement(
        'div',
        { style: { padding: 8 } },
        'mcp-swarm \u00b7 ' + (status.connected ? 'connected' : 'disconnected') +
          ' \u00b7 ' + status.capabilities.length + ' capability(ies)'
      );
    },
  },
  onReady: function (api) {
    api.registerRoute({
      path: '/mcp-swarm',
      title: 'mcp-swarm',
      component: function McpSwarmPage() {
        const React = globalThis.React;
        return React.createElement('div', { style: { padding: 16 } }, 'mcp-swarm status page');
      },
    });
  },
};
`;

export const STATUS_PANEL_STYLE_CSS = `.mcp-swarm-panel {
  font-family: system-ui, sans-serif;
  font-size: 13px;
}
`;

export interface BundleFileDefinition {
  name: string;
  contentBase64: string;
  contentType: string;
}

/** The bundle file list ready for `node.uploadBundle`. */
export function buildStatusPanelFiles(): BundleFileDefinition[] {
  return [
    {
      name: 'index.js',
      contentBase64: Buffer.from(STATUS_PANEL_INDEX_JS, 'utf8').toString('base64'),
      contentType: 'application/javascript',
    },
    {
      name: 'style.css',
      contentBase64: Buffer.from(STATUS_PANEL_STYLE_CSS, 'utf8').toString('base64'),
      contentType: 'text/css',
    },
  ];
}

export const STATUS_PANEL_BUNDLE = {
  name: 'status-panel',
  version: '0.1.0',
};
