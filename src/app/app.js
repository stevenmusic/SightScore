import { generateTest } from '../generator/generate.js';
import { toMusicXml } from '../generator/musicxml.js';
import { createHistory, generateUnique } from '../generator/fingerprint.js';
import { createPlayer } from './playback.js';
import { createStage, barTimings } from './stage.js';

const STORAGE_KEY = 'sightscore.history.v1';

const elements = {
  grade: document.getElementById('grade'),
  generate: document.getElementById('generate'),
  prepare: document.getElementById('prepare'),
  play: document.getElementById('play'),
  playIcon: document.getElementById('playIcon'),
  stop: document.getElementById('stop'),
  fullscreen: document.getElementById('fullscreen'),
  fullscreenIcon: document.getElementById('fullscreenIcon'),
  status: document.getElementById('status'),
  countdown: document.getElementById('countdown'),
  countdownValue: document.getElementById('countdown-value'),
  meta: document.getElementById('meta'),
  score: document.getElementById('score'),
  playline: document.getElementById('playline'),
  highlight: document.getElementById('measure-highlight'),
  message: document.getElementById('message'),
  checklist: document.getElementById('checklist'),
  historyInfo: document.getElementById('history-info'),
  clearHistory: document.getElementById('clear-history'),
  confidence: document.getElementById('confidence'),
};

/* ScrollScore's icon paths, so the two apps show the same glyphs. */
const PLAY_ICON_D = 'M8 5v14l11-7z';
const PAUSE_ICON_D = 'M6 5h4v14H6zM14 5h4v14h-4z';
const EXPAND_ICON_D = 'M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3';
const COMPRESS_ICON_D = 'M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3';

const player = createPlayer({
  // Only loading progress and failures; play() reports the rest.
  onStatus: (text) => { if (text) say(text); },
});
const history = createHistory({
  capacity: 60,
  load: () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'),
  save: (entries) => localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)),
});

let rules = null;
let osmd = null;
let stage = null;
let current = null;
let countdownTimer = null;
let followFrame = null;
let resizeTimer = null;
const BASE_ZOOM = 1;
/** Below this, engraving reads as too small to sight-read from. */
const MIN_ZOOM = 0.5;

const CONFIDENCE_LABEL = {
  verified: null,
  partial: '此級數部分參數為推估值',
  inferred: '此級數參數為推估值，尚待官方大綱核對',
};

init();

/** Ordinary status text, clearing any error styling left behind. */
function say(text) {
  elements.message.className = 'message';
  elements.message.textContent = text;
}

/** Surface failures on the page — a blank screen tells the user nothing. */
function fail(text, detail) {
  elements.message.className = 'message error';
  elements.message.textContent = detail ? `${text}（${detail}）` : text;
  elements.generate.disabled = true;
}

window.addEventListener('error', (event) => fail('發生錯誤', event.message));
window.addEventListener('unhandledrejection', (event) => fail('發生錯誤', String(event.reason)));

async function init() {
  elements.generate.disabled = true;

  if (typeof opensheetmusicdisplay === 'undefined') {
    fail(
      '找不到樂譜渲染函式庫 OSMD（vendor/opensheetmusicdisplay.min.js 未載入）。'
      + '請確認該檔案存在，並透過 http 開啟頁面（直接以 file:// 開啟不會運作）',
    );
    return;
  }

  try {
    const response = await fetch(new URL('../rules/abrsm-piano-grades.json', import.meta.url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    rules = await response.json();
  } catch (error) {
    fail('無法載入規則表', error.message);
    return;
  }

  try {
    osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(elements.score, {
      autoResize: true,
      drawTitle: false,
      drawPartNames: false,
      drawingParameters: 'default',
    });
  } catch (error) {
    fail('無法初始化樂譜渲染器', error.message);
    return;
  }
  window.__osmd = osmd; // debugging hook, also used by scripts/smoke.js
  window.__isFullscreen = isFullscreenActive; // debugging hook, also used by scripts/devices.js

  stage = createStage({
    score: elements.score,
    playline: elements.playline,
    highlight: elements.highlight,
  });
  window.__stage = stage; // debugging hook, also used by scripts/devices.js

  elements.generate.disabled = false;
  elements.generate.addEventListener('click', newTest);
  elements.prepare.addEventListener('click', startCountdown);
  elements.play.addEventListener('click', togglePlayback);
  elements.stop.addEventListener('click', () => {
    player.stop();
    stopFollowing();
    setPlayState(false);
  });
  elements.fullscreen.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => onFullscreenChange(!!document.fullscreenElement));
  document.addEventListener('webkitfullscreenchange', () => onFullscreenChange(!!document.webkitFullscreenElement));
  elements.clearHistory.addEventListener('click', () => {
    history.clear();
    updateHistoryInfo();
  });
  elements.grade.addEventListener('change', () => {
    if (current) newTest();
  });

  // Bars per line depend on the container's actual width, so a resize (or a
  // phone rotating) can turn a fine layout into single-bar rows again. Width
  // only, not height: mobile Safari fires a resize event whenever its
  // address bar auto-hides or reappears from ordinary page scrolling, which
  // only changes innerHeight — refitting (and so re-rendering the score) on
  // every one of those reset the scroll position, making the score appear
  // to snap back to the top while simply scrolling down through it.
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (!current) return;
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { fitScore(); }, 200);
  });

  updateHistoryInfo();
}

