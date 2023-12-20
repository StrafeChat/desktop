import { Tray, Menu, app } from "electron";
import { getMainWindow } from "../index";

/**
 * @type { Tray }
 */
let tray: Tray | null = null;

const contextMenu = () => {
  return Menu.buildFromTemplate([
    {
      label: 'Show App', click: function () {
        getMainWindow()?.show();
      }
    },
    {
      label: 'Quit', click: function () {
        getMainWindow()?.close();
        getMainWindow()?.destroy();
        app.quit();
      }
    }
  ]);
};

function setTray() {
  tray = new Tray("src/assets/icon.png");
  tray.setToolTip('StrafeChat');
  tray.setContextMenu(contextMenu());
  tray.setIgnoreDoubleClickEvents(true);
  tray.on("click", () => {
    getMainWindow()?.show();
  });
  return tray;
}

export {
  setTray,
  tray as getTray,
};
