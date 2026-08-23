import { generateTest, keyOptionsFor } from '../generator/generate.js?v=54';
import { toMusicXml } from '../generator/musicxml.js?v=54';
import { createHistory, generateUnique } from '../generator/fingerprint.js?v=54';
import { createKey, pitchAt } from '../generator/theory.js?v=54';
import { createPlayer } from './playback.js?v=54';
import { createStage, barTimings } from './stage.js?v=54';
import { initLanguage, applyLanguage, getLanguage, t, onLanguageChange } from './i18n.js?v=54';

// As early as possible, before any other DOM work below, so the page never
// paints in the wrong language for a returning en visitor.
initLanguage();

const STORAGE_KEY = 'sightscore.history.v1';
const LAYOUT_STORAGE_KEY = 'sightscore.layout.v1';

const elements = {
  gradeControls: document.getElementById('grade-controls'),
  grade: document.getElementById('grade'),
  key: document.getElementById('key'),
  generate: document.getElementById('generate'),
  prepare: document.getElementById('prepare'),
  play: document.getElementById('play'),
  playIcon: document.getElementById('playIcon'),
  stop: document.getElementById('stop'),
  countdown: document.getElementById('countdown'),
  countdownValue: document.getElementById('countdown-value'),
  meta: document.getElementById('meta'),
  metaRow: document.getElementById('meta-row'),
  scoreFrame: document.getElementById('score-frame'),
  score: document.getElementById('score'),
  playline: document.getElementById('playline'),
  highlight: document.getElementById('measure-highlight'),
  message: document.getElementById('message'),
  checklist: document.getElementById('checklist'),
  historyInfo: document.getElementById('history-info'),
  clearHistory: document.getElementById('clear-history'),
  confidence: document.getElementById('confidence'),
  langToggle: document.getElementById('lang-toggle'),
};

/* ScrollScore's icon paths, so the two apps show the same glyphs. */
const PLAY_ICON_D = 'M8 5v14l11-7z';
const PAUSE_ICON_D = 'M6 5h4v14H6zM14 5h4v14h-4z';

const player = createPlayer({
  // Only loading progress and failures; play() reports the rest. playback.js
  // passes i18n keys (not already-localized text) so a language switch mid
  // load still re-renders correctly — see `refreshDynamicText`.
  onStatus: (key) => { if (key) say(key); },
});
const history = createHistory({
  capacity: 60,
  load: () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'),
  save: (entries) => localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)),
});

/*
 * Which bars-per-line count a given shape of test settled on, remembered so
 * two tests of the same grade and bar count break their lines the same way —
 * the way a printed sight-reading book keeps a consistent page layout for
 * same-length tests. The count is decided by measuring the *rendered*
 * content (bar width depends on note density, chords, accidentals), so
 * without this two same-shaped tests could land on different counts for no
 * reason a reader could point to.
 *
 * Only the line breaking lives here. The staff size used to be the other half
 * of this entry, searched per test and ratcheted down when a denser test of
 * the same shape needed more shrinking; it is now fixed per viewport
 * (`STAFF_ZOOM`) and never searched, so there is nothing left to ratchet.
 * `matchesRequestedLayout` (see `fitScore`) is what keeps the two axes below
 * safe to fold into the key: a cached count OSMD no longer honours for this
 * test's content is caught and re-searched rather than silently rendered as a
 * different number of lines.
 *
 * Two axes are deliberately coarser than "exact value" rather than dropped:
 *
 * - Time signature is bucketed by how much content a bar actually holds —
 *   `narrow` for four quarter notes' worth or fewer (2/4, 3/4, 4/4, 2/2,
 *   3/8, 5/8, 6/8, 7/8), `wide` for more (9/8, 5/4, 12/8, 7/4). This keys off
 *   real beat content rather than a hand-picked "simple time signature"
 *   family: 2/2 and 3/8 hold no more than a 4/4 bar despite not being in the
 *   classic 2/4-3/4-4/4 family. Dropping metre entirely was tried — a 2/4
 *   test and a 12/8 test of the same bar count genuinely do not fit the same
 *   number of bars on a line, so they would keep re-searching instead of
 *   settling.
 * - Viewport width is bucketed (`layoutWidthClass`), since how many bars fit
 *   a line is a question about the screen. Coarse tiers rather than exact
 *   pixels, so two phones (393 vs 430) share one answer instead of each
 *   model getting its own.
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

/** How many quarter notes' worth of content one bar holds — 2/4 is 2, 4/4 is
 * 4, 12/8 (four dotted-quarter beats) is 6. `narrow` at four or under
 * covers 2/4, 3/4, 4/4, 2/2, 3/8, 5/8, 6/8 and 7/8; `wide` covers 9/8, 5/4,
 * 12/8 and 7/4. */
function timeSignatureClass({ beats, beatType }) {
  const quarterNotesPerBar = (beats * 4) / beatType;
  return quarterNotesPerBar <= 4 ? 'narrow' : 'wide';
}

/** Coarse viewport-width tiers, so portrait phone / landscape-or-tablet /
 * desktop each get their own canonical layout instead of sharing one. */
