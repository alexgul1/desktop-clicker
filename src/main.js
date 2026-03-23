const { app, BrowserWindow, ipcMain, globalShortcut, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { version } = require('../package.json');

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
    clickMethod: 'standard',
  },
});

let mainWindow = null;
let tray = null;
let clickerRunning = false;
let clickTimer = null;
let clicksDone = 0;
let nutMouse = null;
let nutButton = null;
let win32Click = null;

async function loadNut() {
  try {
    const nut = require('@nut-tree-fork/nut-js');
    nutMouse = nut.mouse;
    nutButton = nut.Button;
    nut.mouse.config.autoDelayMs = 0;
    nut.mouse.config.mouseSpeed = 0;
    console.log('nut-js loaded successfully');
  } catch (err) {
    console.error('Failed to load nut-js:', err.message);
    nutMouse = null;
    nutButton = null;
  }
}

let win32LoadAttempted = false;

function loadWin32() {
  if (process.platform !== 'win32') return;
  if (win32LoadAttempted) return;
  win32LoadAttempted = true;

  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');

    // Win32 constants
    const INPUT_MOUSE = 0;
    const MOUSEEVENTF_LEFTDOWN = 0x0002;
    const MOUSEEVENTF_LEFTUP = 0x0004;
    const MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const MOUSEEVENTF_RIGHTUP = 0x0010;
    const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const MOUSEEVENTF_MIDDLEUP = 0x0040;

    // Define structs matching Win32 INPUT on x64
    const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
      dx: 'long',
      dy: 'long',
      mouseData: 'uint32',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr_t',
    });

    const INPUT_struct = koffi.struct('INPUT', {
      type: 'uint32',
      padding: koffi.array('uint8', 4), // alignment padding on x64
      mi: MOUSEINPUT,
    });

    // Load functions
    const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)');
    const SetCursorPos = user32.func('int __stdcall SetCursorPos(int X, int Y)');

    const inputSize = koffi.sizeof(INPUT_struct);

    function getButtonFlags(buttonName) {
      switch (buttonName) {
        case 'right':
          return { down: MOUSEEVENTF_RIGHTDOWN, up: MOUSEEVENTF_RIGHTUP };
        case 'middle':
          return { down: MOUSEEVENTF_MIDDLEDOWN, up: MOUSEEVENTF_MIDDLEUP };
        default:
          return { down: MOUSEEVENTF_LEFTDOWN, up: MOUSEEVENTF_LEFTUP };
      }
    }

    function sendMouseEvent(dwFlags) {
      const input = {
        type: INPUT_MOUSE,
        padding: [0, 0, 0, 0],
        mi: { dx: 0, dy: 0, mouseData: 0, dwFlags, time: 0, dwExtraInfo: 0 },
      };
      SendInput(1, [input], inputSize);
    }

    win32Click = {
      async click(buttonName, clickType, positionMode, fixedX, fixedY) {
        if (positionMode === 'fixed') {
          SetCursorPos(fixedX, fixedY);
        }

        const flags = getButtonFlags(buttonName);

        if (clickType === 'double') {
          sendMouseEvent(flags.down);
          sendMouseEvent(flags.up);
          await delay(30);
          sendMouseEvent(flags.down);
          sendMouseEvent(flags.up);
        } else {
          sendMouseEvent(flags.down);
          sendMouseEvent(flags.up);
        }
      },
    };

    console.log('Win32 hardware click method loaded successfully');
  } catch (err) {
    console.error('Failed to load Win32 click method:', err.message);
    win32Click = null;
  }
}

function createTray() {
  // Create a simple 16x16 icon programmatically
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAbwAAAG8B8aLcQwAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAABhSURBVDiNY2AYBQwMDAz/GRgY/pMizsLAwMBACwMYGBgY2BkYGP6TYgALAwMDIzUMYGFgYGCkhgEsxGqmxAAWYjVTYgBMM8UGMDIwMDBRwwUsxGqmxACqs4FRMIoJAACMYhIRoHLfIQAAAABJRU5ErkJggg=='
  );

  tray = new Tray(icon);
  tray.setToolTip('Desktop Clicker');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Window',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'Start/Stop',
      click: () => toggleClicking(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        stopClicking();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 620,
    resizable: false,
    autoHideMenuBar: true,
    title: 'Desktop Clicker',
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function performClickStandard(settings) {
  const button = getMouseButton(settings.clickButton);

  if (settings.clickPosition === 'fixed') {
    await nutMouse.setPosition({ x: settings.fixedX, y: settings.fixedY });
  }

  if (settings.clickType === 'double') {
    await nutMouse.pressButton(button);
    await delay(10);
    await nutMouse.releaseButton(button);
    await delay(30);
    await nutMouse.pressButton(button);
    await delay(10);
    await nutMouse.releaseButton(button);
  } else {
    await nutMouse.pressButton(button);
    await delay(10);
    await nutMouse.releaseButton(button);
  }
}

async function performClickHardware(settings) {
  // Lazy-load Win32 on first use
  if (!win32Click && !win32LoadAttempted) {
    loadWin32();
  }
  if (!win32Click) {
    // Fallback to standard if hardware not available
    await performClickStandard(settings);
    return;
  }
  await win32Click.click(
    settings.clickButton,
    settings.clickType,
    settings.clickPosition,
    settings.fixedX,
    settings.fixedY,
  );
}

async function performClick() {
  if (!clickerRunning) return;

  const settings = store.store;

  try {
    if (settings.clickMethod === 'hardware') {
      await performClickHardware(settings);
    } else {
      await performClickStandard(settings);
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

async function startClicking() {
  if (clickerRunning) return;

  const settings = store.store;
  clickerRunning = true;
  clicksDone = 0;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clicker-status', true);
    mainWindow.webContents.send('click-count-update', 0);
    // Hide window so it doesn't intercept clicks
    mainWindow.hide();
  }

  if (tray) {
    tray.setToolTip('Desktop Clicker - RUNNING');
  }

  // Wait for the target app/browser to receive focus after our window hides
  await delay(300);

  if (!clickerRunning) return; // User may have cancelled during the delay

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

  if (tray) {
    tray.setToolTip('Desktop Clicker');
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clicker-status', false);
    // Restore window when stopped
    mainWindow.show();
    mainWindow.focus();
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

ipcMain.handle('get-version', () => {
  return version;
});

ipcMain.handle('pick-position', () => {
  // Return current cursor position for the "pick" feature
  const pos = screen.getCursorScreenPoint();
  return { x: pos.x, y: pos.y };
});

app.isQuitting = false;

app.whenReady().then(async () => {
  await loadNut();
  createTray();
  createWindow();
  registerHotkey(store.get('hotkey'));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
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
