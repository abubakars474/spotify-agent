const { chromium } = require('playwright');

let context;
let currentPage = null;
let currentTaskId = null;

let playStartTime = null;
let currentDuration = null;

//
// CONNECT TO CHROME
//
async function startBrowser() {

  const browser = await chromium.connectOverCDP(
    'http://localhost:9222'
  );

  context = browser.contexts()[0];

  console.log('Connected to existing Chrome');
}

//
// TASK
//
async function fetchTask() {

  return {
    status: 'play',
    task_id: 1,
    url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
  };
}

//
// PLAY
//
// async function playSpotify(url, duration = 30) {

//   const page = await context.newPage();
//   currentPage = page;

//   console.log('Opening Spotify:', url);

//   await page.goto(url, { waitUntil: 'networkidle' });

//   await page.waitForTimeout(8000);

//   await page.bringToFront();

//   await page.mouse.click(500, 500);

//   const playButton = page
//     .locator('button[data-testid="play-button"]')
//     .first();

//   await playButton.click();

//   console.log('Playback started');

//   playStartTime = Date.now();
//   currentDuration = duration * 1000;
// }
async function playSpotify(url, duration = 30) {

  //
  // FIND EXISTING SPOTIFY TAB
  //
  const pages = context.pages();

  let spotifyPage = pages.find(p =>
    p.url().includes('open.spotify.com')
  );

  //
  // IF NOT FOUND CREATE ONE
  //
  if (!spotifyPage) {

    spotifyPage = await context.newPage();

    await spotifyPage.goto(
      'https://open.spotify.com',
      {
        waitUntil: 'domcontentloaded'
      }
    );

    await spotifyPage.waitForTimeout(8000);
  }

  //
  // ACTIVATE EXISTING TAB
  //
  await spotifyPage.bringToFront();

  await spotifyPage.mouse.move(400, 400);

  await spotifyPage.mouse.click(400, 400);

  await spotifyPage.waitForTimeout(2000);

  //
  // NOW OPEN PLAYLIST
  //
  const page = await context.newPage();

  currentPage = page;

  console.log('Opening playlist:', url);

  await page.goto(url, {
    waitUntil: 'networkidle'
  });

  //
  // WAIT UI
  //
  await page.waitForTimeout(8000);

  //
  // ACTIVATE PAGE
  //
  await page.bringToFront();

  await page.mouse.move(500, 500);

  await page.mouse.click(500, 500);

  await page.waitForTimeout(1000);

  //
  // FIND PLAY BUTTON
  //
  // const playButton = page
  //   .locator('button[data-testid="play-button"]')
  //   .first();

  //
  // WAIT BUTTON
  //
  // await playButton.waitFor({
  //   timeout: 15000
  // });

  //
  // CLICK PLAY
  //
  // await playButton.click({
  //   force: true
  // });

  const playButton = page.locator('button[data-testid="play-button"]').first();

  if (await playButton.count() > 0) {
    try {
      await playButton.click({ force: true });
      console.log('Play button clicked');
    } catch (e) {
      console.log('Click failed, fallback used');
      await page.keyboard.press('Space');
    }
  } else {
    console.log('Play button not found, using fallback');
    await page.keyboard.press('Space');
  }

  
  console.log('Playback started');

  //
  // TIMER
  //
  playStartTime = Date.now();

  currentDuration = duration * 1000;
}

//
// STOP
//
async function stopPlayback() {

  if (!currentPage) return;

  console.log('Closing tab');

  await currentPage.close().catch(() => {});

  currentPage = null;
  currentTaskId = null;
}

//
// DELAY
//
function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

//
// LOOP
//
async function runLoop() {

  while (true) {

    try {

      // AUTO STOP
      if (currentPage && playStartTime && currentDuration) {

        const elapsed = Date.now() - playStartTime;

        if (elapsed >= currentDuration) {

          console.log('⏱ 30 sec finished');

          await stopPlayback();

          playStartTime = null;
          currentDuration = null;
        }
      }

      const task = await fetchTask();

      if (!task) {
        await delay(3000);
        continue;
      }

      if (task.status === 'stop') {
        await stopPlayback();
      }

      if (task.status === 'play') {

        if (task.task_id !== currentTaskId) {

          await stopPlayback();

          currentTaskId = task.task_id;

          await playSpotify(task.url, 30);
        }
      }

    } catch (err) {
      console.log('Loop error:', err.message);
    }

    await delay(2000);
  }
}

//
// START
//
(async () => {

  await startBrowser();

  await runLoop();

})();