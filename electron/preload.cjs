// preload.cjs — bridge for the MAIN window. Exposes a small, explicit
// `window.arete` API over contextBridge. CommonJS so it loads synchronously.

const { contextBridge, ipcRenderer } = require('electron');

const sub = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('arete', {
  // connection/config
  getDefaults: () => ipcRenderer.invoke('arete:getDefaults'),
  connect: (opts) => ipcRenderer.invoke('arete:connect', opts),
  disconnect: () => ipcRenderer.invoke('arete:disconnect'),
  getStatus: () => ipcRenderer.invoke('arete:getStatus'),
  setAutoConnect: (on) => ipcRenderer.invoke('arete:setAutoConnect', on),
  saveSettings: (patch) => ipcRenderer.invoke('arete:saveSettings', patch),
  openExternal: (url) => ipcRenderer.invoke('arete:openExternal', url),

  // live realm data
  getKeys: () => ipcRenderer.invoke('arete:getKeys'),
  getProfile: (name) => ipcRenderer.invoke('arete:getProfile', name),
  onKeys: sub('arete:keys'),
  onLog: sub('arete:log'),
  onStatus: sub('arete:status'),

  // widgets
  widgetDefs: () => ipcRenderer.invoke('widget:defs'),
  widgetReload: () => ipcRenderer.invoke('widget:reload'),
  libraryInfo: () => ipcRenderer.invoke('widget:libraryInfo'),
  widgetInstances: () => ipcRenderer.invoke('widget:instances'),
  widgetAdd: (spec) => ipcRenderer.invoke('widget:add', spec),
  widgetUpdate: (spec) => ipcRenderer.invoke('widget:update', spec),
  widgetRemove: (id) => ipcRenderer.invoke('widget:remove', id),
  widgetRemoveAll: () => ipcRenderer.invoke('widget:removeAll'),
  widgetOpen: (id) => ipcRenderer.invoke('widget:open', id),
  onWidgetDefs: sub('widget:defs'),
  onWidgetInstances: sub('widget:instances'),
  onWidgetState: sub('widget:state'),

  // composer (Compose tab)
  composeCheck: (draft) => ipcRenderer.invoke('compose:check', draft),
  composeSimulate: (payload) => ipcRenderer.invoke('compose:simulate', payload),
  composeSaveLocal: (payload) => ipcRenderer.invoke('compose:saveLocal', payload),
  composeReadDef: (id) => ipcRenderer.invoke('compose:readDef', id),
  composeFaceplateHtml: () => ipcRenderer.invoke('compose:faceplateHtml'),
  composeProfileIndex: (refresh) => ipcRenderer.invoke('compose:profileIndex', refresh),
  composeGoLive: (spec) => ipcRenderer.invoke('compose:goLive', spec),
  composeLiveAction: (payload) => ipcRenderer.invoke('compose:liveAction', payload),
  composeLiveStop: () => ipcRenderer.invoke('compose:liveStop'),
  onComposeLive: sub('compose:liveState'),
});
