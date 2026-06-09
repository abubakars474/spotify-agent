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
let currentDuration = 10;
let userEmail = null;
let playDurationSeconds = null;
let currentPlaylist = null;
let nextPlaylist = null;
let userBrowser = 'chrome';
let isPaused = false;
let pausedAt = null;
let pausedAccumulatedMs = 0;
let resetRequested = false;
let intentionalClose = false;
let firstFetch = true;
let playbackStopped = false;
let offlineReported = false;
let interruptStartTime = null;
let lastHealthCheck = null;
let browserClosed = false;
let lastKnownPlaying = null; // null = unknown, true = playing, false = paused
let lastKnownUrl = null;



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
  const res = await fetch(`${API_BASE}playlists?paging=1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` }
  });
  if (res.status === 401) { authToken = null; await apiLogin(); return apiFetchPlaylists(); }
  const json = await res.json();
  return {
    playlists: json?.data?.play_lists || [],
    duration:  json?.data?.playing_duration ?? null
  };
}

async function apiNotifyPlayed(playlist) {
  if (!playlist) return null;
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
    const json = await res.json();
    console.log('Notified server: playlist', playlist.id, 'played');
    if (json?.data?.playing_duration != null) currentDuration = json.data.playing_duration;
    return json?.data?.next_play_list || null;
  } catch (e) {
    console.log('Notify failed:', e.message);
    return null;
  }
}

// ============================================================
// PLAYLIST LOGIC
// ============================================================
async function fetchTask() {
  if (nextPlaylist) {
    playbackStopped = false;
    const task = nextPlaylist;
    nextPlaylist = null;
    return task;
  }

  // After the first play, only continue if the server provided next_play_list.
  // Never re-fetch automatically — that would cause unwanted repetition.
  if (!firstFetch) {
    if (!playbackStopped) {
      playbackStopped = true;
      emit('playback-state', { state: 'no-playlists' });
    }
    return null;
  }

  firstFetch = false;
  console.log('Fetching first playlist from API...');
  const { playlists, duration } = await apiFetchPlaylists();

  if (duration != null) {
    currentDuration = duration;
    console.log('Duration from API:', currentDuration, 'min');
  }

  if (playlists.length === 0) {
    console.log('No playlists available');
    emit('playback-state', { state: 'no-playlists' });
    return null;
  }

  return playlists[0];
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

async function playSpotify(url, duration = 10, browserName) {
  // Reuse the existing open tab rather than opening a new one each time
  let page = context.pages().find(p => !p.isClosed());
  if (!page) page = await context.newPage();
  const isNewPage = page !== currentPage;
  currentPage = page;
  console.log('Opening playlist:', url);

  // Only attach crash/close handlers on a fresh page to avoid duplicates
  if (isNewPage) {
    page.on('crash', () => {
      console.log('Page crashed');
      browserClosed = true;
      emit('interruption', { reason: 'Browser crashed — click Restart to reopen', level: 'error', ui: { status: 'STOPPED', label: 'Browser Crashed', title: 'Click Restart to reopen' } });
      currentPage = null;
      playDurationSeconds = null;
    });

    page.on('close', () => {
      if (!intentionalClose) {
        console.log('Page closed externally');
        browserClosed = true;
        emit('interruption', { reason: 'Browser closed — click Restart to reopen', level: 'error', ui: { status: 'STOPPED', label: 'Browser Closed', title: 'Click Restart to reopen' } });
        currentPage = null;
        playDurationSeconds = null;
      }
    });
  }

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
    emit('interruption', { reason: 'Could not load playlist — check your internet connection' });
    playStartTime = Date.now();
    playDurationSeconds = duration * 60;
    return;
  }

  lastKnownUrl = page.url();
  await page.bringToFront();

  // Read the real playlist title from Spotify's h1 element once it loads
  try {
    const titleLocator = page.locator('[data-testid="entityTitle"] h1').first();
    await titleLocator.waitFor({ state: 'visible', timeout: 12000 });
    const realTitle = (await titleLocator.textContent())?.trim();
    if (realTitle) {
      emit('playlist-update', { id: currentPlaylist?.id, title: realTitle, url });
    }
  } catch (_) {}

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
    emit('interruption', { clear: true });
  } else {
    console.log('⚠ Could not confirm playback');
    emit('interruption', { reason: 'Playback did not start — Spotify login, DRM, or region issue' });
  }
  lastKnownPlaying = playing;

  playStartTime = Date.now();
  playDurationSeconds = duration * 60;
}

async function setSpotifyPlayback(action) {
  if (!currentPage) return;
  try {
    const result = await currentPage.evaluate((wanted) => {
      const btn = document.querySelector('[data-testid="control-button-playpause"]');
      if (!btn) return 'no-button';
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      const isPlaying = label.includes('pause'); // when playing, the button's job is to pause
      if (wanted === 'pause' && isPlaying) { btn.click(); return 'paused'; }
      if (wanted === 'play'  && !isPlaying) { btn.click(); return 'playing'; }
      return 'unchanged';
    }, action);
    console.log(`Spotify ${action}:`, result);
  } catch (e) {
    console.log('setSpotifyPlayback failed:', e.message);
  }
}

