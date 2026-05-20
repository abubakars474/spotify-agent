const { app, BrowserWindow, ipcMain, utilityProcess } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let win;
let chromeProcess = null;
let workerProcess = null;

// Session state
let userDuration = 30;
let userBrowser  = 'chrome';
let authToken    = null;
let userEmail    = null;
let userPassword = null;

const API_BASE = 'https://myspotify.anvs.xyz/api/v1/';

// ============================================================
// Chrome launcher (CDP)
// ============================================================
function getChromePath() {
  const platform = os.platform();
  if (platform === 'win32') {
    for (const p of [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]) if (fs.existsSync(p)) return p;
    throw new Error('Chrome not found on Windows');
  }
  if (platform === 'darwin') {
    const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(p)) return p;
    throw new Error('Chrome not found on macOS');
  }
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'])
    if (fs.existsSync(p)) return p;
  throw new Error('Chrome not found on Linux');
}

function launchChromeWithCDP() {
  if (chromeProcess) return;
  const userDataDir = os.platform() === 'win32'
    ? 'C:\\temp\\spotify-agent-profile'
    : '/tmp/spotify-electron-profile';

  chromeProcess = spawn(getChromePath(), [
    '--remote-debugging-port=9222',
    `--user-data-dir=${userDataDir}`,
    '--new-window',
    '--no-first-run',
    '--no-default-browser-check',
    'https://open.spotify.com'
  ], { detached: true, stdio: 'ignore' });
  chromeProcess.unref();
  console.log('Chrome launched with CDP');
}

function stopChrome() {
  if (chromeProcess) {
    try { chromeProcess.kill(); } catch {}
    chromeProcess = null;
  }
}

// ============================================================
// Window
// ============================================================
function createWindow() {
  win = new BrowserWindow({
    width: 600,
    height: 520,
    resizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  win.loadFile('ui/index.html');
}

// ============================================================
// API login (renderer → main → API)
// ============================================================
ipcMain.handle('login', async (_e, { email, password }) => {
  try {
    const form = new FormData();
    form.append('username', email);
    form.append('password', password);

    const res = await fetch(`${API_BASE}login`, { method: 'POST', body: form });
    const json = await res.json();

    if (res.ok && json?.data?.token) {
      authToken    = json.data.token;
      userEmail    = email;
      userPassword = password;
      console.log('Login OK for', email);
      return { success: true };
    }
    return {
      success: false,
      message: json?.message || `Login failed (HTTP ${res.status})`
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// ============================================================
// Worker management
// ============================================================
function startWorker() {
  if (workerProcess) {
    workerProcess.postMessage({ type: 'start-playback', duration: userDuration });
    return;
  }

  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'worker.js')
    : path.join(__dirname, 'worker.js');

  workerProcess = utilityProcess.fork(workerPath);

  workerProcess.postMessage({
    type: 'config',
    duration: userDuration,
    browser:  userBrowser,
    apiBase:  API_BASE,
    token:    authToken,
    email:    userEmail,
    password: userPassword,
    mode:     'start-now'
  });

  // Forward worker messages → renderer
  workerProcess.on('message', (msg) => {
    if (!win || win.isDestroyed()) return;
    if (msg?.type === 'playlist-update') {
      win.webContents.send('playlist-update', msg.payload);
    } else if (msg?.type === 'playback-state') {
      win.webContents.send('playback-state', msg.payload);
    }
  });

  workerProcess.on('exit', (code) => {
    console.log('Worker exited:', code);
    workerProcess = null;
    if (win && !win.isDestroyed()) {
      win.webContents.send('playback-state', { state: 'finished-all' });
    }
  });
}

function stopWorker() {
  if (workerProcess) {
    try { workerProcess.kill(); } catch {}
    workerProcess = null;
  }
}

function stopSystem() {
  stopWorker();
  stopChrome();
}

// ============================================================
// IPC
// ============================================================
ipcMain.on('open-browser', (_e, browser) => {
  userBrowser = browser || 'chrome';
  if (userBrowser === 'chrome') launchChromeWithCDP();
});

ipcMain.on('start', (_e, data) => {
  userDuration = Number(data.duration || 30);
  if (!authToken) {
    console.log('Start blocked: not logged in');
    return;
  }
  startWorker();
});

ipcMain.on('stop',  () => stopSystem());
ipcMain.on('pause', () => {
  if (workerProcess) {
    workerProcess.postMessage({
      type: 'pause-playback'
    });
  }
});


ipcMain.on('reset', () => {
  stopSystem();
  authToken = userEmail = userPassword = null;
  userDuration = 30;
});



app.whenReady().then(createWindow);
app.on('window-all-closed', () => { stopSystem(); app.quit(); });