/**
 * Two-language dictionary + tiny apply/lookup helpers, shared shape with
 * ScrollScore/HarmonyMap/LoudMaster's own i18n modules.
 *
 * `sm_lang` is a deliberately shared localStorage key — all four sibling
 * tools and the hub live on the same origin (stevenmusic.github.io/<tool>/),
 * so a language chosen in one carries over to the others. Default is "zh"
 * (this app's original language) whenever nothing is stored yet; there is no
 * browser-language auto-detection.
 *
 * Two kinds of markup consume this:
 *  - `data-i18n="key"` on an element sets its textContent to `t(key)`.
 *  - `data-i18n-attr="attr1:key1,attr2:key2"` sets one or more attributes
 *    (aria-label, title, ...) from their own keys.
 * `applyLanguage()` walks both, then updates `<html lang>` and notifies
 * anything that registered via `onLanguageChange` — used by app.js to
 * re-render the text it builds itself (status messages, select options,
 * the checklist, ...) that no static attribute can reach.
 */

const STORAGE_KEY = 'sm_lang';

export const I18N = {
  zh: {
    pageTitle: 'SightScore — 視奏隨機題目生成器',
    homeAria: '回首頁',
    homeText: '首頁',
    generateLabel: '產生新題目',
    prepareLabel: '開始 30 秒準備',
    playAriaPlay: '播放',
    playTitlePlay: '播放正確版本',
    playAriaStop: '停止',
    playTitleStop: '停止播放',
    stopAria: '停止',
    stopTitle: '停止並回到開頭',
    gradeLabel: '級數',
    keyLabel: '調性',
    randomKey: '隨機調性',
    majorKey: '{tonic} 大調',
    minorKey: '{tonic} 小調',
    // Same content as majorKey/minorKey — the meta strip's fixed-width
    // field doesn't need a separate compact form in Chinese the way English
    // does (see the `en` block below).
    metaKeyMajor: '{tonic} 大調',
    metaKeyMinor: '{tonic} 小調',
    barsSuffix: '{count} 小節',
    countdownUnit: '秒',
    clearHistory: '清除出題紀錄',
    langToggleLabel: 'EN',
    langToggleAria: '切換為英文介面',
    langToggleTitle: '切換為英文介面',

    loadingOSMD: '找不到樂譜渲染函式庫 OSMD（vendor/opensheetmusicdisplay.min.js 未載入）。'
      + '請確認該檔案存在，並透過 http 開啟頁面（直接以 file:// 開啟不會運作）',
    failLoadRules: '無法載入規則表',
    failInitRenderer: '無法初始化樂譜渲染器',
    errorGeneric: '發生錯誤',
    errorDetail: '{text}（{detail}）',
    renderingStatus: '渲染中…',
    readyStatus: '按「開始 30 秒準備」模擬考試流程。',
    failRender: '渲染失敗',
    givingPitch: '給音中……',
    prepFitsScreen: '準備時間：整份樂譜已經在畫面上，時間到會提示開始。',
    prepScrolls: '準備時間：可上下捲動看完整份樂譜，時間到會提示開始。',
    prepDone: '時間到——不要停、不要回頭改，彈完再按播放比對。',
    playingStatus: '播放中——目前小節以色塊標示，同時顯示下一行。',
    failPlayback: '播放失敗',
    historyCount: '已紀錄{count}題',
    confidencePartial: '此級數部分參數為推估值',
    confidenceInferred: '此級數參數為推估值，尚待官方大綱核對',
    loadingSamples: '載入鋼琴音色中…',
    samplesFailed: '鋼琴音色載入失敗，暫用備援音色',

    prepStep1: '調號 — 幾個升降記號？主音在哪？',
    prepStep2: '拍號 — 幾拍子？複拍子用大拍感覺（6/8 是兩大拍）',
    prepStep3: '速度術語 — 決定起頭速度',
    prepStep4: '把位 — 兩手從哪裡開始，中途換不換',
    prepStep5: '掃描難點 — 臨時記號、最密的一小節、最大的跳進',
    prepStep6: '用最難的那一小節決定速度，然後心裡數一小節',
  },
  en: {
    pageTitle: 'SightScore — Sight-Reading Test Generator',
    homeAria: 'Back to home',
    homeText: 'Home',
    generateLabel: 'New test',
    prepareLabel: '30s prep',
    playAriaPlay: 'Play',
    playTitlePlay: 'Play reference',
    playAriaStop: 'Stop',
    playTitleStop: 'Stop playback',
    stopAria: 'Stop',
    stopTitle: 'Stop and return to start',
    gradeLabel: 'Grade',
    keyLabel: 'Key',
    randomKey: 'Random key',
    majorKey: '{tonic} major',
    minorKey: '{tonic} minor',
    // Tighter than majorKey/minorKey above: `.meta-key` is a fixed-width
    // field (sized for Chinese's "Gb 大調") and the full word "major"/
    // "minor" routinely overflowed it — "maj"/"min" reads fine at this
    // field's own compact, label-free style (see showMeta in app.js).
    metaKeyMajor: '{tonic} maj',
    metaKeyMinor: '{tonic} min',
    barsSuffix: '{count} bars',
    countdownUnit: 's',
    clearHistory: 'Clear history',
    langToggleLabel: '中',
    langToggleAria: 'Switch to Chinese interface',
    langToggleTitle: 'Switch to Chinese interface',

    loadingOSMD: 'Could not find the OSMD score-rendering library '
      + '(vendor/opensheetmusicdisplay.min.js did not load). Make sure that file '
      + "exists and open this page over http (opening it directly as file:// won't work)",
    failLoadRules: 'Could not load the rules table',
    failInitRenderer: 'Could not initialise the score renderer',
    errorGeneric: 'Something went wrong',
    errorDetail: '{text} ({detail})',
    renderingStatus: 'Rendering…',
    readyStatus: 'Press "Start 30s prep" to simulate exam conditions.',
    failRender: 'Render failed',
    givingPitch: 'Playing starting pitch…',
    prepFitsScreen: "Prep time: the whole score is on screen — you'll be prompted when time is up.",
    prepScrolls: "Prep time: scroll to see the whole score — you'll be prompted when time is up.",
    prepDone: "Time's up — keep going, don't go back to fix mistakes; compare with playback once you're done.",
    playingStatus: 'Playing — the current bar is highlighted and the next line shown.',
    failPlayback: 'Playback failed',
    historyCount: '{count} recorded',
    confidencePartial: 'Some parameters for this grade are estimated',
    confidenceInferred: 'Parameters for this grade are inferred, pending verification against the official syllabus',
    loadingSamples: 'Loading piano samples…',
    samplesFailed: 'Piano samples failed to load, using a fallback sound',

    prepStep1: 'Key signature — how many sharps/flats? Where is the tonic?',
    prepStep2: 'Time signature — how many beats? Feel compound time in big beats (6/8 is two)',
    prepStep3: 'Tempo marking — set your starting speed',
    prepStep4: 'Hand position — where do both hands start, and does it change',
    prepStep5: 'Scan for hazards — accidentals, the densest bar, the biggest leap',
    prepStep6: 'Set the tempo from the hardest bar, then count yourself in',
  },
};

