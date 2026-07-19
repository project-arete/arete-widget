// preload-faceplate.cjs — bridge for ONE faceplate window. The instance id is
// passed via additionalArguments (--arete-instance=<id>) so the page can only
// see and act on its own widget.

const { contextBridge, ipcRenderer } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--arete-instance='));
const INSTANCE_ID = arg ? arg.slice('--arete-instance='.length) : '';

contextBridge.exposeInMainWorld('faceplate', {
  instanceId: INSTANCE_ID,
  load: () => ipcRenderer.invoke('widget:faceplate', INSTANCE_ID),
  action: (property, value) =>
    ipcRenderer.invoke('widget:action', { id: INSTANCE_ID, property, value }),
  setPinned: (pinned) => ipcRenderer.invoke('widget:fp-pin', { id: INSTANCE_ID, pinned }),
  adjustHeight: (delta) => ipcRenderer.invoke('widget:fp-adjust-height', { id: INSTANCE_ID, delta }),
  onState: (cb) => {
    const h = (_e, payload) => {
      if (payload && payload.id === INSTANCE_ID) cb(payload);
    };
    ipcRenderer.on('widget:state', h);
    return () => ipcRenderer.removeListener('widget:state', h);
  },
  onTheme: (cb) => {
    const h = (_e, theme) => cb(theme);
    ipcRenderer.on('widget:theme', h);
    return () => ipcRenderer.removeListener('widget:theme', h);
  },
});
