/**
 * Test generator: rules table in, score object out.
 *
 * Pipeline (see docs/abrsm-sight-reading-analysis.md §3):
 *   key / meter / length  ->  harmonic skeleton  ->  rhythm cells (with
 *   motif reuse)  ->  pitches under contour constraints  ->  dynamics,
 *   articulation and tempo term.
 */

import { createRandom, randomSeed } from './random.js?v=17';
import { createKey, dstepRange, degreeOf, pitchAt, chordDegrees } from './theory.js?v=17';
import { buildProgression, firstChord, lastChord, halfCadenceBar } from './harmony.js?v=17';
import {
  assignPitches, stackChordTones, soundingTimeline, harmoniseLeadingNotes, harmoniseRepeatedLeadingNotes,
  relaxParallels,
} from './melody.js?v=17';
import { DIVISIONS, cellsFor, fillBar, wholeBarRest } from './rhythm.js?v=17';
import { meterInfo, rescaleCells } from './meter.js?v=17';

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
  // A bar splitting into two chords is a faster harmonic rhythm than
  // lower grades' one-chord-per-bar texture can support — reserved for
  // Grade 5+, the same range where pedal marking starts appearing.
  const progression = buildProgression(rng, barCount, {
    simple: grade <= 3,
    twoChordBarChance: grade >= 5 ? 0.3 : 0,
  });

  /*
   * Which bars of the consequent restate the antecedent's opening, decided
   * once for the whole texture rather than per hand. Rolling it separately in
   * each hand meant the two agreed only about half the time, and a restated
   * melody over a left hand that had moved on is not a restatement the ear
   * can hear — worse, the right hand is checked against the left, so the
   * notes it is trying to bring back keep getting rejected against a bass
   * that no longer matches. A real period brings both hands back together.
   */
  const restatement = planRestatement(rng, barCount);

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
    silentBars: silence.leftHand, restatement,
  });
  /*
   * Where the left hand actually settled. The right hand's working range was
   * drawn independently of it, so at the upper grades — where both ranges are
   * wide — the two could end up more than two octaves apart in 40% of moments,
   * a gaping hole in the middle of the texture that no keyboard writing leaves.
   */
  const leftSteps = leftHand
    .flatMap((bar) => bar.events.filter((event) => !event.rest && event.dstep !== undefined))
    .map((event) => event.dstep);
  const rightHand = buildStaff({
    rng, rules, meter, barCount, hand: 'rightHand', progression, key,
    silentBars: silence.rightHand, restatement,
    against: soundingTimeline(leftHand, meter.barDuration),
    above: leftSteps.length ? Math.max(...leftSteps) : null,
  });
  // Consecutive fifths and octaves put back by the repair passes inside each
  // hand — only visible now that both hands are final.
  relaxParallels(rightHand, leftHand, key, meter.barDuration, rightHand.window);
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