async function newTest() {
  stopCountdown();
  player.stop();
  stopFollowing();
  setPlayState(false);

  // Start fetching the piano samples now, so the first press of play is
  // immediate — same moment ScrollScore loads them, once there is a score.
  player.preload();

  const grade = Number(elements.grade.value);
  const { score } = generateUnique(() => generateTest(rules, { grade }), history);
  current = { score, xml: toMusicXml(score) };

  say('渲染中…');
  try {
    await osmd.load(current.xml);
    osmd.render();
    say('按「開始 30 秒準備」模擬考試流程。');
  } catch (error) {
    fail('渲染失敗', error.message);
    return;
  }

  await fitScore();
  showMeta(score);
  elements.status.hidden = false;
  elements.play.disabled = false;
  elements.stop.disabled = false;
  elements.fullscreen.disabled = false;
  elements.countdownValue.textContent = String(rules.exam.preparationSeconds);
  elements.countdown.className = 'countdown';
  elements.checklist.hidden = true;
  updateHistoryInfo();
}

function showMeta(score) {
  const mode = score.key.mode === 'major' ? '大調' : '小調';
  // No labels — just the values in a fixed order, separated by "丨". The
  // key/time/bar-count fields have a fixed CSS width so the separators
  // never move when a new test changes their text length; only the tempo
  // field (last, nothing after it) is free to vary.
  const fields = [
    ['meta-key', `${score.key.tonic} ${mode}`],
    ['meta-time', score.timeSignature.text],
    ['meta-bars', `${score.barCount} 小節`],
    ['meta-tempo', `${score.tempoTerm} (♩≈${score.tempoBpm})`],
  ];
  elements.meta.innerHTML = fields
    .map(([cls, value]) => `<span class="${cls}">${escapeHtml(value)}</span>`)
    .join('<span class="meta-sep">丨</span>');

  const warning = CONFIDENCE_LABEL[score.confidence];
  elements.confidence.hidden = !warning;
  if (warning) elements.confidence.textContent = warning;
}

/*
 * The standard preparation order from the knowledge base. Reading it beats
 * staring at bar 1: the tempo should be set by the busiest bar, not the first.
 */
const PREPARATION_STEPS = [
  '調號 — 幾個升降記號？主音在哪？',
  '拍號 — 幾拍子？複拍子用大拍感覺（6/8 是兩大拍）',
  '速度術語 — 決定起頭速度',
  '把位 — 兩手從哪裡開始，中途換不換',
  '掃描難點 — 臨時記號、最密的一小節、最大的跳進',
  '用最難的那一小節決定速度，然後心裡數一小節',
];

function startCountdown() {
  stopCountdown();
  let remaining = rules.exam.preparationSeconds;
  elements.countdownValue.textContent = String(remaining);
  elements.countdown.className = 'countdown running';
  elements.checklist.hidden = false;
  elements.checklist.innerHTML = PREPARATION_STEPS
    .map((step) => `<li>${escapeHtml(step)}</li>`)
    .join('');
  say('準備時間：整份樂譜已經在畫面上，時間到會提示開始。');

  countdownTimer = setInterval(() => {
    remaining -= 1;
    elements.countdownValue.textContent = String(Math.max(remaining, 0));
    if (remaining <= 0) {
      stopCountdown();
      elements.countdown.className = 'countdown done';
      elements.checklist.hidden = true;
      // Continuity outscores accuracy: going back to fix a slip is counted as
      // a second mistake.
      say('時間到——不要停、不要回頭改，彈完再按播放比對。');
    }
  }, 1000);
}

