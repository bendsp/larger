const { contextBridge, ipcRenderer } = require("electron");

/** @type {import("./bridge").LargerCanvasBridge} */
const bridge = {
  load: (url) => ipcRenderer.invoke("canvas:load", url),
  navigate: (url) => ipcRenderer.invoke("canvas:navigate", url),
  setBounds: (bounds) => ipcRenderer.send("canvas:bounds", bounds),
  show: () => ipcRenderer.send("canvas:show"),
  hide: () => ipcRenderer.send("canvas:hide"),
  onNavigation: (listener) => {
    /** @param {import("electron").IpcRendererEvent} _event @param {string} url */
    const handler = (_event, url) => listener(url);
    ipcRenderer.on("canvas:navigated", handler);
    return () => ipcRenderer.removeListener("canvas:navigated", handler);
  },
};

contextBridge.exposeInMainWorld("largerCanvas", bridge);
