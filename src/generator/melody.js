/**
 * Pitch selection.
 *
 * Two things keep the result tonal rather than merely legal:
 *
 *  1. The hands are not written independently. The left hand goes first and
 *     becomes a sounding-bass timeline; every right-hand candidate is then
 *     checked against whatever is actually sounding underneath it, so seconds,
 *     sevenths and tritones cannot simply fall out of two separate walks.
 *  2. A non-chord note has to behave like one — approached by step and left by
 *     step. Anything leaping into or out of a dissonance is repaired to the
 *     nearest chord tone afterwards.
 */

import { chordDegrees, degreeOf, pitchAt } from './theory.js';
import { raisesSeventh } from './harmony.js';

/**
 * Interval classes that read as dissonant against the bass. A second, tritone
 * or minor seventh can pass off the beat; a semitone or major seventh between
 * the hands never can, at any of these grades.
 */
const HARSH_INTERVALS = new Set([1, 2, 6, 10, 11]);
const NEVER_INTERVALS = new Set([1, 11]);

/**
 * @param {object} params
 * @param {ReturnType<import('./random.js').createRandom>} params.rng
 * @param {ReturnType<import('./theory.js').createKey>} params.key
 * @param {Array<{events: object[], beatDuration: number}>} params.bars
 * @param {string[]} params.progression roman numeral per bar
 * @param {{low: number, high: number}} params.window allowed dstep window
 * @param {object} params.options
 * @param {Array<{start: number, end: number, midis: number[]}>} [params.against]
 *        sounding notes of the other hand, in absolute divisions
 */
export function assignPitches({ rng, key, bars, progression, window, options, against }) {
  const {
    stepwiseBias = 0.7,
    maxLeapSemitones = 7,
    chordToneOnly = false,
    endOnTonic = true,
    barDuration = 0,
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
  // Direction and length of the current run of consecutive same-direction
  // steps — see pickWeighted for why this matters.
  let runDirection = 0;
  let runLength = 0;

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

      const absolute = barIndex * barDuration + offset;
      const sounding = soundingAt(against, absolute, event.dur);
      const onBeat = offset % bar.beatDuration === 0;
      const isDownbeat = offset === 0;
      const isFinalNote = event === finalEvent;

      let chosen;
      if (isFinalNote && endOnTonic) {
        chosen = nearestWithDegree(allSteps, key, 0, previous ?? centre);
      } else if (previous === null) {
        if (chordToneOnly) {
          // The harmonic foundation (bass) opens in root position: a real
          // test's opening low note is the chord's root, not whichever
          // chord member happens to sit closest to the middle of the range.
          // `tones[0]` is always the root — chordDegrees() builds a triad
          // as [root, root+2, root+4].
          chosen = nearestWithDegree(allSteps, key, tones[0], centre);
        } else {
          const openings = allSteps.filter((dstep) => tones.includes(degreeOf(dstep, key)));
          chosen = leastDistant(openings.length ? openings : allSteps, centre);
        }
      } else {
        chosen = pickWeighted({
          rng,
          key,
          allSteps,
          previous,
          previousLeap,
          repeatRun,
          runDirection,
          runLength,
          tones,
          onBeat,
          isDownbeat,
          centre,
          stepwiseBias,
          maxLeapSemitones,
          chordToneOnly,
          sounding,
        });
      }

      const interval = previous === null ? 0 : chosen - previous;
      repeatRun = interval === 0 ? repeatRun + 1 : 0;
      const stepDirection = Math.abs(interval) === 1 ? Math.sign(interval) : 0;
      if (stepDirection !== 0 && stepDirection === runDirection) {
        runLength += 1;
      } else {
        runDirection = stepDirection;
        runLength = stepDirection !== 0 ? 1 : 0;
      }
      previousLeap = interval;
      previous = chosen;

      event.dstep = chosen;
      event.raiseSeventh = raiseSeventh && degreeOf(chosen, key) === 6;
      event.chordDegrees = tones;
      event.pitch = pitchAt(chosen, key, { raiseSeventh: event.raiseSeventh });
      offset += event.dur;
    });
  });

  repairNonChordTones(bars, key, window);
  fixAugmentedSeconds(bars, key);
  // Both repairs move pitches after the vertical check, so verify once more.
  resolveClashes({ bars, key, window, against, barDuration, finalEvent: endOnTonic ? finalEvent : null });
  // resolveClashes can leave a repeated note disagreeing with itself (see
  // harmoniseRepeatedLeadingNotes) — check that last, since it depends on
  // whatever resolveClashes just decided.
  harmoniseRepeatedLeadingNotes(bars, key);
  return bars;
}