function buildStaff({ rng, rules, meter, barCount, hand, progression, key, silentBars = new Set(), restatement = [], against = null, above = null }) {
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
  let ostinatoSource = null;
  // How many bars the accompaniment figure has run without a break, and how
  // many it has taken overall.
  let ostinatoRun = 0;
  let ostinatoBars = 0;
  /*
   * A hard ceiling on how much of a test the accompaniment figure may occupy.
   * Capping only the consecutive run stopped three identical bars in a row but
   * not the figure owning four of six bars in alternation, which is what a
   * reader actually notices. A probability cannot give this guarantee — over
   * enough tests some will always land badly — so it is a count, not a roll.
   */
  const ostinatoBudget = Math.max(2, Math.round(barCount * 0.4));

  for (let barIndex = 0; barIndex < barCount; barIndex++) {
    const isFinalBar = barIndex === barCount - 1;
    const isCadenceBar = isFinalBar || (silentBars.size && silentBars.has(barIndex + 1));
    const isRegularBar = !silentBars.has(barIndex) && !isCadenceBar && !ostinato;
    let events;
    let motif = null;
    let usedOstinato = false;

    if (silentBars.has(barIndex)) {
      events = wholeBarRest(meter.barDuration);
    } else if (isCadenceBar) {
      // Cadence bar: end on a long note rather than a busy figure.
      const calm = cells.filter((cell) => cell.calm && !cell.rests);
      events = fillBar(rng, calm.length ? calm : cells, meter.cellBeats, {
        restBudget: 0,
        activity: activity * 0.4,
      }).events;
    } else if (ostinato && (ostinatoSource === null || (ostinatoRun < 2 && ostinatoBars < ostinatoBudget && rng.chance(0.55)))) {
      /*
       * The accompaniment figure, but not in *every* bar. Reusing it
       * unconditionally — which is what this did — put 85-89% of an
       * accompaniment's bars on one identical rhythm, and a Grade 2 test came
       * out with the same half-plus-quarter in all six bars. A real Alberti or
       * chordal accompaniment is a recognisable figure that still breaks: at
       * phrase ends, where the harmony moves faster, or simply for variety.
       * Keeping the figure in a clear majority of bars leaves it recognisable
       * while giving the hand somewhere to go.
       */
      usedOstinato = true;
      ostinatoBars += 1;
      events = ostinato.map((event) => ({ ...event }));
      // An accompaniment figure keeps its *shape* from chord to chord — that
      // is what makes an Alberti-style bass one recognisable pattern rather
      // than a new arpeggio every bar. The restatement is anchor-relative
      // (see melody.js), so each bar re-seats the same shape on whatever
      // chord tone the new harmony offers.
      if (ostinatoSource === null) ostinatoSource = barIndex;
      else motif = pitchTreatment(rng, progression, ostinatoSource, barIndex) ?? { sourceBarIndex: ostinatoSource, transpose: 0 };
    } else if (restatement[barIndex] !== undefined && !silentBars.has(restatement[barIndex])) {
      /*
       * The consequent phrase opens by restating the antecedent's opening —
       * bar 5 saying again what bar 1 said, which is the most recognisable
       * single feature of a real sight-reading test and the clearest answer
       * to a test reading as unrelated bars laid end to end. `buildProgression`
       * has already arranged for these two bars to carry the same chords as
       * their counterparts, so the restatement transposes by nothing and the
       * pitches come through intact rather than being bent to a new harmony.
       */
      const source = restatement[barIndex];
      events = bars[source].events.map((event) => ({ ...event }));
      motif = { sourceBarIndex: source, transpose: 0 };
    } else if (barIndex >= 2 && bank[barIndex % 2] && rng.chance(0.18)) {
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
      const source = bank[barIndex % 2];
      events = source.events.map((event) => ({ ...event }));
      motif = pitchTreatment(rng, progression, source.barIndex, barIndex);
    } else {
      /*
       * A bar meant to be *fresh* has to actually come out fresh. The calm
       * cell set a low-grade left hand draws from holds only six or seven
       * cells, and their weights concentrate hard, so an independent draw
       * reproduced the bar before it often enough that a Grade 2 test could
       * show the same figure in four of its six bars even with the ostinato
       * turned down — the vocabulary, not the ostinato, was the binding
       * constraint. Redraw when a bar duplicates what it is meant to be
       * relieving. Restatements are excluded by construction: they are
       * handled in the branches above, where repetition is the intent.
       */
      events = drawContrastingBar(rng, cells, meter.cellBeats, {
        restBudget,
        activity: isLeft ? activity * 0.7 : activity,
      }, [bars[barIndex - 1]?.events, bars[barIndex - 2]?.events, ostinato]);
    }

    /*
     * The figure may state itself twice running, but a third identical bar is
     * where an accompaniment stops being a pattern and starts being a stuck
     * record — which is how a six-bar test ended up with four bars alike.
     */
    ostinatoRun = usedOstinato ? ostinatoRun + 1 : 0;

    if (isRegularBar) {
      bank[barIndex % 2] = { events: events.map((event) => ({ ...event })), barIndex };
    }

    bars.push({ events, beatDuration: meter.beatDuration, directions: [], motif });
  }

  const range = rules.range[hand];
  const { low, high } = dstepRange(key, range.minMidi, range.maxMidi);
  const window = rules.texture.fiveFingerPosition
    ? fiveFingerWindow(rng, key, low, high, above)
    : tessituraWindow(rng, key, low, high, 8 + rules.grade, above);

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
      // The tune is shaped as an arch across the whole test; the bass that
      // supports it should stay put underneath rather than arch with it.
      arch: isLeft ? 0 : 1,
    },
    against,
  });

  /*
   * The accompaniment takes chords from Grade 3, where two-note chords first
   * appear. The melody only starts taking them once the grade declares a
   * simultaneous-note total (`maxNotesTotal`, Grade 5) — that is the point the
   * syllabus describes as four-part writing, "two notes per hand", and until
   * then chords belong under the tune rather than in it. Leaving the melody
   * out of this entirely is why the right hand never played a chord at any
   * grade and Grade 8 read no thicker than Grade 3.
   */
  if (rules.texture.maxNotesPerChord >= 2 && (isLeft || rules.texture.maxNotesTotal)) {
    stackChordTones({
      bars, key, progression, rng, window,
      maxNotes: rules.texture.maxNotesPerChord,
      // A melody is mostly single notes even where chords are allowed, so it
      // takes them a good deal less often than the accompaniment does.
      density: isLeft ? 0.18 + 0.02 * rules.grade : 0.05 + 0.015 * rules.grade,
      barDuration: meter.barDuration,
      against,
      maxTotal: rules.texture.maxNotesTotal ?? Infinity,
      // Only the lower hand actually sets the bass, and so the inversion.
      bassVoicing: isLeft,
    });
  }

  // The cross-hand parallel repair runs once both hands exist and has to keep
  // its replacements inside this hand's working range, so carry it along.
  bars.window = window;
  return bars;
}

