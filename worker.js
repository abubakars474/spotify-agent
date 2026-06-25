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
let autoRetryEnabled = true;
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
let autoRestartAttempts = 0;   // consecutive failed browser-restart attempts
let lastAutoRestartAt = 0;     // timestamp of last auto-restart attempt
let needsSessionRestore = false; // true after browser fully dies and is recreated
let lastKnownPlaying = null;   // null = unknown, true = playing, false = paused
let lastKnownUrl = null;
let navCooldownUntil = 0;           // timestamp — ignore URL changes until this time (post-auto-return)
let manualNavInterrupted = false;   // true when user manually changed playlist in browser
let manualNavAttempts = 0;          // consecutive auto-return attempts after manual nav
let navigatingBack = false;         // true while we are restoring the original playlist
let browserPauseInterrupted = false; // true when browser-tab pause triggered an app message
let logoutDetected = false;          // true when Spotify logout is detected; suppresses false-positive play events
let playlistTrackIds = new Set();   // track IDs from the current playlist (excludes recommendations)
let offPlaylistCount = 0;           // consecutive polls detecting an off-playlist / recommendation song
let offPlaylistWarned = false;      // true while the off-playlist warning is showing

let playbackResumeAttempts = 0;
const MAX_PLAYBACK_RESUME_ATTEMPTS = 2;

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
  logoutDetected = false; // new playlist starting — clear logout gate
  // Reset off-playlist state for the incoming playlist
  playlistTrackIds = new Set();
  offPlaylistCount = 0;
  offPlaylistWarned = false;

  // Reuse the existing open tab rather than opening a new one each time
  const existingPages = context.pages().filter(p => !p.isClosed());
  console.log(`[PLAY] context has ${existingPages.length} open page(s): ${existingPages.map(p => p.url()).join(', ')}`);
  let page = existingPages[0];
  let wasNewPage = false;
  if (!page) {
    page = await context.newPage();
    wasNewPage = true;
    console.log('[PLAY] Created new tab — restoring session cookies...');
    // sp_dc is a session cookie cleared by Chrome when the last tab closes.
    // Re-inject the saved cookies so Spotify doesn't show the login modal.
    await restoreSession();
    needsSessionRestore = true; // also inject localStorage before Spotify loads
  }
  const isNewPage = page !== currentPage;
  currentPage = page;
  console.log('Opening playlist:', url);

  // Only attach crash/close handlers on a fresh page to avoid duplicates
  if (isNewPage) {
    page.on('crash', () => {
      console.log('Page crashed');
      browserClosed = true;
      autoRestartAttempts = 0;
      lastAutoRestartAt = 0;
      emit('interruption', {
        reason: autoRetryEnabled ? 'Browser crashed — attempting restart…' : 'Browser crashed — press Restart to continue',
        level: 'error',
        ui: { status: 'STOPPED', label: 'Browser Crashed', title: autoRetryEnabled ? 'Restarting…' : 'Press Restart' }
      });
      currentPage = null;
      playDurationSeconds = null;
    });

    page.on('close', () => {
      if (!intentionalClose) {
        console.log('Page closed externally');
        browserClosed = true;
        autoRestartAttempts = 0;
        lastAutoRestartAt = 0;
        emit('interruption', {
          reason: autoRetryEnabled ? 'Browser closed — attempting restart…' : 'Browser closed — press Restart to continue',
          level: 'error',
          ui: { status: 'STOPPED', label: 'Browser Closed', title: autoRetryEnabled ? 'Restarting…' : 'Press Restart' }
        });
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

  // After browser recovery, inject saved localStorage so Spotify stays logged in.
  // Cookies are already injected via restoreSession() in recoverBrowser().
  // localStorage must be queued via addInitScript() so it runs before Spotify's auth code.
  if (needsSessionRestore && fs.existsSync(SESSION_FILE)) {
    needsSessionRestore = false;
    try {
      const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      const spotifyItems = saved.origins?.find(o => o.origin === 'https://open.spotify.com')?.localStorage;
      if (spotifyItems?.length) {
        await page.addInitScript(items => {
          for (const { name, value } of items) {
            try { window.localStorage.setItem(name, value); } catch (_) {}
          }
        }, spotifyItems);
      }
    } catch (e) {
      console.log('Session localStorage restore error:', e.message);
    }
  }

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
  const landedUrl = page.url();
  const isLoginPage = landedUrl.includes('accounts.spotify.com') || landedUrl.includes('/login') || landedUrl.includes('/signup');
  console.log(`[NAV] Landed on: ${landedUrl}${isLoginPage ? ' ⚠ SPOTIFY LOGIN PAGE — user is logged out!' : ' ✓ logged in'}`);
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
    saveSession(); // persist cookies + localStorage while we know the user is logged in
    navCooldownUntil = Date.now() + 5000; // ignore URL changes for 5s after initial load
    await updateAgentStatus(1);
  } else {
    console.log('⚠ Could not confirm playback');
    emit('interruption', { reason: 'Playback did not start — Spotify login, DRM, or region issue' });
  }
  lastKnownPlaying = playing;

  // Collect playlist track IDs from DOM — exclude anything inside [data-testid="recommended-track"]
  if (playing && currentPage && !currentPage.isClosed()) {
    try {
      const ids = await currentPage.evaluate(() => {
        return Array.from(
          document.querySelectorAll('a[data-testid="internal-track-link"]')
        ).filter(a => !a.closest('[data-testid="recommended-track"]'))
         .map(a => {
           const m = (a.getAttribute('href') || '').match(/\/track\/([^/?]+)/);
           return m ? m[1] : null;
         }).filter(Boolean);
      });
      ids.forEach(id => playlistTrackIds.add(id));
      console.log(`Collected ${playlistTrackIds.size} playlist track IDs`);
    } catch (_) {}
  }

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
  navCooldownUntil = 0;
  playlistTrackIds = new Set();
  offPlaylistCount = 0;
  offPlaylistWarned = false;
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

const SESSION_FILE = path.join(os.homedir(), '.spotify-agent-session.json');

// Persist Spotify cookies + localStorage to disk so they survive a full browser restart.
// For Firefox/Safari, launchPersistentContext already handles this in the profile dir.
// For Chrome (CDP), we save explicitly because the main process may relaunch Chrome fresh.
async function saveSession() {
  if (!context) return;
  try {
    const state = await context.storageState();
    const spCookie = state.cookies?.find(c => c.name === 'sp_dc');
    const lsItems = state.origins?.find(o => o.origin === 'https://open.spotify.com')?.localStorage?.length ?? 0;
    console.log(`[SESSION SAVE] cookies=${state.cookies?.length ?? 0} sp_dc=${spCookie ? 'YES' : 'NO'} localStorage=${lsItems} → ${SESSION_FILE}`);
    fs.writeFileSync(SESSION_FILE, JSON.stringify(state));
  } catch (e) {
    console.log('[SESSION SAVE] failed:', e.message);
  }
}

async function restoreSession() {
  if (!context) { console.log('[SESSION RESTORE] skipped — no context'); return; }
  if (!fs.existsSync(SESSION_FILE)) { console.log('[SESSION RESTORE] skipped — no session file at', SESSION_FILE); return; }
  try {
    const state = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    const spCookie = state.cookies?.find(c => c.name === 'sp_dc');
    const lsItems = state.origins?.find(o => o.origin === 'https://open.spotify.com')?.localStorage?.length ?? 0;
    console.log(`[SESSION RESTORE] file has cookies=${state.cookies?.length ?? 0} sp_dc=${spCookie ? 'YES (expires ' + new Date(spCookie.expires * 1000).toISOString() + ')' : 'NO'} localStorage=${lsItems}`);
    if (state.cookies?.length) {
      await context.addCookies(state.cookies);
      console.log('[SESSION RESTORE] cookies injected into context');
    }
  } catch (e) {
    console.log('[SESSION RESTORE] failed:', e.message);
  }
}

async function checkPageHealth() {
  if (!currentPage || isPaused) return;

  // Safety net: catch close events the page listener may have missed
  if (currentPage.isClosed()) {
    if (!intentionalClose) {
      browserClosed = true;
      autoRestartAttempts = 0;
      lastAutoRestartAt = 0;
      emit('interruption', {
        reason: autoRetryEnabled ? 'Browser closed — attempting restart…' : 'Browser closed — press Restart to continue',
        level: 'error',
        ui: { status: 'STOPPED', label: 'Browser Closed', title: autoRetryEnabled ? 'Restarting…' : 'Press Restart' }
      });
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
      // Chrome: tell index.js to relaunch Chrome with the same --user-data-dir.
      // Then reconnect via CDP and inject the saved Spotify session so the user
      // doesn't need to log in again even if the profile cookies were lost.
      emit('need-browser-relaunch', {});
      await delay(6000); // wait for Chrome to fully start
      console.log('[RECOVER] Connecting via CDP...');
      const browser = await chromium.connectOverCDP('http://localhost:9222');
      const contexts = browser.contexts();
      console.log(`[RECOVER] CDP connected — contexts=${contexts.length}`);
      context = contexts[0];
      if (!context) throw new Error('No browser context available after CDP connect');
      const pages = context.pages();
      console.log(`[RECOVER] Context pages=${pages.length} urls=${pages.map(p => p.url()).join(', ')}`);
      await restoreSession();   // inject saved cookies immediately into the context
      needsSessionRestore = true; // flag playSpotify() to inject localStorage too
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

async function updateAgentStatus(status) {
  try {
    if (!authToken) await apiLogin();
    const form = new FormData();
    form.append('agent_status', String(status));
    const res = await fetch(`${API_BASE}update-agent-status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: form
    });
    if (res.status === 401) { authToken = null; await apiLogin(); return updateAgentStatus(status); }
    console.log(`[STATUS] update-agent-status(${status}) →`, res.status);
  } catch (e) {
    console.log(`[STATUS] update-agent-status(${status}) failed:`, e.message);
  }
}

// Called after repeated browser-restart failures.
async function notifyBrowserRestartFailed() {
  await updateAgentStatus(3);
}

async function notifyPlaybackPauseFailed() {
  try {
    console.log(
      '[TODO] notifyPlaybackPauseFailed API'
    );

    // API will be added later

    /*
    await fetch(`${API_BASE}YOUR_ENDPOINT`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        playlist_id: currentPlaylist?.id,
        reason: 'playback_paused'
      })
    });
    */

  } catch (e) {
    console.log(
      'notifyPlaybackPauseFailed:',
      e.message
    );
  }
}

async function restoreOriginalPlaylist() {
    if (
        !currentPlaylist?.spotify_url ||
        !currentPage ||
        currentPage.isClosed()
    ) {
        return false;
    }

    const origUrl = currentPlaylist.spotify_url;

    try {
        navigatingBack = true;
        lastKnownUrl = origUrl;

        await currentPage.goto(origUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        navCooldownUntil = Date.now() + 5000;
        await currentPage.bringToFront();

        const playBtn = currentPage.locator(
            '[data-testid="action-bar-row"] button[data-testid="play-button"]'
        ).first();

        await playBtn.waitFor({
            state: 'visible',
            timeout: 10000
        });

        await playBtn.click({
            force: true,
            timeout: 5000
        });

        const playing = await waitForPlaybackStart(
            currentPage,
            8000
        );

        if (playing) {
            lastKnownPlaying = true;
            return true;
        }

        return false;

    } catch (e) {
        console.log(
            'restoreOriginalPlaylist:',
            e.message
        );
        return false;
    } finally {
        navigatingBack = false;
    }
}

async function tryAutoResumePlayback() {
    if (!autoRetryEnabled) return false;

    // Abort if user is not logged into Spotify (sp_dc cookie gone)
    if (context) {
        try {
            const cookies = await context.cookies('https://open.spotify.com');
            if (!cookies.find(c => c.name === 'sp_dc')) {
                console.log('[AUTO RECOVERY] Spotify not logged in — aborting');
                return false;
            }
        } catch (e) {
            console.log('[AUTO RECOVERY] Login check error:', e.message);
        }
    }

    for (let i = 1; i <= 2; i++) {

        console.log(
            `[AUTO RECOVERY] Attempt ${i}/2`
        );

        const restored =
            await restoreOriginalPlaylist();

        if (restored) {

            if (pausedAt) {
                pausedAccumulatedMs +=
                    Date.now() - pausedAt;
                pausedAt = null;
            }

            isPaused = false;
            browserPauseInterrupted = false;
            manualNavInterrupted = false;

            emit('interruption', { clear: true });
            emit('playback-changed', { playing: true });
            await updateAgentStatus(1);

            return true;
        }

        // If redirected to Spotify login, user logged out — no point retrying
        if (currentPage && !currentPage.isClosed()) {
            const url = currentPage.url();
            if (url.includes('accounts.spotify.com') || url.includes('/login') || url.includes('/signup')) {
                lastKnownUrl = url; // prevent URL detector from re-firing
                logoutDetected = true;
                emit('playback-changed', { playing: false });
                emit('interruption', {
                    reason: 'Not logged into Spotify — please login in the browser and click Play',
                    level: 'error',
                    allowPlay: true,
                    ui: { status: 'PAUSED', label: 'LOGIN REQUIRED', title: 'Login to Spotify' }
                });
                return false;
            }
        }

        await delay(3000);
    }

    return false;
}

// Auto-return to the assigned playlist after the user manually navigates away.
// Tries up to 2 times; on total failure shows a message and calls the API placeholder.
async function autoReturnToPlaylist() {
  if (!currentPlaylist?.spotify_url || !currentPage || currentPage.isClosed()) return;

  // Check Spotify login via sp_dc cookie before any navigation.
  // Logout lands on open.spotify.com (not /login), so URL-based detection misses it.
  if (context) {
    try {
      const cookies = await context.cookies('https://open.spotify.com');
      if (!cookies.find(c => c.name === 'sp_dc')) {
        console.log('[MANUAL NAV] Spotify not logged in — stopping auto-return');
        logoutDetected = true;
        if (!isPaused) { isPaused = true; pausedAt = Date.now(); }
        await updateAgentStatus(2);
        emit('playback-changed', { playing: false });
        emit('interruption', {
          reason: 'Not logged into Spotify — please login in the browser and click Play',
          level: 'error',
          allowPlay: true,
          ui: { status: 'PAUSED', label: 'LOGIN REQUIRED', title: 'Login to Spotify' }
        });
        return;
      }
    } catch (e) {
      console.log('[MANUAL NAV] Login check error:', e.message);
    }
  }

  const origUrl = currentPlaylist.spotify_url;
  navigatingBack = true;
  manualNavInterrupted = true;

  const maxAttempts = autoRetryEnabled ? 2 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    manualNavAttempts = attempt;
    console.log(`[MANUAL NAV] Auto-return attempt ${attempt}/2 to ${origUrl}`);
    emit('interruption', {
      reason: `Playlist changed — returning to your playlist (${attempt}/2)…`,
      ui: { status: 'RUNNING', label: 'RETURNING', title: currentPlaylist.title }
    });

    try {
      lastKnownUrl = origUrl; // pre-set so detection won't re-fire
      await currentPage.goto(origUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await currentPage.bringToFront();
      const mainPlayBtn = currentPage.locator(
        '[data-testid="action-bar-row"] button[data-testid="play-button"]'
      ).first();
      await mainPlayBtn.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      await mainPlayBtn.click({ force: true, timeout: 5000 }).catch(() => {});
      const playing = await waitForPlaybackStart(currentPage, 8000);

      if (playing) {
        console.log(`[MANUAL NAV] Auto-return succeeded on attempt ${attempt}`);
        manualNavInterrupted = false;
        manualNavAttempts = 0;
        navigatingBack = false;
        lastKnownPlaying = true;
        navCooldownUntil = Date.now() + 5000; // ignore URL changes for 5s after auto-return
        if (isPaused && pausedAt) { pausedAccumulatedMs += Date.now() - pausedAt; pausedAt = null; }
        isPaused = false;
        emit('interruption', { clear: true });
        emit('playback-changed', { playing: true });
        await updateAgentStatus(1);
        return;
      }
    } catch (e) {
      console.log(`[MANUAL NAV] Attempt ${attempt} error:`, e.message);
    }

    console.log(`[MANUAL NAV] Attempt ${attempt} failed`);
    if (attempt < 2) {
      emit('interruption', {
        reason: `Could not return to playlist (${attempt}/2) — retrying…`,
        ui: { status: 'PAUSED', label: 'PAUSED', title: currentPlaylist.title }
      });
      await delay(3000);
    }
  }

  // Both attempts failed
  console.log('[MANUAL NAV] Auto-return failed after 2 attempts');
  await notifyManualNavFailed();
  if (!isPaused) { isPaused = true; pausedAt = Date.now(); }
  emit('interruption', {
    reason: 'Could not return to playlist after 2 attempts — press Play to retry',
    ui: { status: 'PAUSED', label: 'PAUSED', title: currentPlaylist.title }
  });
  emit('playback-changed', { playing: false });
  navigatingBack = false;
}

async function notifyManualNavFailed() {
  await updateAgentStatus(3);
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
      if (!navigatingBack && currentPage && !currentPage.isClosed() && playDurationSeconds &&
          Date.now() > navCooldownUntil) {
        const currentUrl = currentPage.url();
        if (currentUrl && currentUrl !== lastKnownUrl && !currentUrl.includes('about:blank')) {
          lastKnownUrl = currentUrl;

          // Spotify login/auth redirect — user is not logged into Spotify
          const isLoginPage = currentUrl.includes('accounts.spotify.com') ||
                              currentUrl.includes('/login') ||
                              currentUrl.includes('/signup');
          if (isLoginPage) {
            console.log('[NAV] Spotify login page detected — user is not logged in');
            logoutDetected = true;
            emit('playback-changed', { playing: false });
            emit('interruption', {
              reason: 'Not logged into Spotify — please login in the browser and click Play',
              level: 'error',
              allowPlay: true,
              ui: { status: 'PAUSED', label: 'LOGIN REQUIRED', title: 'Login to Spotify' }
            });
          } else if (currentUrl.includes('open.spotify.com')) {
            lastKnownPlaying = false;
            console.log('Manual navigation detected — auto-returning to:', currentPlaylist?.title);
            await autoReturnToPlaylist();
          }
        }
      }

      // Detect manual play/pause in the browser tab
      if (currentPage && !currentPage.isClosed() && playDurationSeconds) {
        const nowPlaying = await currentPage.evaluate(() => {
          const btn = document.querySelector('[data-testid="control-button-playpause"]');
          if (!btn) return null;
          return (btn.getAttribute('aria-label') || '').toLowerCase().includes('pause');
        }).catch(() => null);

        if (nowPlaying !== null && lastKnownPlaying !== null && nowPlaying !== lastKnownPlaying
            && !(logoutDetected && nowPlaying)) {
          // Note: logoutDetected && nowPlaying is suppressed — the Spotify mini player
          // stays visible on the home page after logout and would otherwise reset the UI.
          emit('playback-changed', { playing: nowPlaying });
          console.log('Browser playback changed:', nowPlaying ? 'playing' : 'paused');

          if (!nowPlaying && !isPaused) {

            isPaused = true;
            pausedAt = Date.now();
            browserPauseInterrupted = true;

            // Check Spotify login before attempting any recovery
            let spotifyLoggedIn = true;
            if (context) {
                try {
                    const cookies = await context.cookies('https://open.spotify.com');
                    spotifyLoggedIn = !!cookies.find(c => c.name === 'sp_dc');
                } catch (e) {}
            }

            if (!spotifyLoggedIn) {
                console.log('[PLAYBACK PAUSED] Spotify not logged in');
                logoutDetected = true;
                await updateAgentStatus(2);
                emit('interruption', {
                    reason: 'Not logged into Spotify — please login in the browser and click Play',
                    level: 'error',
                    allowPlay: true,
                    ui: { status: 'PAUSED', label: 'LOGIN REQUIRED', title: 'Login to Spotify' }
                });
            } else {
                console.log('[PLAYBACK PAUSED] Trying automatic recovery...');
                const resumed = await tryAutoResumePlayback();
                if (!resumed) {
                    await updateAgentStatus(2);
                    await notifyPlaybackPauseFailed();
                    emit('interruption', {
                        reason: 'Playback paused — click Play to resume',
                        ui: { status: 'PAUSED', label: 'PAUSED', title: currentPlaylist?.title || '—' }
                    });
                }
            }
        } else if (nowPlaying && isPaused) {
            if (pausedAt) pausedAccumulatedMs += Date.now() - pausedAt;
            pausedAt = null;
            isPaused = false;
            await updateAgentStatus(1);
            // Browser-initiated resume — clear the pause message if it was set
            if (browserPauseInterrupted) {
              browserPauseInterrupted = false;
              emit('interruption', { clear: true });
            }
          }
        }
        if (nowPlaying !== null) lastKnownPlaying = nowPlaying;
      }

      // Detect recommendation / off-playlist songs
      if (!isPaused && !navigatingBack && !manualNavInterrupted &&
          currentPage && !currentPage.isClosed() && playDurationSeconds) {
        const check = await currentPage.evaluate(() => {
          // Is Spotify playing?
          const playPauseBtn = document.querySelector('[data-testid="control-button-playpause"]');
          if (!playPauseBtn) return null;
          const isPlaying = (playPauseBtn.getAttribute('aria-label') || '').toLowerCase().includes('pause');

          // The mini player links to the album, not the track directly.
          // The "context-link" element has the track URI embedded as a query param:
          // href="/album/ID?uid=...&uri=spotify%3Atrack%3ATRACK_ID"
          const contextLink = document.querySelector('a[data-testid="context-link"]');
          const contextHref = contextLink ? (contextLink.getAttribute('href') || '') : '';
          const uriMatch = contextHref.match(/uri=spotify(?:%3A|:)track(?:%3A|:)([^&]+)/i);
          const miniId = uriMatch ? uriMatch[1] : null;

          // Check if the currently playing track appears in the main playlist (not recommendations).
          // Spotify always scrolls the playing row into view so it will be in the DOM.
          const isInPlaylist = miniId
            ? !!Array.from(document.querySelectorAll('a[data-testid="internal-track-link"]'))
                .find(a =>
                  !a.closest('[data-testid="recommended-track"]') &&
                  (a.getAttribute('href') || '').includes(miniId)
                )
            : null;

          return { isPlaying, miniId, isInPlaylist };
        }).catch(() => null);

        if (check) {
          if (!check.isPlaying) {
            offPlaylistCount = 0;
          } else if (check.isInPlaylist === true) {
            if (check.miniId) playlistTrackIds.add(check.miniId);
            offPlaylistCount = 0;
            if (offPlaylistWarned) { offPlaylistWarned = false; emit('interruption', { clear: true }); }
          } else if (check.isInPlaylist === false) {
            offPlaylistCount++;
            if (offPlaylistCount >= 3 && !offPlaylistWarned) {
              offPlaylistWarned = true;
              emit('interruption', {
                reason: 'Recommendation detected — returning to your playlist...'
              });
              console.log('Off-playlist detected — auto-resuming playlist');

              const resumeUrl = currentPlaylist?.spotify_url;
              if (resumeUrl && currentPage && !currentPage.isClosed()) {
                navigatingBack = true;
                lastKnownUrl = resumeUrl;
                try {
                  await currentPage.goto(resumeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                  await currentPage.bringToFront();
                  const mainPlayBtn = currentPage.locator(
                    '[data-testid="action-bar-row"] button[data-testid="play-button"]'
                  ).first();
                  await mainPlayBtn.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
                  await mainPlayBtn.click({ force: true, timeout: 5000 }).catch(() => {});
                  const playing = await waitForPlaybackStart(currentPage, 8000);
                  lastKnownPlaying = playing;
                  if (playing) {
                    offPlaylistWarned = false;
                    offPlaylistCount = 0;
                    const ids = await currentPage.evaluate(() =>
                      Array.from(document.querySelectorAll('a[data-testid="internal-track-link"]'))
                        .filter(a => !a.closest('[data-testid="recommended-track"]'))
                        .map(a => { const m = (a.getAttribute('href') || '').match(/\/track\/([^/?]+)/); return m ? m[1] : null; })
                        .filter(Boolean)
                    ).catch(() => []);
                    ids.forEach(id => playlistTrackIds.add(id));
                    emit('interruption', { clear: true });
                    console.log('Auto-resumed playlist successfully');
                  } else {
                    emit('interruption', { reason: 'Recommendation detected — could not return to playlist, press Play' });
                  }
                } catch (e) {
                  console.log('Auto-resume failed:', e.message);
                  emit('interruption', { reason: 'Recommendation detected — could not return to playlist, press Play' });
                } finally {
                  navigatingBack = false;
                }
              }
            }
          }
        }
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
        if (browserClosed) {
          // After max attempts: call API, show message, wait for manual restart
          const maxRestarts = autoRetryEnabled ? 2 : 0;
          if (autoRestartAttempts >= maxRestarts) {
            await delay(2000);
            continue;
          }
          // Mirror exactly what the manual Restart button does — try every 5 s
          const now = Date.now();
          if (now - lastAutoRestartAt >= 5000) {
            lastAutoRestartAt = now;
            autoRestartAttempts++;
            console.log(`Auto-restart attempt ${autoRestartAttempts}/${maxRestarts}...`);
            browserClosed = false;
            nextPlaylist = currentPlaylist || nextPlaylist;
            if (!nextPlaylist) firstFetch = true;
            playbackStopped = false;
            offlineReported = false;
            interruptStartTime = null;
            isPaused = false;
            pausedAt = null;
            pausedAccumulatedMs = 0;
            if (currentPage) {
              currentPage.goto('about:blank', { timeout: 5000 }).catch(() => {});
              currentPage = null;
            }
            currentPlaylist = null;
            playStartTime = null;
            playDurationSeconds = null;
          } else {
            await delay(1000);
            continue;
          }
        }

        pausedAccumulatedMs = 0;
        isPaused = false;
        pausedAt = null;

        // Recover browser if the process/context is dead
        if (!isBrowserAlive()) {
          console.log('[RECOVER] Browser not alive — context:', !!context, '— calling recoverBrowser()');
          const recovered = await recoverBrowser();
          if (!recovered) {
            // autoRestartAttempts was already incremented in the auto-restart block above.
            // Check the limit here to decide whether to show the final error.
            if (autoRestartAttempts >= (autoRetryEnabled ? 2 : 0)) {
              // Both attempts exhausted — call API and show final message
              await notifyBrowserRestartFailed();
              emit('interruption', {
                reason: 'Browser could not restart — please restart the app manually',
                level: 'error',
                ui: { status: 'STOPPED', label: 'Restart Required', title: 'Press Restart to continue' }
              });
              browserClosed = true; // stay stopped — manual Restart button resets autoRestartAttempts
            } else {
              // First failure — retry once more after 5 s
              browserClosed = true;
            }
            await delay(5000);
            continue;
          }
          autoRestartAttempts = 0;
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
        currentDuration  = Number(msg.duration || 10);
        userBrowser      = msg.browser  || 'chrome';
        API_BASE         = msg.apiBase  || API_BASE;
        authToken        = msg.token    || null;
        API_USERNAME     = msg.email    || null;
        API_PASSWORD     = msg.password || null;
        autoRetryEnabled = msg.autoRetry !== false;
        console.log('Config received — browser:', userBrowser, 'autoRetry:', autoRetryEnabled, 'mode:', msg.mode);
        if (msg.mode === 'start-now') startPlayback = true;
        resolve();
      }

      if (msg.type === 'start-playback') {
        console.log('Start playback signal received');
        if (msg.duration) currentDuration = Number(msg.duration);
        if (msg.email)    userEmail       = msg.email;

        
        startPlayback = true;
      }

      if (msg.type === 'set-auto-retry') {
        autoRetryEnabled = msg.autoRetry === true;
        console.log('[CONFIG] autoRetry set to:', autoRetryEnabled);
      }

      if (msg.type === 'pause-playback') {
        if (!isPaused) {
          isPaused = true;
          pausedAt = Date.now();
          lastKnownPlaying = false; // app-initiated — don't re-notify
          console.log('Pause requested');
          setSpotifyPlayback('pause').catch(() => {});
          updateAgentStatus(2).catch(() => {});
        }
      }

      if (msg.type === 'resume-playback') {
        logoutDetected = false; // user explicitly pressed Play — clear logout gate
        if (manualNavInterrupted && currentPlaylist?.spotify_url && currentPage && !currentPage.isClosed()) {
          // User pressed Play after manually navigating away — restore our original playlist
          manualNavInterrupted = false;
          navigatingBack = true;
          const origUrl = currentPlaylist.spotify_url;
          lastKnownUrl = origUrl; // pre-set so URL detector won't re-fire during navigation
          try {
            await currentPage.goto(origUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await currentPage.bringToFront();
            const mainPlayBtn = currentPage.locator(
              '[data-testid="action-bar-row"] button[data-testid="play-button"]'
            ).first();
            await mainPlayBtn.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
            await mainPlayBtn.click({ force: true, timeout: 5000 }).catch(() => {});
            const playing = await waitForPlaybackStart(currentPage, 8000);
            lastKnownPlaying = playing;
            if (playing) {
              if (pausedAt) { pausedAccumulatedMs += Date.now() - pausedAt; pausedAt = null; }
              isPaused = false;
              emit('interruption', { clear: true });
              emit('playback-changed', { playing: true });
              await updateAgentStatus(1);
              console.log('Restored original playlist:', origUrl);
            } else {
              emit('interruption', { reason: 'Playback did not start — try again' });
            }
          } catch (e) {
            console.log('Restore navigation failed:', e.message);
            emit('interruption', { reason: 'Could not restore playlist — try Restart' });
          } finally {
            navigatingBack = false;
          }
        } else if (isPaused && pausedAt) {
          // Normal resume — just unpause in place
          pausedAccumulatedMs += Date.now() - pausedAt;
          pausedAt = null;
          isPaused = false;
          lastKnownPlaying = true; // app-initiated — don't re-notify
          console.log('Resume requested');
          // Clear browser-pause message if it was showing (app button overrides)
          if (browserPauseInterrupted) {
            browserPauseInterrupted = false;
            emit('interruption', { clear: true });
          }
          setSpotifyPlayback('play').catch(() => {});
          updateAgentStatus(1).catch(() => {});
        }
      }

      if (msg.type === 'retry-fetch') {
        console.log('Retry fetch signal received');
        firstFetch = true;
        playbackStopped = false;
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
        autoRestartAttempts = 0;
        lastAutoRestartAt = 0;
        needsSessionRestore = false;
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