import type { ConfigData } from "./app";

import {
    app as App,
    BrowserWindow,
    shell,
    ipcMain,
    nativeImage,
    Tray,
    Menu,
    MenuItem,
    Notification,
} from "electron";
import { execFile } from "node:child_process";
import windowStateKeeper from "electron-window-state";
import { RelaunchOptions } from "electron/main";
import { URL } from "node:url";
import path from "node:path";

import { firstRun, getConfig, store, onStart, getBuildURL } from "./lib/Config";
import { connectRPC, dropRPC } from "./lib/DiscordRPC";
import { autoLaunch } from "./lib/AutoLaunch";
import { autoUpdate } from "./lib/Updater";

let forceQuit = false;

const trayIcon = nativeImage.createFromPath(
    path.resolve(
        App.getAppPath(),
        "assets",
        process.platform === "darwin" ? "trayIconTemplate.png" : "icon.png",
    ),
);

const WindowIcon = nativeImage.createFromPath(
    path.resolve(App.getAppPath(), "assets", "icon.png"),
);

trayIcon.setTemplateImage(true);
WindowIcon.setTemplateImage(true);

onStart();
autoUpdate();

type AppInterface = typeof App & {
    shouldRelaunch: boolean;
    shouldQuit: boolean;
};

let mainWindow: BrowserWindow;
let app = App as AppInterface;

function createWindow() {
    const mainWindowState = windowStateKeeper({
        defaultWidth: 1280,
        defaultHeight: 720,
    });

    mainWindow = new BrowserWindow({
        autoHideMenuBar: true,
        title: "StrafeChat",
        icon: WindowIcon,

        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: '#141414',
            symbolColor: 'white',
            height: 24
          },

        webPreferences: {
            preload: path.resolve(App.getAppPath(), "bundle", "app.js"),
            contextIsolation: true,
            nodeIntegration: false,
        },

        x: mainWindowState.x,
        y: mainWindowState.y,
        width: mainWindowState.width,
        height: mainWindowState.height,

        backgroundColor: "#191919",

        minWidth: 300,
        minHeight: 300,
    });

    if (process.platform === "win32") {
        App.setAppUserModelId(mainWindow.title);
    }

    mainWindowState.manage(mainWindow);
    mainWindow.loadURL(getBuildURL());

    mainWindow.on("show", () => buildMenu());
    mainWindow.on("hide", () => buildMenu());

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

    mainWindow.webContents.on("before-input-event", (event, input) => {
        if (input.control && input.key === "=") {
            event.preventDefault();
            mainWindow.webContents.setZoomLevel(
                mainWindow.webContents.getZoomLevel() + 1,
            );
        } else if (input.control && input.key === "-") {
            event.preventDefault();
            mainWindow.webContents.setZoomLevel(
                mainWindow.webContents.getZoomLevel() - 1,
            );
        }
    });

    mainWindow.webContents.on("did-finish-load", () =>
        mainWindow.webContents.send("config", getConfig()),
    );

    mainWindow.webContents.on("context-menu", (_, params) => {
        const menu = new Menu();

        for (const suggestion of params.dictionarySuggestions) {
            menu.append(
                new MenuItem({
                    label: suggestion,
                    click: () =>
                        mainWindow.webContents.replaceMisspelling(suggestion),
                }),
            );
        }

        if (params.misspelledWord) {
            menu.append(
                new MenuItem({
                    label: "Add to dictionary",
                    click: () =>
                        mainWindow.webContents.session.addWordToSpellCheckerDictionary(
                            params.misspelledWord,
                        ),
                }),
            );
        }

        if (menu.items.length > 0) {
            menu.popup();
        }
    });

    ipcMain.on("getAutoStart", () =>
        autoLaunch
            .isEnabled()
            .then((v) => mainWindow.webContents.send("autoStart", v)),
    );

    ipcMain.on("setAutoStart", async (_, value: boolean) => {
        if (value) {
            await autoLaunch.enable();
            mainWindow.webContents.send("autoStart", true);
        } else {
            await autoLaunch.disable();
            mainWindow.webContents.send("autoStart", false);
        }
    });

    ipcMain.on('notify', (_, message: string, url?: string, title?: string, avatar?: string) => {
     const notification = new Notification({
        title: title || "Notifcation",
        body: message, 
        icon: avatar || WindowIcon, 
        closeButtonText: "Close",
        timeoutType: "default",
    });
          
      notification.show();

       notification.on('click', () => {
          if (url) {
            mainWindow.loadURL(url);
          }
        });
      })

    ipcMain.on("set", (_, arg: Partial<ConfigData>) => {
        if (typeof arg.discordRPC !== "undefined") {
            if (arg.discordRPC) {
                connectRPC();
            } else {
                dropRPC();
            }
        }

        store.set("config", {
            ...store.get("config"),
            ...arg,
        });
    });

    ipcMain.on("reload", () => mainWindow.loadURL(getBuildURL()));
    ipcMain.on("relaunch", () => {
        app.shouldRelaunch = true;
        mainWindow.close();
    });

    ipcMain.on("min", () => mainWindow.minimize());
    ipcMain.on("max", () =>
        mainWindow.isMaximized()
            ? mainWindow.unmaximize()
            : mainWindow.maximize(),
    );

    ipcMain.on("close", () => mainWindow.close());

    const tray = new Tray(trayIcon);

    function buildMenu() {
        tray.setContextMenu(
            Menu.buildFromTemplate([
                {
                    label: mainWindow.isVisible()
                        ? "Hide"
                        : "Show",
                    type: "normal",
                    click: function () {
                        if (mainWindow.isVisible()) {
                            mainWindow.hide();
                        } else {
                            mainWindow.show();
                        }
                    },
                },
                {
                    label: "Restart",
                    type: "normal",
                    click: function () {
                        app.shouldRelaunch = true;
                        mainWindow.close();
                    },
                },
                {
                    label: "Quit",
                    type: "normal",
                    click: function () {
                        app.shouldQuit = true;
                        app.quit();
                    },
                },
            ]),
        );
    }

    buildMenu();
    tray.setToolTip("StrafeChat");
    tray.setImage(trayIcon);
}

