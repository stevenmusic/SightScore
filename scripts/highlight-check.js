/**
 * Does the playback highlight actually sit on the bar it is tinting?
 *
 * The block and the playhead are absolutely positioned siblings of the score,
 * so their offsets are measured from `.score-frame`'s padding box, while the
 * numbers driving them come from `getBBox`, measured from the SVG's own
 * origin. Those two origins are not the same point — the frame has padding of
 * its own, and `#score` carries the padding `pinScoreTop` adds — so the two
 * can drift apart without anything else on the page looking wrong.
 *
 * Note the wait after each step: `.measure-highlight` has a CSS transition on
 * `top`/`left`/`width`, so reading its box straight after setting the style
 * returns the *previous* bar's position. Measuring without waiting reports
 * enormous, entirely fictional errors.
 *
 *   node scripts/highlight-check.js [--grade 3] [--width 1200] [--height 900]
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
const GRADES = valueOf('--grade') ? [Number(valueOf('--grade'))] : [1, 3, 6, 8];
const VIEWPORTS = valueOf('--width')
  ? [{ width: Number(valueOf('--width', 1200)), height: Number(valueOf('--height', 900)) }]
  : [{ width: 1200, height: 900 }, { width: 820, height: 1180 }, { width: 430, height: 932 }];
/** Longer than the `top` transition in styles.css, with room to spare. */
const SETTLE_MS = 320;
/** A bar edge may miss by this much before it reads as misaligned. */
const TOLERANCE = 1.5;

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
const problems = [];

for (const viewport of VIEWPORTS) {
  const page = await browser.newPage({ viewport });
  await page.route('**', (route) => (
    route.request().url().startsWith(`http://localhost:${port}`) ? route.continue() : route.abort()
  ));
  await page.goto(`http://localhost:${port}/index.html`);
  await page.waitForFunction(() => window.__osmd);

  for (const grade of GRADES) {
    await page.selectOption('#grade', String(grade));
    await page.click('#generate');
    await page.waitForFunction(() => !document.getElementById('meta').hidden);
    await page.waitForTimeout(250);
    await page.evaluate(() => { window.__stage.measure(); window.__stage.begin(); });

    const bars = await page.evaluate(() => [...new Set(
      [...document.querySelectorAll('#score g.vf-measure')].map((el) => Number(el.id)),
    )].sort((a, b) => a - b));

    let worst = { top: 0, bottom: 0, right: 0 };
    for (const bar of bars) {
      await page.evaluate((n) => window.__stage.update(n, 0), bar);
      await page.waitForTimeout(SETTLE_MS);
      const delta = await page.evaluate((n) => {
        const svg = document.getElementById('score').querySelector('svg');
        const h = document.getElementById('measure-highlight').getBoundingClientRect();
        let b = null;
        for (const el of svg.querySelectorAll(`g.vf-measure[id="${n}"]`)) {
          const r = el.getBoundingClientRect();
          b = b ? {
            top: Math.min(b.top, r.top), bottom: Math.max(b.bottom, r.bottom),
            right: Math.max(b.right, r.right),
          } : { top: r.top, bottom: r.bottom, right: r.right };
        }
        // The block should contain the bar vertically (it also covers the
        // slurs and dynamics drawn outside the bar's own box) and stop
        // exactly at its right-hand barline.
        return {
          top: b.top - h.top, bottom: h.bottom - b.bottom, right: Math.abs(h.right - b.right),
        };
      }, bar);
      worst = {
        top: Math.min(worst.top, delta.top),
        bottom: Math.min(worst.bottom, delta.bottom),
        right: Math.max(worst.right, delta.right),
      };
    }
    await page.evaluate(() => window.__stage.end());

    const label = `${viewport.width}x${viewport.height} grade ${grade} (${bars.length} bars)`;
    const bad = worst.top < -TOLERANCE || worst.bottom < -TOLERANCE || worst.right > TOLERANCE;
    if (bad) {
      problems.push(`${label}: top ${worst.top.toFixed(1)}, bottom ${worst.bottom.toFixed(1)}, right ${worst.right.toFixed(1)}`);
    }
    console.log(`${bad ? '!!' : 'ok'} ${label.padEnd(34)} top ${worst.top.toFixed(1).padStart(6)}  bottom ${worst.bottom.toFixed(1).padStart(6)}  right ${worst.right.toFixed(1).padStart(5)}`);
  }
  await page.close();
}
await browser.close();
server.close();

if (problems.length) {
  console.log(`\n${problems.length} misaligned:`);
  for (const p of problems) console.log(`  ${p}`);
  process.exitCode = 1;
} else {
  console.log('\nthe highlight sits exactly on its bar everywhere');
}