async function stopPlayback() {
  if (!currentPage) return;

  const finished = currentPlaylist;

  // Navigate away instead of closing — keeps a single tab open for the next playlist
  await currentPage.goto('about:blank', { timeout: 5000 }).catch(() => {});

  const next = await apiNotifyPlayed(finished);
  if (next) nextPlaylist = next;

  currentPlaylist = null;
  currentPage = null;
  currentTaskId = null;
  playDurationSeconds = null;
  lastKnownPlaying = null;
  lastKnownUrl = null;
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function checkPageHealth() {
  if (!currentPage || isPaused) return;

  // Safety net: catch close events the page listener may have missed
  if (currentPage.isClosed()) {
    if (!intentionalClose) {
      browserClosed = true;
      emit('interruption', { reason: 'Browser closed — click Restart to reopen', level: 'error', ui: { status: 'STOPPED', label: 'Browser Closed', title: 'Click Restart to reopen' } });
      currentPage = null;
      playDurationSeconds = null;
    }
    return;
  }

  try {
    const online = await currentPage.evaluate(() => navigator.onLine);
    if (!online && !offlineReported) {
      offlineReported = true;
      interruptStartTime = Date.now();
      emit('interruption', { reason: 'Internet connection lost', level: 'error', ui: { status: 'OFFLINE', label: 'Connection Lost', title: 'Waiting for internet…' } });
    } else if (online && offlineReported) {
      offlineReported = false;
      if (!isPaused && currentPage && !currentPage.isClosed() && currentPlaylist) {
        emit('interruption', { reason: 'Internet restored — reloading playlist…', level: 'error', notify: false, ui: { status: 'LOADING', label: 'Reconnecting', title: 'Reloading playlist…' } });
        try {
          await currentPage.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
          await delay(2000);
          const btn = currentPage.locator(
            '[data-testid="action-bar-row"] button[data-testid="play-button"]'
          ).first();
          await btn.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
          await btn.click({ force: true, timeout: 5000 }).catch(() => {});
          const resumed = await waitForPlaybackStart(currentPage, 8000);
          if (resumed) {
            // Exclude the full offline+restore period from the playback timer
            if (interruptStartTime) {
              pausedAccumulatedMs += Date.now() - interruptStartTime;
              interruptStartTime = null;
            }
            emit('interruption', { clear: true });
          } else {
            interruptStartTime = null;
            emit('interruption', { reason: 'Could not resume — check Spotify manually' });
          }
        } catch (e) {
          interruptStartTime = null;
          console.log('Reload after restore failed:', e.message);
          emit('interruption', { reason: 'Could not resume — check Spotify manually' });
        }
      }
    }
  } catch (e) {
    // evaluate() throws when the page is gone or unresponsive
    if (!intentionalClose) {
      emit('interruption', { reason: 'Browser became unresponsive' });
      currentPage = null;
      playDurationSeconds = null;
    }
  }
}

function isBrowserAlive() {
  try {
    if (!context) return false;
    context.pages(); // throws if browser/context is dead
    return true;
  } catch (e) {
    return false;
  }
}

async function recoverBrowser() {
  console.log('Browser dead — attempting recovery...');
  emit('interruption', { reason: 'Browser closed — reopening…', notify: false });
  try {
    if (userBrowser === 'firefox' || userBrowser === 'safari') {
      await startBrowser();
    } else {
      // Chrome: ask main process to relaunch, then reconnect via CDP
      emit('need-browser-relaunch', {});
      await delay(6000);
      const browser = await chromium.connectOverCDP('http://localhost:9222');
      context = browser.contexts()[0];
    }
    console.log('Browser recovered');
    emit('interruption', { clear: true });
    return true;
  } catch (e) {
    console.log('Browser recovery failed:', e.message);
    emit('interruption', { reason: 'Could not reopen browser — please restart the app' });
    return false;
  }
}

async function runLoop() {
  while (true) {
    try {
      // Handle reset request (from new Reset button)
      if (resetRequested) {
        console.log('Reset: pausing current playback');
        if (currentPage && !isPaused) {
          isPaused = true;
          pausedAt = Date.now();
          await setSpotifyPlayback('pause').catch(() => {});
        }
        resetRequested = false;
      }

      // Active health check — internet + page alive (runs every 10 s)
      const now = Date.now();
      if (!lastHealthCheck || now - lastHealthCheck >= 10000) {
        lastHealthCheck = now;
        await checkPageHealth();
      }

      // Detect when user manually navigates to a different playlist in the browser
      if (currentPage && !currentPage.isClosed() && playDurationSeconds) {
        const currentUrl = currentPage.url();
        if (currentUrl && currentUrl !== lastKnownUrl &&
            currentUrl.includes('open.spotify.com') &&
            !currentUrl.includes('about:blank')) {
          lastKnownUrl = currentUrl;
          try {
            const titleLocator = currentPage.locator('[data-testid="entityTitle"] h1').first();
            await titleLocator.waitFor({ state: 'visible', timeout: 5000 });
            const realTitle = (await titleLocator.textContent())?.trim();
            if (realTitle) {
              emit('playlist-update', { id: currentPlaylist?.id, title: realTitle, url: currentUrl });
              console.log('Manual navigation detected, title:', realTitle);
            }
          } catch (_) {}
        }
      }

      // Detect manual play/pause in the browser tab
      if (currentPage && !currentPage.isClosed() && playDurationSeconds) {
        const nowPlaying = await currentPage.evaluate(() => {
          const btn = document.querySelector('[data-testid="control-button-playpause"]');
          if (!btn) return null;
          return (btn.getAttribute('aria-label') || '').toLowerCase().includes('pause');
        }).catch(() => null);

        if (nowPlaying !== null && lastKnownPlaying !== null && nowPlaying !== lastKnownPlaying) {
          emit('playback-changed', { playing: nowPlaying });
          console.log('Browser playback changed:', nowPlaying ? 'playing' : 'paused');

          // Sync isPaused so the app's Play/Pause buttons stay functional
          if (!nowPlaying && !isPaused) {
            isPaused = true;
            pausedAt = Date.now();
          } else if (nowPlaying && isPaused) {
            if (pausedAt) pausedAccumulatedMs += Date.now() - pausedAt;
            pausedAt = null;
            isPaused = false;
          }
        }
        if (nowPlaying !== null) lastKnownPlaying = nowPlaying;
      }

      // Duration check — exclude manual pause time AND ongoing interrupt time
      if (currentPage && playStartTime && playDurationSeconds && !isPaused) {
        const ongoingInterruptMs = interruptStartTime ? Date.now() - interruptStartTime : 0;
        const elapsed = (Date.now() - playStartTime - pausedAccumulatedMs - ongoingInterruptMs) / 1000;
        if (elapsed >= playDurationSeconds) {
          console.log('Duration reached, moving on...');
          await stopPlayback();
        }
      }

      // Start next playlist when nothing is playing
      if (!currentPage) {
        // Wait for user to click Restart if browser was closed externally
        if (browserClosed) {
          await delay(2000);
          continue;
        }

        pausedAccumulatedMs = 0;
        isPaused = false;
        pausedAt = null;

        // Recover browser if it was closed
        if (!isBrowserAlive()) {
          const recovered = await recoverBrowser();
          if (!recovered) {
            await delay(10000);
            continue;
          }
        }

        const task = await fetchTask();
        if (task) {
          currentPlaylist = task;
          currentTaskId = task.id;
          await playSpotify(task.spotify_url, currentDuration, userBrowser);
        } else {
          await delay(10000);
          continue;
        }
      }
    } catch (err) {
      console.log('Loop error:', err.message);
      emit('interruption', { reason: err.message || 'Unexpected error occurred' });
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
        currentDuration = Number(msg.duration || 10);
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
        if (!isPaused) {
          isPaused = true;
          pausedAt = Date.now();
          lastKnownPlaying = false; // app-initiated — don't re-notify
          console.log('Pause requested');
          setSpotifyPlayback('pause').catch(() => {});
        }
      }

      if (msg.type === 'resume-playback') {
        if (isPaused && pausedAt) {
          pausedAccumulatedMs += Date.now() - pausedAt;
          pausedAt = null;
          isPaused = false;
          lastKnownPlaying = true; // app-initiated — don't re-notify
          console.log('Resume requested');
          setSpotifyPlayback('play').catch(() => {});
        }
      }

      if (msg.type === 'reset-playlists') {
        console.log('Reset playlists signal received');
        nextPlaylist = null;
        firstFetch = true;
        playbackStopped = false;
        offlineReported = false;
        interruptStartTime = null;
        resetRequested = true;
      }

      if (msg.type === 'restart-playback') {
        console.log('Restart playback signal received');
        browserClosed = false;
        // Preserve the current playlist — queue it as next so fetchTask reuses it without API call
        nextPlaylist = currentPlaylist || nextPlaylist;
        if (!nextPlaylist) firstFetch = true; // nothing to reuse — allow fresh fetch

        playbackStopped = false;
        offlineReported = false;
        interruptStartTime = null;
        isPaused = false;
        pausedAt = null;
        pausedAccumulatedMs = 0;

        // Navigate away without notifying the server — keeps the single tab open
        if (currentPage) {
          currentPage.goto('about:blank', { timeout: 5000 }).catch(() => {});
          currentPage = null;
        }
        currentPlaylist = null;
        playStartTime = null;
        playDurationSeconds = null;
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