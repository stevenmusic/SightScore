/**
 * Test generator: rules table in, score object out.
 *
 * Pipeline (see docs/abrsm-sight-reading-analysis.md §3):
 *   key / meter / length  ->  harmonic skeleton  ->  rhythm cells (with
 *   motif reuse)  ->  pitches under contour constraints  ->  dynamics,
 *   articulation and tempo term.
 */

import { createRandom, randomSeed } from './random.js';
import { createKey, dstepRange, degreeOf } from './theory.js';
import { buildProgression } from './harmony.js';
import { assignPitches, stackChordTones } from './melody.js';
import { DIVISIONS, cellsFor, fillBar, wholeBarRest } from './rhythm.js';
import { meterInfo, rescaleCells } from './meter.js';

const TEMPO_BPM = {
  Grave: 46, Largo: 52, Adagio: 60, Lento: 58, Andante: 76, Andantino: 84,
  'Andante cantabile': 72, Cantabile: 72, Moderato: 96, 'Allegro moderato': 104,
  Allegretto: 112, 'Con moto': 112, Grazioso: 96, Scherzando: 126, Espressivo: 76,
  Allegro: 132, 'Allegro con brio': 138, 'Allegro vivace': 144, 'Allegro agitato': 138,
  Vivace: 152, Presto: 168, Maestoso: 80, Appassionato: 108,
};

/**
 * @param {object} rulesTable parsed abrsm-piano-grades.json
 * @param {{grade: number, seed?: number}} options
 */
export function generateTest(rulesTable, options) {
  const grade = options.grade;
  const rules = rulesTable.grades[String(grade)];
  if (!rules) throw new Error(`no rules for grade ${grade}`);

  const seed = options.seed ?? randomSeed();
  const rng = createRandom(seed);

  const key = createKey(pickKey(rng, rules));
  const meter = meterInfo(rng.pick(rules.timeSignatures));
  const barCount = pickBarCount(rng, rules, meter.text);
  const progression = buildProgression(rng, barCount, { simple: grade <= 3 });

  // Grade 1 only: the hands never sound together, so each takes half the
  // test. The split is decided up front so that each hand's line is written
  // over the bars it actually plays and cadences properly.
  const silence = rules.texture.handsPlayTogether === false
    ? splitBarsBetweenHands(barCount, rng)
    : { rightHand: new Set(), leftHand: new Set() };

  const rightHand = buildStaff({ rng, rules, meter, barCount, hand: 'rightHand', progression, key, silentBars: silence.rightHand });
  const leftHand = buildStaff({ rng, rules, meter, barCount, hand: 'leftHand', progression, key, silentBars: silence.leftHand });

  const tempoTerm = rng.pick(rules.tempoTerms);
  const score = {
    seed,
    grade,
    confidence: rules.confidence,
    key: { tonic: key.tonic, mode: key.mode, fifths: key.fifths },
    timeSignature: { beats: meter.beats, beatType: meter.beatType, text: meter.text },
    barCount,
    divisions: DIVISIONS,
    beatDuration: meter.beatDuration,
    barDuration: meter.barDuration,
    tempoTerm,
    tempoBpm: TEMPO_BPM[tempoTerm] ?? 96,
    progression,
    staves: { 1: rightHand, 2: leftHand },
  };

  applyExpression(rng, rules, score);
  return score;
}

function pickKey(rng, rules) {
  if (rules.keys.allKeys) {
    // Grade 8: every key up to six accidentals.
    const majors = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'];
    const fifthsFor = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6 };
    const minors = { A: 0, E: 1, B: 2, 'F#': 3, 'C#': 4, 'G#': 5, D: -1, G: -2, C: -3, F: -4, Bb: -5, Eb: -6 };
    if (rng.chance(0.6)) {
      const tonic = rng.pick(majors);
      return { tonic, mode: 'major', fifths: fifthsFor[tonic] };
    }
    const tonic = rng.pick(Object.keys(minors));
    return { tonic, mode: 'minor', fifths: minors[tonic] };
  }

  const majors = rules.keys.major.map((k) => ({ ...k, mode: 'major' }));
  const minors = rules.keys.minor.map((k) => ({ ...k, mode: 'minor' }));
  // Majors are more common in the specimen books than minors.
  return rng.chance(0.65) ? rng.pick(majors) : rng.pick(minors);
}

