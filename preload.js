const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  start: () => ipcRenderer.send('start-agent'),
  stop: () => ipcRenderer.send('stop-agent')
});