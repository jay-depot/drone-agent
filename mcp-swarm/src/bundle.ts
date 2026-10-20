/**
 * The reference front-end bundle shipped by `mcp-swarm`.
 *
 * Two panels exercise the coordinator UI's front-end plugin system: a
 * `topology-page` status panel and a `settings-panel` token manager. React is
 * shared via `globalThis.React` (the coordinator UI installs it before loading
 * bundles), so the bundle does not bundle React. Coordinator calls go through
 * `api.fetch` (captured in `onReady`), which carries the coordinator web token.
 *
 * The contents are embedded as string constants so the package needs no
 * separate static-asset pipeline; they are uploaded as base64 at startup.
 */

export const BUNDLE_INDEX_JS = `let api;
export default {
  regions: {
    'settings-panel': SettingsPanel,
    'topology-page': StatusPanel,
  },
  onReady: function (next) { api = next; },
};

function callAction(action, params) {
  return api
    .fetch('/api/extensions/mcp-swarm/actions/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: params || {} }),
    })
    .then(function (r) { return r.json(); });
}

function StatusPanel() {
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
    'mcp-swarm \\u00b7 ' + (status.connected ? 'connected' : 'disconnected') +
      ' \\u00b7 ' + status.capabilities.length + ' capability(ies)'
  );
}

function SettingsPanel() {
  const React = globalThis.React;
  const [tokens, setTokens] = React.useState([]);
  const [created, setCreated] = React.useState(null);
  const [name, setName] = React.useState('');

  const load = React.useCallback(function () {
    return callAction('token.list', {}).then(function (b) {
      setTokens((b.body && b.body.tokens) || []);
    });
  }, []);

  React.useEffect(function () { load(); }, [load]);

  function create() {
    const value = name.trim();
    if (!value) return;
    callAction('token.create', { name: value })
      .then(function (b) {
        if (b.body && b.body.token) setCreated(b.body.token);
        setName('');
        return load();
      });
  }

  function revoke(id) {
    callAction('token.revoke', { id: id }).then(load);
  }

  const rowStyle = { padding: '4px 8px', borderBottom: '1px solid #eee' };
  const rows = tokens.map(function (t) {
    return React.createElement(
      'tr',
      { key: t.id },
      React.createElement('td', { style: rowStyle }, t.name),
      React.createElement('td', { style: rowStyle }, new Date(t.createdAt).toLocaleString()),
      React.createElement('td', { style: rowStyle }, t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : 'never'),
      React.createElement(
        'td',
        { style: rowStyle },
        React.createElement('button', { onClick: function () { revoke(t.id); } }, 'Revoke')
      )
    );
  });

  const createBox = created
    ? React.createElement(
        'div',
        { style: { margin: '8px 0', padding: 8, background: '#fffbe6', border: '1px solid #ffe58f' } },
        React.createElement('div', null, 'Copy this token now \\u2014 it will not be shown again:'),
        React.createElement('input', {
          readOnly: true,
          value: created,
          style: { width: '100%', fontFamily: 'monospace' },
          onFocus: function (e) { e.target.select(); },
        })
      )
    : null;

  return React.createElement(
    'div',
    { className: 'mcp-swarm-panel' },
    React.createElement(
      'div',
      { style: { marginBottom: 8 } },
      React.createElement('input', {
        placeholder: 'New token name',
        value: name,
        onChange: function (e) { setName(e.target.value); },
      }),
      React.createElement('button', { onClick: create, style: { marginLeft: 8 } }, 'Create token')
    ),
    createBox,
    React.createElement(
      'table',
      { style: { width: '100%', borderCollapse: 'collapse' } },
      React.createElement(
        'thead',
        null,
        React.createElement(
          'tr',
          null,
          React.createElement('th', { style: { textAlign: 'left' } }, 'Name'),
          React.createElement('th', { style: { textAlign: 'left' } }, 'Created'),
          React.createElement('th', { style: { textAlign: 'left' } }, 'Last used'),
          React.createElement('th', null, '')
        )
      ),
      React.createElement('tbody', null, rows)
    )
  );
}
`;

export const BUNDLE_STYLE_CSS = `.mcp-swarm-panel {
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
export function buildBundleFiles(): BundleFileDefinition[] {
  return [
    {
      name: 'index.js',
      contentBase64: Buffer.from(BUNDLE_INDEX_JS, 'utf8').toString('base64'),
      contentType: 'application/javascript',
    },
    {
      name: 'style.css',
      contentBase64: Buffer.from(BUNDLE_STYLE_CSS, 'utf8').toString('base64'),
      contentType: 'text/css',
    },
  ];
}

export const BUNDLE = {
  name: 'status-panel',
  version: '0.2.0',
};
