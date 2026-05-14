const { chromium, webkit, firefox } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

let context;
let currentPage = null;
let currentTaskId = null;
let playStartTime = null;
let currentDuration = 30;
let userEmail = null;
let playDurationSeconds = null;
let currentIndex = 0;
let playlists = [];
let userBrowser = 'chrome';

// ============================================================
// BROWSER LAUNCHERS — all use persistent contexts so logins survive
// ============================================================
async function startBrowser() {
  if (userBrowser === 'safari') {
    const webkitProfile = path.join(os.homedir(), '.spotify-agent-webkit-profile');
    context = await webkit.launchPersistentContext(webkitProfile, {
      headless: false,
    });

    let page = context.pages()[0] || await context.newPage();
    await page.goto('https://open.spotify.com', { waitUntil: 'domcontentloaded' });
    console.log('WebKit (Safari engine) launched with persistent profile');
    return;
  }

  

  if (userBrowser === 'firefox') {
    const firefoxProfile = path.join(
      os.homedir(),
      '.spotify-agent-firefox-profile'
    );

    context = await firefox.launchPersistentContext(firefoxProfile, {
      headless: false,
      viewport: null, // IMPORTANT
      args: [],
    });

    const page = context.pages()[0] || await context.newPage();

    await page.goto('https://open.spotify.com', {
      waitUntil: 'domcontentloaded'
    });

    console.log('Firefox stable session ready');

    return;
  }









  // CHROME → connect to the Chrome already spawned by main.js
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  context = browser.contexts()[0];
  console.log('Chrome connected via CDP');
}

function clearFirefoxVersionLocks(profileDir) {
  if (!fs.existsSync(profileDir)) return;
  const files = ['compatibility.ini', 'times.json', 'lock', '.parentlock'];
  for (const f of files) {
    const p = path.join(profileDir, f);
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        console.log('Removed', f, 'from Firefox profile');
      }
    } catch (e) { /* ignore */ }
  }
}

function seedWidevine(targetProfile) {
  const platform = os.platform();
  let sourceDir = null;

  if (platform === 'darwin') {
    sourceDir = path.join(os.homedir(),
      'Library/Application Support/Mozilla/gmp-widevinecdm');
  } else if (platform === 'linux') {
    const ffRoot = path.join(os.homedir(), '.mozilla/firefox');
    if (fs.existsSync(ffRoot)) {
      const profiles = fs.readdirSync(ffRoot)
        .filter(d => d.endsWith('.default') || d.endsWith('.default-release'));
      if (profiles[0]) sourceDir = path.join(ffRoot, profiles[0], 'gmp-widevinecdm');
    }
  } else if (platform === 'win32') {
    const ffRoot = path.join(process.env.APPDATA, 'Mozilla/Firefox/Profiles');
    if (fs.existsSync(ffRoot)) {
      const profiles = fs.readdirSync(ffRoot)
        .filter(d => d.endsWith('.default') || d.endsWith('.default-release'));
      if (profiles[0]) sourceDir = path.join(ffRoot, profiles[0], 'gmp-widevinecdm');
    }
  }

  if (!sourceDir || !fs.existsSync(sourceDir)) {
    console.log('No system Widevine found — Firefox will try to download it on first run.');
    return false;
  }

  const destDir = path.join(targetProfile, 'gmp-widevinecdm');
  if (fs.existsSync(destDir)) {
    console.log('Widevine already seeded in profile');
    return true;
  }

  try {
    fs.mkdirSync(targetProfile, { recursive: true });
    fs.cpSync(sourceDir, destDir, { recursive: true });
    console.log('Widevine copied from', sourceDir, '→', destDir);
    return true;
  } catch (e) {
    console.log('Widevine seed failed:', e.message);
    return false;
  }
}

// ============================================================
// PLAYLIST LOGIC (mostly unchanged)
// ============================================================
async function fetchTask() {
  playlists = [
    { id: 1, url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M' },
    { id: 2, url: 'https://open.spotify.com/playlist/37i9dQZF1DX4sWSpwq3LiO' },
    { id: 3, url: 'https://open.spotify.com/playlist/37i9dQZF1DXdPec7aLTmlC' },
  ];
  if (currentIndex >= playlists.length) {
    console.log('All playlists done, stopping...');
    process.exit(0);
  }
  return playlists[currentIndex];
}

async function playSpotify(url, duration = 30) {
  const page = await context.newPage();
  currentPage = page;

  console.log('Opening playlist:', url);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(8000);

  await page.bringToFront();
  await page.mouse.move(500, 500);
  await page.mouse.click(500, 500);
  await page.waitForTimeout(1000);

  const playButton = page.locator('button[data-testid="play-button"]').first();
  if (await playButton.count() > 0) {
    try {
      await playButton.click({ force: true });
      console.log('Play button clicked');
    } catch (e) {
      console.log('Click failed, using Space fallback');
      await page.keyboard.press('Space');
    }
  } else {
    console.log('Play button not found, using Space fallback');
    await page.keyboard.press('Space');
  }

  playStartTime = Date.now();
  playDurationSeconds = duration * 60;
}

async function stopPlayback() {
  if (!currentPage) return;
  await currentPage.close().catch(() => {});
  currentIndex += 1;
  currentPage = null;
  currentTaskId = null;
  playDurationSeconds = null;
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function runLoop() {
  while (true) {
    try {
      if (currentPage && playStartTime && playDurationSeconds) {
        const elapsed = (Date.now() - playStartTime) / 1000;
        if (elapsed >= playDurationSeconds) {
          console.log('Duration reached, moving to next playlist...');
          await stopPlayback();
          playStartTime = null;
        }
      }

      const task = await fetchTask();
      if (task && task.id !== currentTaskId) {
        await stopPlayback();
        currentTaskId = task.id;
        await playSpotify(task.url, currentDuration);
      }
    } catch (err) {
      console.log('Loop error:', err.message);
    }
    await delay(2000);
  }
}

// ============================================================
// TWO-PHASE STARTUP
// ============================================================
(async () => {
  let startPlayback = false;
  let configReceived = false;

  // Wait for initial config message
  await new Promise((resolve) => {
    process.parentPort.on('message', (msg) => {
      msg = msg.data;

      if (msg.type === 'config' && !configReceived) {
        configReceived = true;
        currentDuration = Number(msg.duration || 30);
        userEmail       = msg.email;
        userBrowser     = msg.browser || 'chrome';
        console.log('Config received — browser:', userBrowser, 'mode:', msg.mode);

        if (msg.mode === 'start-now') {
          startPlayback = true;
        }
        resolve();
      }

      if (msg.type === 'start-playback') {
        console.log('Start playback signal received');
        if (msg.duration) currentDuration = Number(msg.duration);
        if (msg.email)    userEmail       = msg.email;

        
        startPlayback = true;
      }
    });
  });

  

  await startBrowser();

  //console.log('dfdf');

  // If launched in 'open-only' mode, wait until start-playback arrives
  if (!startPlayback) {
    console.log('Browser open — waiting for Start button...');
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (startPlayback) {
          clearInterval(check);
          resolve();
        }
      }, 500);
    });
  }

  await runLoop();
})();