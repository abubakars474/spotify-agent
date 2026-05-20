const path = require('path');
const fs = require('fs');
if (process.resourcesPath && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const bundled = path.join(process.resourcesPath, 'ms-playwright');
  if (fs.existsSync(bundled)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = bundled;
    console.log('Using bundled Playwright browsers at', bundled);
  }
}
const { chromium, webkit, firefox } = require('playwright');
const os = require('os');

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
let isPaused = false;

// ============================================================
// BROWSER LAUNCHERS — all use persistent contexts so logins survive
// ============================================================
function getFirefoxProfile() {
  return path.join(os.homedir(), '.spotify-agent-firefox-profile');
}

// Clean broken session files (VERY IMPORTANT for Spotify login issues)
function cleanFirefoxProfile(profileDir) {
  if (!fs.existsSync(profileDir)) return;

  const removeFiles = [
    'cookies.sqlite',
    'sessionstore.jsonlz4',
    'prefs.js',
    'logins.json',
    'storage.sqlite'
  ];

  for (const file of removeFiles) {
    const filePath = path.join(profileDir, file);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log('Removed:', file);
      }
    } catch (e) {}
  }
}
function getRealFirefoxPath() {
  const platform = os.platform();

  const candidates = [];

  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Firefox.app/Contents/MacOS/firefox',
      '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
      '/Applications/Firefox Nightly.app/Contents/MacOS/firefox'
    );
  }

  if (platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe'
    );
  }

  if (platform === 'linux') {
    candidates.push('/usr/bin/firefox', '/usr/local/bin/firefox');
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      // 🔥 BLOCK NIGHTLY
      if (p.toLowerCase().includes('nightly')) {
        console.log('Blocked Nightly:', p);
        continue;
      }
      return p;
    }
  }

  throw new Error('Stable Firefox NOT found. Install Firefox stable.');
}

async function launchFirefox() {

  console.log('\n================ FIREFOX LAUNCH START ================');

  const profileBase = path.join(
    os.homedir(),
    '.spotify-agent-firefox'
  );

  const profile = profileBase + '-stable';

  console.log('[1] Profile path:', profile);

  const firefoxPath = getRealFirefoxPath?.();

  console.log('[2] Firefox binary:', firefoxPath || 'Playwright-managed');

  //
  // 🔥 IMPORTANT: CLEAN PROFILE CHECK
  //
  if (fs.existsSync(profile)) {
    console.log('[3] Existing profile found → using same session');
  } else {
    console.log('[3] Creating new clean Firefox profile');
    fs.mkdirSync(profile, { recursive: true });
  }

  //
  // 🚀 LAUNCH FIREFOX (PLAYWRIGHT CONTROLLED = STABLE)
  //
  let launchStart = Date.now();

  let launchPromise;

  try {

    launchPromise = firefox.launchPersistentContext(profile, {
      headless: false,
      viewport: null,

      // ❌ DO NOT USE system Firefox (prevents popup issues)
      // executablePath: firefoxPath,

      args: [
        '-no-remote',
        '-new-instance'
      ],

      firefoxUserPrefs: {
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
        'media.eme.enabled': true
      }
    });

    console.log('[4] Launch initiated...');

  } catch (err) {
    console.log('[X] Launch error before await:', err.message);
    throw err;
  }

  //
  // ⏱ TIMEOUT PROTECTION
  //
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('FIREFOX LAUNCH TIMEOUT')), 20000)
  );

  try {

    context = await Promise.race([launchPromise, timeout]);

    console.log('[5] Firefox context created in', Date.now() - launchStart, 'ms');

  } catch (err) {

    console.log('[X] FIREFOX FAILED:', err.message);
    throw err;
  }

  //
  // 📄 GET OR CREATE PAGE
  //
  let page = context.pages().find(p =>
    p.url() && !p.url().startsWith('about:')
  );

  if (!page) {
    console.log('[6] Creating new tab...');
    page = await context.newPage();
  }

  //
  // 🌐 FORCE SPOTIFY LOAD
  //
  console.log('[7] Navigating to Spotify...');

  await page.goto('https://open.spotify.com', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(3000);

  //
  // 🔍 VERIFY STATE
  //
  const url = page.url();
  const title = await page.title();

  console.log('[8] Final URL:', url);
  console.log('[9] Page Title:', title);

  await page.bringToFront();

  console.log('================ FIREFOX READY =================\n');

  return context;
}


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
    await launchFirefox();
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
// API CONFIG (now passed in via 'config' message)
// ============================================================
let API_BASE     = 'https://myspotify.anvs.xyz/api/v1/';
let API_USERNAME = null;
let API_PASSWORD = null;
let authToken    = null;
let playlistsLoaded = false;

