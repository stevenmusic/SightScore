/**
 * Test generator: rules table in, score object out.
 *
 * Pipeline (see docs/abrsm-sight-reading-analysis.md §3):
 *   key / meter / length  ->  harmonic skeleton  ->  rhythm cells (with
 *   motif reuse)  ->  pitches under contour constraints  ->  dynamics,
 *   articulation and tempo term.
 */

import { createRandom, randomSeed } from './random.js';
import { createKey, dstepRange, degreeOf, pitchAt } from './theory.js';
import { buildProgression } from './harmony.js';
import {
  assignPitches, stackChordTones, soundingTimeline, harmoniseLeadingNotes, harmoniseRepeatedLeadingNotes,
} from './melody.js';
import { DIVISIONS, cellsFor, fillBar, wholeBarRest } from './rhythm.js';
import { meterInfo, rescaleCells } from './meter.js';

const TEMPO_BPM = {
  Grave: 46, Largo: 52, Adagio: 60, Lento: 58, Andante: 76, Andantino: 84,
  'Andante cantabile': 72, Cantabile: 72, Moderato: 96, 'Allegro moderato': 104,
  Allegretto: 112, 'Con moto': 112, Grazioso: 96, Scherzando: 126, Espressivo: 76,
  Allegro: 132, 'Allegro con brio': 138, 'Allegro vivace': 144, 'Allegro agitato': 138,
  Vivace: 152, Presto: 168, Maestoso: 80, Appassionato: 108,

  // English/Italian character words and dance-form titles that real ABRSM
  // sight-reading specimens print at least as often as a plain tempo word
  // (confirmed against the Grade 1-5 specimen books) — the fallback below
  // silently defaulted every one of these to 96bpm before they had entries.
  March: 100, Gently: 76, Fanfare: 108, Sadly: 66, Lively: 116, Dancing: 108,
  Delicately: 84, Grandly: 92, Smoothly: 84, Waltz: 126, Happily: 108,
  'Slowly and smoothly': 66, Dance: 108, 'Sadly and gently': 66,
  'Gently rocking': 72, 'Sadly and slowly': 60,
  Minuet: 108, 'Moderato espressivo': 92, Lullaby: 60, Flowing: 92,
  'Lively and strong': 120, 'Gently and expressively': 72, 'Sad waltz': 108,
  'Tempo di minuetto': 108,
  Leggiero: 116, Grandioso: 84, 'Rather sadly': 66, Playfully: 112,
  'Alla marcia': 104, 'Poco allegretto': 108, Tenderly: 72, Gracefully: 88,
  'Allegretto cantabile': 104, 'Andante grazioso': 80, 'Allegretto semplice': 108,
  'Allegro giocoso': 132, 'Valse lente': 126, 'Andante espressivo': 76,
  Steadily: 92, 'Allegretto capriccioso': 116, Slowly: 60,
  'Andantino espressivo': 80, 'Tempo di tango': 112, 'Allegretto ritmico': 116,
  Rhythmically: 100, 'Leggiero allegretto': 116, 'Adagio espressivo': 58,
  Lilting: 92, 'Molto moderato': 84, 'Allegretto grazioso': 108, Giocoso: 132,
  'Cantabile ed espressivo': 72, 'Moderato leggiero': 100, Mesto: 60,
  'Con brio': 138, 'Andantino leggiero': 88, Gigue: 144, Tango: 112,
  Ritmico: 108, 'Andante maestoso': 84, 'Moderato preciso': 96,
  'Poco vivace': 144, 'Allegro leggiero': 138, 'Andantino grazioso': 84,
  Sprightly: 116, 'Gently flowing': 84, 'Allegretto misterioso': 100,
  'Poco andante': 84, 'Molto andante': 66,

  // Grades 6-8: extrapolated alongside the term additions above (no specimen
  // PDF available), same conservative treatment as those grades' "inferred"
  // confidence marker.
  'Andante sostenuto': 66, Risoluto: 120, Semplice: 88, Dolce: 66,
  'Molto vivace': 160, 'Allegro appassionato': 132, 'Molto agitato': 144,
  'Allegro risoluto': 132, Tranquillo: 60,
};