/** A bar's rhythm, as a comparable string. */
function rhythmSignature(events) {
  return events.map((event) => `${event.rest ? 'r' : 'n'}${event.dur}`).join(',');
}

/**
 * Draw a bar of rhythm that differs from the ones given in `avoid` — the two
 * bars before it, and the accompaniment figure it is supposed to be breaking
 * up. Looking back two bars rather than one matters most in the short metres,
 * where a bar holds two or three beats and the handful of available fillings
 * would otherwise alternate ABAB and still read as one repeated figure.
 * Falls back to the first draw when the cell vocabulary is too small to
 * offer anything else, which is a real situation at Grade 1-2 rather than a
 * failure: better a repeated bar than a bar that does not fill. The attempt
 * count is generous because the draw is weighted, not uniform — in a two-beat
 * bar drawn from the calm cells, quarter-plus-quarter carries most of the
 * probability mass on its own, so a handful of tries kept returning it.
 */
function drawContrastingBar(rng, cells, cellBeats, options, avoid) {
  const unwanted = new Set(avoid.filter(Boolean).map(rhythmSignature));
  let first = null;
  for (let attempt = 0; attempt < 24; attempt++) {
    const { events } = fillBar(rng, cells, cellBeats, options);
    if (first === null) first = events;
    if (!unwanted.has(rhythmSignature(events))) return events;
  }
  return first;
}

/**
 * Which bars of the consequent phrase restate the antecedent's opening, as
 * `plan[destinationBar] = sourceBar`. Only the phrase's first two bars are
 * candidates: a period restates its opening gesture and then goes its own
 * way to the cadence, rather than duplicating the whole phrase.
 */
function planRestatement(rng, barCount) {
  const half = halfCadenceBar(barCount);
  const plan = [];
  if (half === null) return plan;
  for (let position = 0; position < 2; position++) {
    const destination = half + 1 + position;
    if (destination >= barCount - 2) break;
    if (rng.chance(0.7)) plan[destination] = position;
  }
  return plan;
}

/**
 * How a bar that reuses an earlier bar's rhythm should treat that bar's
 * *pitches*. Reusing the rhythm alone — which is all this used to do — gives
 * the ear a rhythmic rhyme with no melodic one: bar 3 has bar 1's rhythm but
 * an unrelated tune, so nothing is recognisable as a restatement and the test
 * reads as a row of separately-invented bars. Measured at 1-5% of bars
 * sharing any melodic contour with an earlier bar, against real specimens
 * where restating the opening motif in bar 3-4 is close to a formal
 * requirement (`docs/abrsm-sight-reading-analysis.md §3.3`, and the rules
 * table's long-unused `motifRepeatBars`).
 *
 * The shift is not a free choice: it is the diatonic distance between the two
 * bars' chord roots. That is the one shift that maps the source bar's chord
 * tones onto *this* bar's chord tones, because a diatonic triad is a stack of
 * thirds — moving {root, +2, +4} up by k gives the triad rooted at root+k. A
 * freely-picked shift (±1, ±2) instead lands the restatement's strong beats on
 * notes the new harmony does not contain, and the chord-tone filters in
 * `pickWeighted` then reject it note by note: measured at only 14% of motif
 * bars keeping their contour, versus the near-total preservation a
 * root-distance shift gets. When the two bars share a chord the shift is zero
 * and the motif restates literally; when they differ it comes out as a tonal
 * sequence — which is exactly the pair of operations the analysis describes.
 *
 * Returning null is the analysis's third operation (same rhythm, new pitches),
 * kept as a minority case so a test is not wall-to-wall restatement.
 */
