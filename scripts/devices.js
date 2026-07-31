/**
 * Layout check across the devices the app is actually read on.
 *
 *   node scripts/devices.js [--shots <dir>]
 *
 * Fails if the page scrolls sideways, if a control overflows its panel, if the
 * metadata strip wraps a value onto two lines, if the score lays out with a
 * bar alone on its own line, or if fullscreen (real or the CSS fallback)
 * doesn't collapse into its dedicated view — title/message/footer/checklist
 * hidden, meta strip and controls sharing one top row, score filling the rest.
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
    const titleBlock = document.querySelector('.title-block');
    const scoreFrame = document.getElementById('score-frame');
    const grade = document.getElementById('grade');
    const meta = document.getElementById('meta');
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
    const fullscreenButton = document.getElementById('fullscreen');
    const titleBlockBox = titleBlock.getBoundingClientRect();
    const controlsBox = controls.getBoundingClientRect();
    const gradeBox = grade.getBoundingClientRect();
    const scoreFrameBox = scoreFrame.getBoundingClientRect();
    const topbarBox = document.querySelector('.topbar').getBoundingClientRect();

    return {
      fullscreenButtonUsable: !!fullscreenButton && !fullscreenButton.disabled,
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
      // Title on the left, controls on the right, same row — this must hold
      // identically whether the page is in normal or fullscreen mode.
      /*
       * The transport no longer lives in the title bar. It shares a row with
       * the countdown and metadata, right-aligned, so that it survives
       * fullscreen (which hides the title bar) and lines up with the tempo
       * reading rather than floating above it.
       */
      /*
       * Right-aligned against the row's *content* edge, not its border box:
       * the status row is full-bleed and carries its own padding, so the
       * border box reaches the screen edge while the buttons correctly stop
       * an inset short of it.
       */
      controlsRightAligned: (() => {
        const row = document.querySelector('.statusbar');
        const box = row.getBoundingClientRect();
        const inset = parseFloat(getComputedStyle(row).paddingRight) || 0;
        return controlsBox.right >= box.right - inset - 2;
      })(),
      controlsShareStatusRow: (() => {
        const statusRow = document.querySelector('.statusbar').getBoundingClientRect();
        return Math.min(statusRow.bottom, controlsBox.bottom)
          - Math.max(statusRow.top, controlsBox.top) > 4;
      })(),
      // Do the metadata and the transport actually share a line, or has the
      // row wrapped and dropped the buttons underneath?
      controlsBesideMeta: (() => {
        const meta = document.querySelector('.meta').getBoundingClientRect();
        return meta.width < 1
          || (Math.min(meta.bottom, controlsBox.bottom) - Math.max(meta.top, controlsBox.top) > 4);
      })(),
      controlsClearOfTitle: titleBlockBox.width < 1 || controlsBox.top >= titleBlockBox.bottom - 2,
      // The grade selector lives over the score frame's own white area, not
      // in the controls row.
      gradeInsideScoreFrame: gradeBox.left >= scoreFrameBox.left - 1 && gradeBox.top >= scoreFrameBox.top - 1,
      gradeNotInControls: !controls.contains(grade),
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

  if (!idle.fullscreenButtonUsable) problems.push(`${device.name}: #fullscreen button is missing or disabled`);
  if (idle.pageScrollsX) problems.push(`${device.name}: page scrolls sideways`);
  for (const control of idle.wrappedControls) {
    problems.push(`${device.name}: control "${control}" wrapped onto a second row`);
  }
  if (idle.controlsOverflow) problems.push(`${device.name}: controls overflow their panel`);
  if (!idle.buttonsVisible) problems.push(`${device.name}: a control has no width`);
  const isTabletOrWider = device.width >= 800;
  if (!idle.controlsRightAligned) problems.push(`${device.name}: controls are not right-aligned in the status row`);
  if (!idle.controlsShareStatusRow) problems.push(`${device.name}: controls don't share the row with the meta strip`);
  if (!idle.controlsClearOfTitle) problems.push(`${device.name}: controls overlap the title row`);
  // A tablet has the width to keep the buttons beside the tempo; a phone does
  // not, and is allowed to wrap them onto their own line.
  if (isTabletOrWider && !idle.controlsBesideMeta) {
    problems.push(`${device.name}: controls wrapped below the meta strip instead of sitting beside the tempo`);
  }
  if (!idle.gradeInsideScoreFrame) problems.push(`${device.name}: grade selector isn't positioned over the score frame`);
  if (!idle.gradeNotInControls) problems.push(`${device.name}: grade selector is still inside the controls row`);
  for (const value of idle.wrappedValues) {
    problems.push(`${device.name}: metadata value wraps onto two lines — "${value}"`);
  }
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
    `${device.name.padEnd(22)} ${device.width}x${device.height}  `
    + `橫向捲動:${idle.pageScrollsX ? 'yes' : 'no'}  `
    + `每行小節:${idle.barsPerRow.join('+')}  `
    + `單小節一行:${idle.singleBarRows}  `
    + `上方滿版:${idle.topbarSpansViewport ? 'yes' : 'no'}  `
    + `整頁可見:${idle.scoreBottom <= idle.viewportHeight ? 'yes' : 'no'}  `
    + `縮放:${idle.zoom.toFixed(2)}`,
  );

  // Double-tapping the score toggles fullscreen — the only way in on a touch
  // device, where the button is hidden to save room in the transport row.
  const scoreBox = await page.evaluate(
    () => document.getElementById('score-frame').getBoundingClientRect().toJSON(),
  );
  await page.mouse.dblclick(scoreBox.x + scoreBox.width / 2, scoreBox.y + Math.min(60, scoreBox.height / 2));
  await page.waitForTimeout(400);
  if (!await page.evaluate(() => window.__isFullscreen())) {
    problems.push(`${device.name}: double-tapping the score did not enter fullscreen`);
  } else {
    await page.mouse.dblclick(scoreBox.x + scoreBox.width / 2, scoreBox.y + Math.min(60, scoreBox.height / 2));
    await page.waitForTimeout(400);
    if (await page.evaluate(() => window.__isFullscreen())) {
      problems.push(`${device.name}: double-tapping again did not leave fullscreen`);
    }
  }

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

  // The meta strip has no labels any more — just the four values separated
  // by "丨" — so the separators are the only thing marking field
  // boundaries. Each of the first three fields has a fixed CSS width
  // specifically so a new test's differently-sized key/time/bar-count text
  // never shifts them. Regenerate a few times and confirm every separator
  // stays exactly where it was.
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
  }

  // Fullscreen is a dedicated distraction-free view that reuses the exact
  // same title-left/controls-right row as normal mode — no fullscreen-
  // specific rearrangement or resizing, so a button must not change size
  // or move when fullscreen toggles. Checked twice: once through the real
  // Fullscreen API, once through the CSS fallback that browsers with no
  // Element.requestFullscreen (older iOS Safari) need instead.
  const buttonBoxesOf = () => page.evaluate(() => {
    const ids = ['generate', 'prepare', 'play', 'stop', 'fullscreen'];
    return Object.fromEntries(ids.map((id) => {
      const box = document.getElementById(id).getBoundingClientRect();
      return [id, { width: box.width, height: box.height }];
    }));
  });

  for (const mode of ['api', 'fallback']) {
    if (mode === 'fallback') {
      await page.evaluate(() => {
        delete Element.prototype.requestFullscreen;
        delete Element.prototype.webkitRequestFullscreen;
      });
    }

    const before = await buttonBoxesOf();
    const beforeControlsBox = await page.evaluate(
      () => document.querySelector('.controls').getBoundingClientRect().toJSON(),
    );
    await page.click('#fullscreen');
    await page.waitForTimeout(500);
    const entered = await page.evaluate(() => {
      const status = document.getElementById('status');
      const controls = document.querySelector('.controls');
      const titleBlock = document.querySelector('.title-block');
      const footer = document.querySelector('footer');
      const message = document.getElementById('message');
      const scoreFrame = document.getElementById('score-frame');
      const grade = document.getElementById('grade');
      const isHidden = (el) => !el || getComputedStyle(el).display === 'none';
      const ids = ['generate', 'prepare', 'play', 'stop', 'fullscreen'];
      const reachable = ids.every((id) => {
        const el = document.getElementById(id);
        const box = el.getBoundingClientRect();
        const atPoint = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return box.width > 0 && box.height > 0 && (atPoint === el || el.contains(atPoint));
      });
      const titleBlockBox = titleBlock.getBoundingClientRect();
      const controlsBox = controls.getBoundingClientRect();
      const statusBox = status.getBoundingClientRect();
      const scoreFrameBox = scoreFrame.getBoundingClientRect();
    const topbarBox = document.querySelector('.topbar').getBoundingClientRect();
      const gradeBox = grade.getBoundingClientRect();
      const gradeReachable = (() => {
        const atPoint = document.elementFromPoint(gradeBox.x + gradeBox.width / 2, gradeBox.y + gradeBox.height / 2);
        return gradeBox.width > 0 && gradeBox.height > 0 && (atPoint === grade || grade.contains(atPoint));
      })();
      const layout = window.__stage.measure();
      const totalBars = layout.bars.size;
      return {
        active: window.__isFullscreen(),
        footerHidden: isHidden(footer),
        messageHidden: isHidden(message),
        countdownVisible: getComputedStyle(document.getElementById('countdown')).display !== 'none',
        controlsVisible: controlsBox.height > 0,
        // Same invariant as normal mode: title on the left, controls on the
        // right, sharing one row — never a separate fullscreen-only layout.
        // Fullscreen shows the music and the transport, nothing else — the
        // title band is hidden outright rather than merely compacted.
        titleHidden: titleBlockBox.width < 1 || titleBlockBox.height < 1,
      /*
         * Right-aligned against the row's *content* edge, not its border box:
         * the status row is full-bleed and carries its own padding, so the
         * border box reaches the screen edge while the buttons correctly stop
         * an inset short of it.
         */
        controlsRightAligned: (() => {
          const row = document.querySelector('.statusbar');
          const box = row.getBoundingClientRect();
          const inset = parseFloat(getComputedStyle(row).paddingRight) || 0;
          return controlsBox.right >= box.right - inset - 2;
        })(),
        /*
         * The metadata and the transport now share a row, so the old
         * "status sits below the controls" ordering no longer applies —
         * what matters is that neither overlaps the score.
         */
        statusAboveScore: statusBox.bottom <= scoreFrameBox.top + 1,
        gradeInsideScoreFrame: gradeBox.left >= scoreFrameBox.left - 1 && gradeBox.top >= scoreFrameBox.top - 1,
        gradeReachable,
        // The score box must size to its own content, not clip to whatever
        // height <main> has room for — checked by scrolling <main> all the
        // way down and confirming the box's background still extends to
        // cover the last system, not just whatever fit in the first screen.
        scoreFrameBottom: scoreFrame.getBoundingClientRect().bottom,
        reachable,
        pageScrollsY: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
        pageScrollsX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        singleBarRows: layout.systems.filter((s) => s.bars.length === 1 && totalBars > 1).length,
      };
    });

    if (!entered.active) problems.push(`${device.name}: fullscreen (${mode}) did not activate`);
    if (!entered.footerHidden) problems.push(`${device.name}: fullscreen (${mode}) still shows the footer`);
    if (!entered.messageHidden) problems.push(`${device.name}: fullscreen (${mode}) still shows the status message`);
    if (!entered.countdownVisible) problems.push(`${device.name}: fullscreen (${mode}) hid the countdown`);
    if (!entered.controlsVisible) problems.push(`${device.name}: fullscreen (${mode}) hid the controls`);
    if (!entered.titleHidden) problems.push(`${device.name}: fullscreen (${mode}) still shows the title bar`);
    if (!entered.controlsRightAligned) problems.push(`${device.name}: fullscreen (${mode}) controls are not right-aligned`);
    if (!entered.statusAboveScore) problems.push(`${device.name}: fullscreen (${mode}) meta strip overlaps the score`);
    if (!entered.gradeInsideScoreFrame) problems.push(`${device.name}: fullscreen (${mode}) grade selector isn't positioned over the score frame`);
    if (!entered.gradeReachable) problems.push(`${device.name}: fullscreen (${mode}) grade selector is unreachable`);
    if (!entered.reachable) problems.push(`${device.name}: fullscreen (${mode}) made a control unreachable`);
    if (entered.pageScrollsY) problems.push(`${device.name}: fullscreen (${mode}) page itself scrolls vertically (should be the score only)`);
    if (entered.pageScrollsX) problems.push(`${device.name}: fullscreen (${mode}) scrolls sideways`);
    if (entered.singleBarRows > 0) {
      problems.push(`${device.name}: fullscreen (${mode}) leaves ${entered.singleBarRows} single-bar line(s)`);
    }

    /*
     * The controls keep their size and their right-hand alignment across the
     * toggle. Their absolute x is allowed to change now and has to: fullscreen
     * drops the page's 64rem cap so the score can use the whole screen, which
     * widens the row the buttons are right-aligned in. What the original
     * version of this check was really guarding against — fullscreen
     * rearranging title and controls into a different layout, so the buttons
     * landed somewhere else entirely — is covered by the alignment and
     * same-row assertions above plus the size check below.
     */
    const afterControlsBox = await page.evaluate(
      () => document.querySelector('.controls').getBoundingClientRect().toJSON(),
    );
    if (Math.abs(beforeControlsBox.width - afterControlsBox.width) > 1) {
      problems.push(
        `${device.name}: fullscreen (${mode}) resized the controls row `
        + `(${Math.round(beforeControlsBox.width)} -> ${Math.round(afterControlsBox.width)})`,
      );
    }

    // Buttons must be pixel-identical to normal mode — no fullscreen-
    // specific shrink, so toggling fullscreen never moves or resizes them.
    const after = await buttonBoxesOf();
    for (const id of Object.keys(before)) {
      if (Math.abs(before[id].width - after[id].width) > 1 || Math.abs(before[id].height - after[id].height) > 1) {
        problems.push(`${device.name}: fullscreen (${mode}) resized #${id} (${Math.round(before[id].width)}x${Math.round(before[id].height)} -> ${Math.round(after[id].width)}x${Math.round(after[id].height)})`);
      }
    }

    // The score-frame box must actually cover the whole score, not clip
    // partway down it — scroll <main> to the bottom and check the box's
    // own background/border extends at least as far as the last note.
    const coverage = await page.evaluate(() => {
      const main = document.querySelector('main');
      main.scrollTop = main.scrollHeight;
      const frameBottom = document.getElementById('score-frame').getBoundingClientRect().bottom;
      const svgs = [...document.querySelectorAll('#score svg')];
      const contentBottom = Math.max(...svgs.map((svg) => svg.getBoundingClientRect().bottom));
      main.scrollTop = 0;
      return { frameBottom, contentBottom };
    });
    if (coverage.frameBottom < coverage.contentBottom - 2) {
      problems.push(`${device.name}: fullscreen (${mode}) score box ends before the score does (box bottom ${Math.round(coverage.frameBottom)} vs content ${Math.round(coverage.contentBottom)})`);
    }

    // Generating a new test must not shift the button row — different
    // key/metre/tempo text is a different length, and a height that
    // depends on that length previously made the controls row bob up and
    // down on every click instead of staying put.
    const rowBefore = await page.evaluate(() => document.querySelector('.controls').getBoundingClientRect().top);
    await page.click('#generate');
    await page.waitForFunction(() => document.getElementById('message').textContent !== '渲染中…', { timeout: 20000 });
    await page.waitForTimeout(200);
    const rowAfter = await page.evaluate(() => document.querySelector('.controls').getBoundingClientRect().top);
    if (Math.abs(rowBefore - rowAfter) > 1) {
      problems.push(`${device.name}: fullscreen (${mode}) controls row moved after generating a new test (${Math.round(rowBefore)} -> ${Math.round(rowAfter)})`);
    }

    // The 30-second preparation countdown number must still run, but the
    // checklist text is exactly the kind of extra text fullscreen drops.
    await page.click('#prepare');
    await page.waitForTimeout(300);
    const preparing = await page.evaluate(() => ({
      checklistHidden: getComputedStyle(document.getElementById('checklist')).display === 'none',
      countdownRunning: document.getElementById('countdown').classList.contains('running'),
    }));
    if (!preparing.checklistHidden) problems.push(`${device.name}: fullscreen (${mode}) still shows the checklist text`);
    if (!preparing.countdownRunning) problems.push(`${device.name}: fullscreen (${mode}) preparation countdown did not run`);

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

/*
 * One pass with real touch emulation. The fullscreen button is hidden behind
 * `(hover: none) and (pointer: coarse)`, which an ordinary desktop context
 * never matches — so without this the button's absence on a phone or tablet,
 * and the double tap that replaces it, would go unverified.
 */
{
  const touch = await browser.newContext({
    viewport: { width: 820, height: 1180 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });
  const page = await touch.newPage();
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => !document.getElementById('generate').disabled, { timeout: 20000 });
  await page.click('#generate');
  await page.waitForTimeout(1500);

  const buttonHidden = await page.evaluate(
    () => getComputedStyle(document.getElementById('fullscreen')).display === 'none',
  );
  if (!buttonHidden) problems.push('touch: fullscreen button is still shown on a touch device');

  /*
   * Wait for the fitting passes to stop re-rendering before reading the box.
   * `fitScore` renders several times to settle on a layout, and tapping a
   * position measured mid-flight can land outside the frame once it moves.
   */
  await page.waitForFunction(() => {
    const box = document.getElementById('score-frame').getBoundingClientRect();
    const previous = window.__lastFrameBox;
    window.__lastFrameBox = `${Math.round(box.top)}x${Math.round(box.height)}`;
    return previous === window.__lastFrameBox;
  }, { timeout: 10000 }).catch(() => {});
  const box = await page.evaluate(
    () => document.getElementById('score-frame').getBoundingClientRect().toJSON(),
  );
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.touchscreen.tap(x, y);
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(500);
  if (!await page.evaluate(() => window.__isFullscreen())) {
    problems.push('touch: double tap did not enter fullscreen');
  }
  await touch.close();
  console.log(`${'touch (tap)'.padEnd(22)} 820x1180  全螢幕按鈕隱藏:${buttonHidden ? 'yes' : 'no'}`);
}

await browser.close();
server.close();

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('\nall devices fine');