let currentLang = 'zh';
const listeners = [];

/** Currently active language code, "zh" or "en". */
export function getLanguage() {
  return currentLang;
}

/** Look up `key` in the active dictionary (falling back to zh, then the key
 * itself), substituting any `{name}` placeholders from `params`. */
export function t(key, params) {
  const dict = I18N[currentLang] ?? I18N.zh;
  let str = dict[key] ?? I18N.zh[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      str = str.replaceAll(`{${name}}`, String(value));
    }
  }
  return str;
}

/** Register a callback fired after every `applyLanguage()` call, for the
 * text app.js builds itself (status messages, select options, the
 * preparation checklist, ...) that no static `data-i18n` attribute reaches. */
export function onLanguageChange(fn) {
  listeners.push(fn);
}

/**
 * Switches the active language, persists it, re-walks every `data-i18n`/
 * `data-i18n-attr` element in the document, and notifies subscribers so the
 * rest of the page's dynamic text can re-render in place. No element is ever
 * cloned or duplicated — the same nodes just get new text.
 */
export function applyLanguage(lang) {
  currentLang = lang === 'en' ? 'en' : 'zh';
  try {
    localStorage.setItem(STORAGE_KEY, currentLang);
  } catch {
    /* storage full or unavailable — the switch still works for this load */
  }

  document.documentElement.lang = currentLang === 'en' ? 'en' : 'zh-Hant';

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    for (const pair of el.getAttribute('data-i18n-attr').split(',')) {
      const [attr, key] = pair.split(':').map((part) => part.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  });

  for (const fn of listeners) fn(currentLang);
}

/** Reads the persisted choice (defaulting to "zh") and applies it — call
 * this first thing on module load, before anything paints. */
export function initLanguage() {
  let stored = 'zh';
  try {
    stored = localStorage.getItem(STORAGE_KEY) ?? 'zh';
  } catch {
    /* storage unavailable — fall back to the default */
  }
  applyLanguage(stored === 'en' ? 'en' : 'zh');
  return currentLang;
}