function layoutWidthClass() {
  const width = window.innerWidth || document.documentElement.clientWidth;
  if (width < 500) return 'phone';
  if (width < 900) return 'compact';
  if (width < 1280) return 'medium';
  return 'wide';
}

/**
 * The one staff size this viewport uses, for every test at every grade. Fixed
 * rather than searched — see `STAFF_ZOOM`.
 */
function staffZoom() {
  return STAFF_ZOOM[layoutWidthClass()] ?? BASE_ZOOM;
}

/*
 * Only the line breaking is cached now: the zoom that used to be the other
 * half of this entry is fixed per viewport, so there is nothing left to
 * ratchet. The metre bucket and width tier stay in the key because both still
 * change how many bars fit on a line.
 */
function layoutShapeKey(score) {
  return `${score.grade}:${score.barCount}:${timeSignatureClass(score.timeSignature)}:${layoutWidthClass()}`;
}

let rules = null;
let osmd = null;
let stage = null;
let current = null;
let countdownTimer = null;
let followFrame = null;
let resizeTimer = null;
const BASE_ZOOM = 1;
/*
 * The staff is a property of the *page*, not of the test printed on it.
 *
 * `fitScore` used to search for a zoom per test and cache it per shape, so
 * the five lines of the stave — and the clefs sitting on them — landed
 * somewhere different depending on what had been generated: measured across
 * 40 renders on one desktop viewport, the gap between staff lines ran from
 * 5.13px to 10.00px (12 distinct sizes, a full 2x), the treble stave's own y
 * moved over a 78px range and the bass stave's over 151px. A reader meets one
 * sheet of paper and then another that is half the size, which reads as the
 * page wobbling rather than as a deliberate fit.
 *
 * So the staff size is now fixed per viewport tier and never searched. Line
 * breaking is the only free variable left — bars-per-line still adapts to the
 * content, which is what the barlines are allowed to do. The cost is that a
 * long, dense test no longer shrinks itself to fit the window; it keeps full
 * size and the page scrolls, the same trade the phone tiers already made.
 */
const STAFF_ZOOM = { phone: 0.46, compact: 0.66, medium: 0.78, wide: 0.78 };
/*
 * `medium` and `wide` share a value on purpose: `body` is capped at 64rem, so
 * the score column is 1024px wide on a 1280px screen and on a 2560px one
 * alike, and the staff has exactly the same room in both. The values are
 * calibrated against that width rather than guessed — each is the largest
 * that still lets `scripts/devices.js` place at least two bars on every line
 * (no stranded single bars) and, outside a landscape phone, keep the whole
 * test on screen. Raising the phone tier to 0.5 was tried and reverted: a
 * 430px-wide screen could not fit two bars of a dense test at that size, so
 * the line breaking fell back to OSMD's greedy wrap and stranded bars alone
 * on their own lines.
 */
/*
 * Fixed vertical spacing, in OSMD units (one unit is one staff-line gap), set
 * where they comfortably clear the tallest thing ordinary writing at these
 * grades puts between the staves — dynamics and a hairpin under the treble,
 * ledger lines reaching down toward the bass. See the OSMD construction for
 * why these are set at all.
 */
const STAFF_GAP_UNITS = 7;
const SYSTEM_GAP_UNITS = 9;
const PAGE_TOP_UNITS = 7;
/** Clear space kept between the tempo/character word and the music, in staff units. */
const TEMPO_TERM_GAP_UNITS = 0.8;
/** Clearance between what hangs off one stave and what rises toward the next. */
const MIN_CLEARANCE_UNITS = 2;
/*
 * Where the treble clef sits, measured from the top of the engraving in staff
 * units (one unit is one line gap, so this scales with the staff size rather
 * than being a pixel guess). Chosen above the most headroom OSMD ever asks
 * for on its own — measured 10.0 to 13.1 units across grades — so `pinScoreTop`
 * only ever pushes the score *down* into the space it reserves. Padding
 * downward can never crowd anything; pulling upward could clip a high ledger
 * line or the tempo word, so the target is deliberately generous.
 */
const SCORE_TOP_UNITS = 15;
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

/*
 * Below this, the grade selector, meta line and countdown stay pinned to
 * the score's own top corners (see `pinTopRowLayout`) — there isn't room
 * to spare for a combined row without crowding the meta text. Two ways to
 * qualify for the combined row instead:
 *   - wide enough outright (desktop, iPad landscape) — `min-width: 1024px`.
 *   - a phone rotated to landscape: plenty of *width* (852px on an iPhone
 *     Pro) but very little *height* (393px), so the pinned-corner layout's
 *     separate rows for the grade selector and meta line cost exactly the
 *     vertical space landscape has least of. `max-height: 500px` catches
 *     this without also catching a portrait phone/tablet, which has height
 *     to spare; `min-width: 680px` keeps it off phones too narrow to lay
 *     the row out on even sideways (matches the breakpoint where the
 *     transport buttons' own labels reappear).
 */
const TOP_ROW_QUERY = window.matchMedia(
  '(min-width: 900px), (orientation: landscape) and (max-height: 420px) and (min-width: 600px)',
);

