/**
 * Measures the actual integrated loudness (ITU-R BS.1770 LUFS, the same
 * measure YouTube/Spotify normalize uploads to — YouTube's target is -14
 * LUFS integrated) of SightScore's real playback engine, and reports how
 * far the current gain staging (`master.gain.value`/`PEAK_GAIN` in
 * playback.js) sits from a target.
 *
 *   node scripts/loudness.js [--target -14] [--grades 1,3,5,7]
 *
 * The real Salamander piano samples (tonejs.github.io) are blocked from
 * this environment's egress, so sample requests are intercepted and
 * fulfilled with synthesized decaying-harmonic tones instead — same
 * envelope character as a struck string (fast attack, exponential decay),
 * close enough in crest factor for calibration purposes even though the
 * timbre isn't the real recording. Everything downstream of the sample
 * buffer (gain envelope, master gain, limiter, reverb send) is the real,
 * unmodified production code path — `window.__playback.audioNodes`
 * (app.js) exposes the actual context/master/limiter nodes so the K-
 * weighting tap listens to the exact signal that reaches
 * `context.destination`, not an approximation of the gain math.
 *
 * K-weighting is computed from the ITU-R BS.1770-4 analog design
 * (high-shelf + RLB high-pass) via the standard bilinear transform, at
 * whatever `context.sampleRate` the browser actually uses, rather than
 * hardcoded 48kHz coefficients that would be wrong at 44.1kHz. Loudness
 * gating uses the absolute (-70 LUFS) and relative (-10 LU below the
 * ungated mean) gates from the spec; blocks are one ScriptProcessor
 * callback each (~93ms at 44.1kHz/4096) rather than the spec's exact
 * 400ms/100ms-hop windows — a simplification with negligible effect on
 * the integrated average for continuous program material like this.
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
const TARGET_LUFS = Number(valueOf('--target', '-14'));
const GRADES = (valueOf('--grades', '1,3,5,7')).split(',').map(Number);

const NOTE_SEMITONE = { C: 0, Cs: 1, D: 2, Ds: 3, E: 4, F: 5, Fs: 6, G: 7, Gs: 8, A: 9, As: 10, B: 11 };

/** A struck-string-like decaying harmonic tone, standing in for the real (network-blocked) Salamander sample. */
function synthPianoWav(freq, durationSec = 4, sampleRate = 44100) {
  const n = Math.floor(durationSec * sampleRate);
  const data = new Int16Array(n);
  const harmonics = [[1, 1], [2, 0.55], [3, 0.32], [4, 0.2], [5, 0.12], [6, 0.07], [8, 0.03]];
  const tau = 1.5;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const attack = Math.min(1, t / 0.004);
    const env = attack * Math.exp(-t / tau);
    let s = 0;
    for (const [mult, amp] of harmonics) s += amp * Math.sin(2 * Math.PI * freq * mult * t);
    s *= env * 0.26;
    data[i] = Math.max(-32767, Math.min(32767, Math.round(s * 32767)));
  }
  return encodeWav(data, sampleRate);
}

function encodeWav(int16Data, sampleRate) {
  const dataSize = int16Data.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + dataSize, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < int16Data.length; i++) buffer.writeInt16LE(int16Data[i], 44 + i * 2);
  return buffer;
}

const wavCache = new Map();
function wavFor(letter, octave) {
  const key = `${letter}${octave}`;
  if (!wavCache.has(key)) {
    const midi = (octave + 1) * 12 + NOTE_SEMITONE[letter];
    const freq = 440 * 2 ** ((midi - 69) / 12);
    wavCache.set(key, synthPianoWav(freq));
  }
  return wavCache.get(key);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };
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
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on('pageerror', (error) => console.log('page error:', error.message));

await page.route('https://tonejs.github.io/audio/salamander/*.mp3', (route) => {
  const name = route.request().url().split('/').pop().replace('.mp3', '');
  const match = name.match(/^([A-G]s?)(-?\d)$/);
  if (!match) return route.continue();
  const wav = wavFor(match[1], Number(match[2]));
  route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
});

await page.goto(`http://localhost:${port}/index.html`);

/**
 * Injected into the page: K-weighting filter design (ITU-R BS.1770-4
 * bilinear-transformed to the real context.sampleRate) plus a ScriptProcessor
 * tap that accumulates per-block mean-square loudness, all attached to the
 * real production limiter output — an analysis-only branch, not connected
 * to destination, so it never affects what would actually be heard.
 */
