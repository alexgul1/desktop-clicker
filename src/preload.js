const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  toggleClicking: () => ipcRenderer.invoke('toggle-clicking'),
  stopClicking: () => ipcRenderer.invoke('stop-clicking'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  getMousePosition: () => ipcRenderer.invoke('get-mouse-position'),
  pickPosition: () => ipcRenderer.invoke('pick-position'),
  getVersion: () => ipcRenderer.invoke('get-version'),

  onClickerStatus: (callback) => {
    ipcRenderer.on('clicker-status', (_event, running) => callback(running));
  },
  onClickCountUpdate: (callback) => {
    ipcRenderer.on('click-count-update', (_event, count) => callback(count));
  },
});