function pitchTreatment(rng, progression, sourceBarIndex, barIndex) {
  if (rng.chance(0.2)) return null;
  const rootOf = (entry) => chordDegrees(firstChord(entry ?? 'I'))[0];
  const diff = (((rootOf(progression[barIndex]) - rootOf(progression[sourceBarIndex])) % 7) + 7) % 7;
  // Take the shift as the nearer of the two directions, so a motif sequences
  // by a third down rather than a sixth up.
  return { sourceBarIndex, transpose: diff > 3 ? diff - 7 : diff };
}

/**
 * Above the five-finger grades, a test still sits in one region of the
 * keyboard rather than roaming the whole permitted range — otherwise the line
 * wanders and collects ledger lines no real test would print. Pick a working
 * tessitura inside the range, wider at each grade.
 */
function tessituraWindow(rng, key, low, high, span, above = null) {
  if (high - low <= span) return { low, high };
  const starts = [];
  for (let dstep = low; dstep + span <= high; dstep++) {
    const hasTonic = Array.from({ length: span + 1 })
      .some((_, step) => degreeOf(dstep + step, key) === 0);
    if (hasTonic) starts.push(dstep);
  }
  if (!starts.length) return { low, high };
  const start = rng.pick(reachableFrom(starts, above));
  return { low: start, high: start + span };
}

/**
 * Keep a hand's working range within reach of the one already written, so the
 * texture holds together instead of leaving a hole in the middle. A little
 * overlap below is allowed — the hands share the middle of the keyboard — and
 * about an octave and a half above is as far as the upper hand should sit.
 */
function reachableFrom(starts, above) {
  if (above === null) return starts;
  const near = starts.filter((dstep) => dstep >= above - 2 && dstep <= above + 8);
  return near.length ? near : starts;
}

/**
 * Choose a five-note window, preferring one that starts on the tonic.
 * The window must contain the tonic somewhere, or the test could not cadence
 * on it — a five-note span starting on the 2nd or 3rd degree has no tonic.
 */