async function attachMeter() {
  return page.evaluate(() => {
    function kWeighting(sampleRate) {
      const shelf = (f0, gainDb, Q) => {
        const A = 10 ** (gainDb / 40);
        const w0 = 2 * Math.PI * f0 / sampleRate;
        const alpha = Math.sin(w0) / (2 * Q);
        const cosw0 = Math.cos(w0);
        const sqrtA = Math.sqrt(A);
        const b0 = A * ((A + 1) + (A - 1) * cosw0 + 2 * sqrtA * alpha);
        const b1 = -2 * A * ((A - 1) + (A + 1) * cosw0);
        const b2 = A * ((A + 1) + (A - 1) * cosw0 - 2 * sqrtA * alpha);
        const a0 = (A + 1) - (A - 1) * cosw0 + 2 * sqrtA * alpha;
        const a1 = 2 * ((A - 1) - (A + 1) * cosw0);
        const a2 = (A + 1) - (A - 1) * cosw0 - 2 * sqrtA * alpha;
        return { feedforward: [b0 / a0, b1 / a0, b2 / a0], feedback: [1, a1 / a0, a2 / a0] };
      };
      const highpass = (f0, Q) => {
        const w0 = 2 * Math.PI * f0 / sampleRate;
        const alpha = Math.sin(w0) / (2 * Q);
        const cosw0 = Math.cos(w0);
        const b0 = (1 + cosw0) / 2;
        const b1 = -(1 + cosw0);
        const b2 = (1 + cosw0) / 2;
        const a0 = 1 + alpha;
        const a1 = -2 * cosw0;
        const a2 = 1 - alpha;
        return { feedforward: [b0 / a0, b1 / a0, b2 / a0], feedback: [1, a1 / a0, a2 / a0] };
      };
      return {
        stage1: shelf(1681.9744509555319, 3.99984385397, 0.7071752369554193),
        stage2: highpass(38.13547087613982, 0.5003270373238773),
      };
    }

    const { context, limiter } = window.__playback.audioNodes;
    const { stage1, stage2 } = kWeighting(context.sampleRate);
    const f1 = context.createIIRFilter(stage1.feedforward, stage1.feedback);
    const f2 = context.createIIRFilter(stage2.feedforward, stage2.feedback);
    const processor = context.createScriptProcessor(4096, 2, 2);

    window.__loudnessBlocks = [];
    window.__peakSample = 0;
    processor.onaudioprocess = (event) => {
      const l = event.inputBuffer.getChannelData(0);
      const r = event.inputBuffer.numberOfChannels > 1 ? event.inputBuffer.getChannelData(1) : l;
      let msL = 0;
      let msR = 0;
      for (let i = 0; i < l.length; i++) { msL += l[i] * l[i]; msR += r[i] * r[i]; }
      msL /= l.length;
      msR /= r.length;
      window.__loudnessBlocks.push(msL + msR);
    };

    // A separate, unweighted tap directly off the limiter (pre-K-weighting)
    // to check for actual clipping — K-weighting itself alters peak levels,
    // so peak-safety has to be measured on the real output, not this branch.
    const peakTap = context.createScriptProcessor(2048, 2, 2);
    peakTap.onaudioprocess = (event) => {
      const l = event.inputBuffer.getChannelData(0);
      const r = event.inputBuffer.numberOfChannels > 1 ? event.inputBuffer.getChannelData(1) : l;
      for (let i = 0; i < l.length; i++) {
        window.__peakSample = Math.max(window.__peakSample, Math.abs(l[i]), Math.abs(r[i]));
      }
    };
    const peakSink = context.createGain();
    peakSink.gain.value = 0;
    limiter.connect(peakTap);
    peakTap.connect(peakSink);
    peakSink.connect(context.destination);
    window.__peakTeardownExtra = () => { peakTap.disconnect(); peakSink.disconnect(); };

    limiter.connect(f1);
    f1.connect(f2);
    f2.connect(processor);
    // A ScriptProcessor must be connected to a destination to pull data at
    // all, even though this tap is analysis-only — a silent, disconnected
    // sink keeps it running without adding to what's actually audible.
    const sink = context.createGain();
    sink.gain.value = 0;
    processor.connect(sink);
    sink.connect(context.destination);

    window.__loudnessTeardown = () => {
      processor.disconnect();
      f1.disconnect();
      f2.disconnect();
      sink.disconnect();
      window.__peakTeardownExtra?.();
    };
  });
}

function integratedLufs(blocks) {
  if (!blocks.length) return null;
  const toLufs = (ms) => -0.691 + 10 * Math.log10(ms);
  const ungated = blocks.filter((ms) => ms > 0 && toLufs(ms) > -70);
  if (!ungated.length) return null;
  const ungatedMean = ungated.reduce((sum, ms) => sum + ms, 0) / ungated.length;
  const relativeThreshold = toLufs(ungatedMean) - 10;
  const gated = ungated.filter((ms) => toLufs(ms) > relativeThreshold);
  const pool = gated.length ? gated : ungated;
  const mean = pool.reduce((sum, ms) => sum + ms, 0) / pool.length;
  return toLufs(mean);
}

async function measureOneTest(grade) {
  await page.selectOption('#grade', String(grade));
  await page.click('#generate');
  await page.waitForFunction(() => window.__osmd && window.__osmd.GraphicSheet, { timeout: 10000 });
  await page.waitForTimeout(100);

  await page.click('#play');
  await page.waitForFunction(() => window.__playback?.audioNodes, { timeout: 30000 });
  await attachMeter();
  await page.waitForFunction(() => window.__playback.playing === false, { timeout: 120000, polling: 200 });
  const { blocks, peak } = await page.evaluate(() => {
    window.__loudnessTeardown?.();
    const collected = { blocks: window.__loudnessBlocks ?? [], peak: window.__peakSample ?? 0 };
    window.__loudnessBlocks = [];
    return collected;
  });
  return { lufs: integratedLufs(blocks), peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity };
}

console.log(`Target: ${TARGET_LUFS} LUFS integrated (YouTube/Spotify normalize to -14)\n`);
const results = [];
for (const grade of GRADES) {
  const { lufs, peakDb } = await measureOneTest(grade);
  console.log(`grade ${grade}: ${lufs === null ? 'no signal' : lufs.toFixed(2) + ' LUFS'}, peak ${peakDb.toFixed(2)} dBFS`);
  if (lufs !== null) results.push(lufs);
}

if (results.length) {
  const avgPower = results.reduce((sum, l) => sum + 10 ** (l / 10), 0) / results.length;
  const avgLufs = 10 * Math.log10(avgPower);
  const deltaDb = TARGET_LUFS - avgLufs;
  console.log(`\naverage: ${avgLufs.toFixed(2)} LUFS`);
  console.log(`gain correction needed: ${deltaDb >= 0 ? '+' : ''}${deltaDb.toFixed(2)} dB (× ${(10 ** (deltaDb / 20)).toFixed(4)})`);
}

await browser.close();
server.close();
