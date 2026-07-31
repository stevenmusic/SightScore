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
 * What may follow a given chord. Only one restriction, but it is the one rule
 * of functional syntax that a free walk breaks audibly: the dominant does not
 * fall back to the subdominant. V-IV undoes the tension the dominant just
 * built and is heard as the progression losing its footing — every textbook
 * calls it a retrogression. Once a bar could split into two chords (Grade 5+)
 * a free pick produced it in 3-4% of chord changes.
 */
function mayFollow(pool, previous) {
  const allowed = previous === 'V' ? pool.filter((chord) => chord === 'I' || chord === 'vi') : pool;
  const usable = allowed.filter((chord) => chord !== previous);
  return usable.length ? usable : pool.filter((chord) => chord !== previous);
}

/**
 * One chord per bar (occasionally two — see `twoChordBarChance`): opens on
 * I, closes with a V–I cadence.
 *
 * The middle is not a free chord walk from end to end. Real sight-reading
 * tests are built as a **period**: an antecedent phrase that puts a comma
 * on the dominant (a half cadence), then a consequent that starts over and
 * finishes the sentence V–I. Without that comma every bar between the
 * opening and the cadence is harmonically interchangeable, and the test
 * reads as one undifferentiated span rather than as a question answered —
 * which is most of what makes a generated test feel assembled rather than
 * composed. `halfCadenceBar` marks the antecedent's last bar (V) and the
 * consequent then restarts on I, so the listener hears the phrase return.
 *
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

  // Only worth articulating once there are two real phrases to divide: at
  // 4 bars the "antecedent" would end on the bar the final cadence already
  // owns, and the anti-static guard below would immediately undo it.
  const half = halfCadenceBar(barCount);

  // A middle bar occasionally splits into two chords, a beat-for-beat
  // harmonic rhythm real intermediate/advanced tests use — never the
  // opening or the closing cadence, which anchor the phrase.
  let previous = 'I';
  for (let bar = 1; bar < barCount - 2; bar++) {
    if (bar === half) {
      progression[bar] = 'V';
      previous = 'V';
      continue;
    }
    // The consequent begins by restating home, the way the piece opened.
    if (half !== null && bar === half + 1) {
      progression[bar] = 'I';
      previous = 'I';
      continue;
    }
    const first = rng.pick(mayFollow(pool, previous));
    if (twoChordBarChance > 0 && rng.chance(twoChordBarChance)) {
      const second = rng.pick(mayFollow(pool, first));
      progression[bar] = [first, second];
      previous = second;
    } else {
      progression[bar] = first;
      previous = first;
    }
  }

  /*
   * The consequent opens the way the antecedent did. This is what makes a
   * period hear as one sentence said twice rather than as two unrelated
   * halves — and, just as importantly, it is what lets the *melody* restate
   * itself literally there: a motif copied onto a bar carrying the same chord
   * needs no transposition and no adjustment, so it survives intact instead
   * of being bent note by note to fit a different harmony.
   */
  if (half !== null) {
    for (let position = 1; position <= 2; position++) {
      const source = progression[position];
      const destination = half + 1 + position;
      if (destination >= barCount - 2) break;
      progression[destination] = Array.isArray(source) ? [...source] : source;
    }
  }

  // Avoid a static V–V into the cadence — but never at the cost of the half
  // cadence itself, which is deliberate rather than accidental repetition.
  if (barCount >= 4 && barCount - 3 !== half && lastChord(progression[barCount - 3]) === 'V') {
    progression[barCount - 3] = rng.pick(['IV', 'ii', 'I', 'vi']);
  }
  return progression;
}

/**
 * The bar carrying the antecedent's half cadence, or null when the test is
 * too short to divide into two phrases. Exported so the melodic side can
 * shape its line toward the same comma the harmony puts there.
 */
export function halfCadenceBar(barCount) {
  if (barCount < 6) return null;
  const bar = Math.floor(barCount / 2) - 1;
  // Must leave room for the consequent's own restart and V–I cadence.
  return bar >= 1 && bar < barCount - 3 ? bar : null;
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
