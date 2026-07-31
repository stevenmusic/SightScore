/**
 * Monte-Carlo audit of the generator.
 *
 * The unit tests answer "is this legal?" — every bar adds up, no augmented
 * seconds, nothing outside the grade's range. They cannot answer "is this a
 * plausible sight-reading test?", because that is a question about
 * *distributions*: how often the bass takes the root of its chord, how much of
 * a test's rhythm is one figure repeated, whether Grade 8 actually reads
 * harder than Grade 3. Those only show up over thousands of tests, and every
 * musical fault found in this project so far has been a distribution that was
 * wrong rather than a rule that was broken.
 *
 * Each section prints observed numbers next to what the syllabus analysis and
 * the rules table lead us to expect, and marks the disagreements. A FAIL here
 * is not a broken test — it is a lead to investigate.
 *
 *   node scripts/audit.js                 # all grades, 1500 tests each
 *   node scripts/audit.js --runs 5000     # more samples
 *   node scripts/audit.js --grade 2       # one grade
 *   node scripts/audit.js --section rhythm
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { generateTest } from '../src/generator/generate.js';
import { createKey, degreeOf, chordDegrees } from '../src/generator/theory.js';
import { firstChord, chordAt } from '../src/generator/harmony.js';

const rules = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/rules/abrsm-piano-grades.json', import.meta.url)), 'utf8'),
);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const RUNS = Number(flag('runs', 1500));
const GRADES = flag('grade') ? [Number(flag('grade'))] : [1, 2, 3, 4, 5, 6, 7, 8];
const SECTION = flag('section', null);

const PASS = '  ok ';
const FAIL = '  !! ';
const findings = [];

/** Record one observation against an expectation. */
function check(section, grade, label, value, ok, expected) {
  const line = `${ok ? PASS : FAIL}g${grade} ${label.padEnd(42)} ${String(value).padStart(8)}   expected ${expected}`;
  if (!ok) findings.push({ section, grade, label, value, expected });
  return line;
}

const pct = (n, d) => (d ? (n / d) * 100 : 0);
const fixed = (x, n = 1) => Number(x).toFixed(n);

function sample(grade, runs) {
  const tests = [];
  for (let i = 0; i < runs; i++) tests.push(generateTest(rules, { grade, seed: i * 2654435761 % 4294967296 }));
  return tests;
}

function notesOfBar(bar) {
  return bar.events.filter((event) => !event.rest && event.pitch);
}

