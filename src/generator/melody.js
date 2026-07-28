/**
 * Pitch selection.
 *
 * Every note is scored against the bar's chord, the previous note and the
 * grade's contour constraints, then drawn from the weighted candidates. The
 * result stays inside the grade's range (and, at Grades 1–2, inside one
 * five-finger position) while still sounding like a phrase rather than a
 * scale exercise.
 */

import { chordDegrees, degreeOf, pitchAt } from './theory.js';
import { raisesSeventh } from './harmony.js';

/**
 * @param {object} params
 * @param {ReturnType<import('./random.js').createRandom>} params.rng
 * @param {ReturnType<import('./theory.js').createKey>} params.key
 * @param {Array<{events: object[], beatDuration: number}>} params.bars
 * @param {string[]} params.progression roman numeral per bar
 * @param {{low: number, high: number}} params.window allowed dstep window
 * @param {object} params.options
 */
export function assignPitches({ rng, key, bars, progression, window, options }) {
  const {
    stepwiseBias = 0.7,
    maxLeapSemitones = 7,
    chordToneOnly = false,
    endOnTonic = true,
  } = options;

  const centre = (window.low + window.high) / 2;
  const allSteps = [];
  for (let dstep = window.low; dstep <= window.high; dstep++) allSteps.push(dstep);

  // The cadence note is the last one that actually sounds, which is not
  // necessarily in the last bar — at Grade 1 a hand may rest through the
  // second half of the test.
  const soundingEvents = bars.flatMap((bar) => bar.events.filter((event) => !event.rest));
  const finalEvent = soundingEvents[soundingEvents.length - 1] ?? null;

  let previous = null;
  let previousLeap = 0;
  let repeatRun = 0;

  bars.forEach((bar, barIndex) => {
    const roman = progression[barIndex] ?? 'I';
    const tones = chordDegrees(roman);
    const raiseSeventh = raisesSeventh(roman);
    let offset = 0;

    bar.events.forEach((event) => {
      if (event.rest) {
        offset += event.dur;
        return;
      }

      const onBeat = offset % bar.beatDuration === 0;
      const isDownbeat = offset === 0;
      const isFinalNote = event === finalEvent;

      let chosen;
      if (isFinalNote && endOnTonic) {
        chosen = nearestWithDegree(allSteps, key, 0, previous ?? centre);
      } else if (previous === null) {
        // Open on a chord tone, near the middle of the hand's range.
        const openings = allSteps.filter((dstep) => tones.includes(degreeOf(dstep, key)));
        chosen = leastDistant(openings.length ? openings : allSteps, centre);
      } else {
        chosen = pickWeighted({
          rng,
          key,
          allSteps,
          previous,
          previousLeap,
          repeatRun,
          tones,
          onBeat,
          isDownbeat,
          centre,
          stepwiseBias,
          maxLeapSemitones,
          chordToneOnly,
        });
      }

      const interval = previous === null ? 0 : chosen - previous;
      repeatRun = interval === 0 ? repeatRun + 1 : 0;
      previousLeap = interval;
      previous = chosen;

      event.dstep = chosen;
      event.raiseSeventh = raiseSeventh && degreeOf(chosen, key) === 6;
      event.pitch = pitchAt(chosen, key, { raiseSeventh: event.raiseSeventh });
      offset += event.dur;
    });
  });

  fixAugmentedSeconds(bars, key);
  return bars;
}