/** Keyed by `score.confidence` — matches the i18n dictionary's own key names
 * one-to-one, so a lookup here is just `t(CONFIDENCE_LABEL_KEY[confidence])`. */
const CONFIDENCE_LABEL_KEY = {
  verified: null,
  partial: 'confidencePartial',
  inferred: 'confidenceInferred',
};

/**
 * The last status/error shown in `#message`, kept as an i18n key (+ params)
 * rather than only as rendered text — so a language switch mid-message (say,
 * while "Rendering…" is on screen) can re-render it in the new language
 * instead of leaving stale text from the old one. See `refreshDynamicText`.
 */
let lastMessage = null;

init();

/** Ordinary status text, clearing any error styling left behind. */
function say(key, params) {
  lastMessage = { kind: 'say', key, params };
  elements.message.className = 'message';
  elements.message.textContent = t(key, params);
}

/** Surface failures on the page — a blank screen tells the user nothing. */
function fail(key, detail) {
  lastMessage = { kind: 'fail', key, detail };
  elements.message.className = 'message error';
  elements.message.textContent = detail ? t('errorDetail', { text: t(key), detail }) : t(key);
  elements.generate.disabled = true;
}

window.addEventListener('error', (event) => fail('errorGeneric', event.message));
window.addEventListener('unhandledrejection', (event) => fail('errorGeneric', String(event.reason)));

/**
 * Move the actual #grade-controls (grade + key together, see index.html)
 * and #countdown elements (not copies — they keep their ids and listeners
 * either way) between the score's own top corners and a shared row with
 * the meta line, depending on whether the viewport has room to spare.
 * `showMeta` replaces #meta's own innerHTML on every test, which is why
 * they're moved into #meta-row (a stable wrapper) rather than into #meta
 * itself.
 */
function pinTopRowLayout() {
  if (TOP_ROW_QUERY.matches) {
    if (elements.gradeControls.parentElement !== elements.metaRow) {
      elements.metaRow.insertBefore(elements.gradeControls, elements.meta);
    }
    if (elements.countdown.parentElement !== elements.metaRow) {
      elements.metaRow.appendChild(elements.countdown);
    }
  } else {
    if (elements.gradeControls.parentElement !== elements.scoreFrame) {
      elements.scoreFrame.insertBefore(elements.gradeControls, elements.scoreFrame.firstChild);
    }
    if (elements.countdown.parentElement !== elements.scoreFrame) {
      elements.scoreFrame.insertBefore(elements.countdown, elements.gradeControls.nextSibling);
    }
  }
}

/**
 * Move the tempo/character-word text to a fixed spot right after bar 1's
 * clef/key/time signature — OSMD itself centres it on whatever event starts
 * the bar, which for a whole-bar rest sits well into the measure (VexFlow
 * centres a measure rest) while an ordinary first note sits right at the
 * start, so the same term rendered at a different position from test to
 * test depending on which hand opens. The margin is taken from the gap
 * OSMD already placed before the time signature (from the key signature if
 * the key has one, otherwise the clef) rather than a fixed pixel value, so
 * it scales with whatever zoom the piece is rendered at.
 */
/**
 * Land the treble clef on the same pixel row for every test.
 *
 * Fixing the zoom holds the *spacing* of the five lines, but not where they
 * sit: OSMD reserves room above the first stave for whatever sticks up out of
 * it — the tempo word, a high ledger line, a slur — and adds that to its page
 * margin rather than taking the larger of the two, so no margin setting can
 * hold it still (measured: the treble stave's own y took 18 different values
 * across 32 renders, a 28px range, and regenerating visibly jogged the whole
 * page up and down).
 *
 * So the score is padded down to a fixed target instead. `SCORE_TOP_UNITS`
 * sits above the most headroom OSMD ever asks for, which makes every
 * correction a downward one — the score is only ever pushed further into
 * blank space, never pulled up into content. When a test somehow needs more
 * than the target, the padding simply goes to zero and that test keeps
 * OSMD's own spacing, which is the behaviour this replaced.
 *
 * The clef is the anchor rather than the staff lines because it is both what
 * the eye actually fixes on and a single cheap query — its own height is a
 * fixed multiple of the staff size, so pinning its top pins the stave with it.
 */
function pinScoreTop() {
  const svg = elements.score.querySelector('svg');
  if (!svg) return;
  elements.score.style.paddingTop = '0px';
  const clef = svg.querySelector('g.vf-clef');
  if (!clef) return;
  const natural = clef.getBoundingClientRect().top - svg.getBoundingClientRect().top;
  // One OSMD unit is ten pixels before zoom, so the target tracks staff size.
  const target = SCORE_TOP_UNITS * 10 * osmd.zoom;
  const shift = target - natural;
  elements.score.style.paddingTop = `${shift > 0 ? shift : 0}px`;
}