/** Every sounding note of a staff, flattened, with its bar index. */
function notesOfStaff(score, staffNumber) {
  const out = [];
  score.staves[staffNumber].forEach((bar, barIndex) => {
    for (const event of notesOfBar(bar)) out.push({ event, barIndex });
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * 1. Harmony — is the bass actually supporting the chord?
 * ------------------------------------------------------------------ */
function auditHarmony(grade, tests) {
  const lines = [];
  // Bass position of every bar's downbeat, per chord quality.
  const position = { root: 0, third: 0, fifth: 0, other: 0 };
  const perChord = {};
  let cadenceV = 0;
  let cadenceVRoot = 0;
  let finalTonicBass = 0;
  let tests0 = 0;

  for (const score of tests) {
    const key = createKey(score.key);
    tests0 += 1;
    /*
     * The span this hand actually occupies. In a five-finger grade the hand
     * has five notes and the root of, say, vi simply may not be one of them —
     * measured as unreachable in 14-19% of Grade 1-2 bars. Counting those as
     * failures blames the generator for the syllabus's own constraint, so the
     * root rate below is conditioned on the root being reachable at all.
     */
    const used = score.staves[2].flatMap((bar) => notesOfBar(bar)).map((e) => e.dstep);
    const low = used.length ? Math.min(...used) : 0;
    const high = used.length ? Math.max(...used) : 0;
    const rootReachable = (root) => {
      for (let d = low; d <= high; d++) if (degreeOf(d, key) === root) return true;
      return false;
    };
    score.staves[2].forEach((bar, barIndex) => {
      const notes = notesOfBar(bar);
      if (!notes.length) return;
      const chord = firstChord(score.progression[barIndex] ?? 'I');
      const root = chordDegrees(chord)[0];
      // The bass note is the lowest pitch sounding at the bar's downbeat.
      const first = notes[0];
      const bass = [first.pitch, ...(first.chord ?? [])]
        .reduce((low, pitch) => (pitch.dstep < low.dstep ? pitch : low));
      const relative = ((degreeOf(bass.dstep, key) - root) % 7 + 7) % 7;
      const slot = relative === 0 ? 'root' : relative === 2 ? 'third' : relative === 4 ? 'fifth' : 'other';
      if (!rootReachable(root)) return;
      position[slot] += 1;
      (perChord[chord] ??= { root: 0, total: 0 });
      perChord[chord].total += 1;
      if (slot === 'root') perChord[chord].root += 1;

      // The cadential dominant specifically.
      if (barIndex === score.barCount - 2 && chord === 'V') {
        cadenceV += 1;
        if (slot === 'root') cadenceVRoot += 1;
      }
    });

    /*
     * The bass should land on the tonic — but where the hands alternate
     * (Grade 1) the left hand may have dropped out long before the end, so
     * the closing bass note is whichever hand is still playing.
     */
    for (const staffNumber of [2, 1]) {
      const lastNotes = notesOfBar(score.staves[staffNumber][score.barCount - 1]);
      if (!lastNotes.length) continue;
      const last = lastNotes[lastNotes.length - 1];
      if (degreeOf(last.dstep, key) === 0) finalTonicBass += 1;
      break;
    }
  }

  const total = position.root + position.third + position.fifth + position.other;
  const rootRate = pct(position.root, total);
  lines.push(check('harmony', grade, 'bass in root position at downbeats', `${fixed(rootRate)}%`,
    rootRate >= 55, '>=55% (root position is the norm)'));
  lines.push(`       inversions: 3rd ${fixed(pct(position.third, total))}%  `
    + `5th ${fixed(pct(position.fifth, total))}%  non-chord ${fixed(pct(position.other, total))}%`);

  for (const chord of Object.keys(perChord).sort()) {
    const { root, total: n } = perChord[chord];
    const rate = pct(root, n);
    // Every chord should reach root position a fair share of the time; a
    // chord that never does is a hole in the harmonic vocabulary.
    lines.push(check('harmony', grade, `  ${chord}: bass on the chord root`, `${fixed(rate)}%`,
      rate >= 55, '>=55% of bars where the root is reachable'));
  }

  const cadRate = pct(cadenceVRoot, cadenceV);
  // Grade 1-2 cap the bass at a 4th-to-5th leap inside a five-note position,
  // so the dominant root is not always both reachable and playable from the
  // note before it; the upper grades have no such excuse.
  const cadFloor = rules.grades[String(grade)].texture.fiveFingerPosition ? 60 : 85;
  lines.push(check('harmony', grade, 'cadential V has its root in the bass', `${fixed(cadRate)}%`,
    cadRate >= cadFloor, `>=${cadFloor}% (a V-I cadence needs the dominant root)`));
  lines.push(check('harmony', grade, 'final bass note is the tonic', `${fixed(pct(finalTonicBass, tests0))}%`,
    pct(finalTonicBass, tests0) >= 95, '>=95%'));
  return lines;
}

/* ------------------------------------------------------------------ *
 * 2. Rhythm — variety, and how much of a test is one figure repeated
 * ------------------------------------------------------------------ */
function auditRhythm(grade, tests) {
  const lines = [];
  const signature = (bar) => bar.events.map((e) => `${e.rest ? 'r' : 'n'}${e.dur}`).join(',');

  const distinctPerTest = { 1: [], 2: [] };
  const dominantShare = { 1: [], 2: [] };
  const valueCounts = {};
  let restBars = 0;
  let totalBars = 0;

  for (const score of tests) {
    for (const staffNumber of [1, 2]) {
      const sigs = score.staves[staffNumber].map(signature);
      const counts = {};
      for (const s of sigs) counts[s] = (counts[s] ?? 0) + 1;
      distinctPerTest[staffNumber].push(Object.keys(counts).length / sigs.length);
      dominantShare[staffNumber].push(Math.max(...Object.values(counts)) / sigs.length);
      for (const bar of score.staves[staffNumber]) {
        totalBars += 1;
        if (!notesOfBar(bar).length) restBars += 1;
        for (const event of bar.events) {
          if (event.rest) continue;
          const name = `${event.type}${event.dots ? '.' : ''}${event.timeModification ? '3' : ''}`;
          valueCounts[name] = (valueCounts[name] ?? 0) + 1;
        }
      }
    }
  }

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  /*
   * The lower hand is held to a looser bound than the melody. Where a grade
   * gives it a real accompaniment figure it is *supposed* to repeat — an
   * Alberti bass that reinvented itself every bar would be wrong — so the
   * question there is only whether the figure ever breaks, not whether it
   * dominates. The melody has no such excuse.
   */
  for (const [staffNumber, hand, floor, ceiling] of
    [[1, 'melody', 45, 60], [2, 'accompaniment', 38, 68]]) {
    const distinct = pct(mean(distinctPerTest[staffNumber]), 1);
    const dominant = pct(mean(dominantShare[staffNumber]), 1);
    lines.push(check('rhythm', grade, `${hand}: distinct rhythms / bars`, `${fixed(distinct)}%`,
      distinct >= floor, `>=${floor}% (a test should not be one figure)`));
    lines.push(check('rhythm', grade, `${hand}: share of bars on the commonest figure`, `${fixed(dominant)}%`,
      dominant <= ceiling, `<=${ceiling}%`));
  }

  const totalValues = Object.values(valueCounts).reduce((a, b) => a + b, 0);
  const top = Object.entries(valueCounts).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, v]) => `${k} ${fixed(pct(v, totalValues), 0)}%`).join('  ');
  lines.push(`       note values: ${top}`);
  lines.push(`       whole-bar rests: ${fixed(pct(restBars, totalBars))}% of bars`);
  return lines;
}

