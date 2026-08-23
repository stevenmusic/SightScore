/**
 * Notation legality.
 *
 * The other suites check that a test obeys the grade's parameter table. These
 * check that what gets engraved is *correct music writing* — the things an
 * ABRSM editor would never let through regardless of grade: wrong spelling,
 * accidentals that should not be printed, melodic augmented seconds, beams
 * crossing beats, tuplets that do not add up.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { generateTest } from '../src/generator/generate.js';
import { toMusicXml } from '../src/generator/musicxml.js';
import { keyAlterations, LETTERS } from '../src/generator/theory.js';
import { rules, GRADES } from './helpers.js';

const SEEDS = Array.from({ length: 30 }, (_, i) => i * 2711 + 5);

function eachTest(callback) {
  for (const grade of GRADES) {
    for (const seed of SEEDS) {
      callback(generateTest(rules, { grade, seed }), rules.grades[String(grade)], { grade, seed });
    }
  }
}

/** Every sounding note, in playing order, per staff. */
function notesOf(score, staffNumber) {
  return score.staves[staffNumber].flatMap((bar) => bar.events.filter((event) => !event.rest));
}

test('every pitch is inside a real piano', () => {
  eachTest((score, _rules, context) => {
    for (const staffNumber of [1, 2]) {
      for (const note of notesOf(score, staffNumber)) {
        for (const pitch of [note.pitch, ...(note.chord ?? [])]) {
          assert.ok(
            pitch.midi >= 21 && pitch.midi <= 108,
            `grade ${context.grade} seed ${context.seed}: MIDI ${pitch.midi} is off the keyboard`,
          );
        }
      }
    }
  });
});

test('no double accidentals are ever written', () => {
  eachTest((score, _rules, context) => {
    for (const staffNumber of [1, 2]) {
      for (const note of notesOf(score, staffNumber)) {
        for (const pitch of [note.pitch, ...(note.chord ?? [])]) {
          assert.ok(
            Math.abs(pitch.alter) <= 1,
            `grade ${context.grade} seed ${context.seed}: ${pitch.step} with alter ${pitch.alter}`,
          );
        }
      }
    }
  });
});

test('accidentals outside the key only appear where the grade allows them', () => {
  eachTest((score, gradeRules, context) => {
    const expected = keyAlterations(score.key.fifths);
    const minorSeventhLetter = (LETTERS.indexOf(score.key.tonic[0]) + 6) % 7;

    for (const staffNumber of [1, 2]) {
      for (const note of notesOf(score, staffNumber)) {
        for (const pitch of [note.pitch, ...(note.chord ?? [])]) {
          const letter = LETTERS.indexOf(pitch.step);
          if (pitch.alter === expected[letter]) continue;

          // A minor key's raised 7th is a scale accidental, not a chromatic
          // note, and is legal at every grade.
          const isRaisedSeventh = score.key.mode === 'minor'
            && letter === minorSeventhLetter
            && pitch.alter === expected[letter] + 1;
          if (isRaisedSeventh) continue;

          assert.ok(
            gradeRules.harmony.chromaticNotes,
            `grade ${context.grade} seed ${context.seed}: chromatic ${pitch.step}${pitch.alter > 0 ? '#' : 'b'} `
            + 'but the grade does not allow chromatic notes',
          );
        }
      }
    }
  });
});

test('no melodic augmented second in a minor key', () => {
  eachTest((score, _rules, context) => {
    if (score.key.mode !== 'minor') return;
    for (const staffNumber of [1, 2]) {
      const notes = notesOf(score, staffNumber);
      for (let i = 1; i < notes.length; i++) {
        const steps = Math.abs(notes[i].dstep - notes[i - 1].dstep);
        const semitones = Math.abs(notes[i].pitch.midi - notes[i - 1].pitch.midi);
        assert.ok(
          !(steps === 1 && semitones === 3),
          `grade ${context.grade} seed ${context.seed} staff ${staffNumber}: augmented 2nd `
          + `${notes[i - 1].pitch.step}→${notes[i].pitch.step}`,
        );
      }
    }
  });
});

