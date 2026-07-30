/**
 * Layout check across the devices the app is actually read on.
 *
 *   node scripts/devices.js [--shots <dir>]
 *
 * Fails if the page scrolls sideways, if a control overflows its panel, if the
 * metadata strip wraps a value onto two lines, or if the two-row follow window
 * clips the lower system.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;

const DEVICES = [
  { name: 'iPhone 15 Pro', width: 393, height: 852, scale: 3 },
  { name: 'iPhone 15 Pro Max', width: 430, height: 932, scale: 3 },
  { name: 'iPhone Pro landscape', width: 852, height: 393, scale: 3 },
  { name: 'iPad', width: 820, height: 1180, scale: 2 },
  { name: 'Desktop', width: 1440, height: 900, scale: 2 },
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  let path = join(root, normalize(decodeURIComponent(url.pathname)));
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
  if (!existsSync(path)) return response.writeHead(404).end();
  response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  createReadStream(path).pipe(response);
});

await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const bundled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(bundled) ? { executablePath: bundled } : {});
const problems = [];

for (const device of DEVICES) {
  const page = await browser.newPage({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: device.scale,
  });
  page.on('pageerror', (error) => problems.push(`${device.name}: ${error.message}`));

  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => !document.getElementById('generate').disabled, { timeout: 20000 });
  await page.selectOption('#grade', '5');
  await page.click('#generate');
  await page.waitForFunction(() => document.querySelector('#score svg'), { timeout: 20000 });
  await page.waitForTimeout(500);

  const idle = await page.evaluate(() => {
    const root = document.documentElement;
    const controls = document.querySelector('.controls');
    const meta = document.getElementById('meta');
    const values = [...meta.querySelectorAll('dd')];
    const lineHeight = values.length
      ? parseFloat(getComputedStyle(values[0]).lineHeight) : 0;
    // Every control must sit on the same line as the first one.
    const items = [...controls.children];
    const firstTop = items.length ? items[0].getBoundingClientRect().top : 0;
    const wrappedControls = items
      .filter((item) => Math.abs(item.getBoundingClientRect().top - firstTop) > 4)
      .map((item) => item.id || item.tagName.toLowerCase());

    return {
      pageScrollsX: root.scrollWidth > root.clientWidth + 1,
      controlsOverflow: controls.scrollWidth > controls.clientWidth + 1,
      wrappedControls,
      wrappedValues: values
        .filter((dd) => dd.getBoundingClientRect().height > lineHeight * 1.6)
        .map((dd) => dd.textContent),
      buttonsVisible: [...document.querySelectorAll('.controls .btn')]
        .every((b) => b.getBoundingClientRect().width > 0),
    };
  });

  if (idle.pageScrollsX) problems.push(`${device.name}: page scrolls sideways`);
  for (const control of idle.wrappedControls) {
    problems.push(`${device.name}: control "${control}" wrapped onto a second row`);
  }
  if (idle.controlsOverflow) problems.push(`${device.name}: controls overflow their panel`);
  if (!idle.buttonsVisible) problems.push(`${device.name}: a control has no width`);
  for (const value of idle.wrappedValues) {
    problems.push(`${device.name}: metadata value wraps onto two lines — "${value}"`);
  }

  // Track the stage's actual scrollLeft over time, so a "no problem" result
  // can't be a false negative from scrollLeft simply never having moved.
  await page.evaluate(() => {
    window.__sightscoreMaxScrollLeft = 0;
    window.__sightscoreScrollWatch = setInterval(() => {
      const stage = document.getElementById('stage');
      window.__sightscoreMaxScrollLeft = Math.max(window.__sightscoreMaxScrollLeft, stage.scrollLeft);
    }, 100);
  });

  // The follow window must not clip the lower system's stems. Playback waits
  // on the piano samples, which can take a while (and, in a sandbox with no
  // route to the sample host, waits for every fetch to fail), so poll rather
  // than guess a delay.
  await page.click('#play');
  await page.waitForFunction(
    () => document.getElementById('stage').classList.contains('following'),
    { timeout: 30000 },
  ).catch(() => {});
  await page.waitForTimeout(900);
  const follow = await page.evaluate(() => {
    const stage = document.getElementById('stage');
    const scroller = document.getElementById('scroller');
    if (!stage.classList.contains('following')) return null;
    const stageBox = stage.getBoundingClientRect();
    const svg = document.querySelector('#score svg');
    const shift = new DOMMatrix(getComputedStyle(scroller).transform).m42;

    // Bottom of the lowest system still inside the window, in stage space.
    const rows = new Map();
    for (const measure of svg.querySelectorAll('g.vf-measure')) {
      const box = measure.getBoundingClientRect();
      const key = Math.round(box.top / 20);
      const row = rows.get(key) ?? { top: box.top, bottom: box.bottom };
      rows.set(key, { top: Math.min(row.top, box.top), bottom: Math.max(row.bottom, box.bottom) });
    }
    const visible = [...rows.values()].filter(
      (row) => row.bottom > stageBox.top && row.top < stageBox.bottom,
    );
    const lowest = Math.max(...visible.map((row) => row.bottom));
    // Text above the top system (the tempo word) must be inside the window too.
    const texts = [...svg.querySelectorAll('text')].map((t) => t.getBoundingClientRect());
    const above = texts.filter((box) => box.bottom > stageBox.top - 60 && box.top < stageBox.bottom);
    const clippedTop = above.length ? Math.max(...above.map((box) => stageBox.top - box.top)) : 0;
    // The playhead has to stay inside the stage, or the music stops following
    // it. `.stage` is the actual horizontal scroll container during
    // following (see stage.js), not `.score-frame` — checking the frame here
    // would pass even when the stage never scrolled at all.
    const stageBounds = stage.getBoundingClientRect();
    const lineBox = document.getElementById('playline').getBoundingClientRect();
    const playheadOffscreen = lineBox.left < stageBounds.left - 1 || lineBox.right > stageBounds.right + 1;

    return {
      clipped: lowest - stageBox.bottom, clippedTop, shift, rows: visible.length, playheadOffscreen,
    };
  });

  if (follow === null) {
    problems.push(`${device.name}: playback did not enter the follow view`);
  } else if (follow.clipped > 1) {
    problems.push(`${device.name}: follow window clips the lower system by ${Math.round(follow.clipped)}px`);
  } else if (follow.clippedTop > 1) {
    problems.push(`${device.name}: follow window clips text above the top system by ${Math.round(follow.clippedTop)}px`);
  } else if (follow.playheadOffscreen) {
    problems.push(`${device.name}: the playhead is outside the visible stage`);
  }

  // The stage must actually have scrolled sideways at some point during
  // playback, not just have room to. A wrong ancestor's overflow being
  // checked (or clipped by a mis-set overflow rule) can leave scrollLeft
  // stuck at 0 the entire time while still reporting no other problem.
  const scrolled = await page.evaluate(() => window.__sightscoreMaxScrollLeft > 2);
  if (follow && follow.rows > 0) {
    const stageOverflows = await page.evaluate(() => {
      const stage = document.getElementById('stage');
      return stage.scrollWidth > stage.clientWidth + 1;
    });
    if (stageOverflows && !scrolled) {
      problems.push(`${device.name}: the stage never actually scrolled sideways during playback`);
    }
  }

  console.log(
    `${device.name.padEnd(22)} ${device.width}x${device.height}  `
    + `橫向捲動:${idle.pageScrollsX ? 'yes' : 'no'}  `
    + `跟譜列數:${follow?.rows ?? '-'}  `
    + `下緣裁切:${follow ? `${Math.round(follow.clipped)}px` : '-'}  `
    + `上緣裁切:${follow ? `${Math.round(follow.clippedTop)}px` : '-'}`,
  );

  if (shots) {
    await page.screenshot({ path: `${shots}/${device.name.replace(/\s+/g, '-')}.png`, fullPage: false });
  }

  await page.evaluate(() => clearInterval(window.__sightscoreScrollWatch));

  // Fullscreen, twice: through the API, and through the CSS fallback that iOS
  // Safari needs because it has no Element.requestFullscreen at all.
  await page.click('#stop');
  for (const mode of ['api', 'fallback']) {
    if (mode === 'fallback') {
      await page.evaluate(() => { delete Element.prototype.requestFullscreen; });
    }
    await page.click('#fullscreen');
    await page.waitForTimeout(700);
    const state = await page.evaluate(() => {
      const frame = document.getElementById('score-frame');
      const svg = document.querySelector('#score svg');
      return {
        active: frame.classList.contains('is-fullscreen'),
        fills: frame.getBoundingClientRect().height > window.innerHeight * 0.8,
        fits: svg ? svg.getBoundingClientRect().height <= frame.clientHeight + 2 : false,
      };
    });
    if (!state.active) problems.push(`${device.name}: fullscreen (${mode}) did not activate`);
    else if (!state.fills) problems.push(`${device.name}: fullscreen (${mode}) does not fill the viewport`);
    else if (!state.fits) problems.push(`${device.name}: fullscreen (${mode}) does not fit the whole test`);
    await page.click('#fullscreen');
    await page.waitForTimeout(500);
  }

  // Pressing "prepare" should go fullscreen on its own (the 30-second look at
  // the whole test), the same way #fullscreen does, without needing a second
  // click.
  {
    const before = await page.evaluate(() => document.getElementById('score-frame').classList.contains('is-fullscreen'));
    await page.click('#prepare');
    await page.waitForTimeout(700);
    const duringPrepare = await page.evaluate(() => document.getElementById('score-frame').classList.contains('is-fullscreen'));
    if (before) problems.push(`${device.name}: fullscreen was already active before testing #prepare`);
    if (!duringPrepare) problems.push(`${device.name}: #prepare did not enter fullscreen`);
  }

  // Every necessary action must stay usable while fullscreen — generate,
  // prepare, play, stop, download, grade. Fullscreen (real or the CSS
  // fallback) removes everything outside #score-frame from both view and
  // hit-testing, so before .controls was reparented into the frame, every
  // one of these was visible but literally unclickable: a hit-test at the
  // button's own centre landed on the frame, not the button.
  {
    const reach = await page.evaluate(() => {
      const ids = ['grade', 'generate', 'prepare', 'play', 'stop', 'download'];
      return Object.fromEntries(ids.map((id) => {
        const el = document.getElementById(id);
        const box = el.getBoundingClientRect();
        const atPoint = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return [id, box.width > 0 && box.height > 0 && (atPoint === el || el.contains(atPoint))];
      }));
    });
    for (const [id, reachable] of Object.entries(reach)) {
      if (!reachable) problems.push(`${device.name}: #${id} is not reachable while fullscreen`);
    }
  }

  // Generating a new test must NOT leave fullscreen — that would defeat the
  // point of putting generate inside the frame at all. A real user auditions
  // several tests in a row without dropping out.
  {
    await page.click('#generate');
    await page.waitForFunction(() => document.querySelector('#score svg'), { timeout: 20000 });
    await page.waitForTimeout(400);
    const stillFullscreen = await page.evaluate(() => document.getElementById('score-frame').classList.contains('is-fullscreen'));
    if (!stillFullscreen) problems.push(`${device.name}: generating a new test while fullscreen left fullscreen`);
  }

  // Play and stop must actually work while fullscreen, not just be present.
  {
    await page.click('#play');
    await page.waitForTimeout(600);
    const playing = await page.evaluate(() => document.getElementById('play').classList.contains('is-active'));
    if (!playing) problems.push(`${device.name}: #play did not activate while fullscreen`);
    await page.click('#stop');
    await page.waitForTimeout(300);
    const stopped = await page.evaluate(() => !document.getElementById('play').classList.contains('is-active'));
    if (!stopped) problems.push(`${device.name}: #stop did not work while fullscreen`);
  }

  // Leaving fullscreen must put .controls back exactly where it started —
  // immediately before #status — not merely "somewhere in the body".
  {
    await page.click('#fullscreen');
    await page.waitForTimeout(500);
    const restored = await page.evaluate(() => {
      const controls = document.querySelector('.controls');
      const status = document.getElementById('status');
      return controls.parentElement === document.body && controls.nextElementSibling === status;
    });
    if (!restored) problems.push(`${device.name}: .controls was not restored to its original position on exiting fullscreen`);
  }

  await page.close();
}

await browser.close();
server.close();

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('\nall devices fine');