/* ------------------------------------------------------------------ *
 * 3. Melody — motion, shape, restatement, cadence
 * ------------------------------------------------------------------ */
function auditMelody(grade, tests) {
  const lines = [];
  let steps = 0;
  let leaps = 0;
  let repeats = 0;
  let cadenceStep = 0;
  let cadenceTotal = 0;
  const restated = [];
  const peakPos = [];
  const intervals = {};

  for (const score of tests) {
    const notes = notesOfStaff(score, 1).map((n) => n.event);
    if (notes.length < 3) continue;
    const ds = notes.map((n) => n.dstep);
    for (let i = 1; i < ds.length; i++) {
      const iv = ds[i] - ds[i - 1];
      const size = Math.abs(iv);
      intervals[size] = (intervals[size] ?? 0) + 1;
      if (size === 0) repeats += 1;
      else if (size === 1) steps += 1;
      else leaps += 1;
    }
    cadenceTotal += 1;
    if (Math.abs(ds[ds.length - 1] - ds[ds.length - 2]) === 1) cadenceStep += 1;

    const max = Math.max(...ds);
    peakPos.push(ds.indexOf(max) / (ds.length - 1));

    const contours = score.staves[1].map((bar) => {
      const ns = notesOfBar(bar).map((e) => e.dstep);
      return ns.length >= 2 ? ns.slice(1).map((d, i) => d - ns[i]).join(',') : null;
    }).filter(Boolean);
    const seen = new Set();
    let again = 0;
    for (const c of contours) {
      if (seen.has(c)) again += 1;
      else seen.add(c);
    }
    if (contours.length) restated.push(again / contours.length);
  }

  const moves = steps + leaps + repeats;
  const stepRate = pct(steps, moves);
  const declared = rules.grades[String(grade)].generatorHints.stepwiseBiasPercent;
  /*
   * `stepwiseBiasPercent` is the weight the step *category* gets before a
   * candidate is picked, not a target for the finished line. The hard
   * harmonic filters run afterwards and remove step candidates — a downbeat
   * must be a chord tone, and a step from the previous note frequently is not
   * — so the realised rate sits below the declared weight by construction,
   * and furthest below it in the five-finger grades where the window holds
   * only three chord tones. What matters is that the line is still
   * predominantly stepwise and that the rate tracks the grade downward.
   */
  lines.push(check('melody', grade, 'stepwise motion', `${fixed(stepRate)}%`,
    stepRate >= 40 && stepRate <= declared + 10, `40%-${declared + 10}% (declared weight ${declared}%)`));
  lines.push(check('melody', grade, 'repeated notes', `${fixed(pct(repeats, moves))}%`,
    pct(repeats, moves) <= 20, '<=20%'));
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  /*
   * A period needs two phrases to put a restatement in. Grade 1 runs to 4-6
   * bars *and* alternates hands, so each hand plays two or three bars in
   * total — there is nowhere for the consequent to bring anything back.
   */
  const canFormPeriod = (rules.grades[String(grade)].lengthBars.default
    ?? Object.values(rules.grades[String(grade)].lengthBars)[0])[1] >= 6
    && rules.grades[String(grade)].texture.handsPlayTogether !== false;
  if (canFormPeriod) {
    lines.push(check('melody', grade, 'bars restating an earlier contour', `${fixed(pct(mean(restated), 1))}%`,
      pct(mean(restated), 1) >= 5, '>=5%'));
  } else {
    lines.push(`       bars restating an earlier contour ${fixed(pct(mean(restated), 1))}% `
      + '(too short / hands alternate — no period possible)');
  }
  lines.push(check('melody', grade, 'reaches final tonic by step', `${fixed(pct(cadenceStep, cadenceTotal))}%`,
    pct(cadenceStep, cadenceTotal) >= 85, '>=85%'));
  /*
   * The contour arch needs range to be audible in. A five-finger grade gives
   * the melody five notes total, where the arch's targets span barely two
   * steps and every other constraint outweighs it — an arch is not a
   * meaningful thing to ask for there.
   */
  if (!rules.grades[String(grade)].texture.fiveFingerPosition) {
    lines.push(check('melody', grade, 'melodic peak position (0=start, 1=end)', fixed(mean(peakPos), 2),
      mean(peakPos) >= 0.4 && mean(peakPos) <= 0.8, '0.40-0.80 (an arch, not a plateau)'));
  } else {
    lines.push(`       melodic peak position ${fixed(mean(peakPos), 2)} (five-finger: no room to arch)`);
  }
  const ivTotal = Object.values(intervals).reduce((a, b) => a + b, 0);
  lines.push(`       intervals: ${Object.entries(intervals).sort((a, b) => a[0] - b[0]).slice(0, 8)
    .map(([k, v]) => `${k}:${fixed(pct(v, ivTotal), 0)}%`).join(' ')}`);
  return lines;
}