function fiveFingerWindow(rng, key, low, high, above = null) {
  const all = [];
  for (let dstep = low; dstep + 4 <= high; dstep++) {
    const hasTonic = [0, 1, 2, 3, 4].some((step) => degreeOf(dstep + step, key) === 0);
    if (hasTonic) all.push(dstep);
  }
  if (!all.length) return { low, high };
  const starts = reachableFrom(all, above);
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
      const target = wedge === 'crescendo'
        ? louderThan(rules.dynamics, opening, rng)
        : softerThan(rules.dynamics, opening, rng);
      if (target) {
        bars[Math.min(start + 2, score.barCount - 1)].directions.push({ kind: 'dynamics', value: target });
      }
    }
  }

  const canSlur = rules.articulations.includes('slur');
  const canStaccato = rules.articulations.includes('staccato');
  const canTenuto = rules.articulations.includes('tenuto');
  const canAccent = rules.articulations.includes('accent');
  const canStaccatissimo = rules.articulations.includes('staccatissimo');
  // The rules table calls this "marcato"; MusicXML (and the playback engine
  // that reads `event.articulations` straight through as tag names) calls
  // the same mark `<strong-accent/>`, so that's the string written here.
  const canMarcato = rules.articulations.includes('marcato');

  for (const staffNumber of [1, 2]) {
    const staff = score.staves[staffNumber];
    for (let barIndex = 0; barIndex < staff.length; barIndex += 2) {
      const pair = [staff[barIndex], staff[barIndex + 1]].filter(Boolean);
      const sounding = pair.flatMap((bar) => bar.events.filter((event) => !event.rest));
      if (sounding.length < 2) continue;
      /*
       * A slur has to cover a continuous line, not sounding notes with a
       * silence in between. Checking only "does each bar in the pair have
       * *some* sounding note" (originally to keep Grade 1's alternating
       * hands from getting slurred across a bar they sit out entirely) let
       * a bar like [note, rest, note] through too — the rest sits inside
       * the very span the slur curve is drawn across, which engraves (and
       * would sound, once playback follows slur spans) as a phrase mark
       * reaching straight through a silence. Every event between the pair's
       * first and last *sounding* note, inclusive, now has to itself be a
       * sounding note.
       */
      const pairEvents = pair.flatMap((bar) => bar.events);
      const firstSoundingIndex = pairEvents.findIndex((event) => !event.rest);
      const lastSoundingIndex = pairEvents.length - 1
        - [...pairEvents].reverse().findIndex((event) => !event.rest);
      const unbroken = firstSoundingIndex !== -1
        && pairEvents.slice(firstSoundingIndex, lastSoundingIndex + 1).every((event) => !event.rest);

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
      } else if (canTenuto && rng.chance(0.25)) {
        // Tenuto marks a held-full-value run the same way staccato marks a
        // detached one — declared from Grade 4 but, until now, never
        // actually written, so it never reached the score at all.
        for (const event of sounding) {
          if (event.type === 'quarter' || event.type === 'eighth') {
            event.articulations = [...(event.articulations ?? []), 'tenuto'];
          }
        }
      } else if (canAccent && rng.chance(0.3)) {
        // Real specimens accent single strong-beat notes (often the phrase's
        // opening note), not a whole run the way staccato marks one.
        sounding[0].articulations = [...(sounding[0].articulations ?? []), 'accent'];
      } else if (canStaccatissimo && rng.chance(0.2)) {
        sounding[0].articulations = [...(sounding[0].articulations ?? []), 'staccatissimo'];
      } else if (canMarcato && rng.chance(0.2)) {
        sounding[0].articulations = [...(sounding[0].articulations ?? []), 'strong-accent'];
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
 * A sustain-pedal span over a legato passage, shown under the bass staff
 * (real engraving convention) rather than tied to any one hand's notes).
 * Holding one continuous pedal across a span used to ignore the harmony
 * changing underneath it entirely — with one chord per bar and the
 * progression essentially never repeating a chord bar-to-bar, a plain
 * start/stop pair could smear three or four unrelated harmonies together,
 * something no real pedalling would do. A real legato pedal instead lifts
 * and immediately redepresses at every harmony change — MusicXML's
 * `<pedal type="change"/>` is exactly that notch — so this now walks the
 * span and drops one wherever the chord actually changes, including
 * *inside* a bar that itself splits into two chords (`buildProgression`'s
 * `twoChordBarChance`), only using a plain `stop` at the very end.
 */
function addPedalMarking(rng, score) {
  if (score.barCount < 3) return;
  const span = Math.min(rng.int(2, 4), score.barCount - 1);
  const start = rng.int(0, score.barCount - 1 - span);
  const end = start + span;
  const bass = score.staves[2];

  bass[start].directions.push({ kind: 'pedal', type: 'start' });
  addMidBarPedalChange(bass[start], score.progression[start], score.barDuration);

  for (let bar = start + 1; bar < end; bar++) {
    if (firstChord(score.progression[bar]) !== lastChord(score.progression[bar - 1])) {
      bass[bar].directions.push({ kind: 'pedal', type: 'change' });
    }
    addMidBarPedalChange(bass[bar], score.progression[bar], score.barDuration);
  }

  bass[end].directions.push({ kind: 'pedal', type: 'stop' });
}

/**
 * A split bar's own harmony turns over partway through it — drop the
 * change notch at the first note starting in the second half, the same
 * point `chordAt` (harmony.js) hands that half its own chord tones. If
 * nothing starts there (a single note sustained through the whole bar),
 * there is no attack to anchor a change to, so none is added.
 */
function addMidBarPedalChange(bar, entry, barDuration) {
  if (!Array.isArray(entry)) return;
  let offset = 0;
  for (let index = 0; index < bar.events.length; index++) {
    if (offset >= barDuration / 2) {
      bar.directions.push({ kind: 'pedal', type: 'change', atEventIndex: index });
      return;
    }
    offset += bar.events[index].dur;
  }
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

/*
 * Where a wedge lands. One step is the norm, but always taking exactly one
 * step means a grade's extreme markings can never be reached from any opening
 * dynamic the generator will pick — Grade 8 declared fff and printed it in
 * none of 1500 tests. An occasional wider swing is also simply how a
 * crescendo behaves.
 */
function louderThan(allowed, from, rng) {
  const candidates = allowed.filter((d) => ORDER.indexOf(d) > ORDER.indexOf(from));
  if (!candidates.length) return null;
  return rng.chance(0.8) ? candidates[0] : rng.pick(candidates);
}
function softerThan(allowed, from, rng) {
  const candidates = allowed.filter((d) => ORDER.indexOf(d) < ORDER.indexOf(from));
  if (!candidates.length) return null;
  return rng.chance(0.8) ? candidates[candidates.length - 1] : rng.pick(candidates);
}