test('a chord is spelled from the same harmony as its main note', () => {
  eachTest((score, _rules, context) => {
    for (const staffNumber of [1, 2]) {
      for (const note of notesOf(score, staffNumber)) {
        for (const extra of note.chord ?? []) {
          const interval = note.pitch.midi - extra.midi;
          assert.ok(
            interval > 0 && interval <= 12,
            `grade ${context.grade} seed ${context.seed}: chord note ${interval} semitones below the melody`,
          );
          assert.ok(
            ![1, 2, 6, 10, 11].includes(interval % 12),
            `grade ${context.grade} seed ${context.seed}: chord contains a ${interval % 12}-semitone clash`,
          );
        }
      }
    }
  });
});

test('tuplets are complete groups that fill their beat', () => {
  eachTest((score, _rules, context) => {
    for (const staffNumber of [1, 2]) {
      for (const bar of score.staves[staffNumber]) {
        let run = [];
        const flush = () => {
          if (!run.length) return;
          const { actualNotes, normalNotes, normalType } = run[0].timeModification;
          assert.equal(
            run.length % actualNotes, 0,
            `grade ${context.grade} seed ${context.seed}: ${run.length} notes in a ${actualNotes}-tuplet`,
          );
          const total = run.reduce((sum, event) => sum + event.dur, 0);
          const TYPE_QUARTERS = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125 };
          const normalDuration = TYPE_QUARTERS[normalType] * score.divisions;
          assert.equal(
            total, (run.length / actualNotes) * normalNotes * normalDuration,
            `grade ${context.grade} seed ${context.seed}: tuplet does not fill its beat`,
          );
          run = [];
        };
        for (const event of bar.events) {
          if (event.timeModification) run.push(event);
          else flush();
        }
        flush();
      }
    }
  });
});

test('beams never cross a beat boundary', () => {
  eachTest((score, _rules, context) => {
    // Only where the beat is a crotchet or a dotted crotchet. In 3/8 a dotted
    // quaver beamed to a semiquaver crosses two notated beats and is correct.
    const compound = score.timeSignature.beatType === 8
      && score.timeSignature.beats % 3 === 0
      && score.timeSignature.beats >= 6;
    if (score.timeSignature.beatType === 8 && !compound) return;
    if (score.timeSignature.beatType === 2) return;
    const xml = toMusicXml(score);
    const measures = xml.split('<measure number=').slice(1);

    measures.forEach((measure, index) => {
      /*
       * One staff's time flow is the run of notes before the `<backup>`, and
       * the other's is the run after it — not "the notes tagged `<staff>N</
       * staff>`". Grade 8's cross-staff writing (`addCrossStaffWriting`) is
       * the difference: such a note is *printed* on the other staff, so it
       * carries that staff's tag and a reserved voice, but its `<duration>`
       * still advances its own hand's flow, because `<staff>`/`<voice>` are
       * placement metadata and the `<backup>` bookkeeping is untouched.
       * Filtering by the tag therefore skipped a note that still consumes
       * time here, desynchronising `offset` from the real bar position and
       * reporting a beam as crossing a beat boundary when it does not.
       * Measured on the code as it stood: 19 spurious hits in 15,043 stress
       * seeds, every one of them a Grade 8 bar containing a crossed note.
       * Splitting on `<backup>` follows the durations the way the renderer
       * actually lays them out.
       */
      const flows = measure.split('<backup>');
      flows.forEach((flow, flowIndex) => {
        const staff = String(flowIndex + 1);
        let offset = 0;
        let depth = 0;
        let beamStartOffset = 0;
        const notes = flow.split('<note>').slice(1).map((n) => n.split('</note>')[0]);

        for (const note of notes) {
          if (note.includes('<chord/>')) continue;
          // A grace note borrows its time from the note it decorates and
          // carries no <duration> (and no beam) of its own.
          if (note.includes('<grace')) continue;
          const duration = Number(note.match(/<duration>(\d+)<\/duration>/)[1]);
          const beams = [...note.matchAll(/<beam number="1">(\w+)<\/beam>/g)].map((m) => m[1]);

          for (const beam of beams) {
            if (beam === 'begin') { depth += 1; beamStartOffset = offset; }
            if (beam === 'end') {
              depth -= 1;
              const beat = score.beatDuration;
              assert.equal(
                Math.floor(beamStartOffset / beat), Math.floor((offset + duration - 1) / beat),
                `grade ${context.grade} seed ${context.seed} measure ${index + 1} staff ${staff}: `
                + 'beam crosses a beat boundary',
              );
            }
          }
          offset += duration;
        }
        assert.equal(depth, 0, `measure ${index + 1} staff ${staff}: unbalanced beam`);
      });
    });
  });
});

