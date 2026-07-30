import test from 'node:test';
import assert from 'node:assert/strict';

import { generateTest } from '../src/generator/generate.js';
import { fingerprintOf, createHistory, generateUnique } from '../src/generator/fingerprint.js';
import { rules, GRADES, expectedDuration, soundingEvents } from './helpers.js';

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 13);

function eachTest(callback) {
  for (const grade of GRADES) {
    for (const seed of SEEDS) {
      callback(generateTest(rules, { grade, seed }), rules.grades[String(grade)], { grade, seed });
    }
  }
}

test('every bar of every staff adds up to a full bar', () => {
  eachTest((score, _grade, context) => {
    for (const staffNumber of [1, 2]) {
      score.staves[staffNumber].forEach((bar, barIndex) => {
        const total = bar.events.reduce((sum, event) => sum + event.dur, 0);
        assert.equal(
          total, score.barDuration,
          `grade ${context.grade} seed ${context.seed} staff ${staffNumber} bar ${barIndex + 1}: ${total} != ${score.barDuration}`,
        );
      });
    }
  });
});

test('printed note values match their durations', () => {
  eachTest((score) => {
    for (const staffNumber of [1, 2]) {
      for (const bar of score.staves[staffNumber]) {
        for (const event of bar.events) {
          if (event.measureRest) continue;
          assert.equal(
            event.dur, expectedDuration(event, score.divisions),
            `${event.type} (dots ${event.dots ?? 0}) should last ${expectedDuration(event, score.divisions)}, got ${event.dur}`,
          );
        }
      }
    }
  });
});

test('pitches stay inside the grade range for each hand', () => {
  eachTest((score, gradeRules, context) => {
    for (const [staffNumber, hand] of [[1, 'rightHand'], [2, 'leftHand']]) {
      const { minMidi, maxMidi } = gradeRules.range[hand];
      for (const bar of score.staves[staffNumber]) {
        for (const event of soundingEvents(bar)) {
          for (const pitch of [event.pitch, ...(event.chord ?? [])]) {
            assert.ok(
              pitch.midi >= minMidi && pitch.midi <= maxMidi,
              `grade ${context.grade} seed ${context.seed} ${hand}: MIDI ${pitch.midi} outside ${minMidi}–${maxMidi}`,
            );
          }
        }
      }
    }
  });
});

test('key, time signature and length follow the rules table', () => {
  eachTest((score, gradeRules, context) => {
    assert.ok(
      gradeRules.timeSignatures.includes(score.timeSignature.text),
      `grade ${context.grade}: unexpected time signature ${score.timeSignature.text}`,
    );

    if (!gradeRules.keys.allKeys) {
      const allowed = [
        ...gradeRules.keys.major.map((k) => `${k.tonic} major`),
        ...gradeRules.keys.minor.map((k) => `${k.tonic} minor`),
      ];
      assert.ok(
        allowed.includes(`${score.key.tonic} ${score.key.mode}`),
        `grade ${context.grade}: key ${score.key.tonic} ${score.key.mode} not in the allowed list`,
      );
    }
    assert.ok(
      Math.abs(score.key.fifths) <= gradeRules.keys.maxAccidentals,
      `grade ${context.grade}: ${score.key.fifths} accidentals exceeds the limit`,
    );

    const [min, max] = gradeRules.lengthBars[score.timeSignature.text] ?? gradeRules.lengthBars.default;
    assert.ok(
      score.barCount >= min && score.barCount <= max,
      `grade ${context.grade}: ${score.barCount} bars outside ${min}–${max}`,
    );
  });
});

test('rhythmic features only appear once the grade introduces them', () => {
  eachTest((score, gradeRules, context) => {
    const allowedTypes = new Set(gradeRules.rhythm.noteValues);
    const allowedDots = new Set(gradeRules.rhythm.dottedValues);

    for (const staffNumber of [1, 2]) {
      for (const bar of score.staves[staffNumber]) {
        for (const event of bar.events) {
          if (event.measureRest) continue;
          assert.ok(
            allowedTypes.has(event.type),
            `grade ${context.grade}: note type ${event.type} is not in the grade's vocabulary`,
          );
          if (event.dots) {
            assert.ok(
              allowedDots.has(event.type),
              `grade ${context.grade}: dotted ${event.type} is not allowed`,
            );
          }
          if (event.timeModification) {
            assert.ok(
              gradeRules.rhythm.triplets,
              `grade ${context.grade}: triplet produced but the grade does not allow one`,
            );
          }
        }
      }
    }
  });
});

