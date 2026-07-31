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
import { chordAt } from './harmony.js';

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
 * @param {(string|[string, string])[]} params.progression roman numeral per
 *        bar, or a `[first, second]` pair for a bar that splits in half
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
    arch = 0,
  } = options;

  const centre = (window.low + window.high) / 2;
  const allSteps = [];
  for (let dstep = window.low; dstep <= window.high; dstep++) allSteps.push(dstep);
  const aim = archTargets(window, centre, arch);

  // The cadence note is the last one that actually sounds, which is not
  // necessarily in the last bar — at Grade 1 a hand may rest through the
  // second half of the test.
  const soundingEvents = bars.flatMap((bar) => bar.events.filter((event) => !event.rest));
  const finalEvent = soundingEvents[soundingEvents.length - 1] ?? null;
  const penultimateEvent = soundingEvents.length >= 2
    ? soundingEvents[soundingEvents.length - 2]
    : null;
  const noteTotal = soundingEvents.length;
  // Where the closing tonic will land, worked out before the walk starts so
  // the note before it can aim to be a step away from it (see below).
  const cadenceTonic = endOnTonic ? nearestWithDegree(allSteps, key, 0, aim(1)) : null;
  let noteIndex = 0;

  let previous = null;
  let previousLeap = 0;
  let repeatRun = 0;
  // Direction and length of the current run of consecutive same-direction
  // steps — see pickWeighted for why this matters.
  let runDirection = 0;
  let runLength = 0;

  bars.forEach((bar, barIndex) => {
    const entry = progression[barIndex] ?? 'I';
    let offset = 0;
    /*
     * A bar restating an earlier bar's motif (see generate.js's `buildStaff`)
     * carries `bar.motif = {sourceBarIndex, transpose}`, where `transpose` is
     * the distance between the two bars' chord roots and therefore maps the
     * source bar's chord tones exactly onto this bar's. Every note is placed
     * from that transposition directly — `source[j] + transpose + octave` —
     * and not relative to whatever this bar's first note turned out to be.
     *
     * Re-basing on the realised first note is the obvious alternative and it
     * is a trap: when the first note is rejected for some reason of its own
     * (unreachable by leap, clashing with the left hand), every later note
     * inherits that arbitrary displacement, lands off the chord, gets
     * rejected by the chord-tone filters in turn, and is finally relocated by
     * `repairNonChordTones`. One unlucky note took the whole bar with it —
     * measured as roughly halving the number of restatements that survived.
     * Placing each note absolutely means a rejected note costs only itself.
     */
    const motif = bar.motif ?? null;
    const motifSource = motif
      ? bars[motif.sourceBarIndex]?.events.filter((e) => !e.rest && e.dstep !== undefined) ?? null
      : null;
    let motifIndex = 0;
    let motifOctave = null;

    bar.events.forEach((event) => {
      if (event.rest) {
        offset += event.dur;
        return;
      }

      // A bar that splits into two chords (see harmony.js's `chordAt`)
      // hands each half its own tones — a note picks its governing chord
      // by when it starts, same as any other harmonic-rhythm change.
      const tones = chordDegrees(chordAt(entry, offset, barDuration));
      const absolute = barIndex * barDuration + offset;
      const sounding = soundingAt(against, absolute, event.dur);
      const onBeat = offset % bar.beatDuration === 0;
      const isDownbeat = offset === 0;
      const isFinalNote = event === finalEvent;
      const position = noteTotal > 1 ? noteIndex / (noteTotal - 1) : 0;
      const target = aim(position);

      /*
       * The pitch this note would ideally take, offered to `pickWeighted` and
       * used only if it survives every hard filter there. Two things ask for
       * one: a motif restatement (shape), and the approach to the closing
       * tonic (cadence). A cadence is approached by step in real writing —
       * the leading note rising to the tonic, or the supertonic falling to it
       * — and both of those degrees belong to the V chord that is virtually
       * always sounding underneath, so the preference usually survives.
       */
      let preferred = null;
      if (event === penultimateEvent && cadenceTonic !== null) {
        preferred = cadenceApproach(cadenceTonic, previous, window);
      } else if (motifSource && !isFinalNote) {
        const source = motifSource[motifIndex];
        if (source) {
          // The octave is settled once for the whole bar, by how well the
          // entire shape fits the window rather than by where its first note
          // would like to sit. Placing it by the first note alone reliably
          // wrecked restatements that reach upward: starting the motif an
          // octave high because the previous note happened to be high pushed
          // everything after it off the top of the window, where it was
          // rejected note by note and replaced by the lottery — the left hand
          // would restate a bar perfectly while the right hand, whose window
          // is the binding one, kept only its first note.
          if (motifOctave === null) {
            motifOctave = fitMotifOctave(motifSource, motif.transpose, window, previous ?? target);
          }
          preferred = source.dstep + motif.transpose + motifOctave;
        }
      }

      let chosen;
      if (isFinalNote && endOnTonic) {
        chosen = nearestWithDegree(allSteps, key, 0, previous ?? target);
      } else if (previous === null) {
        if (chordToneOnly) {
          // The harmonic foundation (bass) opens in root position: a real
          // test's opening low note is the chord's root, not whichever
          // chord member happens to sit closest to the middle of the range.
          // `tones[0]` is always the root — chordDegrees() builds a triad
          // as [root, root+2, root+4].
          chosen = nearestWithDegree(allSteps, key, tones[0], target);
        } else {
          const openings = allSteps.filter((dstep) => tones.includes(degreeOf(dstep, key)));
          chosen = leastDistant(openings.length ? openings : allSteps, target);
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
          centre: target,
          stepwiseBias,
          maxLeapSemitones,
          chordToneOnly,
          sounding,
          preferred,
        });
      }

      if (motifSource) motifIndex += 1;
      noteIndex += 1;

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
      // Written as harmonic minor throughout: the leading note is raised
      // wherever it occurs, not just under a dominant-function chord.
      // `pitchAt` only actually applies this for a minor key, so the flag
      // is harmless (a no-op) in major keys.
      event.raiseSeventh = degreeOf(chosen, key) === 6;
      event.chordDegrees = tones;
      event.pitch = pitchAt(chosen, key, { raiseSeventh: event.raiseSeventh });
      offset += event.dur;
    });
  });

  repairNonChordTones(bars, key, window);
  fixAugmentedSeconds(bars, key);
  // Both repairs move pitches after the vertical check, so verify once more.
  resolveClashes({ bars, key, window, against, barDuration, finalEvent: endOnTonic ? finalEvent : null });
  // The cadence is settled last, and by construction rather than by
  // preference: every pass above can move the note before the tonic, so a
  // stepwise approach merely *asked* for during the walk survived only about
  // a fifth of the time. A melody arriving at its final tonic by leap is the
  // single most audible way an ending sounds arbitrary.
  if (endOnTonic && !chordToneOnly) {
    shapeCadence({ bars, key, window, against, barDuration, soundingEvents });
  }
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

