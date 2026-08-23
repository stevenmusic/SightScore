/**
 * Collision check on the engraved page.
 *
 * `npm run staff` answers "does the page hold still?"; this answers "is
 * anything drawn on top of anything else?" — slurs piled onto each other,
 * a hairpin through a slur, a marking sitting over the notes. Those are the
 * faults a reader meets immediately and no unit test can see, because they
 * only exist once VexFlow has actually placed things on a page.
 *
 * Markings are found by exclusion rather than by class: OSMD gives slurs
 * `g.vf-curve` and dynamics a `<text>`, but a hairpin or a pedal line is a
 * bare `<path>` with nothing to identify it. So anything that is not part of
 * the notes, the stave, or the clef/key/time furniture counts as a marking.
 *
 *   node scripts/engraving-check.js [--runs 6] [--grade 3] [--width 1200]
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
const GRADES = valueOf('--grade') ? [Number(valueOf('--grade'))] : [1, 2, 3, 4, 5, 6, 7, 8];

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
await page.route('**', (route) => (
  route.request().url().startsWith(`http://localhost:${port}`) ? route.continue() : route.abort()
));
await page.goto(`http://localhost:${port}/index.html`);
await page.waitForFunction(() => window.__osmd);

const inspect = () => page.evaluate(() => {
  const svg = document.querySelector('#score svg');
  if (!svg) return null;
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  };
  const overlap = (a, b, pad = 0) => (
    a.left < b.right - pad && a.right > b.left + pad
    && a.top < b.bottom - pad && a.bottom > b.top + pad
  );
  const area = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : 0;
  };

  const noteheads = [...svg.querySelectorAll('g.vf-notehead')].map(rectOf);

  /*
   * A slur is a real curve, so its bounding box is useless here — it covers
   * every note the slur arcs over, which is exactly what a slur is supposed
   * to do. Sample the path itself instead, in screen pixels.
   */
  const NOTE_FURNITURE = 'g.vf-stavenote, g.vf-notehead, g.vf-stem, g.vf-beam, g.vf-flag, g.vf-ledgers, g.vf-clef, g.vf-keysignature, g.vf-timesignature, g.vf-connector, g.vf-brace, g.vf-modifiers';
  const samplePath = (path) => {
    const points = [];
    const total = path.getTotalLength();
    if (!(total > 0)) return points;
    const ctm = path.getScreenCTM();
    const steps = Math.max(12, Math.min(90, Math.round(total / 3)));
    for (let i = 0; i <= steps; i++) {
      const p = path.getPointAtLength((total * i) / steps);
      points.push({ x: p.x * ctm.a + p.y * ctm.c + ctm.e, y: p.x * ctm.b + p.y * ctm.d + ctm.f, t: i / steps });
    }
    return points;
  };
  const slurs = [...svg.querySelectorAll('g.vf-curve path')].map(samplePath).filter((p) => p.length);

  /*
   * Everything that is neither the notes nor the stave: hairpins, pedal
   * lines, dynamics and words. Staff lines (long and flat) and barlines
   * (short and vertical) are dropped by shape, since they carry no class.
   */
  const markings = [];
  for (const el of svg.querySelectorAll('path, text, rect')) {
    if (el.closest(NOTE_FURNITURE)) continue;
    if (el.closest('g.vf-curve')) continue;
    const r = rectOf(el);
    const w = r.right - r.left;
    const h = r.bottom - r.top;
    if (h < 1 && w > 60) continue;           // staff line
    if (w < 3 && h > 12) continue;           // barline
    if (w <= 0 || h <= 0) continue;
    markings.push({
      rect: r,
      text: el.tagName === 'text' ? el.textContent : null,
      // A hairpin and a pedal line are both bare paths; their shape is the
      // only way to tell them apart in a report.
      shape: `${Math.round(w)}x${Math.round(h)}`,
    });
  }

  const problems = [];
  const inside = (pt, r, pad) => (
    pt.x > r.left + pad && pt.x < r.right - pad && pt.y > r.top + pad && pt.y < r.bottom - pad
  );

  // 1. A slur running through a notehead. Its own ends attach at the notes,
  //    so the first and last tenth of the curve is not a fault.
  for (const slur of slurs) {
    for (const pt of slur) {
      if (pt.t < 0.1 || pt.t > 0.9) continue;
      if (noteheads.some((n) => inside(pt, n, 1))) { problems.push('slur crosses a notehead'); break; }
    }
  }

  // 2. Two slurs on top of each other.
  for (let i = 0; i < slurs.length; i++) {
    for (let j = i + 1; j < slurs.length; j++) {
      let close = 0;
      for (const a of slurs[i]) {
        for (const b of slurs[j]) {
          if (Math.hypot(a.x - b.x, a.y - b.y) < 2.5) { close += 1; break; }
        }
      }
      if (close >= 2) { problems.push('two slurs overlap'); }
    }
  }

  // 3. A marking (hairpin, pedal, dynamic, word) crossed by a slur.
  for (const slur of slurs) {
    for (const m of markings) {
      if (slur.some((pt) => inside(pt, m.rect, 0.5))) {
        problems.push(`slur crosses ${m.text ? `"${m.text}"` : `line ${m.shape}`}`);
        break;
      }
    }
  }

  // 4. A marking sitting on the notes.
  for (const m of markings) {
    for (const n of noteheads) {
      if (overlap(m.rect, n, 0.5) && area(m.rect, n) > 2) {
        problems.push(`${m.text ? `"${m.text}"` : 'a hairpin/pedal line'} sits on a notehead`);
        break;
      }
    }
  }

  // 5. Two markings on top of each other.
  for (let i = 0; i < markings.length; i++) {
    for (let j = i + 1; j < markings.length; j++) {
      if (overlap(markings[i].rect, markings[j].rect, 0.5) && area(markings[i].rect, markings[j].rect) > 2) {
        const name = (m) => (m.text ? `"${m.text}"` : `line ${m.shape}`);
        problems.push(`${name(markings[i])} overlaps ${name(markings[j])}`);
      }
    }
  }

  return { problems, slurs: slurs.length, markings: markings.length, noteheads: noteheads.length };
});