function pickBarCount(rng, rules, timeSignature) {
  const spec = rules.lengthBars[timeSignature] ?? rules.lengthBars.default;
  if (!spec) throw new Error(`no bar count for ${timeSignature} at grade ${rules.grade}`);
  const [min, max] = spec;
  // Even bar counts: phrases come in pairs.
  const count = rng.int(min, max);
  return count % 2 === 0 ? count : Math.min(count + 1, max % 2 === 0 ? max : max - 1) || min;
}

function buildStaff({ rng, rules, meter, barCount, hand, progression, key, silentBars = new Set() }) {
  const isLeft = hand === 'leftHand';
  const cells = rescaleCells(
    cellsFor(rules, { compound: meter.compound, calmOnly: isLeft }),
    meter.scale,
    rules,
  );
  if (!cells.length) throw new Error(`no usable rhythm cells for ${hand} at grade ${rules.grade}`);

  const restBudget = Math.max(1, Math.round((rules.generatorHints.restDensityPercent / 100) * meter.cellBeats));
  const bank = [];
  const bars = [];

  for (let barIndex = 0; barIndex < barCount; barIndex++) {
    const isFinalBar = barIndex === barCount - 1;
    let events;

    if (silentBars.has(barIndex)) {
      events = wholeBarRest(meter.barDuration);
    } else if (isFinalBar || (silentBars.size && silentBars.has(barIndex + 1))) {
      // Cadence bar: end on a long note rather than a busy figure.
      const calm = cells.filter((cell) => cell.calm && !cell.rests);
      events = fillBar(rng, calm.length ? calm : cells, meter.cellBeats, { restBudget: 0 }).events;
    } else if (barIndex >= 2 && bank[barIndex % 2] && rng.chance(0.55)) {
      // Motif reuse: bars 3–4 restate the rhythm of bars 1–2.
      events = bank[barIndex % 2].map((event) => ({ ...event }));
    } else {
      const filled = fillBar(rng, cells, meter.cellBeats, { restBudget });
      events = filled.events;
      if (barIndex < 2) bank[barIndex] = events.map((event) => ({ ...event }));
    }

    bars.push({ events, beatDuration: meter.beatDuration, directions: [] });
  }

  const range = rules.range[hand];
  const { low, high } = dstepRange(key, range.minMidi, range.maxMidi);
  const window = rules.texture.fiveFingerPosition
    ? fiveFingerWindow(rng, key, low, high)
    : tessituraWindow(rng, key, low, high, 8 + rules.grade);

  assignPitches({
    rng,
    key,
    bars,
    progression,
    window,
    options: {
      stepwiseBias: rules.generatorHints.stepwiseBiasPercent / 100,
      maxLeapSemitones: isLeft
        ? Math.min(rules.generatorHints.maxLeapSemitones, 12)
        : rules.generatorHints.maxLeapSemitones,
      chordToneOnly: isLeft,
      endOnTonic: true,
    },
  });

  if (isLeft && rules.texture.maxNotesPerChord >= 2) {
    stackChordTones({
      bars, key, progression, rng, window,
      maxNotes: rules.texture.maxNotesPerChord,
      density: 0.25 + 0.05 * rules.grade,
    });
  }

  return bars;
}

/**
 * Above the five-finger grades, a test still sits in one region of the
 * keyboard rather than roaming the whole permitted range — otherwise the line
 * wanders and collects ledger lines no real test would print. Pick a working
 * tessitura inside the range, wider at each grade.
 */
function tessituraWindow(rng, key, low, high, span) {
  if (high - low <= span) return { low, high };
  const starts = [];
  for (let dstep = low; dstep + span <= high; dstep++) {
    const hasTonic = Array.from({ length: span + 1 })
      .some((_, step) => degreeOf(dstep + step, key) === 0);
    if (hasTonic) starts.push(dstep);
  }
  if (!starts.length) return { low, high };
  const start = rng.pick(starts);
  return { low: start, high: start + span };
}

/**
 * Choose a five-note window, preferring one that starts on the tonic.
 * The window must contain the tonic somewhere, or the test could not cadence
 * on it — a five-note span starting on the 2nd or 3rd degree has no tonic.
 */