function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
}

function setPlayState(playing) {
  elements.play.classList.toggle('is-active', playing);
  elements.playIcon.setAttribute('d', playing ? PAUSE_ICON_D : PLAY_ICON_D);
  const label = playing ? '停止' : '播放';
  elements.play.setAttribute('aria-label', label);
  elements.play.title = playing ? '停止播放' : '播放正確版本';
}

/*
 * Fullscreen goes on <html>, not just the score frame — the countdown, the
 * controls and the score are then all still the same page, nothing hidden or
 * reparented, so nothing needs a separate "show this while fullscreen too"
 * path. Only the browser chrome (address bar, tab strip) goes away.
 *
 * iOS Safari (pre-16.4) has no Element.requestFullscreen at all, so a missing
 * or rejected request falls back to a CSS class that pins the page to the
 * viewport instead — same effect, no native API required.
 */
function isFullscreenActive() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement)
    || document.body.classList.contains('pseudo-fullscreen');
}

function toggleFullscreen() {
  if (isFullscreenActive()) {
    exitFullscreen();
  } else {
    enterFullscreen();
  }
}

function enterFullscreen() {
  const root = document.documentElement;
  const request = root.requestFullscreen?.bind(root) ?? root.webkitRequestFullscreen?.bind(root);
  if (!request) {
    enterPseudoFullscreen();
    return;
  }
  const result = request();
  if (result?.catch) result.catch(() => enterPseudoFullscreen());
}

function exitFullscreen() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document);
  } else {
    exitPseudoFullscreen();
  }
}

function enterPseudoFullscreen() {
  document.body.classList.add('pseudo-fullscreen');
  onFullscreenChange(true);
}

function exitPseudoFullscreen() {
  document.body.classList.remove('pseudo-fullscreen');
  onFullscreenChange(false);
}

/** Also fires from the browser's own Esc-to-exit, not just our button. */
function onFullscreenChange(active) {
  elements.fullscreenIcon.setAttribute('d', active ? COMPRESS_ICON_D : EXPAND_ICON_D);
  elements.fullscreen.setAttribute('aria-label', active ? '退出全螢幕' : '全螢幕顯示');
  elements.fullscreen.title = active ? '退出全螢幕' : '全螢幕顯示';
  elements.fullscreen.classList.toggle('is-active', active);
  if (active) {
    // Fullscreen pins the page to exactly one screen (only the score scrolls,
    // inside <main>) — a scroll position left over from before entering can
    // otherwise push the whole grid, top bar included, out of view.
    window.scrollTo(0, 0);
  }
  // The available width just changed (relaxed max-width, or the address bar
  // disappearing); re-run the same fit used on resize so lines don't strand
  // a single bar.
  if (current) requestAnimationFrame(() => fitScore());
}

/**
 * Shrinks zoom, re-rendering each step, until no line holds only a single
 * bar (unreadable) or the legibility floor is hit. Returns the layout from
 * the last render. Whatever `EngravingRules.RenderXMeasuresPerLineAkaSystem`
 * is currently set to stays in effect across every render in the loop — used
 * both unforced (to find a legible natural size) and forced (since that rule
 * is a target, not a guarantee: if the forced bar count doesn't actually fit
 * the container at the current zoom, OSMD still wraps it further, splitting
 * one intended line into several, sometimes down to single bars each).
 */
function shrinkUntilNoSingleBarLines(zoom) {
  osmd.zoom = zoom;
  osmd.render();
  let layout = stage.measure();
  while (zoom > MIN_ZOOM && hasSingleBarLine(layout)) {
    zoom = Math.max(MIN_ZOOM, zoom * 0.92);
    osmd.zoom = zoom;
    osmd.render();
    layout = stage.measure();
  }
  return { layout, zoom };
}

function hasSingleBarLine(layout) {
  return layout.bars.size > 1 && layout.systems.some((system) => system.bars.length === 1);
}

/**
 * Picks a uniform bars-per-line count for `RenderXMeasuresPerLineAkaSystem`.
 * That rule isn't a "share the remainder with the last line" split — it's a
 * flat chunking of every `n` bars into a line, so any remainder becomes an
 * extra, undersized final line (`n=3` on 10 bars renders 3+3+3+1, not
 * 3+3+4). Search for the `n` that keeps the result closest to `targetLines`
 * lines, ruling out any `n` that would strand a single bar on its own line,
 * preferring an exact divisor (no remainder line at all) on ties.
 */