/** The pitch a dstep will actually sound at, per the always-raised harmonic-minor policy. */
function soundingMidi(dstep, key) {
  return pitchAt(dstep, key, { raiseSeventh: degreeOf(dstep, key) === 6 }).midi;
}

/**
 * The moving pitch the line is drawn toward, as a function of how far
 * through the piece a note is (0 at the first note, 1 at the last).
 *
 * A fixed attraction to the middle of the tessitura — what this used to be —
 * gives every note the same target, so the line has no reason to go anywhere:
 * it mills about the centre and touches its highest note two or three times
 * at arbitrary places. Real melodies, and ABRSM's specimens in particular,
 * are shaped: they start in the lower-middle of their range, rise to a single
 * climax roughly two thirds through (inside the consequent phrase), then fall
 * away to the cadence. Interpolating the target along that arch is what makes
 * the line read as going somewhere rather than as bars stitched end to end.
 *
 * `amount` scales the whole effect back toward the flat centre, so a bass
 * line — which should stay put underneath the tune, not arch — can pass 0
 * and keep exactly the old behaviour.
 */
function archTargets(window, centre, amount) {
  if (!amount) return () => centre;
  const span = window.high - window.low;
  const PEAK_AT = 0.68;
  const START = 0.34;
  const PEAK = 0.86;
  const END = 0.30;

  return (position) => {
    const height = position <= PEAK_AT
      ? START + (PEAK - START) * (position / PEAK_AT)
      : PEAK + (END - PEAK) * ((position - PEAK_AT) / (1 - PEAK_AT));
    const arched = window.low + span * height;
    return centre + (arched - centre) * amount;
  };
}

