const { app, BrowserWindow, ipcMain, utilityProcess } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

const fs = require('fs');
const os = require('os');

let win;
let chromeProcess = null;
let workerProcess = null;

function getChromePath() {
  const platform = os.platform();

  if (platform === 'win32') {
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ];

    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }

    throw new Error('Chrome not found on Windows');
  }

  if (platform === 'darwin') {
    const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(macPath)) return macPath;

    throw new Error('Chrome not found on macOS');
  }

  throw new Error('Unsupported OS');
}

function createWindow() {
  win = new BrowserWindow({
    width: 400,
    height: 260,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadFile('ui/index.html');
}

//
// START SYSTEM
//
async function startSystem() {
  console.log('START clicked');
  launchChrome();
  waitForChromeAndStartWorker();
}

//
// SAFE WORKER START
//
function waitForChromeAndStartWorker() {
  let attempts = 0;

  const interval = setInterval(() => {
    attempts++;

    if (attempts > 15) {
      clearInterval(interval);
      console.log('Chrome CDP not ready');
      return;
    }

    if (!workerProcess) {
      startWorker();
      clearInterval(interval);
    }
  }, 1000);
}

//
// STOP SYSTEM
//
function stopSystem() {
  console.log('STOP clicked');
  stopWorker();
  stopChrome();
}

//
// CHROME (CDP MODE)
//
function launchChrome() {
  if (chromeProcess) return;

  const chromePath = getChromePath();

  const userDataDir =
    os.platform() === 'win32'
      ? 'C:\\temp\\spotify-agent-profile'
      : '/tmp/spotify-electron-profile';

  chromeProcess = spawn(chromePath, [
    '--remote-debugging-port=9222',
    `--user-data-dir=${userDataDir}`,
    '--new-window',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank' // IMPORTANT: avoid auto page race issues
  ], {
    detached: true,
    stdio: 'ignore'
  });

  chromeProcess.unref();

  console.log('Chrome launched with CDP:', chromePath);
}

function stopChrome() {
  if (chromeProcess) {
    try { chromeProcess.kill(); } catch (e) {}
    chromeProcess = null;
  }
}

//
// WORKER
//
function startWorker() {
  if (workerProcess) return;

  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'worker.js')
    : path.join(__dirname, 'worker.js');

  console.log('Worker path:', workerPath);

  workerProcess = utilityProcess.fork(workerPath);

  workerProcess.on('exit', (code) => {
    console.log('Worker stopped:', code);
    workerProcess = null;
  });

  console.log('Worker started');
}

function stopWorker() {
  if (workerProcess) {
    workerProcess.kill();
    workerProcess = null;
  }
}

//
// IPC
//
ipcMain.on('start', () => startSystem());
ipcMain.on('stop',  () => stopSystem());

app.whenReady().then(createWindow);