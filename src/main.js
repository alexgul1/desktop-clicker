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

// Win32 native objects (lazy-loaded)
let win32 = null;
let win32LoadAttempted = false;
let hotkeyPollTimer = null;
let hotkeyKeyWasDown = false;

// ── nut-js loader ──────────────────────────────────────────────
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

// ── Win32 native API loader (koffi) ───────────────────────────
function loadWin32() {
  if (process.platform !== 'win32') return;
  if (win32LoadAttempted) return;
  win32LoadAttempted = true;

  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');

    // Constants
    const INPUT_MOUSE = 0;
    const MOUSEEVENTF_LEFTDOWN = 0x0002;
    const MOUSEEVENTF_LEFTUP = 0x0004;
    const MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const MOUSEEVENTF_RIGHTUP = 0x0010;
    const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const MOUSEEVENTF_MIDDLEUP = 0x0040;

    // Structs for SendInput
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
      padding: koffi.array('uint8', 4),
      mi: MOUSEINPUT,
    });

    // Win32 functions
    const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)');
    const SetCursorPos = user32.func('int __stdcall SetCursorPos(int X, int Y)');
    const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)');

    // Legacy mouse_event function
    const mouse_event = user32.func('void __stdcall mouse_event(uint32 dwFlags, uint32 dx, uint32 dy, uint32 dwData, uintptr_t dwExtraInfo)');

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

    win32 = {
      GetAsyncKeyState,
      SetCursorPos,

      // SendInput-based click
      sendInputClick(dwFlags) {
        const input = {
          type: INPUT_MOUSE,
          padding: [0, 0, 0, 0],
          mi: { dx: 0, dy: 0, mouseData: 0, dwFlags, time: 0, dwExtraInfo: 0 },
        };
        SendInput(1, [input], inputSize);
      },

      // Legacy mouse_event-based click
      mouseEventClick(dwFlags) {
        mouse_event(dwFlags, 0, 0, 0, 0);
      },

      getButtonFlags,
    };

    console.log('Win32 native API loaded successfully');
  } catch (err) {
    console.error('Failed to load Win32 API:', err.message);
    win32 = null;
  }
}

// ── VK code mapping for GetAsyncKeyState ──────────────────────
function hotkeyToVkCode(hotkey) {
  const VK_MAP = {
    'F1': 0x70, 'F2': 0x71, 'F3': 0x72, 'F4': 0x73,
    'F5': 0x74, 'F6': 0x75, 'F7': 0x76, 'F8': 0x77,
    'F9': 0x78, 'F10': 0x79, 'F11': 0x7A, 'F12': 0x7B,
    'Space': 0x20, 'Return': 0x0D, 'Escape': 0x1B,
    'Backspace': 0x08, 'Delete': 0x2E, 'Tab': 0x09,
    'Home': 0x24, 'End': 0x23, 'PageUp': 0x21, 'PageDown': 0x22,
    'Up': 0x26, 'Down': 0x28, 'Left': 0x25, 'Right': 0x27,
    'Insert': 0x2D,
  };

  // Single key like "F6"
  if (VK_MAP[hotkey]) return { vk: VK_MAP[hotkey], modifiers: [] };

  // Combo like "CommandOrControl+Shift+F6"
  const parts = hotkey.split('+');
  const mainKey = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  let vk = VK_MAP[mainKey];
  if (!vk && mainKey.length === 1) {
    // A-Z or 0-9
    vk = mainKey.toUpperCase().charCodeAt(0);
  }

  const modVks = [];
  for (const mod of modifiers) {
    if (mod === 'CommandOrControl' || mod === 'Control') modVks.push(0x11); // VK_CONTROL
    if (mod === 'Alt') modVks.push(0x12); // VK_MENU
    if (mod === 'Shift') modVks.push(0x10); // VK_SHIFT
  }

  return vk ? { vk, modifiers: modVks } : null;
}

function isKeyDown(vkCode) {
  if (!win32) return false;
  // GetAsyncKeyState returns short; bit 15 (0x8000) = currently pressed
  const state = win32.GetAsyncKeyState(vkCode);
  return (state & 0x8000) !== 0;
}