/**
 * Put a real cadence on the end of the melodic line: the last note on the
 * tonic, the one before it a step away from that tonic.
 *
 * Almost every closing gesture in tonal music approaches the final tonic by
 * step — the leading note rising to it, or the supertonic falling to it — and
 * in a minor key that rising leading note is exactly what the harmonic-minor
 * policy already raises. Both of those degrees also belong to the dominant
 * chord that the progression puts under the penultimate bar, so the approach
 * agrees with the harmony rather than fighting it.
 *
 * The bass is deliberately excluded (`chordToneOnly`): a bass line is
 * *supposed* to leap V–I at the cadence, and stepping it down onto the tonic
 * would flatten the one leap that belongs there.
 */
function shapeCadence({ bars, key, window, against, barDuration, soundingEvents }) {
  if (soundingEvents.length < 2) return;
  const final = soundingEvents[soundingEvents.length - 1];
  const penultimate = soundingEvents[soundingEvents.length - 2];
  if (!final?.pitch || !penultimate?.pitch) return;

  const sounding = soundingAtEvent(bars, against, barDuration, penultimate);
  const before = soundingEvents[soundingEvents.length - 3] ?? null;
  const tonic = final.dstep;
  // The leading note first: 7–1 is the stronger of the two approaches.
  for (const candidate of [tonic - 1, tonic + 1]) {
    if (candidate < window.low || candidate > window.high) continue;
    let raiseSeventh = degreeOf(candidate, key) === 6;
    /*
     * This runs after `fixAugmentedSeconds`, so it has to keep that rule
     * itself: raising the 7th when the note before it is the natural 6th a
     * step below makes a melodic augmented 2nd, which these tests never
     * write. Falling back to the natural 7th still reaches the tonic by step,
     * which is what this function is actually for.
     */
    if (raiseSeventh && before
      && degreeOf(before.dstep, key) === 5
      && Math.abs(candidate - before.dstep) === 1) {
      raiseSeventh = false;
    }
    const pitch = pitchAt(candidate, key, { raiseSeventh });
    if (clashesWith(pitch.midi, sounding)) continue;
    penultimate.dstep = candidate;
    penultimate.raiseSeventh = raiseSeventh;
    penultimate.pitch = pitch;
    return;
  }
}

/** What the other hand is sounding while `event` sounds. */
function soundingAtEvent(bars, against, barDuration, event) {
  if (!against?.length) return [];
  for (let barIndex = 0; barIndex < bars.length; barIndex++) {
    let offset = 0;
    for (const candidate of bars[barIndex].events) {
      if (candidate === event) {
        return soundingAt(against, barIndex * barDuration + offset, candidate.dur);
      }
      offset += candidate.dur;
    }
  }
  return [];
}

/**
 * The octave displacement that lets the most of a transposed motif land
 * inside the hand's window, breaking ties toward starting near `near` (the
 * note the line is coming from, so the restatement is reachable).
 */
function fitMotifOctave(source, transpose, window, near) {
  let best = 0;
  let bestScore = -Infinity;
  for (let shift = -14; shift <= 14; shift += 7) {
    let inside = 0;
    for (const note of source) {
      const dstep = note.dstep + transpose + shift;
      if (dstep >= window.low && dstep <= window.high) inside += 1;
    }
    // Fitting the shape dominates; proximity only settles ties between
    // octaves that fit equally well.
    const score = inside * 100 - Math.abs(source[0].dstep + transpose + shift - near);
    if (score > bestScore) {
      bestScore = score;
      best = shift;
    }
  }
  return best;
}

/**
 * The note to aim for immediately before the closing tonic: a step above or
 * below it, whichever is nearer to where the line already is, preferring the
 * leading note below on a tie (7–1 is the strongest of the two).
 */
function cadenceApproach(tonicDstep, previous, window) {
  const below = tonicDstep - 1;
  const above = tonicDstep + 1;
  const inRange = (dstep) => dstep >= window.low && dstep <= window.high;
  if (!inRange(below)) return inRange(above) ? above : null;
  if (!inRange(above)) return below;
  if (previous === null) return below;
  return Math.abs(above - previous) < Math.abs(below - previous) ? above : below;
}