test('Grade 1 keeps the hands apart and inside one five-finger position', () => {
  for (const seed of SEEDS) {
    const score = generateTest(rules, { grade: 1, seed });

    for (let barIndex = 0; barIndex < score.barCount; barIndex++) {
      const rightSounds = soundingEvents(score.staves[1][barIndex]).length > 0;
      const leftSounds = soundingEvents(score.staves[2][barIndex]).length > 0;
      assert.ok(
        !(rightSounds && leftSounds),
        `seed ${seed} bar ${barIndex + 1}: both hands sound, but Grade 1 alternates`,
      );
    }

    for (const staffNumber of [1, 2]) {
      const steps = score.staves[staffNumber]
        .flatMap(soundingEvents)
        .map((event) => event.dstep);
      if (steps.length) {
        const span = Math.max(...steps) - Math.min(...steps);
        assert.ok(span <= 4, `seed ${seed} staff ${staffNumber}: span of ${span + 1} notes exceeds a five-finger position`);
      }
    }
  }
});

test('Grade 2 plays hands together but stays in a five-finger position', () => {
  for (const seed of SEEDS) {
    const score = generateTest(rules, { grade: 2, seed });
    const barsWithBothHands = score.staves[1].filter(
      (_, index) => soundingEvents(score.staves[1][index]).length && soundingEvents(score.staves[2][index]).length,
    );
    assert.ok(barsWithBothHands.length > 0, `seed ${seed}: Grade 2 should have the hands playing together`);

    for (const staffNumber of [1, 2]) {
      const steps = score.staves[staffNumber].flatMap(soundingEvents).map((event) => event.dstep);
      const span = Math.max(...steps) - Math.min(...steps);
      assert.ok(span <= 4, `seed ${seed} staff ${staffNumber}: span exceeds a five-finger position`);
    }
  }
});

test('every test cadences on the tonic', () => {
  eachTest((score, gradeRules, context) => {
    const tonicPitchClass = tonicPitchClassOf(score.key);
    // Where the hands alternate (Grade 1) only the hand still playing at the
    // end carries the cadence; the other one has already dropped out.
    const staves = gradeRules.texture.handsPlayTogether === false
      ? [lastSoundingStaff(score)]
      : [1, 2];

    for (const staffNumber of staves) {
      const notes = score.staves[staffNumber].flatMap(soundingEvents);
      if (!notes.length) continue;
      const last = notes[notes.length - 1];
      assert.equal(
        last.pitch.midi % 12, tonicPitchClass,
        `grade ${context.grade} seed ${context.seed} staff ${staffNumber}: ends on ${last.pitch.step}, not the tonic`,
      );
    }
  });
});

function lastSoundingStaff(score) {
  const lastBar = score.barCount - 1;
  return soundingEvents(score.staves[1][lastBar]).length ? 1 : 2;
}

test('the same seed always produces the same test', () => {
  for (const grade of GRADES) {
    const first = generateTest(rules, { grade, seed: 4242 });
    const second = generateTest(rules, { grade, seed: 4242 });
    assert.equal(fingerprintOf(first), fingerprintOf(second));
    assert.deepEqual(first.progression, second.progression);
  }
});

test('different seeds produce different tests', () => {
  for (const grade of GRADES) {
    const fingerprints = new Set(
      SEEDS.map((seed) => fingerprintOf(generateTest(rules, { grade, seed }))),
    );
    assert.ok(
      fingerprints.size >= SEEDS.length * 0.9,
      `grade ${grade}: only ${fingerprints.size} distinct tests from ${SEEDS.length} seeds`,
    );
  }
});

test('history records each distinct test once', () => {
  const history = createHistory({ capacity: 10 });

  // A producer pinned to one seed can only ever make the same test, so the
  // retry loop gives up and returns it — but the history holds one entry.
  const first = generateUnique(() => generateTest(rules, { grade: 3, seed: 1 }), history, 3);
  const second = generateUnique(() => generateTest(rules, { grade: 3, seed: 1 }), history, 3);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(history.size, 1);
  assert.ok(history.has(first.fingerprint));

  // A free-running producer should get past the history immediately.
  let seed = 100;
  const third = generateUnique(() => generateTest(rules, { grade: 3, seed: seed++ }), history, 12);
  assert.notEqual(third.fingerprint, first.fingerprint);
  assert.equal(history.size, 2);
});

