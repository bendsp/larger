const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("largerCanvas", {
  load: (url) => ipcRenderer.invoke("canvas:load", url),
  navigate: (url) => ipcRenderer.invoke("canvas:navigate", url),
  setBounds: (bounds) => ipcRenderer.send("canvas:bounds", bounds),
  hide: () => ipcRenderer.send("canvas:hide"),
  onNavigation: (listener) => {
    const handler = (_event, url) => listener(url);
    ipcRenderer.on("canvas:navigated", handler);
    return () => ipcRenderer.removeListener("canvas:navigated", handler);
  },
});