/* ------------------------------------------------------------------ *
 * 4. Texture and per-grade scope
 * ------------------------------------------------------------------ */
function auditTexture(grade, tests) {
  const lines = [];
  const R = rules.grades[String(grade)];
  let notes = 0;
  let bars = 0;
  const spans = [];
  let maxPerHand = 0;
  let maxTogether = 0;
  const keysSeen = new Set();
  const metresSeen = new Set();
  const barCounts = new Set();

  for (const score of tests) {
    keysSeen.add(`${score.key.tonic} ${score.key.mode}`);
    metresSeen.add(score.timeSignature.text);
    barCounts.add(score.barCount);
    const attacks = new Map();
    for (const staffNumber of [1, 2]) {
      score.staves[staffNumber].forEach((bar, barIndex) => {
        if (staffNumber === 1) bars += 1;
        let offset = 0;
        for (const event of bar.events) {
          if (!event.rest && event.pitch) {
            if (staffNumber === 1) notes += 1;
            const n = 1 + (event.chord?.length ?? 0);
            maxPerHand = Math.max(maxPerHand, n);
            const at = barIndex * score.barDuration + offset;
            attacks.set(at, (attacks.get(at) ?? 0) + n);
          }
          offset += event.dur;
        }
      });
    }
    maxTogether = Math.max(maxTogether, ...attacks.values());
    const ds = notesOfStaff(score, 1).map((n) => n.event.dstep);
    if (ds.length) spans.push(Math.max(...ds) - Math.min(...ds));
  }

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  lines.push(`       notes/bar ${fixed(notes / bars, 2)}   melody span ${fixed(mean(spans))} steps`);
  lines.push(check('texture', grade, 'max notes in one hand', maxPerHand,
    maxPerHand <= R.texture.maxNotesPerChord, `<= declared ${R.texture.maxNotesPerChord}`));
  lines.push(check('texture', grade, 'max notes struck together', maxTogether,
    !R.texture.maxNotesTotal || maxTogether <= R.texture.maxNotesTotal,
    `<= declared ${R.texture.maxNotesTotal ?? 'n/a'}`));

  const allowedKeys = R.keys.allKeys ? null
    : [...R.keys.major.map((k) => `${k.tonic} major`), ...R.keys.minor.map((k) => `${k.tonic} minor`)];
  if (allowedKeys) {
    lines.push(check('texture', grade, 'keys used / keys allowed',
      `${keysSeen.size}/${allowedKeys.length}`,
      keysSeen.size === allowedKeys.length, 'every allowed key should appear'));
  }
  lines.push(check('texture', grade, 'time signatures used / allowed',
    `${metresSeen.size}/${R.timeSignatures.length}`,
    metresSeen.size === R.timeSignatures.length, 'every allowed metre should appear'));
  lines.push(`       bar counts seen: ${[...barCounts].sort((a, b) => a - b).join(', ')}`);
  return lines;
}

