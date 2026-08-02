import { generateTest } from '../generator/generate.js?v=18';
import { toMusicXml } from '../generator/musicxml.js?v=18';
import { createHistory, generateUnique } from '../generator/fingerprint.js?v=18';
import { createKey, pitchAt } from '../generator/theory.js?v=18';
import { createPlayer } from './playback.js?v=18';
import { createStage, barTimings } from './stage.js?v=18';

const STORAGE_KEY = 'sightscore.history.v1';
const LAYOUT_STORAGE_KEY = 'sightscore.layout.v1';

const elements = {
  grade: document.getElementById('grade'),
  generate: document.getElementById('generate'),
  prepare: document.getElementById('prepare'),
  play: document.getElementById('play'),
  playIcon: document.getElementById('playIcon'),
  stop: document.getElementById('stop'),
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

const player = createPlayer({
  // Only loading progress and failures; play() reports the rest.
  onStatus: (text) => { if (text) say(text); },
});
const history = createHistory({
  capacity: 60,
  load: () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'),
  save: (entries) => localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)),
});

/*
 * Two tests of the same grade, bar count and time signature are the same
 * "shape" of test, but `fitScore`'s own search is driven by measuring the
 * *rendered* content — how wide a bar comes out depends on note density,
 * chords, accidentals, dynamics — so two same-shaped tests could still land
 * on a different bars-per-line/zoom combination and read as visibly
 * different sizes for no reason a reader could point to. Keyed by shape and
 * persisted (not just per-session) so the same shape always converges on the
 * same size, the way a printed sight-reading book would set it. The first
 * test of a given shape establishes the canonical layout; later same-shaped
 * tests reuse it, only adjusting zoom downward if that particular test's own
 * content genuinely needs more room (denser content never overflows, it just
 * stops matching the canonical size for that one render).
 */
const layoutCache = (() => {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
})();

function saveLayoutCache() {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layoutCache));
  } catch {
    /* storage full or unavailable — the layout still works, just isn't remembered */
  }
}

function layoutShapeKey(score) {
  return `${score.grade}:${score.barCount}:${score.timeSignature.text}`;
}

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
/** Breathing room under the last system, so it never sits on the screen edge. */
const SCORE_BOTTOM_GAP = 16;
/*
 * Past this, a line of a short/simple test starts reading as cramped. Five
 * rather than four so that a ten-bar test — a common length from Grade 5 up,
 * and one with no even divisor at four or below — can split 5+5 instead of
 * 4+4+2. On a narrow screen the zoom floor rejects it and the search falls
 * through to a smaller count, so this only takes effect where there is width
 * for it.
 */
const MAX_MEASURES_PER_LINE = 5;

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
      // OSMD's default leaves the last system of a piece at its own natural
      // width rather than justifying it to the frame like every other line —
      // normal typesetting convention, but with `fitScore` forcing a uniform
      // bars-per-line count so that same-shaped tests share a layout (see
      // `layoutCache`), it means two lines with the *same* bar count can
      // still end at different points, which reads as misaligned rather than
      // deliberate. Stretching the last line to match keeps every line's
      // right edge where the reader expects it.
      stretchLastSystemLine: true,
    });
    osmd.EngravingRules.FixedMeasureWidth = true;
  } catch (error) {
    fail('無法初始化樂譜渲染器', error.message);
    return;
  }
  window.__osmd = osmd; // debugging hook, also used by scripts/smoke.js

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
  elements.meta.hidden = false;
  elements.countdown.hidden = false;
  elements.play.disabled = false;
  elements.stop.disabled = false;
  elements.prepare.disabled = false;
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

/**
 * The tonic triad in root position, near the middle of the keyboard — what
 * an ABRSM examiner plays to establish the key before the 30 seconds start.
 * Built from `theory.js`'s diatonic-step spelling rather than a hand-picked
 * MIDI set, so the chord always comes from the test's actual key (its
 * accidentals follow the key signature, the same way every note in the
 * generated score does).
 */
function tonicTriadMidis(scoreKey) {
  const key = createKey(scoreKey);
  const root = 7 * 4 + key.tonicLetter; // dstep for the tonic near middle C
  return [root, root + 2, root + 4].map((dstep) => pitchAt(dstep, key).midi);
}

/**
 * Real preparation starts once the key has been given, not the instant the
 * button is pressed — so this gives the tonic chord first and only starts
 * the visible 30-second countdown once it has finished ringing. `current` is
 * guarded rather than assumed: `#prepare` isn't disabled while a chord or a
 * countdown from a *previous* test is still in flight, only before the very
 * first test exists.
 */
async function startCountdown() {
  if (!current) return;
  stopCountdown();
  player.stop();
  elements.checklist.hidden = true;
  say('給音中……');

  await player.playChord(tonicTriadMidis(current.score.key)).catch(() => {});

  runPreparationCountdown();
}

