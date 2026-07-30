import { generateTest } from '../generator/generate.js';
import { toMusicXml } from '../generator/musicxml.js';
import { createHistory, generateUnique } from '../generator/fingerprint.js';
import { createPlayer } from './playback.js';
import { createStage, barTimings } from './stage.js';

const STORAGE_KEY = 'sightscore.history.v1';

const elements = {
  controls: document.querySelector('.controls'),
  grade: document.getElementById('grade'),
  generate: document.getElementById('generate'),
  prepare: document.getElementById('prepare'),
  play: document.getElementById('play'),
  playIcon: document.getElementById('playIcon'),
  stop: document.getElementById('stop'),
  download: document.getElementById('download'),
  status: document.getElementById('status'),
  countdown: document.getElementById('countdown'),
  countdownValue: document.getElementById('countdown-value'),
  frameCountdown: document.getElementById('frame-countdown'),
  frameCountdownValue: document.getElementById('frame-countdown-value'),
  meta: document.getElementById('meta'),
  score: document.getElementById('score'),
  frame: document.getElementById('score-frame'),
  stage: document.getElementById('stage'),
  scroller: document.getElementById('scroller'),
  playline: document.getElementById('playline'),
  highlight: document.getElementById('measure-highlight'),
  fullscreen: document.getElementById('fullscreen'),
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

let rules = null;
let osmd = null;
let stage = null;
let current = null;
let countdownTimer = null;
let followFrame = null;
/** Zoom chosen for the normal view, restored when leaving fullscreen. */
const BASE_ZOOM = 1;

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

  stage = createStage({
    frame: elements.frame,
    stage: elements.stage,
    scroller: elements.scroller,
    score: elements.score,
    playline: elements.playline,
    highlight: elements.highlight,
    fullscreen: elements.fullscreen,
    // .controls sits immediately before #status in the document; that's
    // where it's restored to when leaving fullscreen.
    controls: elements.controls,
    controlsHome: elements.status,
    onFullscreenChange: fitScore,
  });

  elements.generate.disabled = false;
  elements.generate.addEventListener('click', newTest);
  elements.prepare.addEventListener('click', startCountdown);
  elements.play.addEventListener('click', togglePlayback);
  elements.stop.addEventListener('click', () => {
    player.stop();
    stopFollowing();
    setPlayState(false);
  });
  elements.download.addEventListener('click', downloadXml);
  elements.clearHistory.addEventListener('click', () => {
    history.clear();
    updateHistoryInfo();
  });
  elements.grade.addEventListener('change', () => {
    if (current) newTest();
  });

  updateHistoryInfo();
}

async function newTest() {
  stopCountdown();
  player.stop();
  stopFollowing();
  setPlayState(false);
  // Fullscreen is deliberately left alone here: generate is one of the
  // controls reparented into the frame while fullscreen (see stage.js), so a
  // real user can audition several tests in a row without ever dropping out
  // of it. Forcing an exit on every new test defeats that.

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

  stage.measure();
  showMeta(score);
  elements.status.hidden = false;
  elements.play.disabled = false;
  elements.stop.disabled = false;
  elements.download.disabled = false;
  elements.countdownValue.textContent = String(rules.exam.preparationSeconds);
  elements.countdown.className = 'countdown';
  elements.checklist.hidden = true;
  elements.frameCountdown.hidden = true;
  updateHistoryInfo();
}

function showMeta(score) {
  const mode = score.key.mode === 'major' ? '大調' : '小調';
  const rows = [
    ['調性', `${score.key.tonic} ${mode}`],
    ['拍號', score.timeSignature.text],
    ['小節', `${score.barCount} 小節`],
    ['速度', `${score.tempoTerm} (♩≈${score.tempoBpm})`],
  ];
  elements.meta.innerHTML = rows
    .map(([term, value]) => `<div><dt>${term}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('');

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
  // Mirrors the main countdown: entering fullscreen removes #status (a
  // sibling of .score-frame) from view entirely, so the seconds have to be
  // shown again from inside the frame itself.
  elements.frameCountdownValue.textContent = String(remaining);
  elements.frameCountdown.hidden = false;
  say('準備時間：全螢幕顯示整份樂譜，時間到會自動返回。');

  // The real exam hands over the whole page for these 30 seconds — go
  // fullscreen for the same reason the follow view exists at all: the next
  // line needs to already be in sight. enterFullscreen() is called directly
  // from this click handler (nothing awaited before it), which is what the
  // Fullscreen API's user-gesture rule requires.
  stage.enterFullscreen().catch(() => {
    /* refused or unsupported; the countdown still runs in the normal view */
  });

  countdownTimer = setInterval(() => {
    remaining -= 1;
    const display = String(Math.max(remaining, 0));
    elements.countdownValue.textContent = display;
    elements.frameCountdownValue.textContent = display;
    if (remaining <= 0) {
      stopCountdown();
      elements.countdown.className = 'countdown done';
      elements.checklist.hidden = true;
      elements.frameCountdown.hidden = true;
      stage.exitFullscreen().catch(() => {});
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
 * Fit the whole test on screen. In fullscreen the point is to read it in one
 * go, so the engraving is scaled down until it fits both ways.
 */
async function fitScore(isFullscreen) {
  if (!current || !osmd) return;
  osmd.zoom = BASE_ZOOM;
  osmd.render();

  if (isFullscreen) {
    const style = getComputedStyle(elements.frame);
    // The controls toolbar is an overlay pinned to the bottom of the frame
    // (see stage.js's relocateControls) — it doesn't push the frame's own
    // box around, so its height has to be subtracted by hand or the fitted
    // score would render underneath it instead of stopping above it.
    const controlsBar = elements.controls;
    const overlayHeight = controlsBar && controlsBar.parentElement === elements.frame
      ? controlsBar.getBoundingClientRect().height + 24
      : 0;
    const availableHeight = elements.frame.clientHeight
      - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - overlayHeight;

    let low = 0.35;
    let high = 1.6;
    let best = null;
    for (let pass = 0; pass < 6 && high - low > 0.04; pass++) {
      const zoom = (low + high) / 2;
      osmd.zoom = zoom;
      osmd.render();
      const box = elements.score.querySelector('svg')?.getBoundingClientRect();
      if (box && box.height <= availableHeight) {
        best = zoom;
        low = zoom;
      } else {
        high = zoom;
      }
    }
    if (best !== null && osmd.zoom !== best) {
      osmd.zoom = best;
      osmd.render();
    }
  }
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

function downloadXml() {
  if (!current) return;
  const { score, xml } = current;
  const name = `sightscore-g${score.grade}-${score.seed}.musicxml`;
  const url = URL.createObjectURL(new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function updateHistoryInfo() {
  elements.historyInfo.textContent = `本機已記錄 ${history.size} 題`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
}