/** Absolute-time index of one hand's sounding notes, for vertical checks. */
export function soundingTimeline(bars, barDuration) {
  const timeline = [];
  bars.forEach((bar, barIndex) => {
    let offset = 0;
    for (const event of bar.events) {
      if (!event.rest && event.pitch) {
        const start = barIndex * barDuration + offset;
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

function soundingAt(timeline, start, duration) {
  if (!timeline?.length) return [];
  const end = start + duration;
  const midis = [];
  for (const entry of timeline) {
    if (entry.start < end && entry.end > start) midis.push(...entry.midis);
  }
  return midis;
}

function pickWeighted(ctx) {
  const {
    rng, key, allSteps, previous, previousLeap, repeatRun, runDirection, runLength, tones,
    onBeat, isDownbeat, centre, stepwiseBias, maxLeapSemitones, chordToneOnly, sounding,
  } = ctx;

  const previousMidi = pitchAt(previous, key).midi;
  const ceiling = sounding.length ? Math.max(...sounding) : null;
  // Was the note we're stepping from itself a passing/neighbour tone? If so,
  // continuing the same direction is how it resolves — see the weighting
  // comment below for why this matters.
  const previousWasChordTone = tones.includes(degreeOf(previous, key));

  const repeats = [];
  const steps = [];
  const leaps = [];

  for (const dstep of allSteps) {
    const interval = dstep - previous;
    const distance = Math.abs(interval);
    const midi = pitchAt(dstep, key).midi;
    const semitones = Math.abs(midi - previousMidi);
    if (semitones > maxLeapSemitones) continue;

    const isChordTone = tones.includes(degreeOf(dstep, key));
    if (chordToneOnly && !isChordTone) continue;
    // A non-chord note on a strong beat is only allowed as a passing step.
    if (onBeat && !isChordTone && distance !== 1) continue;
    if (isDownbeat && !isChordTone) continue;
    if (distance === 0 && repeatRun >= 1) continue;

    // Vertical check against whatever the other hand is holding.
    let clash = false;
    let forbidden = false;
    for (const other of sounding) {
      const vertical = Math.abs(midi - other) % 12;
      if (NEVER_INTERVALS.has(vertical)) { forbidden = true; break; }
      if (HARSH_INTERVALS.has(vertical)) clash = true;
    }
    if (forbidden) continue;
    // A milder dissonance is only tolerable off the beat, as a step.
    if (clash && (onBeat || distance !== 1)) continue;
    // Keep the hands out of each other's way: the melody stays above
    // everything the left hand is holding, not just its lowest note.
    if (ceiling !== null && midi < ceiling) continue;

    /*
     * On the beat, prefer a chord tone — that's correct harmony. Off the
     * beat is where real melodic writing puts its passing and neighbour
     * tones, so give those a slight edge there instead.
     */
    let weight = isChordTone ? (onBeat ? 1.6 : 0.85) : 1;
    /*
     * A passing/neighbour tone has to actually resolve, or the later repair
     * pass (repairNonChordTones) discards it and replaces it with the
     * nearest chord tone — measured at 23-44% of all off-beat passing tones
     * getting thrown away this way, because the note after one was picked
     * with no memory of it needing to step onward. Continuing the same
     * direction by another step is exactly how a passing tone resolves (it
     * lands on the chord tone the passing tone was heading toward), so give
     * that specific continuation a strong boost rather than leaving it to
     * ordinary stepwise-motion weighting to stumble onto by chance.
     */
    if (!previousWasChordTone && distance === 1 && Math.sign(interval) === Math.sign(previousLeap)) {
      weight *= 3;
    }
    /*
     * A real scale passage keeps going in the same direction for several
     * notes, not just one — measured at only 4-6% of stepwise motion
     * forming a run of 4+ consecutive same-direction steps, against
     * real specimens where a scale run spanning most of a beat or bar is a
     * routine figure. Scoring every step independently on a roughly 50/50
     * up-or-down basis (once a direction isn't forced) is why: nothing
     * carried a run's momentum forward from one note to the next. This
     * boosts continuing the run, growing with how long it has already run
     * and capped so it tapers off rather than producing an unbroken
     * octave-plus scale every time.
     */
    if (distance === 1 && runDirection !== 0 && Math.sign(interval) === runDirection) {
      weight *= 1 + Math.min(runLength, 4) * 0.6;
    }
    if (clash) weight *= 0.3;
    if (Math.abs(previousLeap) >= 3) {
      weight *= Math.sign(interval) === -Math.sign(previousLeap) ? 2.5 : 0.4;
    }
    weight *= 1 / (1 + Math.abs(dstep - centre) * 0.12);
    // Within the leap category, a smaller leap still outweighs a bigger one.
    if (distance > 1) weight /= distance - 1;

    const candidate = { dstep, weight, clash };
    if (distance === 0) repeats.push(candidate);
    else if (distance === 1) steps.push(candidate);
    else leaps.push(candidate);
  }

  if (!steps.length && !leaps.length && !repeats.length) {
    return nearestWithDegreeSet(allSteps, key, tones, previous);
  }

  /*
   * A passing/neighbour tone must resolve by step in the direction it was
   * approached from — that is what makes it a passing tone rather than a
   * wrong note. Leaving that to the category lottery below meant the
   * (1 - stepwiseBias) chance of a leap could fire right when the previous
   * note needed resolving, and repairNonChordTones then discards that
   * previous note and relocates it to the nearest chord tone anyway,
   * quietly turning an intended stepwise pair into two leaps. Forcing the
   * resolution here, before the lottery, is what actually stops that.
   *
   * There is exactly one step candidate in the resolving direction (never
   * two), so if it happens to clash with the other hand there is no
   * alternative resolution to fall back on — better to let the ordinary
   * (clash-weighted) lottery below have this one note than to force a
   * clash unconditionally every time.
   */
  if (!previousWasChordTone && previousLeap !== 0) {
    const resolving = steps.filter((s) => Math.sign(s.dstep - previous) === Math.sign(previousLeap) && !s.clash);
    if (resolving.length) return rng.weighted(resolving).dstep;
  }

  /*
   * Decide step vs. leap vs. repeat as a category first, weighted by
   * stepwiseBias, and only then pick a candidate within it. There are
   * always exactly two possible step candidates (previous ± 1) but often
   * a dozen+ legal leap candidates — weighing every candidate individually
   * on the same scale let the leap candidates' combined weight dwarf the
   * steps' even at a high stepwiseBias, since summing a dozen modest
   * weights beats two: measured at 70-80% leaps by Grade 5+ versus a
   * configured stepwiseBias of 62-65%. Deciding the category first is what
   * actually makes stepwiseBias mean "this fraction of moves are steps."
   */
  // A run in progress should also make "keep stepping" itself more likely,
  // not just which direction to step in once that category is chosen —
  // otherwise a run this same weighting just made attractive within the
  // step category could still get cut short by an unrelated leap roll.
  const runBoost = runDirection !== 0 ? 1 + Math.min(runLength, 4) * 0.5 : 1;
  const categories = [];
  if (steps.length) categories.push({ items: steps, weight: 10 * stepwiseBias * runBoost });
  if (leaps.length) categories.push({ items: leaps, weight: 10 * (1 - stepwiseBias) });
  if (repeats.length) categories.push({ items: repeats, weight: 1 });
  return rng.weighted(rng.weighted(categories).items).dstep;
}

/**
 * Final vertical sweep. The non-chord-tone and augmented-second repairs both
 * move notes after candidates were scored, so a semitone against the other
 * hand can reappear. Anything still clashing is moved to the nearest pitch
 * that does not.
 */
function resolveClashes({ bars, key, window, against, barDuration, finalEvent }) {
  if (!against?.length) return;

  bars.forEach((bar, barIndex) => {
    let offset = 0;
    for (const event of bar.events) {
      if (event.rest) { offset += event.dur; continue; }

      const absolute = barIndex * barDuration + offset;
      const sounding = soundingAt(against, absolute, event.dur);
      offset += event.dur;
      // The melody must clear the other hand's top note as well as avoid
      // semitone clashes; both repairs above can undo either.
      const ceiling = sounding.length ? Math.max(...sounding) : null;
      const wrong = (midi) => clashesWith(midi, sounding)
        || (ceiling !== null && midi < ceiling);
      if (!wrong(event.pitch.midi)) continue;

      // The cadence note stays on the tonic whatever else has to move.
      const tones = event === finalEvent ? [0] : (event.chordDegrees ?? []);
      let replacement = null;
      let bestDistance = Infinity;
      for (let dstep = window.low; dstep <= window.high; dstep++) {
        if (tones.length && !tones.includes(degreeOf(dstep, key))) continue;
        const candidate = pitchAt(dstep, key, { raiseSeventh: false });
        if (wrong(candidate.midi)) continue;
        const distance = Math.abs(dstep - event.dstep);
        if (distance < bestDistance) { bestDistance = distance; replacement = { dstep, pitch: candidate }; }
      }
      if (replacement) {
        event.dstep = replacement.dstep;
        event.raiseSeventh = false;
        event.pitch = replacement.pitch;
      }
    }
  });
}

function clashesWith(midi, sounding) {
  return sounding.some((other) => NEVER_INTERVALS.has(Math.abs(midi - other) % 12));
}

/**
 * A repeated note — the melody landing on the same scale degree twice in a
 * row — has to agree with itself on whether the 7th is raised. Both
 * `resolveClashes` (dodging a clash against the other hand) and
 * `harmoniseLeadingNotes` (reconciling a clash between the hands) can flip
 * just one occurrence to its natural form, leaving the immediately
 * adjacent repeat still raised: an F# followed immediately by F-natural
 * (or the reverse), which no real melody writes. The natural form is
 * always safe — the same rule `harmoniseLeadingNotes` uses between the
 * hands — so force both occurrences to it rather than leaving one raised.
 * Called once per hand inside `assignPitches` (catching what
 * `resolveClashes` does) and once more after the cross-hand
 * `harmoniseLeadingNotes` pass (catching what that introduces).
 */
export function harmoniseRepeatedLeadingNotes(bars, key) {
  if (!key.isMinor) return;
  const notes = bars.flatMap((bar) => bar.events.filter((event) => !event.rest));
  for (let i = 1; i < notes.length; i++) {
    const previous = notes[i - 1];
    const current = notes[i];
    if (current.dstep !== previous.dstep) continue;
    if (current.raiseSeventh === previous.raiseSeventh) continue;
    for (const note of [previous, current]) {
      note.raiseSeventh = false;
      note.pitch = pitchAt(note.dstep, key, { raiseSeventh: false });
    }
  }
}

/**
 * A passing note that leaps in or out is not a passing note, it is a wrong
 * note. Replace those with the nearest chord tone.
 */
function repairNonChordTones(bars, key, window) {
  const notes = bars.flatMap((bar) => bar.events.filter((event) => !event.rest));

  notes.forEach((note, index) => {
    if (!note.chordDegrees) return;
    if (note.chordDegrees.includes(degreeOf(note.dstep, key))) return;

    const previous = notes[index - 1];
    const next = notes[index + 1];
    const steppedInto = !previous || Math.abs(note.dstep - previous.dstep) === 1;
    const steppedOut = !next || Math.abs(next.dstep - note.dstep) === 1;
    if (steppedInto && steppedOut) return;

    const options = [];
    for (let dstep = window.low; dstep <= window.high; dstep++) {
      if (note.chordDegrees.includes(degreeOf(dstep, key))) options.push(dstep);
    }
    if (!options.length) return;

    const replacement = leastDistant(options, note.dstep);
    note.dstep = replacement;
    note.raiseSeventh = note.raiseSeventh && degreeOf(replacement, key) === 6;
    note.pitch = pitchAt(replacement, key, { raiseSeventh: note.raiseSeventh });
  });
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
    const approachedFromSixth = previous && degreeOf(previous.dstep, key) === 5
      && Math.abs(current.dstep - previous.dstep) === 1;
    const leavesToSixth = next && degreeOf(next.dstep, key) === 5
      && Math.abs(next.dstep - current.dstep) === 1;
    // Stepping to or from the natural 6th makes the augmented 2nd either way;
    // resolving upward afterwards does not undo the approach.
    if (approachedFromSixth || (leavesToSixth && !resolvesUp)) {
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

/**
 * Both hands must agree about the leading note. Repairing augmented seconds
 * per hand can leave one hand raising the 7th while the other does not, and
 * the two sounding together is a false relation — the harshest thing the
 * generator can produce.
 */
export function harmoniseLeadingNotes(staves, key, barDuration) {
  if (!key.isMinor) return;
  const timelines = staves.map((bars) => soundingTimelineWithEvents(bars, barDuration));

  for (const entry of timelines[0]) {
    for (const other of timelines[1]) {
      if (entry.start >= other.end || entry.end <= other.start) continue;
      const a = entry.event;
      const b = other.event;
      if (degreeOf(a.dstep, key) !== 6 || degreeOf(b.dstep, key) !== 6) continue;
      if (a.raiseSeventh === b.raiseSeventh) continue;
      // Follow the natural form: it is always available, the raised one is not.
      for (const note of [a, b]) {
        note.raiseSeventh = false;
        note.pitch = pitchAt(note.dstep, key, { raiseSeventh: false });
      }
    }
  }
}

function soundingTimelineWithEvents(bars, barDuration) {
  const timeline = [];
  bars.forEach((bar, barIndex) => {
    let offset = 0;
    for (const event of bar.events) {
      if (!event.rest && event.pitch) {
        const start = barIndex * barDuration + offset;
        timeline.push({ start, end: start + event.dur, event });
      }
      offset += event.dur;
    }
  });
  return timeline;
}
