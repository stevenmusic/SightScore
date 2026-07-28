import { generateTest } from '../generator/generate.js';
import { toMusicXml } from '../generator/musicxml.js';
import { createHistory, generateUnique } from '../generator/fingerprint.js';
import { createPlayer } from './playback.js';

const STORAGE_KEY = 'sightscore.history.v1';

const elements = {
  grade: document.getElementById('grade'),
  generate: document.getElementById('generate'),
  prepare: document.getElementById('prepare'),
  play: document.getElementById('play'),
  download: document.getElementById('download'),
  status: document.getElementById('status'),
  countdown: document.getElementById('countdown'),
  countdownValue: document.getElementById('countdown-value'),
  meta: document.getElementById('meta'),
  score: document.getElementById('score'),
  message: document.getElementById('message'),
  historyInfo: document.getElementById('history-info'),
  clearHistory: document.getElementById('clear-history'),
  confidence: document.getElementById('confidence'),
};

const player = createPlayer();
const history = createHistory({
  capacity: 60,
  load: () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'),
  save: (entries) => localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)),
});

let rules = null;
let osmd = null;
let current = null;
let countdownTimer = null;

const CONFIDENCE_LABEL = {
  verified: null,
  partial: '此級數部分參數為推估值',
  inferred: '此級數參數為推估值，尚待官方大綱核對',
};

init();

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

  elements.generate.disabled = false;
  elements.generate.addEventListener('click', newTest);
  elements.prepare.addEventListener('click', startCountdown);
  elements.play.addEventListener('click', togglePlayback);
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

  const grade = Number(elements.grade.value);
  const { score } = generateUnique(() => generateTest(rules, { grade }), history);
  current = { score, xml: toMusicXml(score) };

  elements.message.textContent = '渲染中…';
  try {
    await osmd.load(current.xml);
    osmd.render();
    elements.message.textContent = '按「開始 30 秒準備」模擬考試流程。';
  } catch (error) {
    elements.message.textContent = `渲染失敗：${error.message}`;
    return;
  }

  showMeta(score);
  elements.status.hidden = false;
  elements.play.disabled = false;
  elements.download.disabled = false;
  elements.countdownValue.textContent = String(rules.exam.preparationSeconds);
  elements.countdown.className = 'countdown';
  updateHistoryInfo();
}

function showMeta(score) {
  const mode = score.key.mode === 'major' ? '大調' : '小調';
  const rows = [
    ['調性', `${score.key.tonic} ${mode}`],
    ['拍號', score.timeSignature.text],
    ['小節', `${score.barCount} 小節`],
    ['速度', `${score.tempoTerm} (♩≈${score.tempoBpm})`],
    ['種子', String(score.seed)],
  ];
  elements.meta.innerHTML = rows
    .map(([term, value]) => `<div><dt>${term}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('');

  const warning = CONFIDENCE_LABEL[score.confidence];
  elements.confidence.hidden = !warning;
  if (warning) elements.confidence.textContent = warning;
}

function startCountdown() {
  stopCountdown();
  let remaining = rules.exam.preparationSeconds;
  elements.countdownValue.textContent = String(remaining);
  elements.countdown.className = 'countdown running';
  elements.message.textContent = '準備時間：看調號、拍號、速度術語，找出把位與難處。';

  countdownTimer = setInterval(() => {
    remaining -= 1;
    elements.countdownValue.textContent = String(Math.max(remaining, 0));
    if (remaining <= 0) {
      stopCountdown();
      elements.countdown.className = 'countdown done';
      elements.message.textContent = '時間到——請不間斷地彈完，再按「播放正確版本」比對。';
    }
  }, 1000);
}

function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
}

function togglePlayback() {
  if (!current) return;
  if (player.playing) {
    player.stop();
    elements.play.textContent = '播放正確版本';
    return;
  }
  elements.play.textContent = '停止播放';
  player.play(current.score, {
    onEnd: () => {
      elements.play.textContent = '播放正確版本';
    },
  });
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