// ── Hotkey polling (works in fullscreen games) ────────────────
function startHotkeyPolling() {
  stopHotkeyPolling();

  const hotkey = store.get('hotkey') || 'F6';
  const parsed = hotkeyToVkCode(hotkey);
  if (!parsed) {
    console.error('Cannot parse hotkey for polling:', hotkey);
    return;
  }

  hotkeyKeyWasDown = false;

  hotkeyPollTimer = setInterval(() => {
    // Check all modifier keys
    const modsOk = parsed.modifiers.every((vk) => isKeyDown(vk));
    const mainDown = isKeyDown(parsed.vk);
    const keyDown = modsOk && mainDown;

    // Detect key-down edge (was up, now down)
    if (keyDown && !hotkeyKeyWasDown) {
      toggleClicking();
    }
    hotkeyKeyWasDown = keyDown;
  }, 30); // 30ms poll = responsive enough

  console.log(`Hotkey polling started for "${hotkey}" (VK=0x${parsed.vk.toString(16)})`);
}

function stopHotkeyPolling() {
  if (hotkeyPollTimer) {
    clearInterval(hotkeyPollTimer);
    hotkeyPollTimer = null;
  }
}

// ── Tray & Window ─────────────────────────────────────────────
function createTray() {
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

// ── Click methods ─────────────────────────────────────────────
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

// Method 1: nut-js (standard, cross-platform)
async function performClickStandard(settings) {
  if (!nutMouse) return;
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

// Method 2: Win32 SendInput (hardware-level)
async function performClickSendInput(settings) {
  if (!win32) return;
  const flags = win32.getButtonFlags(settings.clickButton);

  if (settings.clickPosition === 'fixed') {
    win32.SetCursorPos(settings.fixedX, settings.fixedY);
  }

  if (settings.clickType === 'double') {
    win32.sendInputClick(flags.down);
    win32.sendInputClick(flags.up);
    await delay(30);
    win32.sendInputClick(flags.down);
    win32.sendInputClick(flags.up);
  } else {
    win32.sendInputClick(flags.down);
    win32.sendInputClick(flags.up);
  }
}

// Method 3: Win32 mouse_event (legacy API — some games only respond to this)
async function performClickMouseEvent(settings) {
  if (!win32) return;
  const flags = win32.getButtonFlags(settings.clickButton);

  if (settings.clickPosition === 'fixed') {
    win32.SetCursorPos(settings.fixedX, settings.fixedY);
  }

  if (settings.clickType === 'double') {
    win32.mouseEventClick(flags.down);
    win32.mouseEventClick(flags.up);
    await delay(30);
    win32.mouseEventClick(flags.down);
    win32.mouseEventClick(flags.up);
  } else {
    win32.mouseEventClick(flags.down);
    win32.mouseEventClick(flags.up);
  }
}

async function performClick() {
  if (!clickerRunning) return;

  const settings = store.store;

  try {
    // Lazy-load Win32 on first use of non-standard methods
    if (settings.clickMethod !== 'standard' && !win32 && !win32LoadAttempted) {
      loadWin32();
    }

    switch (settings.clickMethod) {
      case 'sendinput':
        await performClickSendInput(settings);
        break;
      case 'mouse_event':
        await performClickMouseEvent(settings);
        break;
      default:
        await performClickStandard(settings);
        break;
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

// ── Start / Stop / Toggle ─────────────────────────────────────
async function startClicking() {
  if (clickerRunning) return;

  const settings = store.store;
  clickerRunning = true;
  clicksDone = 0;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clicker-status', true);
    mainWindow.webContents.send('click-count-update', 0);
    mainWindow.hide();
  }

  if (tray) {
    tray.setToolTip('Desktop Clicker - RUNNING');
  }

  await delay(300);

  if (!clickerRunning) return;

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

// ── Hotkey registration ───────────────────────────────────────
function registerHotkey(key) {
  // On Windows: use GetAsyncKeyState polling (works in fullscreen games)
  if (process.platform === 'win32') {
    // Make sure Win32 is loaded for hotkey polling
    if (!win32 && !win32LoadAttempted) {
      loadWin32();
    }
    if (win32) {
      startHotkeyPolling();
      return;
    }
    // Fallback to globalShortcut if koffi failed
    console.warn('Win32 not available, falling back to globalShortcut for hotkey');
  }

  // Non-Windows or fallback: use Electron globalShortcut
  globalShortcut.unregisterAll();
  try {
    globalShortcut.register(key, () => {
      toggleClicking();
    });
  } catch (err) {
    console.error('Failed to register hotkey:', err);
  }
}

// ── IPC handlers ──────────────────────────────────────────────
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
  const pos = screen.getCursorScreenPoint();
  return { x: pos.x, y: pos.y };
});

// ── App lifecycle ─────────────────────────────────────────────
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
  stopHotkeyPolling();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