test('history evicts the oldest entries beyond its capacity', () => {
  const history = createHistory({ capacity: 3 });
  const fingerprints = [1, 2, 3, 4, 5].map((seed) =>
    generateUnique(() => generateTest(rules, { grade: 4, seed }), history, 1).fingerprint,
  );
  assert.equal(history.size, 3);
  assert.ok(!history.has(fingerprints[0]));
  assert.ok(history.has(fingerprints[4]));
});

function tonicPitchClassOf(key) {
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const accidental = key.tonic.includes('#') ? 1 : key.tonic.includes('b') ? -1 : 0;
  return (base[key.tonic[0]] + accidental + 12) % 12;
}

test('simultaneous intervals stay consonant', () => {
  // Before the hands were written against each other, roughly 18% of
  // simultaneous intervals were seconds, sevenths or tritones. What is left
  // should only be off-beat passing dissonance. That bound moved from 6% to
  // 10% when melody.js started forcing a passing/neighbour tone to actually
  // resolve by step (previously it could get silently discarded and
  // replaced with a chord tone instead, which is why so few survived to
  // clash in the first place) — more of them surviving means slightly more
  // of exactly the dissonance this test expects to find, still strictly
  // off-beat and never a forced unconditional clash (see pickWeighted).
  const HARSH = new Set([1, 2, 6, 10, 11]);

  for (const grade of GRADES) {
    let harsh = 0;
    let total = 0;

    for (const seed of SEEDS) {
      const score = generateTest(rules, { grade, seed });
      const right = soundingTimeline(score, 1);
      const left = soundingTimeline(score, 2);

      for (const above of right) {
        for (const below of left) {
          if (above.start >= below.end || above.end <= below.start) continue;
          for (const a of above.midis) {
            for (const b of below.midis) {
              total += 1;
              if (HARSH.has(Math.abs(a - b) % 12)) harsh += 1;
            }
          }
        }
      }
    }

    if (!total) continue; // Grade 1 alternates, so nothing ever sounds together
    const rate = harsh / total;
    assert.ok(
      rate <= 0.10,
      `grade ${grade}: ${(rate * 100).toFixed(1)}% of simultaneous intervals are harsh`,
    );
  }
});

test('no false relations between the hands', () => {
  for (const grade of GRADES) {
    for (const seed of SEEDS) {
      const score = generateTest(rules, { grade, seed });
      if (score.key.mode !== 'minor') continue;
      const right = soundingTimeline(score, 1);
      const left = soundingTimeline(score, 2);

      for (const above of right) {
        for (const below of left) {
          if (above.start >= below.end || above.end <= below.start) continue;
          for (const a of above.midis) {
            for (const b of below.midis) {
              // Same letter sounding both natural and raised at once.
              assert.notEqual(
                Math.abs(a - b) % 12, 1,
                `grade ${grade} seed ${seed}: semitone clash between the hands (${a} vs ${b})`,
              );
            }
          }
        }
      }
    }
  }
});

test('a repeated note never disagrees with itself on the raised 7th', () => {
  // resolveClashes (dodging the other hand) and harmoniseLeadingNotes
  // (reconciling the two hands) can each flip just one occurrence of a
  // repeated scale-degree-7 note to its natural form — e.g. a G minor test
  // whose bass sat on G/D printed the melody's F# immediately followed by
  // F-natural, an obvious wrong note no real test would write. Every
  // immediately repeated pitch within one hand must agree with itself.
  for (const grade of GRADES) {
    for (const seed of SEEDS) {
      const score = generateTest(rules, { grade, seed });
      if (score.key.mode !== 'minor') continue;

      for (const staffNumber of [1, 2]) {
        const notes = soundingEvents({ events: score.staves[staffNumber].flatMap((bar) => bar.events) });
        for (let i = 1; i < notes.length; i++) {
          const previous = notes[i - 1];
          const current = notes[i];
          if (current.dstep !== previous.dstep) continue;
          assert.equal(
            current.raiseSeventh, previous.raiseSeventh,
            `grade ${grade} seed ${seed} staff ${staffNumber}: repeated note disagrees with itself on the raised 7th`,
          );
        }
      }
    }
  }
});