function pickWeighted(ctx) {
  const {
    rng, key, allSteps, previous, previousLeap, repeatRun, runDirection, runLength, tones,
    onBeat, isDownbeat, centre, stepwiseBias, maxLeapSemitones, chordToneOnly, sounding,
    preferred = null,
  } = ctx;

  const previousMidi = soundingMidi(previous, key);
  const ceiling = sounding.length ? Math.max(...sounding) : null;
  // Was the note we're stepping from itself a passing/neighbour tone? If so,
  // continuing the same direction is how it resolves — see the weighting
  // comment below for why this matters.
  const previousWasChordTone = tones.includes(degreeOf(previous, key));

  const repeats = [];
  const steps = [];
  const leaps = [];
  let preferredCandidate = null;

  for (const dstep of allSteps) {
    const interval = dstep - previous;
    const distance = Math.abs(interval);
    // The pitch this candidate will actually sound at — harmonic minor
    // raises the leading note unconditionally (see assignPitches), so a
    // degree-7 candidate has to be clash-checked at its raised pitch here,
    // not its natural one. Screening against the natural form let this
    // function happily pick a degree-7 dstep that clashed once raised,
    // leaving a later repair pass (resolveClashes) to quietly un-raise it
    // back to natural — which defeated the harmonic-minor policy far more
    // than the rare, deliberate exceptions (an unavoidable clash, or
    // avoiding an augmented 2nd) ever should.
    const midi = soundingMidi(dstep, key);
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
    if (dstep === preferred && !clash) preferredCandidate = candidate;
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
    if (resolving.length) {
      /*
       * A motif restatement usually *is* the resolution: the source bar
       * resolved its own passing tones, and a diatonic transposition of that
       * bar resolves them the same way. When the two agree, following the
       * motif and resolving the dissonance are the same act — so check that
       * before overriding the motif with an arbitrary weighted resolution.
       * This was the single largest cause of restatements breaking up.
       */
      const preferredResolves = resolving.find((s) => s.dstep === preferred);
      if (preferredResolves) return preferredResolves.dstep;
      return rng.weighted(resolving).dstep;
    }
  }

  /*
   * A motif restatement or a cadential approach asked for this exact pitch,
   * and it came through every filter above — range, leap limit, chord tone
   * on the beat, and the vertical check against the other hand — so it is as
   * legal as anything the lottery below could return. Take it. Leaving it to
   * the lottery with a mere weight boost is not enough: a motif is only
   * audible as a restatement if it is heard more or less intact, and a shape
   * that survives in three notes out of five is not a restatement of
   * anything. This is checked *after* the passing-tone resolution above, so
   * motif-following never breaks the dissonance treatment that
   * `repairNonChordTones` would otherwise undo anyway.
   */
  if (preferredCandidate) return preferredCandidate.dstep;

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
    // Harmonic minor throughout — the leading note is raised by degree
    // alone, not carried over from whatever the note being replaced had.
    note.raiseSeventh = degreeOf(replacement, key) === 6;
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
 * Turn single notes into chords by stacking chord tones underneath.
 *
 * This used to consider exactly one candidate — the diatonic third below —
 * which quietly capped every chord at two notes no matter what the grade
 * allowed, so Grade 6-8's declared three- and four-note chords never appeared
 * and Grade 8's texture came out identical to Grade 3's. It now walks down a
 * full octave and takes the nearest chord tones it finds, which is also what
 * produces a real close voicing: from the root, the nearest members below are
 * the fifth and the third, not another third.
 *
 * `maxTotal` caps how many notes sound across *both* hands at once, and
 * `against` is what the other hand is already holding — the melody may not be
 * voiced down through the accompaniment, so a stack stops at the other hand's
 * top note rather than crossing it.
 */
export function stackChordTones({
  bars, key, progression, maxNotes, rng, window, density = 0.4, barDuration = 0,
  against = null, maxTotal = Infinity,
}) {
  bars.forEach((bar, barIndex) => {
    const entry = progression[barIndex] ?? 'I';
    let offset = 0;
    bar.events.forEach((event) => {
      const tones = chordDegrees(chordAt(entry, offset, barDuration));
      const sounding = against ? soundingAt(against, barIndex * barDuration + offset, event.dur) : [];
      offset += event.dur;
      if (event.rest || event.dstep === undefined) return;
      if (maxNotes < 2 || !rng.chance(density)) return;
      if (!tones.includes(degreeOf(event.dstep, key))) return;

      // Room left under the grade's limit on simultaneous notes.
      const room = Math.min(maxNotes, maxTotal - sounding.length);
      if (room < 2) return;
      const ceiling = sounding.length ? Math.max(...sounding) : null;
      /*
       * How thick *this* chord is. Taking the grade's maximum every time made
       * the upper grades read as a chorale rather than a sight-reading test —
       * six three-note chords in a seven-note bar — because the maximum is a
       * ceiling the syllabus permits occasionally, not a target. Most chords
       * are the thinnest the texture allows and the full stack stays an event.
       */
      let want = 2;
      while (want < room && rng.chance(0.35)) want += 1;

      const extras = [];
      for (let below = event.dstep - 1; below >= event.dstep - 7; below--) {
        if (extras.length >= want - 1) break;
        if (below < window.low) break;
        if (!tones.includes(degreeOf(below, key))) continue;
        // A stacked note can itself land on the leading note (a V or vii°
        // chord contains it) — harmonic minor raises it there same as anywhere.
        const pitch = pitchAt(below, key, { raiseSeventh: degreeOf(below, key) === 6 });
        const interval = event.pitch.midi - pitch.midi;
        if (interval <= 0 || interval > 12) continue;
        if (HARSH_INTERVALS.has(interval % 12)) continue;
        if (ceiling !== null && pitch.midi < ceiling) break;
        /*
         * Consonant with its own chord is not the same as consonant with what
         * the other hand is holding. In a bar whose harmony turns over halfway
         * (`twoChordBarChance`) the other hand may still be sounding the
         * previous chord, and in a minor key it may be sounding the leading
         * note raised where this chord wants it natural — either way a stacked
         * note can land a semitone from it.
         */
        if (clashesWith(pitch.midi, sounding)) continue;
        extras.push(pitch);
      }
      if (extras.length) event.chord = extras;
    });
  });
  return bars;
}

/**
 * Both hands must agree about the leading note. Repairing augmented seconds
 * per hand can leave one hand raising the 7th while the other does not, and
 * the two sounding together is a false relation — the harshest thing the
 * generator can produce.
 *
 * A single pairwise pass isn't enough once three or more degree-7 notes
 * overlap in time across the two hands (denser textures — faster harmonic
 * rhythm, syncopation — make this routine): fixing one disagreeing pair by
 * un-raising both notes can silently break a THIRD note's previously-fine
 * agreement with one of them. Since every fix only ever moves a note from
 * raised to natural (never back), repeating the sweep until a pass finds
 * nothing left to fix always terminates and leaves every mutually-
 * overlapping cluster fully reconciled, not just the first pair checked.
 */
export function harmoniseLeadingNotes(staves, key, barDuration) {
  if (!key.isMinor) return;
  const timelines = staves.map((bars) => leadingNoteVoices(bars, key, barDuration));

  let changed = true;
  while (changed) {
    changed = false;
    for (const a of timelines[0]) {
      for (const b of timelines[1]) {
        if (a.start >= b.end || a.end <= b.start) continue;
        if (a.isRaised() === b.isRaised()) continue;
        // Follow the natural form: it is always available, the raised one is not.
        a.lower();
        b.lower();
        changed = true;
      }
    }
  }
}

/**
 * Every sounding 7th-degree voice in a staff, main notes and stacked chord
 * notes alike, as something that can report whether it is raised and be put
 * back to natural.
 *
 * Chord notes have to be included. They are raised by the same harmonic-minor
 * rule as any other note, so once both hands can carry chords a stacked
 * leading note in one hand will eventually sound against the natural 7th in
 * the other — a false relation, and the harshest thing the generator can
 * produce. Reconciling only the main notes left exactly that hole.
 */
function leadingNoteVoices(bars, key, barDuration) {
  const voices = [];
  bars.forEach((bar, barIndex) => {
    let offset = 0;
    for (const event of bar.events) {
      if (event.rest || !event.pitch) {
        offset += event.dur;
        continue;
      }
      const start = barIndex * barDuration + offset;
      const end = start + event.dur;

      if (degreeOf(event.dstep, key) === 6) {
        voices.push({
          start,
          end,
          isRaised: () => Boolean(event.raiseSeventh),
          lower: () => {
            event.raiseSeventh = false;
            event.pitch = pitchAt(event.dstep, key, { raiseSeventh: false });
          },
        });
      }

      (event.chord ?? []).forEach((pitch, index) => {
        if (degreeOf(pitch.dstep, key) !== 6) return;
        const natural = pitchAt(pitch.dstep, key, { raiseSeventh: false });
        voices.push({
          start,
          end,
          isRaised: () => event.chord[index].alter > natural.alter,
          lower: () => { event.chord[index] = natural; },
        });
      });
      offset += event.dur;
    }
  });
  return voices;
}