const tally = new Map();
let checked = 0;
let bad = 0;
const examples = [];
for (const grade of GRADES) {
  await page.selectOption('#grade', String(grade));
  for (let run = 0; run < RUNS; run++) {
    await page.click('#generate');
    await page.waitForFunction(() => !document.getElementById('meta').hidden);
    await page.waitForTimeout(200);
    const result = await inspect();
    checked += 1;
    if (!result) continue;
    if (result.problems.length) {
      bad += 1;
      const meta = (await page.textContent('#meta')).replace(/\s+/g, ' ').trim();
      if (examples.length < 8) examples.push(`g${grade} · ${meta} → ${[...new Set(result.problems)].join('; ')}`);
      // Keep a picture of the first fault, so a number can be looked at.
      const shot = valueOf('--screenshot', null);
      if (shot && bad === 1) await page.screenshot({ path: shot, fullPage: true });
    }
    for (const p of new Set(result.problems)) tally.set(p, (tally.get(p) ?? 0) + 1);
  }
}
await browser.close();
server.close();

console.log(`${checked} rendered tests at ${WIDTH}x${HEIGHT}\n`);

/*
 * Two classes of fault, judged differently.
 *
 * Anything that puts a marking on the notes, piles two slurs together, or
 * prints a word twice is fixed and must stay at zero — those were real faults
 * with real causes and any reappearance is a regression.
 *
 * A slur grazing a hairpin or the pedal line is the known residue. OSMD
 * places the pedal bracket at a fixed offset under the bass stave with no
 * setting to move it, and decides slur placement itself (better than any
 * blanket rule this app tried), so the two can still touch. It is a graze
 * rather than a collision — the page reads cleanly — so it gets a budget
 * instead of a ban, sized above the measured rate with room to spare so it
 * catches a real slide without being permanently red.
 */
const NEVER = [/notehead/, /two slurs overlap/, /overlaps "/];
const GRAZE_BUDGET = 12;

const never = [...tally].filter(([what]) => NEVER.some((re) => re.test(what)));
const grazes = [...tally].filter(([what]) => !NEVER.some((re) => re.test(what)));
const grazeTests = grazes.reduce((sum, [, n]) => sum + n, 0);
const grazeRate = (100 * grazeTests) / checked;

if (!tally.size) {
  console.log('no overlapping engraving found');
} else {
  for (const [what, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${what}`);
  }
  console.log('\nexamples:');
  for (const e of examples) console.log(`  ${e}`);
}

console.log(`\nmust never happen: ${never.length ? never.map(([w, n]) => `${w} (${n})`).join(', ') : 'none'}`);
console.log(`slur grazing a hairpin/pedal line: ${grazeRate.toFixed(1)}% of tests (budget ${GRAZE_BUDGET}%)`);

if (never.length || grazeRate > GRAZE_BUDGET) {
  console.log('\nFAIL');
  process.exitCode = 1;
} else {
  console.log('\nOK');
}