test('printed accidentals agree with the key signature', () => {
  eachTest((score, _rules, context) => {
    const xml = toMusicXml(score);
    const originalAlters = keyAlterations(score.key.fifths);
    // A modulating test (generate.js's addModulation) prints a real key
    // change partway through — accidentals from that bar on have to be
    // judged against the *new* signature, not the opening one.
    const modulatedAlters = score.keyChange ? keyAlterations(score.keyChange.fifths) : null;

    const measures = xml.split(/<measure number="(\d+)">/).slice(1);
    for (let i = 0; i < measures.length; i += 2) {
      const barIndex = Number(measures[i]) - 1;
      const expected = modulatedAlters && barIndex >= score.keyChange.barIndex
        ? modulatedAlters : originalAlters;
      /*
       * An accidental holds for the rest of the bar, on its own staff, for
       * the line or space it is written on — so this has to be judged per
       * staff with the bar's running state, not against the key signature
       * alone. Judging it against the key signature was the bug: it demanded
       * a fresh accidental on every recurrence of an altered note, which is
       * how the second F# of a bar came to print a second sharp (30.1% of all
       * accidentals printed, in 25.3% of tests). The two staves are split on
       * `<backup>` rather than by the `<staff>` tag, for the reason the
       * beaming test above documents.
       */
      const flows = measures[i + 1].split('<backup>');
      for (const flow of flows) {
        const notes = flow.split('<note>').slice(1).map((n) => n.split('</note>')[0]);
        const inEffect = new Map();

        for (const note of notes) {
          const step = note.match(/<step>([A-G])<\/step>/)?.[1];
          if (!step) continue;
          const octave = note.match(/<octave>(\d+)<\/octave>/)?.[1];
          const alter = Number(note.match(/<alter>(-?\d+)<\/alter>/)?.[1] ?? 0);
          const printed = note.includes('<accidental>');
          const fromKey = expected[LETTERS.indexOf(step)];
          // A crossed note is drawn on the other staff, outside this one's
          // accidental context, so it always states its own and changes
          // nothing here (musicxml.js's accidentalFor).
          if (/<voice>5<\/voice>/.test(note)) {
            assert.equal(
              printed, alter !== fromKey,
              `grade ${context.grade} seed ${context.seed} bar ${barIndex + 1}: `
              + `crossed ${step} alter ${alter} accidental wrong`,
            );
            continue;
          }
          const slot = `${step}${octave}`;
          const current = inEffect.has(slot) ? inEffect.get(slot) : fromKey;
          inEffect.set(slot, alter);
          assert.equal(
            printed, alter !== current,
            `grade ${context.grade} seed ${context.seed} bar ${barIndex + 1}: ${step}${octave} alter ${alter} `
            + `${printed ? 'prints' : 'omits'} an accidental but should ${printed ? 'omit' : 'print'} one `
            + `(${current} already in force for that line)`,
          );
        }
      }
    }
  });
});

test('rests fill whole bars only when the hand is silent for the whole bar', () => {
  eachTest((score, _rules, context) => {
    for (const staffNumber of [1, 2]) {
      for (const [index, bar] of score.staves[staffNumber].entries()) {
        const measureRests = bar.events.filter((event) => event.measureRest);
        if (!measureRests.length) continue;
        assert.equal(
          bar.events.length, 1,
          `grade ${context.grade} seed ${context.seed} staff ${staffNumber} bar ${index + 1}: `
          + 'whole-bar rest alongside other events',
        );
        assert.equal(measureRests[0].dur, score.barDuration);
      }
    }
  });
});

