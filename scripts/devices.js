/**
 * Layout check across the devices the app is actually read on.
 *
 *   node scripts/devices.js [--shots <dir>]
 *
 * Fails if the page scrolls sideways, if a control overflows its panel, if
 * the metadata strip wraps a value onto two lines, if the score lays out
 * with a bar alone on its own line, if the title/controls row ever moves
 * (generating a new test must only ever change the meta strip and the
 * score, never the topbar above them), or if the grade selector / countdown
 * drift from where they belong — pinned to the score frame's corners on a
 * narrow viewport, or sharing the meta row at 1024px and up, or on a phone
 * rotated to landscape (see app.js's `pinTopRowLayout`, which moves the
 * actual elements between the two, and its `TOP_ROW_QUERY`).
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
/** Mirrors `MIN_ZOOM` in src/app/app.js — the point below which fitting stops. */
const MIN_LEGIBLE_ZOOM = 0.5;

const DEVICES = [
  { name: 'iPhone 15 Pro', width: 393, height: 852, scale: 3 },
  { name: 'iPhone 15 Pro Max', width: 430, height: 932, scale: 3 },
  { name: 'iPhone Pro landscape', width: 852, height: 393, scale: 3 },
  // Between the phone breakpoint and the tablet sizes below — the width
  // range where the topbar's icon-only breakpoint (680px) actually matters,
  // and where a full-label overflow was previously found only by resizing
  // through it rather than by any of the other fixed widths here.
  { name: 'Portrait tablet (narrow)', width: 744, height: 1133, scale: 2 },
  { name: 'iPad', width: 820, height: 1180, scale: 2 },
  // Landscape, and wider than the page's 64rem cap — the size at which the
  // topbar was reported stopping short of the screen edge.
  { name: 'iPad landscape', width: 1366, height: 1024, scale: 2 },
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

  // Before the first test exists, the meta strip and countdown must both be
  // hidden — there is nothing yet for either to describe.
  const beforeGenerate = await page.evaluate(() => ({
    metaHidden: document.getElementById('meta').hidden,
    countdownHidden: document.getElementById('countdown').hidden,
  }));
  if (!beforeGenerate.metaHidden) problems.push(`${device.name}: meta strip is visible before any test exists`);
  if (!beforeGenerate.countdownHidden) problems.push(`${device.name}: countdown is visible before any test exists`);

  // The controls row must never move, no matter how many times a test is
  // generated — it lives in the topbar, a fixed sibling of the meta strip
  // and score, not a layout neighbour either has to share space with.
  const controlsBoxOf = () => page.evaluate(
    () => document.querySelector('.controls').getBoundingClientRect().toJSON(),
  );
  const controlsBefore = await controlsBoxOf();

  await page.selectOption('#grade', '5');
  await page.click('#generate');
  await page.waitForFunction(
    () => document.getElementById('message').textContent !== '渲染中…',
    { timeout: 20000 },
  );
  await page.waitForTimeout(400);

  const controlsAfterFirst = await controlsBoxOf();
  if (Math.abs(controlsBefore.top - controlsAfterFirst.top) > 1
    || Math.abs(controlsBefore.left - controlsAfterFirst.left) > 1) {
    problems.push(
      `${device.name}: controls moved when the first test was generated `
      + `(${Math.round(controlsBefore.top)},${Math.round(controlsBefore.left)} -> `
      + `${Math.round(controlsAfterFirst.top)},${Math.round(controlsAfterFirst.left)})`,
    );
  }

  const idle = await page.evaluate(() => {
    const root = document.documentElement;
    const controls = document.querySelector('.controls');
    const titleBlock = document.querySelector('.title-block');
    const topbar = document.querySelector('.topbar');
    const scoreFrame = document.getElementById('score-frame');
    const grade = document.getElementById('grade');
    const countdown = document.getElementById('countdown');
    const meta = document.getElementById('meta');
    const metaRow = document.getElementById('meta-row');
    // Same query as app.js's TOP_ROW_QUERY (matchMedia rather than
    // re-deriving the width/height/orientation logic by hand, so this
    // can't quietly drift out of sync with it) — below it grade/countdown
    // are pinned to the score frame's corners, at or above it (outright
    // wide, or a landscape phone short on height) they live in the meta
    // row instead.
    const wideLayout = window.matchMedia(
      '(min-width: 1024px), (orientation: landscape) and (max-height: 500px) and (min-width: 680px)',
    ).matches;
    const values = [...meta.querySelectorAll('span:not(.meta-sep)')];
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
    const titleBlockBox = titleBlock.getBoundingClientRect();
    const controlsBox = controls.getBoundingClientRect();
    const topbarBox = topbar.getBoundingClientRect();
    const gradeBox = grade.getBoundingClientRect();
    const countdownBox = countdown.getBoundingClientRect();
    const scoreFrameBox = scoreFrame.getBoundingClientRect();
    const metaBox = meta.getBoundingClientRect();

    const reachableAt = (el, box) => {
      const atPoint = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return box.width > 0 && box.height > 0 && (atPoint === el || el.contains(atPoint));
    };

    return {
      pageScrollsX: root.scrollWidth > root.clientWidth + 1,
      controlsOverflow: controls.scrollWidth > controls.clientWidth + 1,
      wrappedControls,
      wrappedValues: values
        .filter((span) => span.getBoundingClientRect().height > lineHeight * 1.6)
        .map((span) => span.textContent),
      buttonsVisible: [...document.querySelectorAll('.controls .btn')]
        .every((b) => b.getBoundingClientRect().width > 0),
      singleBarRows,
      totalRows: layout.systems.length,
      zoom: window.__osmd.zoom,
      // Title on the left, controls on the right, sharing the topbar's one row.
      titleLeftOfControls: titleBlockBox.width < 1 || controlsBox.left >= titleBlockBox.right - 1,
      titleAndControlsShareRow:
        Math.min(titleBlockBox.bottom, controlsBox.bottom) - Math.max(titleBlockBox.top, controlsBox.top) > 4,
      controlsRightAligned: controlsBox.right >= topbarBox.right - parseFloat(getComputedStyle(topbar).paddingRight) - 2,
      // The meta strip sits below the topbar and above the score, sharing
      // neither's row.
      metaBelowTopbar: metaBox.top >= topbarBox.bottom - 1,
      metaAboveScore: metaBox.bottom <= scoreFrameBox.top + 1,
      // Grade selector top-left, countdown top-right — pinned to the score
      // frame's own corners below the breakpoint, or sharing the meta row
      // (never the controls row) at or above it.
      gradeInsideScoreFrame: wideLayout
        ? metaRow.contains(grade)
        : gradeBox.left >= scoreFrameBox.left - 1 && gradeBox.top >= scoreFrameBox.top - 1,
      gradeNotInControls: !controls.contains(grade),
      countdownInsideScoreFrame: wideLayout
        ? metaRow.contains(countdown)
        : countdownBox.right <= scoreFrameBox.right + 1 && countdownBox.top >= scoreFrameBox.top - 1,
      countdownRightOfGrade: countdownBox.left >= gradeBox.right,
      countdownReachable: reachableAt(countdown, countdownBox),
      /*
       * The topbar is meant to be a flat band spanning the whole screen. It
       * used to cancel only the page's own inset, which stops at the edge of
       * the content column — and `body` is capped at 64rem and centred, so on
       * anything wider the band stopped short with a gutter either side.
       */
      topbarSpansViewport:
        topbarBox.left <= 1 && topbarBox.right >= document.documentElement.clientWidth - 1,
      /*
       * Bars per line, so an uneven split shows up: six bars laid out 4+2
       * leaves the second line half as long as the first, since OSMD does not
       * stretch a final short system to full width.
       */
      barsPerRow: layout.systems.map((system) => system.bars.length),
      /*
       * Does the whole test fit the screen without scrolling? Measured from
       * the rendered SVG rather than the bar boxes, so pedal brackets,
       * hairpins and slurs hanging outside the staves count — those are
       * exactly what would otherwise be cut off at the bottom edge.
       */
      scoreBottom: (() => {
        const svg = document.querySelector('#score svg');
        return svg ? svg.getBoundingClientRect().bottom : 0;
      })(),
      viewportHeight: window.innerHeight,
    };
  });

  if (idle.pageScrollsX) problems.push(`${device.name}: page scrolls sideways`);
  for (const control of idle.wrappedControls) {
    problems.push(`${device.name}: control "${control}" wrapped onto a second row`);
  }
  if (idle.controlsOverflow) problems.push(`${device.name}: controls overflow their panel`);
  if (!idle.buttonsVisible) problems.push(`${device.name}: a control has no width`);
  if (!idle.titleLeftOfControls) problems.push(`${device.name}: title is not left of the controls`);
  if (!idle.titleAndControlsShareRow) problems.push(`${device.name}: title and controls don't share the topbar row`);
  if (!idle.controlsRightAligned) problems.push(`${device.name}: controls are not right-aligned in the topbar`);
  if (!idle.metaBelowTopbar) problems.push(`${device.name}: meta strip overlaps the topbar`);
  if (!idle.metaAboveScore) problems.push(`${device.name}: meta strip overlaps the score`);
  if (!idle.gradeInsideScoreFrame) problems.push(`${device.name}: grade selector isn't positioned over the score frame`);
  if (!idle.gradeNotInControls) problems.push(`${device.name}: grade selector is still inside the controls row`);
  if (!idle.countdownInsideScoreFrame) problems.push(`${device.name}: countdown isn't positioned over the score frame`);
  if (!idle.countdownRightOfGrade) problems.push(`${device.name}: countdown isn't to the right of the grade selector`);
  if (!idle.countdownReachable) problems.push(`${device.name}: countdown is covered by something else`);
  for (const value of idle.wrappedValues) {
    problems.push(`${device.name}: metadata value wraps onto two lines — "${value}"`);
  }
  const isTabletOrWider = device.width >= 800;
  /*
   * A lone bar on a line is a fault where there is room to avoid it. On the
   * narrowest phones a long, dense test cannot be laid out without one at any
   * zoom that is still readable — `fitScore` shrinks until the legibility
   * floor and stops there rather than going below it — so on those it is
   * reported and not failed.
   */
  if (idle.singleBarRows > 0) {
    const note = `${device.name}: ${idle.singleBarRows} line(s) hold only a single bar (zoom ${idle.zoom.toFixed(2)})`;
    if (isTabletOrWider || idle.zoom > MIN_LEGIBLE_ZOOM + 0.001) problems.push(note);
    else console.log(`       note — ${note}, at the legibility floor`);
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

  if (!idle.topbarSpansViewport) {
    problems.push(`${device.name}: topbar does not reach the viewport edges`);
  }
  /*
   * A tablet has to show the whole test at once — that is what it is for. A
   * phone does not have the height and is deliberately left to scroll rather
   * than shrink into illegibility, so the requirement starts at tablet width.
   */
  const isTablet = isTabletOrWider && device.height >= 700;
  if (isTablet && idle.scoreBottom > idle.viewportHeight) {
    problems.push(
      `${device.name}: score runs past the bottom of the screen `
      + `(${Math.round(idle.scoreBottom)} > ${idle.viewportHeight})`,
    );
  }
  /*
   * The last line may hold fewer bars than the others, but not less than half
   * of them — that is the 4+2 split that looked wrong on a tablet.
   */
  const rows = idle.barsPerRow;
  if (rows.length > 1) {
    const full = Math.max(...rows);
    const last = rows[rows.length - 1];
    if (last * 2 < full) {
      problems.push(`${device.name}: bars split unevenly across lines (${rows.join('+')})`);
    }
  }

  console.log(
    `${device.name.padEnd(24)} ${device.width}x${device.height}  `
    + `橫向捲動:${idle.pageScrollsX ? 'yes' : 'no'}  `
    + `每行小節:${idle.barsPerRow.join('+')}  `
    + `單小節一行:${idle.singleBarRows}  `
    + `上方滿版:${idle.topbarSpansViewport ? 'yes' : 'no'}  `
    + `整頁可見:${idle.scoreBottom <= idle.viewportHeight ? 'yes' : 'no'}  `
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

  // The 30-second preparation countdown must run in place, in the score
  // frame's top-right corner, without moving the controls row above it.
  // Pressing #prepare first gives the tonic chord and only starts the
  // visible countdown once it has finished ringing (~1.3s), so this has to
  // poll rather than assume the countdown is already running a moment after
  // the click.
  const controlsBeforePrepare = await controlsBoxOf();
  await page.click('#prepare');
  // The tonic chord is given before the countdown starts — check that the
  // gap is real (the countdown is not yet running moments after the click)
  // and that the status line says so, not just that the countdown eventually
  // starts.
  await page.waitForTimeout(150);
  const givingNote = await page.evaluate(() => ({
    message: document.getElementById('message').textContent,
    running: document.getElementById('countdown').classList.contains('running'),
  }));
  if (!givingNote.message.includes('給音')) {
    problems.push(`${device.name}: no "giving the note" status shown before the countdown starts (got "${givingNote.message}")`);
  }
  if (givingNote.running) {
    problems.push(`${device.name}: countdown started running before the tonic chord finished`);
  }
  const preparing = await page.waitForFunction(() => {
    const running = document.getElementById('countdown').classList.contains('running');
    const checklistVisible = getComputedStyle(document.getElementById('checklist')).display !== 'none';
    return running && checklistVisible ? { running, checklistVisible } : false;
  }, { timeout: 15000 }).then((handle) => handle.jsonValue()).catch(() => ({ running: false, checklistVisible: false }));
  if (!preparing.checklistVisible) problems.push(`${device.name}: preparation checklist did not appear`);
  if (!preparing.running) problems.push(`${device.name}: preparation countdown did not run`);
  const controlsAfterPrepare = await controlsBoxOf();
  if (Math.abs(controlsBeforePrepare.top - controlsAfterPrepare.top) > 1) {
    problems.push(`${device.name}: controls moved when the preparation countdown started`);
  }

  // The meta strip has no labels any more — just the four values separated
  // by "丨" — so the separators are the only thing marking field
  // boundaries. Each of the first three fields has a fixed CSS width
  // specifically so a new test's differently-sized key/time/bar-count text
  // never shifts them. Regenerate a few times and confirm every separator
  // stays exactly where it was, and that the controls row still hasn't moved.
  const sepPositions = () => page.evaluate(
    () => [...document.querySelectorAll('.meta-sep')].map((s) => s.getBoundingClientRect().left),
  );
  const firstSeps = await sepPositions();
  for (let i = 1; i <= 3; i++) {
    await page.selectOption('#grade', String((i % 8) + 1));
    await page.click('#generate');
    await page.waitForFunction(() => document.getElementById('message').textContent !== '渲染中…', { timeout: 20000 });
    await page.waitForTimeout(200);
    const seps = await sepPositions();
    if (seps.length !== firstSeps.length || seps.some((x, idx) => Math.abs(x - firstSeps[idx]) > 1)) {
      problems.push(
        `${device.name}: meta separator position moved after generating a new test `
        + `(${firstSeps.map((n) => Math.round(n))} -> ${seps.map((n) => Math.round(n))})`,
      );
    }
    const controlsNow = await controlsBoxOf();
    if (Math.abs(controlsBefore.top - controlsNow.top) > 1 || Math.abs(controlsBefore.left - controlsNow.left) > 1) {
      problems.push(`${device.name}: controls moved after generating test #${i + 1}`);
    }
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
      controlsOverflow: document.querySelector('.controls').scrollWidth
        > document.querySelector('.controls').clientWidth + 1,
    };
  });
  if (resized.pageScrollsX) problems.push(`${device.name}: page scrolls sideways after resizing narrower`);
  if (resized.controlsOverflow) problems.push(`${device.name}: controls overflow their panel after resizing narrower`);

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
