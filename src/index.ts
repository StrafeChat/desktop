import { app as App, BrowserWindow, ipcMain, Notification } from 'electron';
import windowStateKeeper from "electron-window-state";
import { getConfig } from "./util/config";
import { connectRPC, dropRPC } from "./util/DiscordPresence";
import { setTray, getTray } from "./util/Tray";
import path from "node:path";

let mainWindow: BrowserWindow;
let forceQuit = false;
let app = App as AppInterface;

type AppInterface = typeof App & {
    shouldRelaunch: boolean;
    shouldQuit: boolean;
};

function createWindow() {

    setTray();

    const initialConfig = getConfig();

    const mainWindowState = windowStateKeeper({
        defaultWidth: 1280,
        defaultHeight: 720,
    });

  mainWindow = new BrowserWindow({
    autoHideMenuBar: true,
    title: "StrafeChat",
    icon: "src/assets/icon.png",
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    frame: false,
    backgroundColor: "#141414",

    
    webPreferences: {
        preload: path.join(__dirname, "util", 'preLoader.ts'),
    },

    minWidth: 300,
    minHeight: 300,
  });

  mainWindow.loadURL('https://web.strafe.chat');
  connectRPC();

  mainWindow.on("close", (event) => {
    if (
        !forceQuit &&
        !app.shouldQuit &&
        !app.shouldRelaunch &&
        getConfig().minimiseToTray
    ) {
        event.preventDefault();
        mainWindow.hide();
    }
});

  mainWindow.webContents.on("did-finish-load", () =>
  mainWindow.webContents.send("config", getConfig()),
  );

}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
                dropRPC();
});

app.on('activate', ()  => {
        if (mainWindow === null) createWindow();
});

ipcMain.on('notify', (_, message) => {
    new Notification({ title: "Notifcation", body: message}).show();
})

export const getMainWindow = (): BrowserWindow | null => mainWindow;