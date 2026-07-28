/**
 * Pitch spelling in diatonic-step space.
 *
 * Notes are generated as *diatonic steps* (`dstep`), not MIDI numbers, so that
 * spelling is correct by construction: in D minor the raised 7th comes out as
 * C#, not Db, and a step is always ±1 regardless of whether the interval is a
 * tone or a semitone.
 *
 *   dstep = 7 * octave + letterIndex        (C4 -> 7*4 + 0 = 28, MIDI 60)
 */

export const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_SEMITONE = [0, 2, 4, 5, 7, 9, 11];

// Order in which key-signature accidentals are applied, as letter indices.
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; //  B E A D G C F

/** Per-letter alteration implied by a key signature. */
export function keyAlterations(fifths) {
  const alters = [0, 0, 0, 0, 0, 0, 0];
  if (fifths > 0) {
    for (let i = 0; i < fifths; i++) alters[SHARP_ORDER[i]] = 1;
  } else {
    for (let i = 0; i < -fifths; i++) alters[FLAT_ORDER[i]] = -1;
  }
  return alters;
}

export function letterIndex(tonic) {
  return LETTERS.indexOf(tonic[0].toUpperCase());
}

/**
 * A key as the generator uses it.
 * @param {{tonic: string, mode: 'major'|'minor', fifths: number}} spec
 */
export function createKey(spec) {
  const alters = keyAlterations(spec.fifths);
  const tonicLetter = letterIndex(spec.tonic);
  // 0-indexed 7th degree: the leading note that harmonic minor raises.
  const seventhLetter = (tonicLetter + 6) % 7;
  return {
    ...spec,
    alters,
    tonicLetter,
    seventhLetter,
    isMinor: spec.mode === 'minor',
  };
}

/**
 * Resolve a diatonic step to a concrete pitch.
 * @param {number} dstep
 * @param {ReturnType<typeof createKey>} key
 * @param {{raiseSeventh?: boolean, chromaticAlter?: number}} [options]
 */
export function pitchAt(dstep, key, options = {}) {
  const octave = Math.floor(dstep / 7);
  const letter = ((dstep % 7) + 7) % 7;
  let alter = key.alters[letter];

  if (key.isMinor && options.raiseSeventh && letter === key.seventhLetter) {
    alter += 1;
  }
  if (options.chromaticAlter) {
    alter += options.chromaticAlter;
  }

  return {
    step: LETTERS[letter],
    alter,
    octave,
    dstep,
    midi: 12 * (octave + 1) + LETTER_SEMITONE[letter] + alter,
  };
}

/**
 * Lowest dstep whose pitch is >= minMidi, and highest that is <= maxMidi.
 *
 * In a minor key the leading note may be raised a semitone later on, so the
 * bounds are checked against the *raised* form too — otherwise a G at the top
 * of the range becomes an out-of-range G#.
 */
export function dstepRange(key, minMidi, maxMidi) {
  let low = null;
  let high = null;
  for (let dstep = 0; dstep < 80; dstep++) {
    const natural = pitchAt(dstep, key).midi;
    const raised = pitchAt(dstep, key, { raiseSeventh: true }).midi;
    const lowest = Math.min(natural, raised);
    const highest = Math.max(natural, raised);
    if (lowest >= minMidi && low === null) low = dstep;
    if (highest <= maxMidi) high = dstep;
  }
  if (low === null || high === null || low > high) {
    throw new Error(`no diatonic pitches between MIDI ${minMidi} and ${maxMidi}`);
  }
  return { low, high };
}

/** Diatonic degree (0 = tonic) of a step in this key. */
export function degreeOf(dstep, key) {
  return (((dstep % 7) - key.tonicLetter) % 7 + 7) % 7;
}

/**
 * Triad degrees for a roman-numeral-ish chord symbol.
 * Returns the 0-indexed scale degrees the chord is built from.
 */
export function chordDegrees(roman) {
  const roots = { I: 0, ii: 1, iii: 2, IV: 3, V: 4, vi: 5, viio: 6 };
  const root = roots[roman];
  if (root === undefined) throw new Error(`unknown chord ${roman}`);
  return [root, (root + 2) % 7, (root + 4) % 7];
}

/** Semitone distance between two diatonic steps in a key. */
export function semitonesBetween(a, b, key) {
  return Math.abs(pitchAt(a, key).midi - pitchAt(b, key).midi);
}
