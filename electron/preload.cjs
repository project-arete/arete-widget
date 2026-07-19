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
  widgetInstances: () => ipcRenderer.invoke('widget:instances'),
  widgetAdd: (spec) => ipcRenderer.invoke('widget:add', spec),
  widgetRemove: (id) => ipcRenderer.invoke('widget:remove', id),
  widgetOpen: (id) => ipcRenderer.invoke('widget:open', id),
  onWidgetDefs: sub('widget:defs'),
  onWidgetInstances: sub('widget:instances'),
  onWidgetState: sub('widget:state'),
});
