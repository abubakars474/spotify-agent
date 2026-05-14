const { app, BrowserWindow, ipcMain, utilityProcess } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let win;
let chromeProcess = null;
let workerProcess = null;

let userDuration = 30;
let userEmail = null;
let userBrowser = 'chrome';

function getChromePath() {
  const platform = os.platform();
  if (platform === 'win32') {
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const p of paths) if (fs.existsSync(p)) return p;
    throw new Error('Chrome not found on Windows');
  }
  if (platform === 'darwin') {
    const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(p)) return p;
    throw new Error('Chrome not found on macOS');
  }
  if (platform === 'linux') {
    const paths = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
    for (const p of paths) if (fs.existsSync(p)) return p;
    throw new Error('Chrome not found on Linux');
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 600,
    height: 450,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  win.loadFile('ui/index.html');
}

// ============================================================
// CHROME ONLY — launches real Chrome with CDP for the worker to attach to
// ============================================================
function launchChromeWithCDP() {
  if (chromeProcess) return;

  const userDataDir = os.platform() === 'win32'
    ? 'C:\\temp\\spotify-agent-profile'
    : '/tmp/spotify-electron-profile';

  const args = [
    '--remote-debugging-port=9222',
    `--user-data-dir=${userDataDir}`,
    '--new-window',
    '--no-first-run',
    '--no-default-browser-check',
    'https://open.spotify.com'
  ];

  chromeProcess = spawn(getChromePath(), args, { detached: true, stdio: 'ignore' });
  chromeProcess.unref();
  console.log('Chrome launched with CDP');
}

function stopChrome() {
  if (chromeProcess) {
    try { chromeProcess.kill(); } catch (e) {}
    chromeProcess = null;
  }
}

// ============================================================
// WORKER
// ============================================================
function startWorker(mode) {
  if (workerProcess) {
    // Worker already running (Firefox/Safari case where worker launched on Open Browser)
    // Just tell it to start playback
    workerProcess.postMessage({ type: 'start-playback' });
    return;
  }

  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'worker.js')
    : path.join(__dirname, 'worker.js');

  workerProcess = utilityProcess.fork(workerPath);

  workerProcess.postMessage({
    type: 'config',
    duration: userDuration,
    email: userEmail,
    browser: userBrowser,
    mode: mode  // 'open-only' or 'start-now'
  });

  workerProcess.on('exit', (code) => {
    console.log('Worker exited:', code);
    workerProcess = null;
  });
}

function stopWorker() {
  if (workerProcess) {
    workerProcess.kill();
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

// "Open Browser" button
ipcMain.on('open-browser', (event, browser) => {
  userBrowser = browser || 'chrome';
  console.log('Open browser:', userBrowser);

  if (userBrowser === 'chrome') {
    // Chrome: launch the actual browser, worker comes later
    launchChromeWithCDP();
  } else {
    // Firefox / Safari: spawn worker which launches Playwright browser
    // Worker will idle until 'start-playback' arrives
    startWorker('open-only');
  }
});

// "Start" button
ipcMain.on('start', (event, data) => {
  userDuration = Number(data.duration || 30);
  userEmail    = data.email;
  userBrowser  = data.browser || 'chrome';

  if (userBrowser === 'chrome') {
    // Worker not yet spawned — spawn it now to connect to Chrome
    startWorker('start-now');
  } else {
    // Worker already running from "Open Browser" — just send config + start
    if (workerProcess) {
      workerProcess.postMessage({
        type: 'start-playback',
        duration: userDuration,
        email: userEmail
      });
    } else {
      // Fallback if user somehow skipped Open Browser
      startWorker('start-now');
    }
  }
});

ipcMain.on('stop', () => stopSystem());

ipcMain.on('reset', () => {
  stopSystem();
  userDuration = 30;
});

app.whenReady().then(createWindow);