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


  // if (userBrowser === 'firefox') {
  //   const firefoxProfile = path.join(os.homedir(), '.spotify-agent-firefox-profile');

  //   clearFirefoxVersionLocks(firefoxProfile);   // <-- before launch
  //   seedWidevine(firefoxProfile);

  //   context = await firefox.launchPersistentContext(firefoxProfile, {
  //     headless: false,
  //     viewport: { width: 1280, height: 800 },
  //     args: ['-allow-downgrade'],               // <-- silences the dialog if it recurs
  //     firefoxUserPrefs: {
  //       'media.eme.enabled': true,
  //       'media.gmp-widevinecdm.enabled': true,
  //       'media.gmp-widevinecdm.visible': true,
  //       'media.gmp-widevinecdm.forceSupported': true,
  //       'media.autoplay.default': 0,
  //       'media.autoplay.blocking_policy': 0,
  //     }
  //   });

  //   const page = context.pages()[0] || await context.newPage();
  //   await page.goto('https://open.spotify.com', { waitUntil: 'domcontentloaded' });
  //   console.log('Firefox launched (persistent profile)');
  // }









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

// async function playSpotify(url, duration = 30) {
//   const page = await context.newPage();
//   currentPage = page;

//   console.log('Opening playlist:', url);
//   await page.goto(url, { waitUntil: 'networkidle' });
//   await page.waitForTimeout(8000);

//   await page.bringToFront();
//   await page.mouse.move(500, 500);
//   await page.mouse.click(500, 500);
//   await page.waitForTimeout(1000);

//   const playButton = page.locator('button[data-testid="play-button"]').first();
//   if (await playButton.count() > 0) {
//     try {
//       await playButton.click({ force: true });
//       console.log('Play button clicked');
//     } catch (e) {
//       console.log('Click failed, using Space fallback');
//       await page.keyboard.press('Space');
//     }
//   } else {
//     console.log('Play button not found, using Space fallback');
//     await page.keyboard.press('Space');
//   }

//   playStartTime = Date.now();
//   playDurationSeconds = duration * 60;
// }

async function playSpotify(url, duration = 30, userBrowser) {
  const page = await context.newPage();
  currentPage = page;
  const playButton = page.locator('button[data-testid="play-button"]').first();
  const pauseButton =
      page.locator('button[data-testid="control-button-pause"]').first();

  if(userBrowser==='chrome'){
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(8000);

    await page.bringToFront();
    await page.mouse.move(500, 500);
    await page.mouse.click(500, 500);
    await page.waitForTimeout(1000);

    
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
  }else{
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(8000);

    await page.bringToFront();

    //
    // === UNIVERSAL HUMAN GESTURE (IMPORTANT FOR SAFARI + FIREFOX) ===
    //
    await page.mouse.move(200, 300);
    await page.waitForTimeout(300);
    await page.mouse.move(600, 500);
    await page.waitForTimeout(300);
    await page.mouse.click(600, 500);


    let clicked = false;

    if (await playButton.count() > 0) {
      //await page.keyboard.press('Space');
      try {

        await playButton.scrollIntoViewIfNeeded();

        await page.waitForTimeout(500);
        await page.keyboard.press('Space');
        


      } catch (e) {
        await playButton.click({ delay: 250 });
        console.log('Play click failed, fallback keyboard');

      }
    }

    
  }

  console.log('Opening playlist:', url);
  

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
        console.log('Current browser:'+ userBrowser);
        await playSpotify(task.url, currentDuration, userBrowser);
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