function chooseMeasuresPerLine(totalBars, targetLines) {
  let best = null;
  for (let n = 2; n <= totalBars; n++) {
    if (totalBars % n === 1) continue; // would leave one bar alone on the last line
    const lines = Math.ceil(totalBars / n);
    const score = Math.abs(lines - targetLines) * 10 - (totalBars % n === 0 ? 1 : 0);
    if (!best || score < best.score || (score === best.score && n > best.n)) best = { n, score };
  }
  return best.n;
}

/**
 * The whole test always renders on the page — no fullscreen step, no cropped
 * follow-window — so the only fitting left to do is layout: OSMD's own line
 * breaking is a greedy fill (pack bars onto a line until the next one
 * doesn't fit), which both leaves a lone bar on a line when the content
 * doesn't happen to divide evenly, and tends to front-load the earlier lines
 * since they're filled first (they're packed to the same width limit, but
 * bar-to-bar width varies with note density, so the count that fits varies
 * with it too). Two passes fix both: shrink zoom until the *natural* wrap
 * has no single-bar lines (establishing a legible size and how many lines
 * the piece needs), then force a uniform bars-per-line count via
 * `RenderXMeasuresPerLineAkaSystem` chosen to match that many lines without
 * ever stranding a single bar alone. On a narrow-enough screen even that can
 * still fail to fit at the legibility floor — falling back to the natural
 * wrap (already confirmed single-bar-free) is safer than an uneven split
 * that reintroduces the very problem being fixed.
 */
async function fitScore() {
  if (!current || !osmd) return;
  osmd.EngravingRules.RenderXMeasuresPerLineAkaSystem = 0;
  const natural = shrinkUntilNoSingleBarLines(BASE_ZOOM);
  const totalBars = natural.layout.bars.size;
  const lineCount = natural.layout.systems.length;
  if (lineCount <= 1 || totalBars <= lineCount) return;

  const perLine = chooseMeasuresPerLine(totalBars, lineCount);
  osmd.EngravingRules.RenderXMeasuresPerLineAkaSystem = perLine;
  const forced = shrinkUntilNoSingleBarLines(natural.zoom);
  if (hasSingleBarLine(forced.layout)) {
    osmd.EngravingRules.RenderXMeasuresPerLineAkaSystem = 0;
    osmd.zoom = natural.zoom;
    osmd.render();
    stage.measure();
  }
}

function startFollowing() {
  if (!current || !stage.begin()) return;
  const { secondsPerBar } = barTimings(current.score);
  const totalBars = current.score.barCount;

  const step = () => {
    const elapsed = player.elapsed;
    if (elapsed === null) {
      stopFollowing();
      return;
    }
    if (elapsed >= 0) {
      const position = elapsed / secondsPerBar;
      /*
       * Playback keeps running for a couple of seconds after the last note —
       * the reverb tail — before onEnd fires and stops this loop, but
       * `elapsed` keeps climbing that whole time. Left unclamped, `position`
       * sails past `totalBars` and its fractional part keeps cycling 0→1, so
       * the playhead swept back across the final bar and re-played it, which
       * is the "last bar repeats" symptom. Freeze at the end of the last bar
       * once the test itself is actually finished.
       */
      if (position >= totalBars) {
        stage.update(totalBars, 1);
      } else {
        const bar = Math.floor(position) + 1;
        stage.update(bar, position - Math.floor(position));
      }
    }
    followFrame = requestAnimationFrame(step);
  };
  followFrame = requestAnimationFrame(step);
}

function stopFollowing() {
  cancelAnimationFrame(followFrame);
  followFrame = null;
  stage?.end();
}

function togglePlayback() {
  if (!current) return;
  if (player.playing) {
    player.stop();
    stopFollowing();
    setPlayState(false);
    return;
  }
  setPlayState(true);
  player.play(current.score, {
    onEnd: () => {
      stopFollowing();
      setPlayState(false);
    },
  })
    .then(() => {
      if (!player.playing) return;
      say('播放中——目前小節以色塊標示，同時顯示下一行。');
      startFollowing();
    })
    .catch((error) => fail('播放失敗', error.message));
}

function updateHistoryInfo() {
  elements.historyInfo.textContent = `本機已記錄 ${history.size} 題`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
}