function pickWeighted(ctx) {
  const {
    rng, key, allSteps, previous, previousLeap, repeatRun, tones,
    onBeat, isDownbeat, centre, stepwiseBias, maxLeapSemitones, chordToneOnly,
  } = ctx;

  const previousMidi = pitchAt(previous, key).midi;
  const candidates = [];

  for (const dstep of allSteps) {
    const interval = dstep - previous;
    const distance = Math.abs(interval);
    const semitones = Math.abs(pitchAt(dstep, key).midi - previousMidi);
    if (semitones > maxLeapSemitones) continue;

    const isChordTone = tones.includes(degreeOf(dstep, key));
    if (chordToneOnly && !isChordTone) continue;
    // A non-chord note on a strong beat is only allowed as a passing step.
    if (onBeat && !isChordTone && distance !== 1) continue;
    if (isDownbeat && !isChordTone) continue;
    if (distance === 0 && repeatRun >= 1) continue;

    let weight;
    if (distance === 0) weight = 0.5;
    else if (distance === 1) weight = 10 * stepwiseBias;
    else weight = (10 * (1 - stepwiseBias)) / (distance - 1);

    if (isChordTone) weight *= onBeat ? 2.2 : 1.3;
    // After a leap, prefer a step back the other way.
    if (Math.abs(previousLeap) >= 3) {
      weight *= Math.sign(interval) === -Math.sign(previousLeap) ? 2.5 : 0.4;
    }
    // Gentle pull back toward the middle of the range.
    weight *= 1 / (1 + Math.abs(dstep - centre) * 0.12);

    candidates.push({ dstep, weight });
  }

  if (!candidates.length) {
    // Nothing legal: fall back to the nearest chord tone.
    return nearestWithDegreeSet(allSteps, key, tones, previous);
  }
  return rng.weighted(candidates).dstep;
}

function leastDistant(steps, target) {
  return steps.reduce((best, dstep) =>
    Math.abs(dstep - target) < Math.abs(best - target) ? dstep : best,
  );
}

function nearestWithDegree(steps, key, degree, target) {
  const matches = steps.filter((dstep) => degreeOf(dstep, key) === degree);
  return matches.length ? leastDistant(matches, target) : leastDistant(steps, target);
}

function nearestWithDegreeSet(steps, key, degrees, target) {
  const matches = steps.filter((dstep) => degrees.includes(degreeOf(dstep, key)));
  return matches.length ? leastDistant(matches, target) : leastDistant(steps, target);
}

/**
 * In minor keys a raised 7th next to a natural 6th makes an augmented 2nd,
 * which ABRSM tests do not write. Drop the raise unless it resolves upward
 * to the tonic.
 */
function fixAugmentedSeconds(bars, key) {
  if (!key.isMinor) return;
  const notes = bars.flatMap((bar) => bar.events.filter((event) => !event.rest));
  for (let i = 0; i < notes.length; i++) {
    const current = notes[i];
    if (!current.raiseSeventh) continue;
    const next = notes[i + 1];
    const previous = notes[i - 1];
    const resolvesUp = next && next.dstep === current.dstep + 1;
    const touchesSixth = (previous && degreeOf(previous.dstep, key) === 5)
      || (next && degreeOf(next.dstep, key) === 5);
    if (touchesSixth && !resolvesUp) {
      current.raiseSeventh = false;
      current.pitch = pitchAt(current.dstep, key, { raiseSeventh: false });
    }
  }
}

/**
 * Turn single notes into chords by stacking diatonic thirds below.
 * Used for the left hand from Grade 3 upward.
 */
export function stackChordTones({ bars, key, progression, maxNotes, rng, window, density = 0.4 }) {
  bars.forEach((bar, barIndex) => {
    const tones = chordDegrees(progression[barIndex] ?? 'I');
    bar.events.forEach((event) => {
      if (event.rest || !event.dstep) return;
      if (maxNotes < 2 || !rng.chance(density)) return;
      if (!tones.includes(degreeOf(event.dstep, key))) return;

      const extras = [];
      const below = event.dstep - 2;
      // The added note has to stay inside the hand's range too.
      if (below >= window.low && tones.includes(degreeOf(below, key))) extras.push(below);
      if (extras.length) {
        event.chord = extras
          .slice(0, maxNotes - 1)
          .map((dstep) => pitchAt(dstep, key, { raiseSeventh: false }));
      }
    });
  });
  return bars;
}
