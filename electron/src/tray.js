// The tray icon: what is left of Strafe when the window is closed to the tray, and the way
// to quit it for real. Same labels as the Tauri shell (lib.rs build_tray).

const { app, Menu, Tray, nativeImage } = require('electron');
const { iconPath } = require('./env');

/** Held here so it is never garbage-collected (the icon would vanish from the panel). */
let tray = null;

function createTray({ showMain }) {
  const file = iconPath(['32x32.png', '128x128.png', '256x256.png', 'icon.png']);
  let image = file ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
  if (!image.isEmpty() && image.getSize().width !== 32) image = image.resize({ width: 32, height: 32, quality: 'best' });
  tray = new Tray(image);
  tray.setToolTip('Strafe');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Strafe', click: () => showMain() },
      { type: 'separator' },
      { label: 'Quit Strafe', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => showMain());
  return tray;
}

module.exports = { createTray };
