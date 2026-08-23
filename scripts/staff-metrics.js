/**
 * Measures staff geometry across many generated tests: the gap between staff
 * lines, and the on-screen y of the treble and bass staves. A reader should
 * meet the same sheet of paper every time, so all three should be identical
 * whatever the test — see `fitScore` in src/app/app.js.
 *
 *   node scripts/staff-metrics.js [--runs 6] [--width 1200] [--height 900]
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
};
const RUNS = Number(valueOf('--runs', 6));
const WIDTH = Number(valueOf('--width', 1200));
const HEIGHT = Number(valueOf('--height', 900));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
};
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  let path = join(root, normalize(decodeURIComponent(url.pathname)));
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
  if (!existsSync(path)) return response.writeHead(404).end('not found');
  response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  createReadStream(path).pipe(response);
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const bundled = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));
const browser = await chromium.launch(bundled ? { executablePath: bundled } : {});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
await page.route('**', (route) => {
  const url = route.request().url();
  if (url.startsWith(`http://localhost:${port}`)) return route.continue();
  return route.abort();
});
await page.goto(`http://localhost:${port}/index.html`);
await page.waitForFunction(() => window.__osmd);

/*
 * The five lines of one staff are the five horizontal <line>s (or thin rects)
 * VexFlow draws for it. Reading them straight out of the SVG rather than from
 * OSMD's model is deliberate: it is what the eye actually meets.
 */
const readGeometry = () => page.evaluate(() => {
  const svg = document.querySelector('#score svg');
  if (!svg) return null;
  /*
   * Screen pixels, not SVG user units: OSMD's zoom scales the SVG itself, so
   * getBBox() reports the same numbers at every zoom and would show a staff
   * that never moves however much it actually does.
   *
   * A staff line is a zero-height horizontal <path> spanning a measure, and
   * every measure redraws its own five, so the distinct y values are what
   * matter. Hairpins and beams are wide and thin too, so rather than trusting
   * the filter alone, look for the first run of five *equally spaced* lines —
   * that is a stave, and nothing else in the engraving looks like one.
   */
  const ys = [...svg.querySelectorAll('path')]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.height < 0.6 && r.width > 120)
    .map((r) => Math.round(r.y * 100) / 100);
  const distinct = [...new Set(ys)].sort((a, b) => a - b);

  const staveAt = (start) => {
    const gap = distinct[start + 1] - distinct[start];
    if (!(gap > 1)) return null;
    for (let k = 2; k < 5; k++) {
      if (Math.abs((distinct[start + k] - distinct[start + k - 1]) - gap) > 0.15) return null;
    }
    return { top: distinct[start], gap: Math.round(gap * 100) / 100 };
  };
  const staves = [];
  for (let i = 0; i + 4 < distinct.length && staves.length < 2; i++) {
    const stave = staveAt(i);
    if (stave) { staves.push(stave); i += 4; }
  }
  if (staves.length < 2) return null;

  const clefs = [...svg.querySelectorAll('g.vf-clef')].map((el) => el.getBoundingClientRect());
  // How much room OSMD reserved above the first staff line, inside the SVG.
  const headroom = staves[0].top - svg.getBoundingClientRect().top;
  const round = (v) => Math.round(v * 100) / 100;
  return {
    lineGap: staves[0].gap,
    trebleTop: staves[0].top,
    bassTop: staves[1].top,
    trebleClefTop: clefs[0] ? round(clefs[0].top) : null,
    bassClefTop: clefs[1] ? round(clefs[1].top) : null,
    staffGap: round(staves[1].top - staves[0].top),
    headroom: round(headroom),
    systems: svg.querySelectorAll('g.staffline').length,
    zoom: window.__osmd.zoom,
  };
});

const rows = [];
for (const grade of [1, 2, 3, 4, 5, 6, 7, 8]) {
  await page.selectOption('#grade', String(grade));
  for (let run = 0; run < RUNS; run++) {
    await page.click('#generate');
    await page.waitForFunction(() => !document.getElementById('meta').hidden);
    await page.waitForTimeout(220);
    const g = await readGeometry();
    const meta = (await page.textContent('#meta')).replace(/\s+/g, ' ').trim();
    rows.push({ grade, ...g, meta });
  }
}
await browser.close();
server.close();

const spread = (key) => {
  const vals = rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
  if (!vals.length) return 'n/a';
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  return `${min.toFixed(2)} … ${max.toFixed(2)}  (spread ${(max - min).toFixed(2)}px, ${new Set(vals.map((v) => v.toFixed(2))).size} distinct)`;
};

console.log(`${rows.length} renders at ${WIDTH}x${HEIGHT}\n`);
console.log('staff line gap  :', spread('lineGap'));
console.log('treble staff y  :', spread('trebleTop'));
console.log('bass staff y    :', spread('bassTop'));
console.log('treble clef y   :', spread('trebleClefTop'));
console.log('bass clef y     :', spread('bassClefTop'));
console.log('gap between staves:', spread('staffGap'));
console.log('headroom above  :', spread('headroom'));
console.log('zoom            :', spread('zoom'));

/*
 * What this asserts, and what it deliberately only reports.
 *
 * The staff size and the treble clef's position are fixed by construction —
 * `STAFF_ZOOM` and `pinScoreTop` in src/app/app.js — so any spread beyond
 * sub-pixel rounding is a regression. The distance down to the bass stave is
 * not fixed and cannot be: OSMD reserves room between the staves for whatever
 * is engraved there (dynamics, a hairpin, ledger lines reaching between the
 * hands) and *adds* it to the configured distance rather than taking the
 * larger of the two, so no engraving-rule value can hold it still. Pinning it
 * would mean moving the bass stave independently of the brace and barline
 * connectors that join it to the treble, which is surgery on VexFlow's own
 * output and risks collisions — so it is measured and printed, not enforced.
 */
const TOLERANCE = 0.5;
const spreadOf = (key) => {
  const vals = rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
  return vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
};

const problems = [];
for (const key of ['lineGap', 'trebleClefTop']) {
  if (spreadOf(key) > TOLERANCE) problems.push(`${key} varies by ${spreadOf(key).toFixed(2)}px`);
}
if (problems.length) {
  console.log(`\nFAIL: ${problems.join('; ')} — sample:`);
  for (const r of rows.slice(0, 10)) {
    console.log(`  g${r.grade} gap ${r.lineGap} clefY ${r.trebleClefTop} zoom ${r.zoom} · ${r.meta}`);
  }
  process.exitCode = 1;
} else {
  console.log('\nstaff size and treble clef position identical across every render');
  console.log(`(distance down to the bass stave varies by ${spreadOf('bassTop').toFixed(1)}px — reported, not enforced; see above)`);
}