function fiveFingerWindow(rng, key, low, high) {
  const starts = [];
  for (let dstep = low; dstep + 4 <= high; dstep++) {
    const hasTonic = [0, 1, 2, 3, 4].some((step) => degreeOf(dstep + step, key) === 0);
    if (hasTonic) starts.push(dstep);
  }
  if (!starts.length) return { low, high };
  const tonicStarts = starts.filter((dstep) => degreeOf(dstep, key) === 0);
  const start = tonicStarts.length && rng.chance(0.7) ? rng.pick(tonicStarts) : rng.pick(starts);
  return { low: start, high: start + 4 };
}

/** Which bars each hand sits out, when the hands alternate (Grade 1). */
function splitBarsBetweenHands(barCount, rng) {
  const split = Math.ceil(barCount / 2);
  const leadWithRight = rng.chance(0.7);
  const rightHand = new Set();
  const leftHand = new Set();

  for (let barIndex = 0; barIndex < barCount; barIndex++) {
    const rightPlays = leadWithRight ? barIndex < split : barIndex >= split;
    (rightPlays ? leftHand : rightHand).add(barIndex);
  }
  return { rightHand, leftHand };
}

/** Dynamics, wedges, slurs and staccato, within what the grade allows. */
function applyExpression(rng, rules, score) {
  // Hang expression marks off whichever staff actually sounds in bar 1 —
  // at Grade 1 the right hand may be resting there.
  const sounds = (staffNumber, barIndex) =>
    score.staves[staffNumber][barIndex].events.some((event) => !event.rest);
  const bars = sounds(1, 0) ? score.staves[1] : score.staves[2];

  const opening = rng.pick(rules.dynamics.filter((d) => d !== 'ff' && d !== 'fff'));
  bars[0].directions.push({ kind: 'dynamics', value: opening });

  if (score.barCount >= 4 && rng.chance(0.7)) {
    const wedge = rng.pick(
      rules.dynamicFeatures.filter((f) => f === 'crescendo' || f === 'diminuendo'),
    );
    if (wedge) {
      const start = Math.floor(score.barCount / 2) - 1;
      bars[start].directions.push({ kind: 'wedge', value: wedge, type: 'start' });
      bars[Math.min(start + 1, score.barCount - 1)].directions.push({ kind: 'wedge', type: 'stop' });
      const target = wedge === 'crescendo' ? lastLouder(rules.dynamics, opening) : lastSofter(rules.dynamics, opening);
      if (target) {
        bars[Math.min(start + 2, score.barCount - 1)].directions.push({ kind: 'dynamics', value: target });
      }
    }
  }

  const canSlur = rules.articulations.includes('slur');
  const canStaccato = rules.articulations.includes('staccato');

  for (const staffNumber of [1, 2]) {
    const staff = score.staves[staffNumber];
    for (let barIndex = 0; barIndex < staff.length; barIndex += 2) {
      const pair = [staff[barIndex], staff[barIndex + 1]].filter(Boolean);
      const sounding = pair.flatMap((bar) => bar.events.filter((event) => !event.rest));
      if (sounding.length < 2) continue;

      if (canSlur && rng.chance(staffNumber === 1 ? 0.75 : 0.35)) {
        sounding[0].slur = 'start';
        sounding[sounding.length - 1].slur = 'stop';
      } else if (canStaccato && rng.chance(0.4)) {
        for (const event of sounding) {
          if (event.type === 'quarter' || event.type === 'eighth') {
            event.articulations = [...(event.articulations ?? []), 'staccato'];
          }
        }
      }
    }
  }

  if (rules.otherFeatures.some((feature) => feature.includes('rall'))) {
    if (rng.chance(0.5)) {
      score.staves[1][score.barCount - 2]?.directions.push({ kind: 'words', value: 'rall.' });
    }
  }
}

const ORDER = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'];
function lastLouder(allowed, from) {
  const candidates = allowed.filter((d) => ORDER.indexOf(d) > ORDER.indexOf(from));
  return candidates[0] ?? null;
}
function lastSofter(allowed, from) {
  const candidates = allowed.filter((d) => ORDER.indexOf(d) < ORDER.indexOf(from));
  return candidates[candidates.length - 1] ?? null;
}
