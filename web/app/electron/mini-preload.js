const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("miniPlayer", {
  onState: (handler) => ipcRenderer.on("mediaverse:mini-state", (_event, state) => handler(state)),
  command: (command) => ipcRenderer.send("mediaverse:mini-command", command && typeof command === "object" ? command : {}),
  close: () => ipcRenderer.send("mediaverse:mini-close"),
  pin: (value) => ipcRenderer.send("mediaverse:mini-pin", value),
  showMain: () => ipcRenderer.send("mediaverse:mini-show-main"),
});