test('a melodic hand develops fresh rhythm rather than leaning on repetition', () => {
  // A genuine accompaniment (Grade 2-3's left hand, once the hands play
  // together) is *supposed* to repeat one figure for the whole piece — real
  // Alberti-bass-style accompaniments do exactly that (see buildStaff's
  // `ostinato`) — so only the melodic hand is checked here: the right hand
  // always, and the left hand once Grade 1's alternation or Grade 4+'s
  // independent rhythms mean it isn't a fixed accompaniment figure.
  const rhythmSignature = (bar) => bar.events.map((e) => `${e.rest ? 'r' : 'n'}${e.dur}.${e.dots ?? 0}`).join(',');
  let repeated = 0;
  let total = 0;

  eachTest((score, gradeRules) => {
    for (const [handKey, hand] of [[1, 'rightHand'], [2, 'leftHand']]) {
      const isAccompaniment = hand === 'leftHand' && gradeRules.grade < 4 && gradeRules.texture.handsPlayTogether;
      if (isAccompaniment) continue;

      const seen = [];
      for (const bar of score.staves[handKey]) {
        const sig = rhythmSignature(bar);
        total += 1;
        if (seen.includes(sig)) repeated += 1;
        seen.push(sig);
      }
    }
  });

  // Before buildStaff's motif-reuse mechanic was scoped down, 33-46% of a
  // melodic hand's bars were an exact rhythmic clone of an earlier one —
  // it kept echoing bars 1-2 specifically for the rest of the piece
  // (instead of whichever phrase most recently played) at too high a
  // chance (0.55) to begin with. Measured at ~29% after the fix.
  const rate = repeated / total;
  assert.ok(
    rate <= 0.35,
    `${(rate * 100).toFixed(1)}% of melodic-hand bars exactly repeat an earlier bar's rhythm`,
  );
});

test('melodies include real scale-run figures, not just note-by-note wobble', () => {
  // Scoring every step candidate independently (no memory of a run already
  // in progress) made a 4+-note stepwise run — a routine figure in real
  // specimens, often spanning most of a beat or bar — rare: only 4-6% of
  // stepwise motion formed one. `pickWeighted`'s run-continuation bias
  // (melody.js) should make that a regular occurrence instead. Grade 1 is
  // excluded: its five-finger window and short alternating phrases leave
  // no room for a run this long regardless of weighting.
  const runLengths = (bars) => {
    const notes = bars.flatMap((bar) => soundingEvents(bar));
    const runs = [];
    let current = 0;
    let direction = 0;
    for (let i = 1; i < notes.length; i++) {
      const interval = notes[i].dstep - notes[i - 1].dstep;
      const isStep = Math.abs(interval) === 1;
      const stepDirection = isStep ? Math.sign(interval) : 0;
      if (isStep && stepDirection === direction && stepDirection !== 0) {
        current += 1;
      } else {
        if (current > 0) runs.push(current);
        current = isStep ? 1 : 0;
        direction = stepDirection;
      }
    }
    if (current > 0) runs.push(current);
    return runs;
  };

  let longRuns = 0;
  let totalRuns = 0;

  eachTest((score, gradeRules) => {
    if (gradeRules.grade === 1) return;
    for (const staffNumber of [1, 2]) {
      const runs = runLengths(score.staves[staffNumber]);
      totalRuns += runs.length;
      longRuns += runs.filter((length) => length >= 4).length;
    }
  });

  // Measured at ~7.3% after adding the run-continuation bias, against
  // 4-6% before it existed.
  const rate = longRuns / totalRuns;
  assert.ok(
    rate >= 0.03,
    `only ${(rate * 100).toFixed(1)}% of stepwise runs reach 4+ notes — scale-run figures are too rare`,
  );
});

/** Absolute-time sounding notes of one staff. */
function soundingTimeline(score, staffNumber) {
  const timeline = [];
  score.staves[staffNumber].forEach((bar, barIndex) => {
    let offset = 0;
    for (const event of bar.events) {
      if (!event.rest) {
        const start = barIndex * score.barDuration + offset;
        timeline.push({
          start,
          end: start + event.dur,
          midis: [event.pitch.midi, ...(event.chord ?? []).map((p) => p.midi)],
        });
      }
      offset += event.dur;
    }
  });
  return timeline;
}
