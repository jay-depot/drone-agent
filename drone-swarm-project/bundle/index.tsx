import type { PluginClientExport } from 'drone-extension-ui-types';
import { setApi } from './api';
import { BoardPage } from './BoardPage';
import { BoardSettings } from './BoardSettings';

const client: PluginClientExport = {
  routes: [{ path: '/board', title: 'Board', component: BoardPage }],
  regions: { 'settings-panel': BoardSettings },
  onReady(api) {
    setApi(api);
  },
};

export default client;
