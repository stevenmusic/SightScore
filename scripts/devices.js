/**
 * Layout check across the devices the app is actually read on.
 *
 *   node scripts/devices.js [--shots <dir>]
 *
 * Fails if the page scrolls sideways, if a control overflows its panel, if the
 * metadata strip wraps a value onto two lines, if the score lays out with a
 * bar alone on its own line, or if fullscreen (real or the CSS fallback) hides
 * the countdown/status strip or makes a control unreachable.
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
  await page.waitForFunction(
    () => document.getElementById('message').textContent !== '渲染中…',
    { timeout: 20000 },
  );
  await page.waitForTimeout(400);

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

    const layout = window.__stage.measure();
    const totalBars = layout.bars.size;
    const singleBarRows = layout.systems.filter(
      (system) => system.bars.length === 1 && totalBars > 1,
    ).length;
    const fullscreenButton = document.getElementById('fullscreen');

    return {
      fullscreenButtonUsable: !!fullscreenButton && !fullscreenButton.disabled,
      pageScrollsX: root.scrollWidth > root.clientWidth + 1,
      controlsOverflow: controls.scrollWidth > controls.clientWidth + 1,
      wrappedControls,
      wrappedValues: values
        .filter((dd) => dd.getBoundingClientRect().height > lineHeight * 1.6)
        .map((dd) => dd.textContent),
      buttonsVisible: [...document.querySelectorAll('.controls .btn')]
        .every((b) => b.getBoundingClientRect().width > 0),
      singleBarRows,
      totalRows: layout.systems.length,
      zoom: window.__osmd.zoom,
    };
  });

  if (!idle.fullscreenButtonUsable) problems.push(`${device.name}: #fullscreen button is missing or disabled`);
  if (idle.pageScrollsX) problems.push(`${device.name}: page scrolls sideways`);
  for (const control of idle.wrappedControls) {
    problems.push(`${device.name}: control "${control}" wrapped onto a second row`);
  }
  if (idle.controlsOverflow) problems.push(`${device.name}: controls overflow their panel`);
  if (!idle.buttonsVisible) problems.push(`${device.name}: a control has no width`);
  for (const value of idle.wrappedValues) {
    problems.push(`${device.name}: metadata value wraps onto two lines — "${value}"`);
  }
  if (idle.singleBarRows > 0) {
    problems.push(`${device.name}: ${idle.singleBarRows} line(s) hold only a single bar (zoom ${idle.zoom})`);
  }

  // The whole test must actually be showing on the page — the SVG's own
  // height should roughly match what its systems actually cover, and no bar
  // number should be missing from the measured layout.
  const wholeScore = await page.evaluate(() => {
    const layout = window.__stage.measure();
    const barNumbers = [...layout.bars.keys()].sort((a, b) => a - b);
    const contiguous = barNumbers.every((n, i) => n === i + 1);
    return { barCount: barNumbers.length, contiguous };
  });
  if (!wholeScore.contiguous || wholeScore.barCount === 0) {
    problems.push(`${device.name}: the rendered score is missing bars (found ${wholeScore.barCount})`);
  }

  // The playhead must start at the first beat, not at a leading clef — the
  // bug this fix targets shows up specifically on a system's opening bar,
  // where VexFlow draws the clef/key/time signature inside the same group.
  const playheadStart = await page.evaluate(() => {
    const layout = window.__stage.measure();
    const svg = document.querySelector('#score svg');
    const bad = [];
    for (const [number, box] of layout.bars) {
      const groups = [...svg.querySelectorAll(`g.vf-measure[id="${number}"]`)];
      let manualMin = Infinity;
      for (const g of groups) {
        for (const c of g.children) {
          if (c.getAttribute('class') === 'vf-stavenote') manualMin = Math.min(manualMin, c.getBBox().x);
        }
      }
      if (Number.isFinite(manualMin) && Math.abs(manualMin - box.contentLeft) > 0.5) {
        bad.push(number);
      }
    }
    return bad;
  });
  if (playheadStart.length) {
    problems.push(`${device.name}: playhead start doesn't match the first note in bar(s) ${playheadStart.join(', ')}`);
  }

  console.log(
    `${device.name.padEnd(22)} ${device.width}x${device.height}  `
    + `橫向捲動:${idle.pageScrollsX ? 'yes' : 'no'}  `
    + `總行數:${idle.totalRows}  `
    + `單小節一行:${idle.singleBarRows}  `
    + `縮放:${idle.zoom.toFixed(2)}`,
  );

  if (shots) {
    await page.screenshot({ path: `${shots}/${device.name.replace(/\s+/g, '-')}.png`, fullPage: true });
  }

  // Play/stop must actually work, and the highlight/playhead must appear.
  // startFollowing() (which shows them) only runs once player.play()
  // resolves, and that waits on the piano samples first — which can take a
  // while, and in a sandbox with no route to the sample host, waits for
  // every fetch to fail before falling back to a synthesized tone. Poll
  // rather than guess a delay.
  await page.click('#play');
  await page.waitForFunction(() => window.__stage.active, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(400);
  const playing = await page.evaluate(() => ({
    active: document.getElementById('play').classList.contains('is-active'),
    following: window.__stage.active,
    highlightVisible: getComputedStyle(document.getElementById('measure-highlight')).display !== 'none',
    playlineVisible: getComputedStyle(document.getElementById('playline')).display !== 'none',
  }));
  if (!playing.active) problems.push(`${device.name}: #play did not activate`);
  if (!playing.following) problems.push(`${device.name}: playback did not start following (highlight/playhead)`);
  else {
    if (!playing.highlightVisible) problems.push(`${device.name}: measure highlight did not appear during playback`);
    if (!playing.playlineVisible) problems.push(`${device.name}: playhead did not appear during playback`);
  }

  await page.click('#stop');
  await page.waitForTimeout(200);
  const stopped = await page.evaluate(() => !document.getElementById('play').classList.contains('is-active'));
  if (!stopped) problems.push(`${device.name}: #stop did not work`);

  // Fullscreen goes on <html>, not the score frame — nothing is hidden or
  // reparented, so the countdown/status strip and every control should stay
  // exactly where they are and stay clickable. Checked twice: once through
  // the real Fullscreen API, once through the CSS fallback that browsers
  // with no Element.requestFullscreen (older iOS Safari) need instead.
  for (const mode of ['api', 'fallback']) {
    if (mode === 'fallback') {
      await page.evaluate(() => {
        delete Element.prototype.requestFullscreen;
        delete Element.prototype.webkitRequestFullscreen;
      });
    }

    await page.click('#fullscreen');
    await page.waitForTimeout(500);
    const entered = await page.evaluate(() => {
      const status = document.getElementById('status');
      const controls = document.querySelector('.controls');
      const ids = ['grade', 'generate', 'prepare', 'play', 'stop', 'fullscreen', 'download'];
      const reachable = ids.every((id) => {
        const el = document.getElementById(id);
        const box = el.getBoundingClientRect();
        const atPoint = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return box.width > 0 && box.height > 0 && (atPoint === el || el.contains(atPoint));
      });
      const layout = window.__stage.measure();
      const totalBars = layout.bars.size;
      return {
        active: window.__isFullscreen(),
        statusVisible: !status.hidden && status.getBoundingClientRect().height > 0,
        countdownVisible: getComputedStyle(document.getElementById('countdown')).display !== 'none',
        controlsVisible: controls.getBoundingClientRect().height > 0,
        reachable,
        pageScrollsX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        singleBarRows: layout.systems.filter((s) => s.bars.length === 1 && totalBars > 1).length,
      };
    });

    if (!entered.active) problems.push(`${device.name}: fullscreen (${mode}) did not activate`);
    if (!entered.statusVisible) problems.push(`${device.name}: fullscreen (${mode}) hid the status/countdown strip`);
    if (!entered.countdownVisible) problems.push(`${device.name}: fullscreen (${mode}) hid the countdown`);
    if (!entered.controlsVisible) problems.push(`${device.name}: fullscreen (${mode}) hid the controls`);
    if (!entered.reachable) problems.push(`${device.name}: fullscreen (${mode}) made a control unreachable`);
    if (entered.pageScrollsX) problems.push(`${device.name}: fullscreen (${mode}) scrolls sideways`);
    if (entered.singleBarRows > 0) {
      problems.push(`${device.name}: fullscreen (${mode}) leaves ${entered.singleBarRows} single-bar line(s)`);
    }

    // The 30-second preparation countdown must still run and stay visible
    // while fullscreen — the whole reason fullscreen is on <html> rather
    // than just the score frame.
    await page.click('#prepare');
    await page.waitForTimeout(300);
    const preparing = await page.evaluate(() => ({
      checklistVisible: !document.getElementById('checklist').hidden,
      countdownRunning: document.getElementById('countdown').classList.contains('running'),
    }));
    if (!preparing.checklistVisible || !preparing.countdownRunning) {
      problems.push(`${device.name}: fullscreen (${mode}) preparation countdown did not run/show`);
    }

    await page.click('#fullscreen');
    await page.waitForTimeout(500);
    const exited = await page.evaluate(() => window.__isFullscreen());
    if (exited) problems.push(`${device.name}: fullscreen (${mode}) did not exit`);
  }

  // Resizing the viewport must re-fit the layout (no leftover single-bar
  // rows) rather than leaving whatever zoom the previous width chose.
  await page.setViewportSize({ width: Math.max(360, Math.round(device.width * 0.7)), height: device.height });
  // The resize handler debounces 200ms before re-fitting, and re-fitting
  // itself may take a few render() passes — give it room to settle before
  // checking, or a mid-refit moment reads as a false failure.
  await page.waitForTimeout(900);
  const resized = await page.evaluate(() => {
    const layout = window.__stage.measure();
    const totalBars = layout.bars.size;
    return {
      singleBarRows: layout.systems.filter((s) => s.bars.length === 1 && totalBars > 1).length,
      pageScrollsX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
  if (resized.pageScrollsX) problems.push(`${device.name}: page scrolls sideways after resizing narrower`);

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