test('the left hand never rises above the right', () => {
  eachTest((score, gradeRules, context) => {
    if (gradeRules.texture.handsPlayTogether === false) return;

    const timeline = (staffNumber) => {
      const entries = [];
      score.staves[staffNumber].forEach((bar, barIndex) => {
        let offset = 0;
        for (const event of bar.events) {
          if (!event.rest) {
            const start = barIndex * score.barDuration + offset;
            entries.push({
              start,
              end: start + event.dur,
              lowest: Math.min(event.pitch.midi, ...(event.chord ?? []).map((p) => p.midi)),
              highest: Math.max(event.pitch.midi, ...(event.chord ?? []).map((p) => p.midi)),
            });
          }
          offset += event.dur;
        }
      });
      return entries;
    };

    for (const above of timeline(1)) {
      for (const below of timeline(2)) {
        if (above.start >= below.end || above.end <= below.start) continue;
        assert.ok(
          above.lowest >= below.highest,
          `grade ${context.grade} seed ${context.seed}: hands cross `
          + `(right ${above.lowest} under left ${below.highest})`,
        );
      }
    }
  });
});

test('a minor key does not write both forms of the same degree', () => {
  /*
   * A cross relation: the same letter printed both natural and raised
   * somewhere in one short test — C and C sharp in a four-bar D minor piece.
   * Unlike a false relation the two need never sound together to jar, and at
   * these grades a sight-reader meets the piece once, so the inconsistency
   * reads as a misprint rather than as melodic-minor colour.
   *
   * Almost all of these came from `fixAugmentedSeconds`: a raised 7th landing
   * next to the natural 6th was repaired by un-raising it, which fixed the
   * interval and left the piece disagreeing with itself about the 7th
   * everywhere else. Declining that step in `pickWeighted` — the rule ABRSM
   * writing follows anyway — took minor tests containing one from 64% to
   * under 8%. The rest are genuinely forced, where raising the 7th back would
   * write an augmented 2nd, cross the hands or clash with the other hand, and
   * the competing rule has to win.
   */
  let mixed = 0;
  let total = 0;

  eachTest((score) => {
    if (score.key.mode !== 'minor') return;
    total += 1;
    const alters = new Map();
    for (const staffNumber of [1, 2]) {
      for (const note of notesOf(score, staffNumber)) {
        for (const pitch of [note.pitch, ...(note.chord ?? [])]) {
          if (!alters.has(pitch.step)) alters.set(pitch.step, new Set());
          alters.get(pitch.step).add(pitch.alter);
        }
      }
    }
    if ([...alters.values()].some((set) => set.size > 1)) mixed += 1;
  });

  const rate = mixed / total;
  assert.ok(
    rate <= 0.15,
    `${(rate * 100).toFixed(1)}% of minor tests write the same letter both natural and raised`,
  );
});

/*
 * Notation has to show the metre's primary division. In a bar that halves
 * evenly — 4/4, 2/4, 6/8 — that is the half-way point, and a value which
 * starts after the downbeat and is still sounding across it hides the beat
 * the reader counts from; real engraving writes it as two notes joined by a
 * tie. Measured before `crossesMidBar` was extended from rests to notes:
 * 11.9% of bars in qualifying metres broke this and 38.5% of tests contained
 * at least one, most often a dotted crotchet on beat 2 of 4/4.
 *
 * Two exemptions are part of the rule, not loopholes: a bar with an odd
 * number of beats has no equal half to show (a minim on beat 1 of 3/4 is
 * ordinary), and a value starting on the downbeat may run straight through
 * the middle (a dotted minim plus a crotchet in 4/4, a dotted crotchet
 * opening a 2/4 bar).
 */
test('no note obscures the half-bar', () => {
  eachTest((score, _rules, context) => {
    const { beats, beatType } = score.timeSignature;
    const compound = beatType === 8 && beats % 3 === 0 && beats >= 6;
    const beatsPerBar = compound ? beats / 3 : beats;
    if (!Number.isInteger(beatsPerBar / 2)) return;
    const half = score.barDuration / 2;

    for (const staffNumber of [1, 2]) {
      score.staves[staffNumber].forEach((bar, barIndex) => {
        let offset = 0;
        for (const event of bar.events) {
          const start = offset;
          const end = start + event.dur;
          offset = end;
          if (event.rest || start === 0) continue;
          assert.ok(
            !(start < half && end > half),
            `grade ${context.grade} seed ${context.seed} staff ${staffNumber} bar ${barIndex + 1}: `
            + `a ${event.dots ? 'dotted ' : ''}${event.type} starting at ${start} runs through the `
            + `half-bar at ${half} — it needs writing as two notes and a tie`,
          );
        }
      });
    }
  });
});