function emit(type, payload) {
  try { process.parentPort.postMessage({ type, payload }); } catch {}
}

async function apiLogin() {
  if (!API_USERNAME || !API_PASSWORD) {
    throw new Error('No credentials available for re-login');
  }
  const form = new FormData();
  form.append('username', API_USERNAME);
  form.append('password', API_PASSWORD);

  const res = await fetch(`${API_BASE}login`, { method: 'POST', body: form });
  const json = await res.json();
  if (json?.data?.token) {
    authToken = json.data.token;
    console.log('Worker re-login OK');
    return authToken;
  }
  throw new Error('Worker re-login failed: ' + JSON.stringify(json));
}

async function apiFetchPlaylists() {
  if (!authToken) await apiLogin();
  const res = await fetch(`${API_BASE}playlists`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` }
  });
  if (res.status === 401) { authToken = null; await apiLogin(); return apiFetchPlaylists(); }
  const json = await res.json();
  return json?.data?.play_lists || [];
}

async function apiNotifyPlayed(playlist) {
  if (!playlist) return;
  if (!authToken) await apiLogin();
  const form = new FormData();
  if (playlist.id) form.append('play_list_id', String(playlist.id));
  try {
    const res = await fetch(`${API_BASE}playlists/play`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: form
    });
    if (res.status === 401) { authToken = null; await apiLogin(); return apiNotifyPlayed(playlist); }
    console.log('Notified server: playlist', playlist.id, 'played');
  } catch (e) { console.log('Notify failed:', e.message); }
}

// ============================================================
// PLAYLIST LOGIC (mostly unchanged)
// ============================================================
async function fetchTask() {
  // First run, or we finished the current batch → ask the server again
  if (!playlistsLoaded || currentIndex >= playlists.length) {
    console.log('Fetching playlists from API...');
    playlists = await apiFetchPlaylists();
    playlistsLoaded = true;
    currentIndex = 0;

    if (playlists.length === 0) {
      console.log('Empty playlist response — nothing left to play, exiting');
      process.exit(0);
    }
    console.log(`Loaded ${playlists.length} playlists`);
  }

  return playlists[currentIndex];
}



// Verify playback actually started by watching the bottom-bar pause button
async function waitForPlaybackStart(page, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const playing = await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="control-button-playpause"]');
        if (!btn) return false;
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        // When audio is playing, the button's job is to PAUSE
        return label.includes('pause');
      });
      if (playing) return true;
    } catch (e) { /* page may be navigating */ }
    await page.waitForTimeout(500);
  }
  return false;
}

async function playSpotify(url, duration = 30, browserName) {
  const page = await context.newPage();
  currentPage = page;
  console.log('Opening playlist:', url);

  const currentPlaylist = playlists[currentIndex];
  emit('playlist-update', {
    id:    currentPlaylist?.id,
    title: currentPlaylist?.title || currentPlaylist?.name || 'Untitled playlist',
    url:   url
  });

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',   // NOT networkidle
      timeout: 30000
    });
  } catch (e) {
    console.log('Navigation failed:', e.message);
    playStartTime = Date.now();
    playDurationSeconds = duration * 60;
    return;
  }

  await page.bringToFront();

  // Scope to the playlist header action bar — not every track row
  const mainPlayBtn = page.locator(
    '[data-testid="action-bar-row"] button[data-testid="play-button"]'
  ).first();

  let btnReady = false;
  try {
    await mainPlayBtn.waitFor({ state: 'visible', timeout: 20000 });
    btnReady = true;
  } catch {
    console.log('Main play button never appeared within 20s');
  }

  if (btnReady) {
    // Tiny human gesture — needed on Firefox/WebKit, harmless on Chrome
    if (browserName !== 'chrome') {
      await page.mouse.move(300, 300);
      await page.mouse.move(600, 500, { steps: 5 });
      await page.waitForTimeout(200);
    }

    // Try real click → programmatic click → keyboard
    let clicked = false;
    try {
      await mainPlayBtn.click({ force: true, timeout: 5000 });
      clicked = true;
      console.log('Play clicked');
    } catch (e) {
      console.log('Real click failed:', e.message);
    }

    if (!clicked) {
      clicked = await page.evaluate(() => {
        const btn = document.querySelector(
          '[data-testid="action-bar-row"] button[data-testid="play-button"]'
        );
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (clicked) console.log('Programmatic click succeeded');
    }
  }

  // Confirm audio actually started
  const playing = await waitForPlaybackStart(page, 12000);
  if (playing) {
    console.log('✓ Playback confirmed');
  } else {
    console.log('⚠ Could not confirm playback — page may need login, be region-locked, or hit DRM. Moving on after duration.');
  }

  playStartTime = Date.now();
  playDurationSeconds = duration * 60;
}

async function stopPlayback() {
  if (!currentPage) return;

  // Capture which playlist just finished BEFORE incrementing
  const finished = playlists[currentIndex];

  await currentPage.close().catch(() => {});

  // Fire-and-forget notification to the server
  await apiNotifyPlayed(finished);

  currentIndex += 1;
  currentPage = null;
  currentTaskId = null;
  playDurationSeconds = null;
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function runLoop() {
  while (true) {
    try {
      // Has the current playlist's time run out?
      if (currentPage && playStartTime && playDurationSeconds) {
        const elapsed = (Date.now() - playStartTime) / 1000;
        if (elapsed >= playDurationSeconds) {
          console.log('Duration reached, moving on...');
          await stopPlayback();
        }
      }

      // No tab open → start the next playlist
      if (!currentPage) {
        const task = await fetchTask();
        if (task) {
          currentTaskId = task.id;
          console.log('Current browser:', userBrowser);
          await playSpotify(task.spotify_url, currentDuration, userBrowser);
        }
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
    process.parentPort.on('message', async (msg) => {
      msg = msg.data;

      if (msg.type === 'config' && !configReceived) {
        configReceived = true;
        currentDuration = Number(msg.duration || 30);
        userBrowser     = msg.browser  || 'chrome';
        API_BASE        = msg.apiBase  || API_BASE;
        authToken       = msg.token    || null;
        API_USERNAME    = msg.email    || null;
        API_PASSWORD    = msg.password || null;
        console.log('Config received — browser:', userBrowser, 'mode:', msg.mode, 'token:', !!authToken);
        if (msg.mode === 'start-now') startPlayback = true;
        resolve();
      }

      if (msg.type === 'start-playback') {
        console.log('Start playback signal received');
        if (msg.duration) currentDuration = Number(msg.duration);
        if (msg.email)    userEmail       = msg.email;

        
        startPlayback = true;
      }

      if (msg.type === 'pause-playback') {

        isPaused = true;

        console.log('Pause playback requested');

        if (!currentPage) {
          console.log('No active page');
          return;
        }

        try {

          //
          // MAIN SPOTIFY PLAYER PAUSE BUTTON
          //
          const pauseButton = currentPage.locator(
            '[data-testid="control-button-pause"]'
          ).first();

          //
          // WAIT SMALL DELAY
          //
          await currentPage.waitForTimeout(500);

          //
          // IF CURRENTLY PLAYING
          //
          if (await pauseButton.count() > 0) {

            await pauseButton.click({
              force: true,
              timeout: 5000
            });

            console.log('Spotify playback paused');

          } else {

            //
            // FALLBACK → SPACE KEY
            //
            console.log('Pause button not found, using keyboard fallback');

            await currentPage.keyboard.press('Space');
          }

        } catch (e) {

          console.log('Pause failed:', e.message);

          //
          // LAST RESORT
          //
          try {

            await currentPage.keyboard.press('Space');

            console.log('Space fallback pause triggered');

          } catch (err) {

            console.log('Final pause fallback failed:', err.message);
          }
        }
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