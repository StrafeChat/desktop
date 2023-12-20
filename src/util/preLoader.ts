import { ipcRenderer, contextBridge } from 'electron'

contextBridge.exposeInMainWorld('WindowAPI', {
  isElectron: true,
  notificationApi: {
    sendNotification(message: any) {
       ipcRenderer.send('notify', message);
    }
  },
  },
)