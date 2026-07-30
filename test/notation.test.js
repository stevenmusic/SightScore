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
      // Walk the notes of one staff at a time, tracking beam depth and time.
      for (const staff of ['1', '2']) {
        let offset = 0;
        let depth = 0;
        let beamStartOffset = 0;
        const notes = measure.split('<note>').slice(1).map((n) => n.split('</note>')[0]);

        for (const note of notes) {
          if (!note.includes(`<staff>${staff}</staff>`)) continue;
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
      }
    });
  });
});

test('printed accidentals agree with the key signature', () => {
  eachTest((score, _rules, context) => {
    const xml = toMusicXml(score);
    const expected = keyAlterations(score.key.fifths);
    const notes = xml.split('<note>').slice(1).map((n) => n.split('</note>')[0]);

    for (const note of notes) {
      const step = note.match(/<step>([A-G])<\/step>/)?.[1];
      if (!step) continue;
      const alter = Number(note.match(/<alter>(-?\d+)<\/alter>/)?.[1] ?? 0);
      const printed = note.includes('<accidental>');
      const needed = alter !== expected[LETTERS.indexOf(step)];
      assert.equal(
        printed, needed,
        `grade ${context.grade} seed ${context.seed}: ${step} alter ${alter} `
        + `${printed ? 'prints' : 'omits'} an accidental but should ${needed ? 'print' : 'omit'} one`,
      );
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