function runPreparationCountdown() {
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
function shrinkUntilNoSingleBarLines(zoom, { fitHeight = false } = {}) {
  /*
   * Only shrink for height when the caller is actually looking for a layout
   * that fits the screen. On a phone nothing fits, so folding the height into
   * the loop unconditionally drove every candidate to the zoom floor and made
   * the whole page tiny — the opposite of leaving a small screen alone.
   */
  const available = fitHeight ? availableScoreHeight() : Infinity;
  osmd.zoom = zoom;
  osmd.render();
  let layout = stage.measure();
  while (zoom > MIN_ZOOM && (hasSingleBarLine(layout) || renderedScoreHeight() > available)) {
    zoom = Math.max(MIN_ZOOM, zoom * 0.92);
    osmd.zoom = zoom;
    osmd.render();
    layout = stage.measure();
  }
  return { layout, zoom, fitsHeight: renderedScoreHeight() <= available };
}

/**
 * How tall the engraved score actually is, measured from the rendered SVG
 * rather than from the bar boxes.
 *
 * The bar boxes cover the staves only. Everything OSMD hangs outside them —
 * pedal brackets under the bass staff, dynamics and hairpins between the
 * staves, slurs and ledger lines above — is in the SVG but not in those
 * boxes, so sizing to them would leave exactly the material this needs to
 * reserve room for hanging off the bottom of the screen.
 */
function renderedScoreHeight() {
  const svg = document.querySelector('#score svg');
  return svg ? svg.getBoundingClientRect().height : 0;
}

/**
 * The height the score has to fit into for the whole test to be readable
 * without scrolling — the distance from the top of the engraving to the
 * bottom of the window, less the frame's own padding.
 *
 * A tablet has the room for this and a phone often does not; the zoom floor
 * decides which. Where the floor is reached first the score simply stays
 * legible and the page scrolls, which is the right trade on a small screen.
 */
function availableScoreHeight() {
  const scoreBox = document.getElementById('score')?.getBoundingClientRect();
  if (!scoreBox) return Infinity;
  const frame = document.getElementById('score-frame');
  const framePadding = frame
    ? parseFloat(getComputedStyle(frame).paddingBottom) || 0
    : 0;
  const viewport = window.innerHeight || document.documentElement.clientHeight;
  return Math.max(120, viewport - scoreBox.top - framePadding - SCORE_BOTTOM_GAP);
}

function hasSingleBarLine(layout) {
  return layout.bars.size > 1 && layout.systems.some((system) => system.bars.length === 1);
}

/**
 * The whole test always renders on the page in normal flow — no fullscreen
 * step, no cropped follow-window — so the only fitting left to do is layout.
 * OSMD's own line
 * breaking is also a greedy fill (pack bars onto a line until the next one
 * doesn't fit), which leaves a lone bar on a line when the content doesn't
 * happen to divide evenly, and tends to front-load earlier lines since
 * bar-to-bar width varies with note density. `RenderXMeasuresPerLineAkaSystem`
 * fixes both by forcing a uniform bars-per-line count instead of a greedy
 * wrap — the question is which count.
 *
 * A short/simple test (a Grade 1 six-bar piece, say) can render at full
 * legible zoom with a natural wrap of just 1-2 bars per line — nothing
 * forces it smaller, so it reads as conspicuously oversized even though a
 * slightly smaller (but still comfortably legible) zoom would fit
 * noticeably more per line. So rather than matching whatever the natural
 * unforced wrap happens to produce, try progressively more bars per line —
 * from `MAX_MEASURES_PER_LINE` down to 2 — and take the first (most
 * compact) count that still renders with zoom no smaller than `MIN_ZOOM`
 * and no line stranding a single bar. `n=3` on 10 bars would strand one
 * bar on a fourth line (3+3+3+1) rather than sharing it with the others,
 * so any `n` that leaves a remainder of exactly 1 is skipped outright.
 * Denser/longer tests simply fail every candidate down to 2 and fall back
 * to the natural wrap, which is always guaranteed single-bar-line-free.
 */
async function fitScore() {
  if (!current || !osmd) return;

  const shapeKey = layoutShapeKey(current.score);
  const cached = layoutCache[shapeKey];
  if (cached) {
    osmd.EngravingRules.RenderXMeasuresPerLineAkaSystem = cached.measuresPerLine;
    // Re-shrinks from the cached zoom only if *this* render's own content
    // (denser notes, more accidentals) doesn't actually fit it — the cache
    // itself is never overwritten by that, so later same-shaped tests still
    // converge back on the canonical size.
    const result = shrinkUntilNoSingleBarLines(cached.zoom, { fitHeight: true });
    ensureFitsHeight(result.zoom);
    return;
  }

  osmd.EngravingRules.RenderXMeasuresPerLineAkaSystem = 0;
  const natural = shrinkUntilNoSingleBarLines(BASE_ZOOM);
  const totalBars = natural.layout.bars.size;

  const tryCount = (n, mustFitHeight) => {
    osmd.EngravingRules.RenderXMeasuresPerLineAkaSystem = n;
    const attempt = shrinkUntilNoSingleBarLines(BASE_ZOOM, { fitHeight: mustFitHeight });
    if (attempt.zoom < MIN_ZOOM || hasSingleBarLine(attempt.layout)) return null;
    return !mustFitHeight || attempt.fitsHeight ? attempt : null;
  };

  /*
   * Two passes over the same candidates: the first insists the whole test fit
   * the screen, the second drops that. A tablet gets a layout that needs no
   * scrolling; a phone, where the zoom floor is reached long before the score
   * is short enough, keeps a legible size and scrolls instead of shrinking
   * into something nobody can read.
   */
  const search = (mustFitHeight) => {
    let found = null;
    for (let n = Math.min(MAX_MEASURES_PER_LINE, totalBars); n >= 3 && !found; n--) {
      if (totalBars % n === 0) found = tryCount(n, mustFitHeight);
    }
    for (let n = Math.min(MAX_MEASURES_PER_LINE, totalBars); n >= 2 && !found; n--) {
      if (totalBars % n === 1) continue; // would strand one bar on its own line
      if (totalBars % n === 0) continue; // already tried above
      found = tryCount(n, mustFitHeight);
    }
    return found;
  };

  /*
   * A count that divides the bars evenly comes first. Taking merely the most
   * compact count that avoids a lone bar is not the same thing: six bars at
   * four per line gives 4+2, and OSMD does not stretch a final short line to
   * the full width, so the second line ends up half the length of the first
   * and its bars visibly smaller. 3+3 fills both lines instead — squarer, and
   * the bars come out wider because the width is shared evenly. Counts below
   * three are not worth evenness on its own: two bars a line turns a ten-bar
   * test into five lines to avoid one short one.
   */
  const chosen = search(true) ?? search(false);
  // `tryCount` leaves `RenderXMeasuresPerLineAkaSystem` set to whichever `n`
  // it last tried, and the loops stop trying more once `chosen` is found —
  // so this is still the winning count, captured before the fallback branch
  // below can reset it back to 0 (natural wrap).
  const measuresPerLine = chosen ? osmd.EngravingRules.RenderXMeasuresPerLineAkaSystem : 0;

  if (!chosen) {
    osmd.EngravingRules.RenderXMeasuresPerLineAkaSystem = 0;
    osmd.zoom = natural.zoom;
    osmd.render();
    stage.measure();
  }

  layoutCache[shapeKey] = { measuresPerLine, zoom: chosen ? chosen.zoom : natural.zoom };
  saveLayoutCache();

  ensureFitsHeight(chosen ? chosen.zoom : natural.zoom);
}

/**
 * Last word on vertical fit: if the layout just settled on still runs off the
 * bottom, shrink it until it does not — but only when that is actually
 * reachable above the legibility floor.
 *
 * The per-candidate search can miss by a hair (an iPad was overflowing by nine
 * pixels), and the search that ignores height deliberately does not shrink at
 * all. Checking the floor first is what keeps the two cases apart: on a tablet
 * the score comes down the little it needs to, and on a phone — where even the
 * floor would not fit the whole test — nothing is shrunk and the page scrolls,
 * rather than the music being reduced to something unreadable in pursuit of a
 * fit that was never available.
 */
function ensureFitsHeight(startZoom) {
  const available = availableScoreHeight();
  if (renderedScoreHeight() <= available) return;

  const settled = osmd.zoom;
  osmd.zoom = MIN_ZOOM;
  osmd.render();
  const floorFits = renderedScoreHeight() <= available;
  if (!floorFits) {
    osmd.zoom = settled;
    osmd.render();
    stage.measure();
    return;
  }

  /*
   * Shrinking re-flows the line breaks on the unforced fallback layout, so
   * this has to keep watching for a bar left alone on a line — otherwise
   * stopping the moment the height fits can hand back a layout that reads
   * worse than the one it started from.
   */
  let zoom = startZoom;
  osmd.zoom = zoom;
  osmd.render();
  let layout = stage.measure();
  const startedClean = !hasSingleBarLine(layout);
  while (zoom > MIN_ZOOM && (renderedScoreHeight() > available || hasSingleBarLine(layout))) {
    zoom = Math.max(MIN_ZOOM, zoom * 0.94);
    osmd.zoom = zoom;
    osmd.render();
    layout = stage.measure();
  }
  /*
   * Fitting the height is not worth stranding a bar on a line of its own.
   * Shrinking re-flows the unforced layout, and on the smallest screens that
   * can turn a clean set of lines into one with a lone bar on the end — a
   * worse thing to read than a score that needs a scroll.
   */
  if (!startedClean || !hasSingleBarLine(layout)) return;
  osmd.zoom = settled;
  osmd.render();
  stage.measure();
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
  elements.historyInfo.textContent = `已紀錄${history.size}題`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
}