/**
 * From Grade 6 the specimen books print an actual piece title above the
 * tempo/character word, not just the tempo word on its own (confirmed
 * against the Grade 6-8 specimen books — "Aria" / Molto moderato, "Prelude" /
 * Allegro giusto, "Procession" / Alla marcia, etc.). Original titles in the
 * same spirit — dance forms and short character pieces — not the specific
 * titles those books use.
 */
const TITLES = [
  'Prelude', 'Nocturne', 'Impromptu', 'Reverie', 'Caprice', 'Intermezzo', 'Arabesque',
  'Barcarolle', 'Berceuse', 'Elegy', 'Serenade', 'Aubade', 'Rhapsody', 'Toccata',
  'Minuet', 'Waltz', 'Gigue', 'Bolero', 'Mazurka', 'Polka', 'Gavotte', 'Sarabande',
  'Tarantella', 'Habanera', 'Polonaise',
  'Morning Light', 'Evening Song', 'Distant Bells', 'Running Stream', 'Mountain Path',
  'City Lights', 'Falling Snow', 'Summer Breeze', 'Autumn Leaves', "Winter's Tale",
  'Clockwork Toy', 'Puppet Dance', 'Midnight Journey', 'Whirlwind', 'Lantern Festival',
  'Silver Moon', 'Garden Path', 'Storm Clouds', 'Quiet Harbour', 'Wandering Star',
  'Forest Whisper', 'Village Fair', 'Market Square', 'Old Clock Tower', 'Sunlit Meadow',
  'Rolling Waves', 'Frosty Morning', 'Firefly Dance', 'Hidden Valley', 'Carnival',
  'Shadow Play', 'Restless Spirit', 'Homeward Bound', 'Fleeting Moment', 'Golden Hour',
];

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
  const meter = meterInfo(pickTimeSignature(rng, rules, rulesTable));
  const barCount = pickBarCount(rng, rules, meter.text);
  const progression = buildProgression(rng, barCount, { simple: grade <= 3 });

  // Grade 1 only: the hands never sound together, so each takes half the
  // test. The split is decided up front so that each hand's line is written
  // over the bars it actually plays and cadences properly.
  const silence = rules.texture.handsPlayTogether === false
    ? splitBarsBetweenHands(barCount, rng)
    : { rightHand: new Set(), leftHand: new Set() };

  // The left hand is written first and becomes the bass the right hand is
  // checked against; writing them independently is what produced clashes.
  const leftHand = buildStaff({
    rng, rules, meter, barCount, hand: 'leftHand', progression, key,
    silentBars: silence.leftHand,
  });
  const rightHand = buildStaff({
    rng, rules, meter, barCount, hand: 'rightHand', progression, key,
    silentBars: silence.rightHand,
    against: soundingTimeline(leftHand, meter.barDuration),
  });
  harmoniseLeadingNotes([rightHand, leftHand], key, meter.barDuration);
  // The cross-hand reconciliation above can itself leave a repeated note
  // disagreeing with itself within one hand (it only checks the two hands
  // against each other, not a hand against its own immediate repeat).
  harmoniseRepeatedLeadingNotes(rightHand, key);
  harmoniseRepeatedLeadingNotes(leftHand, key);

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
    title: grade >= 6 ? rng.pick(TITLES) : null,
    progression,
    staves: { 1: rightHand, 2: leftHand },
  };

  applyExpression(rng, rules, score);
  return score;
}

/** Weighted so the staple metres dominate and the rarities stay rare. */
function pickTimeSignature(rng, rules, rulesTable) {
  const weights = rulesTable.timeSignatureWeights ?? {};
  const candidates = rules.timeSignatures.map((text) => ({ text, weight: weights[text] ?? 1 }));
  return rng.weighted(candidates).text;
}

