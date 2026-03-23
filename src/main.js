const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');
const Store = require('electron-store');

const store = new Store({
  defaults: {
    clickInterval: 100,
    clickButton: 'left',
    clickType: 'single',
    clickCount: 0,
    hotkey: 'F6',
    clickPosition: 'current',
    fixedX: 0,
    fixedY: 0,
  },
});

let mainWindow = null;
let clickerRunning = false;
let clickTimer = null;
let clicksDone = 0;
let nutMouse = null;
let nutButton = null;

async function loadNut() {
  const nut = require('@nut-tree-fork/nut-js');
  nutMouse = nut.mouse;
  nutButton = nut.Button;
  nut.mouse.config.autoDelayMs = 0;
  nut.mouse.config.mouseSpeed = 0;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 620,
    resizable: false,
    autoHideMenuBar: true,
    title: 'Desktop Clicker',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function getMouseButton(buttonName) {
  switch (buttonName) {
    case 'right':
      return nutButton.RIGHT;
    case 'middle':
      return nutButton.MIDDLE;
    default:
      return nutButton.LEFT;
  }
}

async function performClick() {
  if (!clickerRunning) return;

  const settings = store.store;
  const button = getMouseButton(settings.clickButton);

  try {
    if (settings.clickPosition === 'fixed') {
      const point = { x: settings.fixedX, y: settings.fixedY };
      await nutMouse.setPosition(point);
    }

    if (settings.clickType === 'double') {
      await nutMouse.doubleClick(button);
    } else {
      await nutMouse.click(button);
    }

    clicksDone++;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('click-count-update', clicksDone);
    }

    if (settings.clickCount > 0 && clicksDone >= settings.clickCount) {
      stopClicking();
      return;
    }
  } catch (err) {
    console.error('Click error:', err);
  }
}

function startClicking() {
  if (clickerRunning) return;

  const settings = store.store;
  clickerRunning = true;
  clicksDone = 0;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clicker-status', true);
    mainWindow.webContents.send('click-count-update', 0);
  }

  const interval = Math.max(1, settings.clickInterval);

  clickTimer = setInterval(() => {
    performClick();
  }, interval);
}

function stopClicking() {
  if (!clickerRunning) return;

  clickerRunning = false;
  if (clickTimer) {
    clearInterval(clickTimer);
    clickTimer = null;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clicker-status', false);
  }
}

function toggleClicking() {
  if (clickerRunning) {
    stopClicking();
  } else {
    startClicking();
  }
}

function registerHotkey(key) {
  globalShortcut.unregisterAll();
  try {
    globalShortcut.register(key, () => {
      toggleClicking();
    });
  } catch (err) {
    console.error('Failed to register hotkey:', err);
  }
}

// IPC handlers
ipcMain.handle('get-settings', () => {
  return store.store;
});

ipcMain.handle('save-settings', (_event, settings) => {
  for (const [key, value] of Object.entries(settings)) {
    store.set(key, value);
  }
  if (settings.hotkey) {
    registerHotkey(settings.hotkey);
  }
  return true;
});

ipcMain.handle('toggle-clicking', () => {
  toggleClicking();
  return clickerRunning;
});

ipcMain.handle('stop-clicking', () => {
  stopClicking();
  return false;
});

ipcMain.handle('get-status', () => {
  return { running: clickerRunning, clicks: clicksDone };
});

ipcMain.handle('get-mouse-position', () => {
  const pos = screen.getCursorScreenPoint();
  return { x: pos.x, y: pos.y };
});

ipcMain.handle('pick-position', () => {
  // Return current cursor position for the "pick" feature
  const pos = screen.getCursorScreenPoint();
  return { x: pos.x, y: pos.y };
});

app.whenReady().then(async () => {
  await loadNut();
  createWindow();
  registerHotkey(store.get('hotkey'));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('will-quit', () => {
  stopClicking();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
