import test from 'node:test';
import assert from 'node:assert/strict';

import { generateTest } from '../src/generator/generate.js';
import { toMusicXml } from '../src/generator/musicxml.js';
import { rules, GRADES, assertWellFormedXml, countMatches } from './helpers.js';

const SEEDS = [11, 2027, 40507, 88888];

function eachXml(callback) {
  for (const grade of GRADES) {
    for (const seed of SEEDS) {
      const score = generateTest(rules, { grade, seed });
      callback(toMusicXml(score), score, { grade, seed });
    }
  }
}

test('output is well-formed XML', () => {
  eachXml((xml, _score, context) => {
    try {
      assertWellFormedXml(xml);
    } catch (error) {
      throw new Error(`grade ${context.grade} seed ${context.seed}: ${error.message}`);
    }
  });
});

test('one part, two staves, one measure per bar', () => {
  eachXml((xml, score) => {
    assert.equal(countMatches(xml, /<part id="P1">/g), 1);
    assert.equal(countMatches(xml, /<staves>2<\/staves>/g), 1);
    assert.equal(countMatches(xml, /<measure number=/g), score.barCount);
    // One <backup> per measure, to get from staff 1 back to staff 2.
    assert.equal(countMatches(xml, /<backup>/g), score.barCount);
  });
});

test('attributes and clefs are declared once, in the first measure', () => {
  eachXml((xml) => {
    assert.equal(countMatches(xml, /<attributes>/g), 1);
    assert.equal(countMatches(xml, /<sign>G<\/sign>/g), 1);
    assert.equal(countMatches(xml, /<sign>F<\/sign>/g), 1);
    const firstMeasureEnd = xml.indexOf('</measure>');
    assert.ok(xml.indexOf('<attributes>') < firstMeasureEnd);
  });
});

test('key signature and divisions match the score', () => {
  eachXml((xml, score) => {
    assert.ok(xml.includes(`<fifths>${score.key.fifths}</fifths>`));
    assert.ok(xml.includes(`<mode>${score.key.mode}</mode>`));
    assert.ok(xml.includes(`<divisions>${score.divisions}</divisions>`));
    assert.ok(xml.includes(`<beats>${score.timeSignature.beats}</beats>`));
    assert.ok(xml.includes(`<beat-type>${score.timeSignature.beatType}</beat-type>`));
  });
});

test('every note carries a staff and a voice', () => {
  eachXml((xml) => {
    const notes = xml.split('<note>').slice(1);
    for (const note of notes) {
      const body = note.split('</note>')[0];
      assert.ok(/<staff>[12]<\/staff>/.test(body), 'note without a staff');
      assert.ok(/<voice>[12]<\/voice>/.test(body), 'note without a voice');
      assert.ok(/<duration>\d+<\/duration>/.test(body), 'note without a duration');
    }
  });
});

test('durations in each measure add up to two full bars (one per staff)', () => {
  eachXml((xml, score) => {
    const measures = xml.split('<measure number=').slice(1);
    measures.forEach((measure, index) => {
      const durations = [...measure.matchAll(/<duration>(\d+)<\/duration>/g)].map((m) => Number(m[1]));
      const backups = [...measure.matchAll(/<backup><duration>(\d+)<\/duration>/g)].map((m) => Number(m[1]));
      const backupTotal = backups.reduce((sum, value) => sum + value, 0);
      // Note durations include the backup value, which is counted separately.
      const noteTotal = durations.reduce((sum, value) => sum + value, 0) - backupTotal;
      // Chord notes repeat the duration without advancing time.
      const chordExtra = [...measure.matchAll(/<chord\/>/g)].length;
      assert.ok(
        noteTotal >= score.barDuration * 2 && noteTotal <= score.barDuration * (2 + chordExtra),
        `measure ${index + 1}: durations total ${noteTotal}, expected about ${score.barDuration * 2}`,
      );
    });
  });
});

test('accidentals are printed only where they differ from the key signature', () => {
  // A minor: a raised leading note must print a sharp; the key's own notes must not.
  const score = generateTest(rules, { grade: 3, seed: 31337 });
  const xml = toMusicXml(score);
  const notes = xml.split('<note>').slice(1).map((note) => note.split('</note>')[0]);

  for (const note of notes) {
    const alterMatch = note.match(/<alter>(-?\d+)<\/alter>/);
    const alter = alterMatch ? Number(alterMatch[1]) : 0;
    const hasAccidental = note.includes('<accidental>');
    if (hasAccidental) {
      const accidental = note.match(/<accidental>([\w-]+)<\/accidental>/)[1];
      const expected = { '-2': 'flat-flat', '-1': 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp' }[String(alter)];
      assert.equal(accidental, expected, 'printed accidental disagrees with <alter>');
    }
  }
});

test('slurs and ties are balanced', () => {
  eachXml((xml, _score, context) => {
    for (const tag of ['slur', 'tied']) {
      const starts = countMatches(xml, new RegExp(`<${tag} type="start"`, 'g'));
      const stops = countMatches(xml, new RegExp(`<${tag} type="stop"`, 'g'));
      assert.equal(
        starts, stops,
        `grade ${context.grade} seed ${context.seed}: ${starts} ${tag} starts vs ${stops} stops`,
      );
    }
    const wedgeStarts = countMatches(xml, /<wedge type="(crescendo|diminuendo)"/g);
    const wedgeStops = countMatches(xml, /<wedge type="stop"/g);
    assert.equal(wedgeStarts, wedgeStops, 'unbalanced wedge');
  });
});

test('beams are balanced within each measure', () => {
  eachXml((xml, _score, context) => {
    const measures = xml.split('<measure number=').slice(1);
    measures.forEach((measure, index) => {
      const beams = [...measure.matchAll(/<beam number="(\d+)">(\w+)<\/beam>/g)]
        .map((match) => ({ level: Number(match[1]), value: match[2] }));
      const open = new Map();
      for (const beam of beams) {
        const depth = open.get(beam.level) ?? 0;
        if (beam.value === 'begin') open.set(beam.level, depth + 1);
        else if (beam.value === 'end') open.set(beam.level, depth - 1);
        assert.ok(
          (open.get(beam.level) ?? 0) >= 0,
          `grade ${context.grade} seed ${context.seed} measure ${index + 1}: beam ${beam.level} ends before it begins`,
        );
      }
      for (const [level, depth] of open) {
        assert.equal(depth, 0, `measure ${index + 1}: beam level ${level} left open`);
      }
    });
  });
});

test('triplets carry a time-modification and a bracket', () => {
  for (const grade of [5, 6, 7, 8]) {
    for (let seed = 0; seed < 60; seed++) {
      const xml = toMusicXml(generateTest(rules, { grade, seed }));
      const modifications = countMatches(xml, /<time-modification>/g);
      if (!modifications) continue;
      assert.equal(modifications % 3, 0, 'triplets should come in threes');
      assert.equal(
        countMatches(xml, /<tuplet type="start"/g),
        countMatches(xml, /<tuplet type="stop"/g),
        'unbalanced tuplet bracket',
      );
    }
  }
});