function pickKey(rng, rules) {
  if (rules.keys.allKeys) {
    // Grade 8: every key up to six accidentals.
    const majors = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'];
    const fifthsFor = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6 };
    // g#/d#/a# minor are left out: their leading notes need double sharps.
    const minors = { A: 0, E: 1, B: 2, 'F#': 3, 'C#': 4, D: -1, G: -2, C: -3, F: -4, Bb: -5, Eb: -6 };
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

function buildStaff({ rng, rules, meter, barCount, hand, progression, key, silentBars = new Set(), against = null }) {
  const isLeft = hand === 'leftHand';
  const activity = rules.generatorHints.activity ?? 0.4;
  // A supportive accompaniment role only exists once the hands actually
  // sound together — Grade 1's hands alternate, so its "calm" hand is just
  // taking its turn at the tune, not accompanying anything underneath it.
  const isAccompaniment = isLeft && rules.grade < 4 && rules.texture.handsPlayTogether;
  const cells = rescaleCells(
    cellsFor(rules, {
      compound: meter.compound,
      // From Grade 4 the hands have independent rhythms, so the left hand is
      // no longer limited to long values.
      calmOnly: isLeft && rules.grade < 4,
    }),
    meter.scale,
    rules,
  );
  if (!cells.length) throw new Error(`no usable rhythm cells for ${hand} at grade ${rules.grade}`);

  const restBudget = Math.max(1, Math.round((rules.generatorHints.restDensityPercent / 100) * meter.cellBeats));
  const bank = [];
  const bars = [];

  /*
   * A real accompaniment (Grade 2-3's left hand under the melody) reads as
   * one consistent figure for the whole piece — an Alberti-bass-style
   * pattern, not a fresh rhythm drawn bar by bar — so pick that figure once
   * and reuse it everywhere it applies, rather than leaving it to chance.
   */
  const ostinato = isAccompaniment
    ? fillBar(rng, cells, meter.cellBeats, { restBudget, activity: activity * 0.7 }).events
    : null;

  for (let barIndex = 0; barIndex < barCount; barIndex++) {
    const isFinalBar = barIndex === barCount - 1;
    const isCadenceBar = isFinalBar || (silentBars.size && silentBars.has(barIndex + 1));
    const isRegularBar = !silentBars.has(barIndex) && !isCadenceBar && !ostinato;
    let events;

    if (silentBars.has(barIndex)) {
      events = wholeBarRest(meter.barDuration);
    } else if (isCadenceBar) {
      // Cadence bar: end on a long note rather than a busy figure.
      const calm = cells.filter((cell) => cell.calm && !cell.rests);
      events = fillBar(rng, calm.length ? calm : cells, meter.cellBeats, {
        restBudget: 0,
        activity: activity * 0.4,
      }).events;
    } else if (ostinato) {
      events = ostinato.map((event) => ({ ...event }));
    } else if (barIndex >= 2 && bank[barIndex % 2] && rng.chance(0.3)) {
      /*
       * Phrase echo: this bar restates the rhythm of the same position two
       * bars back (bar 3 echoing bar 1, bar 4 echoing bar 2, and so on).
       * `bank` is refreshed on every regular bar below, not just the first
       * two — otherwise every later pair keeps echoing bars 1-2
       * specifically forever, instead of echoing whichever phrase most
       * recently played. The chance itself is also lower than it used to
       * be (was 0.55): real specimens use this device occasionally, not as
       * the dominant way bars get filled — at 0.55 measured 33-46% of a
       * whole test's bars ending up an exact rhythmic clone of an earlier
       * one, which read as far more repetitive than a real test.
       */
      events = bank[barIndex % 2].map((event) => ({ ...event }));
    } else {
      const filled = fillBar(rng, cells, meter.cellBeats, {
        restBudget,
        activity: isLeft ? activity * 0.7 : activity,
      });
      events = filled.events;
    }

    if (isRegularBar) bank[barIndex % 2] = events.map((event) => ({ ...event }));

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
      barDuration: meter.barDuration,
    },
    against,
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
  const canAccent = rules.articulations.includes('accent');

  for (const staffNumber of [1, 2]) {
    const staff = score.staves[staffNumber];
    for (let barIndex = 0; barIndex < staff.length; barIndex += 2) {
      const pair = [staff[barIndex], staff[barIndex + 1]].filter(Boolean);
      const sounding = pair.flatMap((bar) => bar.events.filter((event) => !event.rest));
      if (sounding.length < 2) continue;
      // Don't slur across a bar the hand sits out (Grade 1 alternation).
      const unbroken = pair.every((bar) => bar.events.some((event) => !event.rest));

      if (canSlur && unbroken && rng.chance(staffNumber === 1 ? 0.75 : 0.35)) {
        sounding[0].slur = 'start';
        sounding[sounding.length - 1].slur = 'stop';
        // Concurrent slurs in one part must not share a number, or the
        // renderer pairs a right-hand start with a left-hand stop and draws
        // a curve straight across the grand staff.
        sounding[0].slurNumber = staffNumber;
        sounding[sounding.length - 1].slurNumber = staffNumber;
      } else if (canStaccato && rng.chance(0.4)) {
        for (const event of sounding) {
          if (event.type === 'quarter' || event.type === 'eighth') {
            event.articulations = [...(event.articulations ?? []), 'staccato'];
          }
        }
      } else if (canAccent && rng.chance(0.3)) {
        // Real specimens accent single strong-beat notes (often the phrase's
        // opening note), not a whole run the way staccato marks one.
        sounding[0].articulations = [...(sounding[0].articulations ?? []), 'accent'];
      }
    }
  }

  if (rules.otherFeatures.some((feature) => feature.includes('rall'))) {
    if (rng.chance(0.5)) {
      score.staves[1][score.barCount - 2]?.directions.push({ kind: 'words', value: 'rall.' });
    }
  }

  // Grade 5's otherFeatures happen to be written in English ('sustaining
  // pedal markings') where grade 6-8's are in Chinese ('踏板') — match both,
  // or grade 5 (which already documents wanting it) would silently never get one.
  if (rules.otherFeatures.some((feature) => feature.includes('踏板') || /pedal/i.test(feature))) {
    addPedalMarking(rng, score);
  }

  // Real Grade 6-8 specimens pull the tempo around mid-piece (rit. ... a
  // tempo), not just at the final cadence the way lower grades' rall. does.
  if (rules.grade >= 6 && rng.chance(0.4)) {
    addMidPieceTempoChange(rng, score);
  }

  if (rules.grade >= 7) {
    addOrnaments(rng, score);
  }
}

/**
 * One sustain-pedal span over a legato passage, shown under the bass staff
 * (real engraving convention) rather than tied to any one hand's notes.
 */
function addPedalMarking(rng, score) {
  if (score.barCount < 3) return;
  const span = Math.min(rng.int(2, 4), score.barCount - 1);
  const start = rng.int(0, score.barCount - 1 - span);
  const end = start + span;
  score.staves[2][start].directions.push({ kind: 'pedal', type: 'start' });
  score.staves[2][end].directions.push({ kind: 'pedal', type: 'stop' });
}

/**
 * A temporary tempo pull mid-piece (rit. then a tempo a bar or two later),
 * not just the single final rall. lower grades get — real Grade 6-8
 * specimens fluctuate tempo within the piece itself.
 */
function addMidPieceTempoChange(rng, score) {
  if (score.barCount < 6) return;
  const around = Math.floor(score.barCount * 0.5) + rng.int(-1, 1);
  const bar = Math.max(1, Math.min(score.barCount - 3, around));
  score.staves[1][bar]?.directions.push({ kind: 'words', value: 'rit.' });
  score.staves[1][bar + 1]?.directions.push({ kind: 'words', value: 'a tempo' });
}

/**
 * A short acciaccatura (crushed grace note, a step above or below) into one
 * or two melody notes — the rules table already listed ornaments as a
 * Grade 7+ feature with no generation logic behind it.
 */
function addOrnaments(rng, score) {
  const notes = score.staves[1].flatMap((bar) => bar.events.filter((event) => !event.rest));
  if (notes.length < 4) return;

  const key = createKey(score.key);
  const candidates = notes.slice(1, -1).filter((event) => event.type === 'quarter' || event.type === 'eighth');
  if (!candidates.length) return;

  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const count = Math.min(shuffled.length, rng.int(1, 2));
  for (const event of shuffled.slice(0, count)) {
    const graceDstep = event.dstep + (rng.chance(0.5) ? 1 : -1);
    event.grace = { pitch: pitchAt(graceDstep, key, { raiseSeventh: false }) };
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
