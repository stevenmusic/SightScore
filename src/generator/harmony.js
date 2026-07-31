/**
 * Harmonic skeleton.
 *
 * Pitches are chosen against a chord progression rather than freely from the
 * scale. This is the single biggest factor in whether a generated test sounds
 * like music or like a random note-string.
 */

const MIDDLE_POOL = ['IV', 'ii', 'vi', 'I', 'V', 'iii'];
const MIDDLE_POOL_SIMPLE = ['IV', 'V', 'I', 'vi'];

/**
 * One chord per bar (occasionally two — see `twoChordBarChance`): opens on
 * I, closes with a V–I cadence.
 * @param {ReturnType<import('./random.js').createRandom>} rng
 * @param {number} barCount
 * @param {{simple?: boolean, twoChordBarChance?: number}} [options]
 * @returns {(string|[string, string])[]} one roman numeral per bar, or a
 *   `[first, second]` pair for a bar whose harmony changes halfway through
 */
export function buildProgression(rng, barCount, options = {}) {
  const pool = options.simple ? MIDDLE_POOL_SIMPLE : MIDDLE_POOL;
  const twoChordBarChance = options.twoChordBarChance ?? 0;
  if (barCount <= 1) return ['I'];
  if (barCount === 2) return ['I', 'I'];

  const progression = new Array(barCount);
  progression[0] = 'I';
  progression[barCount - 1] = 'I';
  progression[barCount - 2] = 'V';

  // A middle bar occasionally splits into two chords, a beat-for-beat
  // harmonic rhythm real intermediate/advanced tests use — never the
  // opening or the closing cadence, which anchor the phrase.
  let previous = 'I';
  for (let bar = 1; bar < barCount - 2; bar++) {
    const first = rng.pick(pool.filter((chord) => chord !== previous));
    if (twoChordBarChance > 0 && rng.chance(twoChordBarChance)) {
      const second = rng.pick(pool.filter((chord) => chord !== first));
      progression[bar] = [first, second];
      previous = second;
    } else {
      progression[bar] = first;
      previous = first;
    }
  }

  // Avoid a static V–V into the cadence.
  if (barCount >= 4 && lastChord(progression[barCount - 3]) === 'V') {
    progression[barCount - 3] = rng.pick(['IV', 'ii', 'I', 'vi']);
  }
  return progression;
}

/** The chord sounding at the very start of a (possibly split) bar entry. */
export function firstChord(entry) {
  return Array.isArray(entry) ? entry[0] : entry;
}

/** The chord sounding at the very end of a (possibly split) bar entry. */
export function lastChord(entry) {
  return Array.isArray(entry) ? entry[entry.length - 1] : entry;
}

/** The chord in effect at `offset` divisions into a bar of `barDuration`. */
export function chordAt(entry, offset, barDuration) {
  if (!Array.isArray(entry)) return entry;
  return offset < barDuration / 2 ? entry[0] : entry[1];
}