/* ------------------------------------------------------------------ *
 * 5. Expression — do declared features actually get generated?
 * ------------------------------------------------------------------ */
function auditExpression(grade, tests) {
  const lines = [];
  const R = rules.grades[String(grade)];
  const found = {
    slur: 0, staccato: 0, accent: 0, wedge: 0, pedal: 0, ornament: 0, tempoChange: 0,
  };
  const dynamicsSeen = new Set();

  for (const score of tests) {
    let has = { slur: false, staccato: false, accent: false, wedge: false, pedal: false, ornament: false, tempoChange: false };
    for (const staffNumber of [1, 2]) {
      for (const bar of score.staves[staffNumber]) {
        for (const d of bar.directions) {
          if (d.kind === 'dynamics') dynamicsSeen.add(d.value);
          if (d.kind === 'wedge') has.wedge = true;
          if (d.kind === 'pedal') has.pedal = true;
          if (d.kind === 'words' && /rit|a tempo/.test(d.value)) has.tempoChange = true;
        }
        for (const event of bar.events) {
          if (event.slur) has.slur = true;
          if (event.grace) has.ornament = true;
          for (const a of event.articulations ?? []) {
            if (a === 'staccato') has.staccato = true;
            if (a === 'accent') has.accent = true;
          }
        }
      }
    }
    for (const k of Object.keys(found)) if (has[k]) found[k] += 1;
  }

  const n = tests.length;
  const expect = (name, allowed) => {
    const rate = pct(found[name], n);
    if (!allowed) {
      lines.push(check('expression', grade, `${name} (not allowed at this grade)`, `${fixed(rate)}%`,
        rate === 0, '0%'));
    } else {
      lines.push(check('expression', grade, `${name}`, `${fixed(rate)}%`,
        rate >= 2, '>=2% of tests (declared, so should appear)'));
    }
  };
  expect('slur', R.articulations.includes('slur'));
  expect('staccato', R.articulations.includes('staccato'));
  expect('accent', R.articulations.includes('accent'));
  expect('wedge', R.dynamicFeatures.some((f) => f === 'crescendo' || f === 'diminuendo'));
  expect('pedal', R.otherFeatures.some((f) => f.includes('踏板') || /pedal/i.test(f)));
  expect('ornament', grade >= 7);
  expect('tempoChange', grade >= 6);

  const unusedDynamics = R.dynamics.filter((d) => !dynamicsSeen.has(d));
  lines.push(check('expression', grade, 'dynamics used / allowed',
    `${dynamicsSeen.size}/${R.dynamics.length}`,
    unusedDynamics.length === 0, `unused: ${unusedDynamics.join(',') || 'none'}`));
  return lines;
}

/* ------------------------------------------------------------------ */
const SECTIONS = {
  harmony: auditHarmony,
  rhythm: auditRhythm,
  melody: auditMelody,
  texture: auditTexture,
  expression: auditExpression,
};

console.log(`Monte-Carlo audit — ${RUNS} tests per grade\n`);
for (const grade of GRADES) {
  const tests = sample(grade, RUNS);
  console.log(`${'='.repeat(72)}\nGRADE ${grade}  (${rules.grades[String(grade)].confidence})\n${'='.repeat(72)}`);
  for (const [name, fn] of Object.entries(SECTIONS)) {
    if (SECTION && SECTION !== name) continue;
    console.log(`-- ${name}`);
    for (const line of fn(grade, tests)) console.log(line);
  }
  console.log('');
}

console.log(`${'='.repeat(72)}`);
if (!findings.length) {
  console.log('no distribution problems found');
} else {
  console.log(`${findings.length} finding(s):\n`);
  const bySection = {};
  for (const f of findings) (bySection[f.section] ??= []).push(f);
  for (const [section, list] of Object.entries(bySection)) {
    console.log(`  ${section}:`);
    for (const f of list) {
      console.log(`    g${f.grade} ${f.label.trim()} = ${f.value}  (expected ${f.expected})`);
    }
  }
  process.exitCode = 1;
}
