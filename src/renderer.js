// DOM elements
const statusBadge = document.getElementById('statusBadge');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const clickCounter = document.getElementById('clickCounter');
const hotkeyBtn = document.getElementById('hotkeyBtn');
const pickPositionBtn = document.getElementById('pickPositionBtn');

// Interval inputs
const hoursInput = document.getElementById('hours');
const minutesInput = document.getElementById('minutes');
const secondsInput = document.getElementById('seconds');
const millisecondsInput = document.getElementById('milliseconds');

// Option inputs
const clickButtonSelect = document.getElementById('clickButton');
const clickTypeSelect = document.getElementById('clickType');
const clickCountInput = document.getElementById('clickCount');
const fixedXInput = document.getElementById('fixedX');
const fixedYInput = document.getElementById('fixedY');

// Radio buttons
const repeatRadios = document.querySelectorAll('input[name="repeatMode"]');
const positionRadios = document.querySelectorAll('input[name="positionMode"]');

let isRecordingHotkey = false;
let currentHotkey = 'F6';

// Convert interval to milliseconds
function getIntervalMs() {
  const h = parseInt(hoursInput.value) || 0;
  const m = parseInt(minutesInput.value) || 0;
  const s = parseInt(secondsInput.value) || 0;
  const ms = parseInt(millisecondsInput.value) || 0;
  return h * 3600000 + m * 60000 + s * 1000 + ms;
}

// Set interval inputs from milliseconds
function setIntervalFromMs(totalMs) {
  const h = Math.floor(totalMs / 3600000);
  totalMs %= 3600000;
  const m = Math.floor(totalMs / 60000);
  totalMs %= 60000;
  const s = Math.floor(totalMs / 1000);
  const ms = totalMs % 1000;

  hoursInput.value = h;
  minutesInput.value = m;
  secondsInput.value = s;
  millisecondsInput.value = ms;
}

// Collect all settings from UI
function collectSettings() {
  const repeatMode = document.querySelector('input[name="repeatMode"]:checked').value;
  const positionMode = document.querySelector('input[name="positionMode"]:checked').value;

  return {
    clickInterval: Math.max(1, getIntervalMs()),
    clickButton: clickButtonSelect.value,
    clickType: clickTypeSelect.value,
    clickCount: repeatMode === 'count' ? (parseInt(clickCountInput.value) || 10) : 0,
    clickPosition: positionMode,
    fixedX: parseInt(fixedXInput.value) || 0,
    fixedY: parseInt(fixedYInput.value) || 0,
    hotkey: currentHotkey,
  };
}

// Save settings to main process
async function saveSettings() {
  const settings = collectSettings();
  await window.api.saveSettings(settings);
}

// Update UI based on running state
function setRunningState(running) {
  if (running) {
    statusBadge.textContent = 'Running';
    statusBadge.classList.add('running');
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } else {
    statusBadge.textContent = 'Stopped';
    statusBadge.classList.remove('running');
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

// Map keyboard events to Electron accelerator strings
function keyEventToAccelerator(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  const key = e.key;

  // Function keys
  if (/^F\d{1,2}$/.test(key)) {
    parts.push(key);
    return parts.join('+');
  }

  // Regular keys
  if (key.length === 1 && /[a-zA-Z0-9]/.test(key)) {
    parts.push(key.toUpperCase());
    return parts.join('+');
  }

  // Special keys
  const specialMap = {
    ' ': 'Space',
    'Enter': 'Return',
    'Escape': 'Escape',
    'Backspace': 'Backspace',
    'Delete': 'Delete',
    'Tab': 'Tab',
    'Home': 'Home',
    'End': 'End',
    'PageUp': 'PageUp',
    'PageDown': 'PageDown',
    'ArrowUp': 'Up',
    'ArrowDown': 'Down',
    'ArrowLeft': 'Left',
    'ArrowRight': 'Right',
    'Insert': 'Insert',
  };

  if (specialMap[key]) {
    parts.push(specialMap[key]);
    return parts.join('+');
  }

  // Modifier-only presses — ignore
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
    return null;
  }

  return null;
}

// Event Listeners

startBtn.addEventListener('click', async () => {
  await saveSettings();
  await window.api.toggleClicking();
});

stopBtn.addEventListener('click', async () => {
  await window.api.stopClicking();
});

// Auto-save on any setting change
const settingInputs = [
  hoursInput, minutesInput, secondsInput, millisecondsInput,
  clickButtonSelect, clickTypeSelect, clickCountInput,
  fixedXInput, fixedYInput,
];

settingInputs.forEach((input) => {
  input.addEventListener('change', saveSettings);
});

repeatRadios.forEach((radio) => {
  radio.addEventListener('change', saveSettings);
});

positionRadios.forEach((radio) => {
  radio.addEventListener('change', saveSettings);
});

// Hotkey recording
hotkeyBtn.addEventListener('click', () => {
  if (isRecordingHotkey) return;
  isRecordingHotkey = true;
  hotkeyBtn.textContent = 'Press a key...';
  hotkeyBtn.classList.add('recording');
});

document.addEventListener('keydown', async (e) => {
  if (!isRecordingHotkey) return;
  e.preventDefault();
  e.stopPropagation();

  const accelerator = keyEventToAccelerator(e);
  if (!accelerator) return;

  currentHotkey = accelerator;
  hotkeyBtn.textContent = accelerator;
  hotkeyBtn.classList.remove('recording');
  isRecordingHotkey = false;

  // Update button labels
  startBtn.textContent = `Start (${accelerator})`;
  stopBtn.textContent = `Stop (${accelerator})`;

  await saveSettings();
});

// Pick position
pickPositionBtn.addEventListener('click', async () => {
  // Select the fixed position radio
  document.querySelector('input[name="positionMode"][value="fixed"]').checked = true;

  pickPositionBtn.textContent = 'Move cursor & press Enter...';

  const handler = async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.removeEventListener('keydown', handler, true);
      const pos = await window.api.pickPosition();
      fixedXInput.value = pos.x;
      fixedYInput.value = pos.y;
      pickPositionBtn.textContent = 'Pick';
      await saveSettings();
    } else if (e.key === 'Escape') {
      document.removeEventListener('keydown', handler, true);
      pickPositionBtn.textContent = 'Pick';
    }
  };

  document.addEventListener('keydown', handler, true);
});

// Listen for status updates from main process
window.api.onClickerStatus((running) => {
  setRunningState(running);
});

window.api.onClickCountUpdate((count) => {
  clickCounter.textContent = count.toLocaleString();
});

// Load settings on start
(async () => {
  const settings = await window.api.getSettings();

  setIntervalFromMs(settings.clickInterval);
  clickButtonSelect.value = settings.clickButton;
  clickTypeSelect.value = settings.clickType;

  if (settings.clickCount > 0) {
    document.querySelector('input[name="repeatMode"][value="count"]').checked = true;
    clickCountInput.value = settings.clickCount;
  }

  if (settings.clickPosition === 'fixed') {
    document.querySelector('input[name="positionMode"][value="fixed"]').checked = true;
  }
  fixedXInput.value = settings.fixedX;
  fixedYInput.value = settings.fixedY;

  currentHotkey = settings.hotkey || 'F6';
  hotkeyBtn.textContent = currentHotkey;
  startBtn.textContent = `Start (${currentHotkey})`;
  stopBtn.textContent = `Stop (${currentHotkey})`;

  // Sync status
  const status = await window.api.getStatus();
  setRunningState(status.running);
  clickCounter.textContent = status.clicks.toLocaleString();
})();