/**
 * Drop the second copy of a word OSMD draws twice.
 *
 * A `<words>` direction OSMD does not recognise as a known instruction gets
 * rendered twice, at byte-identical coordinates — confirmed on the vendored
 * build with a minimal one-note, one-direction document: "rall." and "dolce"
 * each come out twice, while "rit." and "a tempo" (which it does recognise)
 * come out once. Our MusicXML contains the direction exactly once, so this is
 * the renderer, not the serialiser, and no encoding avoids it: placement
 * above/below, with and without `<staff>`, with and without `<voice>`, plain
 * and italic all double.
 *
 * Two identical strings at the same pixel cannot be anything but a duplicate —
 * a real second marking would have to sit somewhere else to be readable — so
 * removing the later one is safe. It also makes the text stop looking
 * artificially bold, which is what drawing it twice actually looks like.
 *
 * Runs before `pinTempoTermPosition`, or that would move one copy and leave
 * the other behind.
 */
function removeDuplicateText() {
  const svg = elements.score.querySelector('svg');
  if (!svg) return;
  const seen = new Set();
  for (const text of svg.querySelectorAll('text')) {
    const box = text.getBoundingClientRect();
    const key = `${text.textContent}@${Math.round(box.x)},${Math.round(box.y)}`;
    if (seen.has(key)) text.remove();
    else seen.add(key);
  }
}

/**
 * Hold the staves in the same place on every render.
 *
 * OSMD spaces the two staves of a grand staff — and the systems below them —
 * by taking the *larger* of a fixed distance and a skyline measured from
 * whatever content sticks out: ledger lines, slurs, hairpins, dynamics. With
 * only the zoom fixed the staff lines kept their spacing but the staves
 * themselves still shuffled: measured over 40 renders, the treble stave's y
 * moved across a 37px range, the bass stave's across 71px, and the gap
 * between them took 18 different values. Set the fixed terms high enough to
 * win against the skyline in ordinary writing at these grades and the fixed
 * term is the one that decides, so every test puts its clefs on the same
 * pixels and only the notes change.
 *
 * This runs before *every* render rather than once at construction because
 * OSMD's `drawingParameters` preset reassigns these same rules
 * (`StaffDistance`, `BetweenStaffDistance`, `MinSkyBottomDist*`) behind us —
 * setting them once looked like it worked and silently did nothing.
 * `StaffDistance` is the one that actually governs the gap inside a grand
 * staff (`addStaffLineToMusicSystem` reads it); `BetweenStaffDistance` is set
 * alongside it for the same value rather than left at whatever the preset
 * chose.
 */
function applyFixedSpacing() {
  const rules = osmd.EngravingRules;
  rules.StaffDistance = STAFF_GAP_UNITS;
  rules.BetweenStaffDistance = STAFF_GAP_UNITS;
  rules.MinimumDistanceBetweenSystems = SYSTEM_GAP_UNITS;
  /*
   * These two are the clearance that keeps what hangs below one stave off
   * what rises toward the next — slurs, hairpins, dynamics, ledger lines.
   * They were briefly set to 0 while chasing a constant staff position, which
   * removed exactly that protection and let slurs pile onto each other and
   * onto the notes. The staff distance above is what holds the layout still;
   * these are what stop it colliding, and they are not the same job.
   */
  rules.MinSkyBottomDistBetweenStaves = MIN_CLEARANCE_UNITS;
  rules.MinSkyBottomDistBetweenSystems = MIN_CLEARANCE_UNITS;
  /*
   * Let a slur bend around what is already engraved rather than being placed
   * from the notes alone. Off by default in OSMD, and with two hands each
   * carrying their own slurs into the same gap between the staves, the
   * default put one straight through the other.
   */
  rules.SlurPlacementUseSkyBottomLine = true;
  /*
   * Anchor slurs at the stems and flatten them slightly. Both keep a slur
   * close to the notes it belongs to instead of arcing out into the bands
   * where the hairpins and the pedal line live, which is where slurs were
   * running through other markings. Measured over 80 rendered tests: 11.6% of
   * tests had a slur crossing a marking with OSMD's defaults, 4.7% with the
   * stem anchoring, 3.8% with both. Attaching a slur at the stem is ordinary
   * engraving practice, not a compromise.
   *
   * Forcing the placement *side* per hand was tried too — right hand above,
   * left hand below, as piano writing normally does — and made it markedly
   * worse (22.5%), because it drove the left hand's slurs down onto the pedal
   * line, which OSMD gives no way to move. Its own stem-based choice is
   * better informed than a blanket rule, so it keeps that decision.
   */
  rules.SlurPlacementAtStems = true;
  rules.SlurHeightFactor = 0.8;
  rules.PageTopMargin = PAGE_TOP_UNITS;
}

