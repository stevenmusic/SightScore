/**
 * Browser smoke test: loads the app, generates a test at every grade and
 * checks that OSMD actually rendered it. OSMD is strict about MusicXML, so
 * this catches serialiser problems that unit tests on the string cannot.
 *
 *   node scripts/smoke.js [--screenshot out.png] [--grade 3]
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
  if (!existsSync(path)) return response.writeHead(404).end('not found');
  response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  createReadStream(path).pipe(response);
});

await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

// Use the browser already in the image when its build differs from the one
// this Playwright version expects.
const bundled = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((path) => existsSync(path));
const browser = await chromium.launch(bundled ? { executablePath: bundled } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const problems = [];
page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
/*
 * The page pulls two things from other origins at runtime: the Google Fonts
 * stylesheet and the Salamander piano samples. Neither is reachable from a
 * sandboxed run and neither affects engraving, so only same-origin request
 * failures count. Console messages for those failures carry no URL, so the
 * check is done on the request instead.
 */
const sameOrigin = (url) => url.startsWith(`http://localhost:${port}`);

page.on('requestfailed', (request) => {
  if (sameOrigin(request.url())) {
    problems.push(`request failed: ${request.url()} (${request.failure()?.errorText})`);
  }
});
page.on('response', (response) => {
  if (sameOrigin(response.url()) && response.status() >= 400) {
    problems.push(`HTTP ${response.status()}: ${response.url()}`);
  }
});
page.on('console', (message) => {
  const text = message.text();
  if (message.type() === 'error' && !text.includes('Failed to load resource')) {
    problems.push(`console: ${text}`);
  }
});

await page.goto(`http://localhost:${port}/index.html`);
await page.waitForFunction(() => !document.getElementById('generate').disabled, { timeout: 15000 });

const only = valueOf('--grade', null);
const grades = only ? [Number(only)] : [1, 2, 3, 4, 5, 6, 7, 8];
const runsPerGrade = only ? 1 : 3;

for (const grade of grades) {
  await page.selectOption('#grade', String(grade));
  for (let run = 0; run < runsPerGrade; run++) {
    await page.click('#generate');
    await page.waitForFunction(
      () => document.querySelector('#score svg') !== null
        && document.getElementById('message').textContent !== '渲染中…',
      { timeout: 20000 },
    );

    const result = await page.evaluate(() => {
      const svg = document.querySelector('#score svg');
      return {
        message: document.getElementById('message').textContent,
        staves: svg ? svg.querySelectorAll('path, line').length : 0,
        height: svg ? svg.getBoundingClientRect().height : 0,
        meta: document.getElementById('meta').textContent,
      };
    });

    if (result.message.startsWith('渲染失敗')) problems.push(`grade ${grade}: ${result.message}`);
    if (result.height < 60) problems.push(`grade ${grade}: rendered SVG is only ${result.height}px tall`);
    if (result.staves < 20) problems.push(`grade ${grade}: SVG has only ${result.staves} drawing elements`);
    console.log(`grade ${grade} run ${run + 1}: ${Math.round(result.height)}px · ${result.meta.replace(/\s+/g, ' ').trim()}`);
  }
}

const screenshot = valueOf('--screenshot', null);
if (screenshot) {
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(`screenshot: ${screenshot}`);
}

await browser.close();
server.close();

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('\nall grades rendered');