const acquiredLock = App.requestSingleInstanceLock();

if (!acquiredLock) {
    App.quit();
} else {
    App.on("second-instance", () => {
        if (mainWindow) {
            if (!mainWindow.isVisible()) mainWindow.show();
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    App.whenReady().then(async () => {
        await firstRun();
        createWindow();
        connectRPC();

        App.on("activate", function () {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            } else {
                if (!mainWindow.isVisible()) return mainWindow.show();
                else return mainWindow.focus();
            }
        });
    });
}

app.on("before-quit", () => {
    forceQuit = true;
});

App.on("window-all-closed", function () {
    if (app.shouldRelaunch) {
        const options: RelaunchOptions = {
            args: process.argv.slice(1).concat(["--relaunch"]),
        };

        if (App.isPackaged && process.env.APPIMAGE) {
            execFile(process.env.APPIMAGE, options.args);
        } else {
            App.relaunch(options);
        }

        App.quit();
        return;
    }

    if (process.platform !== "darwin") App.quit();
});


App.on("web-contents-created", (_, contents) => {
    contents.on("will-navigate", (event, navigationUrl) => {
        const parsedUrl = new URL(navigationUrl);

        if (parsedUrl.origin !== getBuildURL()) {
            event.preventDefault();
        }
    });

    contents.setWindowOpenHandler(({ url }) => {
        if (
            url.startsWith("http:") ||
            url.startsWith("https:") ||
            url.startsWith("mailto:")
        ) {
            setImmediate(() => {
                shell.openExternal(url);
            });
        }

        return { action: "deny" };
    });
});