function pinTempoTermPosition() {
  const svg = elements.score.querySelector('svg');
  if (!svg) return;
  const measures = [...svg.querySelectorAll('g.vf-measure[id="1"]')];
  if (!measures.length) return;
  // Staff 1 (treble) is the topmost of bar 1's two measure groups.
  const staff1Measure = measures.reduce(
    (top, candidate) => (candidate.getBBox().y < top.getBBox().y ? candidate : top),
  );
  const clef = staff1Measure.querySelector('.vf-clef');
  const time = staff1Measure.querySelector('.vf-timesignature');
  if (!clef || !time) return;
  const keySignature = staff1Measure.querySelector('.vf-keysignature');
  const timeBox = time.getBBox();
  const clefBox = clef.getBBox();
  const priorRight = keySignature
    ? keySignature.getBBox().x + keySignature.getBBox().width
    : clefBox.x + clefBox.width;
  const margin = timeBox.x - priorRight;
  if (margin <= 0) return;

  // The tempo term is the only bold, non-italic text OSMD draws — dynamics
  // (f, mf, ...) are bold italic, ordinary directions (rit., a tempo) are
  // italic but not bold.
  const term = svg.querySelector('text[font-weight="bold"][font-style="normal"]');
  if (!term) return;
  term.setAttribute('x', timeBox.x + timeBox.width + margin);
  /*
   * Lift it clear of the music as well as pinning its horizontal spot. OSMD
   * places the term just above whatever sits directly beneath it, which is
   * the same band a slur arcing over bar 1 reaches — measured with the term
   * crossed by a slur in a few percent of tests, and a fixed lift only trades
   * one guess for another, since how high a slur reaches depends on how high
   * the notes go.
   *
   * So it is raised above whatever is actually engraved in the first system
   * rather than by a set amount, and only ever *upward* — the reserved blank
   * space above the first stave (`pinScoreTop`) is where it goes, so there is
   * always somewhere to move to, and a test with nothing reaching up keeps
   * the term exactly where OSMD put it.
   */
  const termBox = term.getBBox();
  let highest = Infinity;
  /*
   * Every drawn shape, not a list of the ones worth worrying about. Naming
   * the obvious candidates — noteheads, ledger lines, slurs — missed beams,
   * which sit at the far end of upward stems and so reach higher than any of
   * them; a term cleared of the notes still landed on the beam above them.
   * Anything with ink can be in the way, so the cheapest correct rule is to
   * consider all of it and let the horizontal test do the filtering.
   */
  for (const el of svg.querySelectorAll('path, rect')) {
    if (el === term) continue;
    const box = el.getBBox();
    // Only what actually sits under the term horizontally can collide with it.
    if (box.x + box.width < termBox.x || box.x > termBox.x + termBox.width) continue;
    highest = Math.min(highest, box.y);
  }
  if (Number.isFinite(highest)) {
    const lift = termBox.y + termBox.height - (highest - TEMPO_TERM_GAP_UNITS * 10);
    if (lift > 0) term.setAttribute('y', Number(term.getAttribute('y')) - lift);
  }
}

async function init() {
  elements.generate.disabled = true;

  if (typeof opensheetmusicdisplay === 'undefined') {
    fail('loadingOSMD');
    return;
  }

  try {
    const response = await fetch(new URL('../rules/abrsm-piano-grades.json', import.meta.url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    rules = await response.json();
  } catch (error) {
    fail('failLoadRules', error.message);
    return;
  }
  populateKeyOptions();

  try {
    osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(elements.score, {
      autoResize: true,
      drawTitle: false,
      drawPartNames: false,
      drawingParameters: 'default',
      // OSMD's default numbers a bar at the start of every system *and*
      // periodically on a fixed interval regardless of line breaks — with
      // `fitScore` forcing a uniform bars-per-line count, that interval
      // routinely lands on a bar mid-line too (e.g. bar 3 of a 3-per-line
      // test), printing a number nothing but the first bar of each line
      // should carry. Real engraving (and this app's own convention
      // everywhere else) numbers a line by its first bar only.
      drawMeasureNumbersOnlyAtSystemStart: true,
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
    // OSMD centres the tempo/character-word direction on whatever event
    // starts bar 1 — fine for an ordinary first note, but a bar that opens
    // with a whole-bar rest (Grade 1's alternating hands) gets it hovering
    // over that rest's own centred position instead of the start of the
    // piece, so the same term reads in a different spot test to test.
    // Wrapping `render` itself (rather than patching every call site) means
    // every one of `fitScore`'s repeated renders gets the correction too.
    const rawRender = osmd.render.bind(osmd);
    osmd.render = (...args) => {
      applyFixedSpacing();
      rawRender(...args);
      removeDuplicateText();
      pinTempoTermPosition();
      pinScoreTop();
    };
  } catch (error) {
    fail('failInitRenderer', error.message);
    return;
  }
  window.__osmd = osmd; // debugging hook, also used by scripts/smoke.js

  stage = createStage({
    score: elements.score,
    playline: elements.playline,
    highlight: elements.highlight,
  });
  window.__stage = stage; // debugging hook, also used by scripts/devices.js
  window.__playback = player; // debugging hook, also used by scripts/loudness.js

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
    // Each grade allows a different key list, so the dropdown has to be
    // rebuilt before (possibly) generating off it.
    populateKeyOptions();
    if (current) newTest();
  });
  elements.key.addEventListener('change', () => {
    if (current) newTest();
  });
  elements.langToggle.addEventListener('click', () => {
    applyLanguage(getLanguage() === 'en' ? 'zh' : 'en');
  });
  // `aria-pressed` is a boolean, not translated text, so it's set here
  // rather than via a static `data-i18n-attr`; `refreshDynamicText` covers
  // everything else app.js itself builds or labels dynamically. `initLanguage()`
  // (top of this module) already applied whichever language was stored
  // before this listener existed to hear about it, so aria-pressed is
  // synced once explicitly here too — otherwise a returning "en" visitor's
  // toggle would render as unpressed until the next actual switch.
  onLanguageChange((lang) => {
    elements.langToggle.setAttribute('aria-pressed', lang === 'en' ? 'true' : 'false');
    refreshDynamicText();
  });
  elements.langToggle.setAttribute('aria-pressed', getLanguage() === 'en' ? 'true' : 'false');

  pinTopRowLayout();
  // Crossing the breakpoint changes how much top padding `.score-frame`
  // needs (see the CSS) and so how much room the score actually has, which
  // fitScore's own search has to see fresh rather than reuse a cached
  // layout computed for the other arrangement.
  TOP_ROW_QUERY.addEventListener('change', () => {
    pinTopRowLayout();
    if (current) fitScore();
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

/**
 * Re-renders every piece of text app.js builds or labels itself — the stuff
 * no static `data-i18n`/`data-i18n-attr` element in index.html can reach,
 * because it's assembled at runtime (select options, the meta strip, the
 * preparation checklist) or depends on state that isn't just "which language"
 * (the last status/error message, the play/stop button's playing state).
 * Called once after every `applyLanguage()` — see the `onLanguageChange`
 * subscription in `init()`. Safe to call before `rules`/`current` exist:
 * each piece guards on the state it actually needs.
 */
function refreshDynamicText() {
  if (lastMessage) {
    if (lastMessage.kind === 'say') say(lastMessage.key, lastMessage.params);
    else fail(lastMessage.key, lastMessage.detail);
  }
  if (rules) populateKeyOptions();
  if (current) showMeta(current.score);
  setPlayState(player.playing);
  updateHistoryInfo();
  if (!elements.checklist.hidden) {
    elements.checklist.innerHTML = PREPARATION_STEP_KEYS
      .map((key) => `<li>${escapeHtml(t(key))}</li>`)
      .join('');
  }
}

/**
 * Rebuild #key's options for whichever grade is currently selected — each
 * grade allows a different key list (Grade 8's is every key up to six
 * accidentals), so this can't be written once in index.html the way
 * #grade's fixed 1-8 list is. "隨機調性" (empty value) is always first and
 * is what keeps today's fully-random behaviour the default. If the
 * previously chosen key is still valid for the new grade it's kept
 * selected rather than silently reset, so switching, say, Grade 3 to
 * Grade 5 doesn't quietly drop a still-valid "C 大調" pick back to random.
 */
function populateKeyOptions() {
  const gradeRules = rules.grades[elements.grade.value];
  const { major, minor } = keyOptionsFor(gradeRules);
  const previous = elements.key.value;

  elements.key.innerHTML = `<option value="">${escapeHtml(t('randomKey'))}</option>`;
  for (const { tonic } of major) {
    elements.key.insertAdjacentHTML('beforeend', `<option value="${tonic}:major">${escapeHtml(t('majorKey', { tonic }))}</option>`);
  }
  for (const { tonic } of minor) {
    elements.key.insertAdjacentHTML('beforeend', `<option value="${tonic}:minor">${escapeHtml(t('minorKey', { tonic }))}</option>`);
  }

  const stillValid = [...elements.key.options].some((option) => option.value === previous);
  elements.key.value = stillValid ? previous : '';
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
  // '' (隨機調性) keeps the fully-random pickKey() behaviour; otherwise
  // every retry generateUnique makes is forced to the same chosen key,
  // same as it's forced to the same grade.
  const [tonic, mode] = elements.key.value ? elements.key.value.split(':') : [];
  const { score } = generateUnique(() => generateTest(rules, { grade, tonic, mode }), history);
  current = { score, xml: toMusicXml(score) };

  // Held at opacity 0 through the whole render + fitScore search (which
  // calls osmd.render() many times while measuring candidate layouts) and
  // only released once a final layout is settled — see the .entering rule.
  elements.score.classList.add('entering');

  say('renderingStatus');
  try {
    await osmd.load(current.xml);
    osmd.render();
    say('readyStatus');
  } catch (error) {
    fail('failRender', error.message);
    elements.score.classList.remove('entering');
    return;
  }

  await fitScore();
  // Two frames: the first lets the browser paint the held opacity-0 state
  // (removing `transition: none` alone wouldn't stop the two class changes
  // from collapsing into one paint), the second flips to the visible state
  // so the opacity/transform change is what actually animates.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => elements.score.classList.remove('entering'));
  });
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
  // `metaKeyMajor`/`metaKeyMinor` are a deliberately tighter English form
  // ("F# min") than the key-select dropdown's own "{tonic} minor" — this
  // field alone has a fixed CSS width (see `.meta-key`, sized for the
  // Chinese "Gb 大調"), and the full English word routinely overflowed it.
  const keyTemplate = score.key.mode === 'major' ? 'metaKeyMajor' : 'metaKeyMinor';
  // No labels — just the values in a fixed order, separated by "丨". The
  // key/time/bar-count fields have a fixed CSS width so the separators
  // never move when a new test changes their text length; only the tempo
  // field (last, nothing after it) is free to vary.
  const fields = [
    ['meta-key', t(keyTemplate, { tonic: score.key.tonic })],
    ['meta-time', score.timeSignature.text],
    ['meta-bars', t('barsSuffix', { count: score.barCount })],
    // The tempo term itself already prints above bar 1 in the score
    // (pinTempoTermPosition keeps it at a fixed spot there); showing it a
    // second time here was redundant, so only the metronome mark remains.
    ['meta-tempo', `♩≈${score.tempoBpm}`],
  ];
  elements.meta.innerHTML = fields
    .map(([cls, value]) => `<span class="${cls}">${escapeHtml(value)}</span>`)
    .join('<span class="meta-sep">丨</span>');

  const warningKey = CONFIDENCE_LABEL_KEY[score.confidence];
  elements.confidence.hidden = !warningKey;
  if (warningKey) elements.confidence.textContent = t(warningKey);
}

/*
 * The standard preparation order from the knowledge base. Reading it beats
 * staring at bar 1: the tempo should be set by the busiest bar, not the first.
 * The actual text lives in i18n.js (prepStep1..6) — kept as keys here rather
 * than resolved once, so `refreshDynamicText` can re-render this list in
 * place when the language changes while it's on screen.
 */
const PREPARATION_STEP_KEYS = ['prepStep1', 'prepStep2', 'prepStep3', 'prepStep4', 'prepStep5', 'prepStep6'];

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
  say('givingPitch');

  await player.playChord(tonicTriadMidis(current.score.key)).catch(() => {});

  runPreparationCountdown();
}

/**
 * Whether the rendered score fits the viewport without scrolling — the same
 * check `scripts/devices.js` audits per device (`scoreBottom <=
 * viewportHeight`, measured off the rendered SVG rather than the bar boxes
 * so pedal brackets/hairpins/slurs hanging outside the staves count). A
 * phone routinely fails this (see CLAUDE.md: deliberately left to scroll
 * rather than shrink into illegibility), so the preparation message can't
 * unconditionally claim the whole piece is on screen — real ABRSM
 * preparation time is built around seeing the whole test at a glance, and
 * telling a scrolling phone user otherwise actively misleads the one thing
 * this countdown is simulating.
 */
function scoreFitsViewport() {
  const svg = elements.score.querySelector('svg');
  return svg ? svg.getBoundingClientRect().bottom <= window.innerHeight : true;
}

function runPreparationCountdown() {
  let remaining = rules.exam.preparationSeconds;
  elements.countdownValue.textContent = String(remaining);
  elements.countdown.className = 'countdown running';
  elements.checklist.hidden = false;
  elements.checklist.innerHTML = PREPARATION_STEP_KEYS
    .map((key) => `<li>${escapeHtml(t(key))}</li>`)
    .join('');
  say(scoreFitsViewport() ? 'prepFitsScreen' : 'prepScrolls');

  countdownTimer = setInterval(() => {
    remaining -= 1;
    elements.countdownValue.textContent = String(Math.max(remaining, 0));
    if (remaining <= 0) {
      stopCountdown();
      elements.countdown.className = 'countdown done';
      elements.checklist.hidden = true;
      // Continuity outscores accuracy: going back to fix a slip is counted as
      // a second mistake.
      say('prepDone');
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
  elements.play.setAttribute('aria-label', t(playing ? 'playAriaStop' : 'playAriaPlay'));
  elements.play.title = t(playing ? 'playTitleStop' : 'playTitlePlay');
}

/**
 * One render at this viewport's fixed staff size, reporting the layout OSMD
 * actually produced and whether it fits the window without scrolling.
 *
 * Whatever `EngravingRules.RenderXMeasuresPerLineAkaSystem` is currently set
 * to stays in effect — and it is a target, not a guarantee: if the requested
 * bar count does not fit the container, OSMD silently wraps further instead,
 * which is what `matchesRequestedLayout` exists to catch.
 */
function renderAtStaffZoom() {
  osmd.zoom = staffZoom();
  osmd.render();
  const layout = stage.measure();
  return { layout, fitsHeight: renderedScoreHeight() <= availableScoreHeight() };
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
  if (!svg) return 0;
  /*
   * From the top of the score container to the bottom of the engraving, so
   * the padding `pinScoreTop` adds above the first stave counts toward the
   * fit. Measuring the SVG alone would report a score that fits while the
   * padding pushed it off the bottom of the screen.
   */
  const container = document.getElementById('score');
  const top = container ? container.getBoundingClientRect().top : svg.getBoundingClientRect().top;
  return svg.getBoundingClientRect().bottom - top;
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

/*
 * `RenderXMeasuresPerLineAkaSystem` is a target, not a guarantee: when the
 * requested count doesn't actually fit the container at the current zoom,
 * OSMD silently re-wraps into a different system shape instead — e.g. "3 per
 * line" on a 6-bar test can come back as three systems of 2 rather than the
 * requested two systems of 3. `hasSingleBarLine` only catches the case where
 * that re-wrap strands a lone bar; a re-wrap into some *other* uniform shape
 * (like the two-of-three example) sails right through it and looks like a
 * success — so two tests of the same shape could each request the same `n`,
 * each get silently re-wrapped to a *different* actual shape depending on
 * their own content, and still both get cached under that same `n` as if
 * they'd rendered identically. This checks that OSMD actually honoured the
 * request — every system has exactly `n` bars except optionally the last,
 * which gets whatever remainder is left — so a request that wasn't honoured
 * can be told apart from one that was, instead of both being cached as if
 * interchangeable.
 */
function matchesRequestedLayout(layout, n, totalBars) {
  const systems = layout.systems;
  if (systems.length !== Math.ceil(totalBars / n)) return false;
  const remainder = totalBars % n;
  return systems.every((system, i) => {
    const isLast = i === systems.length - 1;
    const expected = isLast && remainder !== 0 ? remainder : n;
    return system.bars.length === expected;
  });
}

/**
 * The whole test always renders on the page in normal flow — no fullscreen
 * step, no cropped follow-window — and the staff size is fixed for this
 * viewport (see `STAFF_ZOOM`), so the only thing left to decide is where the
 * lines break.
 *
 * OSMD's own line breaking is a greedy fill (pack bars onto a line until the
 * next one doesn't fit), which strands a lone bar whenever the content
 * doesn't divide evenly and front-loads earlier lines, since bar-to-bar width
 * varies with note density. `RenderXMeasuresPerLineAkaSystem` fixes both by
 * forcing a uniform count — the question is which count.
 *
 * Try progressively fewer bars per line, from `MAX_MEASURES_PER_LINE` down to
 * 2, and take the first (most compact) count OSMD actually honours without
 * stranding a bar or silently re-wrapping into some other shape
 * (`matchesRequestedLayout`). `n=3` on 10 bars would strand one bar on a
 * fourth line (3+3+3+1) rather than sharing it, so any `n` leaving a
 * remainder of exactly 1 is skipped outright. A test where no uniform count
 * works falls back to the natural wrap, which is always free of stranded
 * bars.
 */
async function fitScore() {
  if (!current || !osmd) return;

  const shapeKey = layoutShapeKey(current.score);
  const totalBars = current.score.barCount;
  const cached = layoutCache[shapeKey];

  if (cached) {
    osmd.EngravingRules.RenderXMeasuresPerLineAkaSystem = cached.measuresPerLine;
    const result = renderAtStaffZoom();
    /*
     * The cached count is only meaningful if OSMD still honours it for *this*
     * test's content — denser content can push it into silently re-wrapping
     * into a different (still non-stranded) shape. Reusing a mismatched shape
     * would give this test a visibly different number of lines from every
     * other same-shaped test, which is the bug the cache exists to prevent,
     * so a mismatch falls through to a fresh search below.
     */
    if (cached.measuresPerLine === 0
      ? !hasSingleBarLine(result.layout)
      : matchesRequestedLayout(result.layout, cached.measuresPerLine, totalBars)) {
      return;
    }
  }

  const tryCount = (n, mustFitHeight) => {
    osmd.EngravingRules.RenderXMeasuresPerLineAkaSystem = n;
    const attempt = renderAtStaffZoom();
    if (hasSingleBarLine(attempt.layout)) return null;
    if (!matchesRequestedLayout(attempt.layout, n, totalBars)) return null;
    return !mustFitHeight || attempt.fitsHeight ? attempt : null;
  };

  /*
   * Two passes over the same candidates: the first insists the whole test fit
   * the window, the second drops that. Since the staff size no longer moves,
   * fitting can only be bought by packing more bars onto a line — and where
   * even the most compact honoured count is still too tall, the test keeps
   * full size and the page scrolls rather than the music shrinking.
   */
  const search = (mustFitHeight) => {
    let found = null;
    for (let n = Math.min(MAX_MEASURES_PER_LINE, totalBars); n >= 2 && !found; n--) {
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
   * four per line gives 4+2, and even with the last line stretched, two bars
   * spread across a full-width line read as oversized rather than aligned.
   * 3+3 fills both lines instead. `n=2` is tried last within that pass rather
   * than skipped, since only reaching it once everything larger has failed
   * keeps fragmentation down without special-casing it away.
   */
  const chosen = search(true) ?? search(false);
  // `tryCount` leaves `RenderXMeasuresPerLineAkaSystem` set to whichever `n`
  // it last tried, and the loops stop once `chosen` is found — so this is
  // still the winning count, captured before the fallback can reset it.
  const measuresPerLine = chosen ? osmd.EngravingRules.RenderXMeasuresPerLineAkaSystem : 0;

  if (!chosen) {
    // Nothing uniform worked; OSMD's own greedy wrap is always free of
    // stranded bars, and the staff size stays put either way.
    osmd.EngravingRules.RenderXMeasuresPerLineAkaSystem = 0;
    renderAtStaffZoom();
  }

  layoutCache[shapeKey] = { measuresPerLine };
  saveLayoutCache();
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
      say('playingStatus');
      startFollowing();
    })
    .catch((error) => fail('failPlayback', error.message));
}

function updateHistoryInfo() {
  elements.historyInfo.textContent = t('historyCount', { count: history.size });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
}
