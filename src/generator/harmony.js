/**
 * Harmonic skeleton.
 *
 * Pitches are chosen against a chord progression rather than freely from the
 * scale. This is the single biggest factor in whether a generated test sounds
 * like music or like a random note-string.
 */

/*
 * How one chord tends to move to the next, weighted by how idiomatic the
 * progression is — not just legal, which a flat pool cannot tell apart from
 * common. Measured across 600 tests per grade, an unweighted uniform pick
 * over {I, ii, iii, IV, V, vi} put `iii` — the weakest and most tonally
 * ambiguous diatonic triad, sharing two tones with both I and V and pushing
 * toward neither — within a point of IV by Grade 5, and root motion by a
 * bare third (root motion with no strong directional pull) at 14-15% of all
 * chord changes, nearly matching the 15-18% that moved by a second. Motion by
 * a fourth/fifth — the progression that actually drives tonal harmony
 * forward — was already the largest single category (30-46%), but a random
 * walk has no notion that it *should* be, so it wandered into weak motion far
 * more than real practice does.
 *
 * Every chord is reachable from every other (nothing here is impossible),
 * but `iii` is a weak destination from everywhere it can be reached at all:
 * real practice uses it almost exclusively as a passing chord on the way
 * from I or vi to IV, not as a harmony to arrive on and linger over. `V`'s
 * entry has no IV or ii at all — not a filter bolted on afterward, but the
 * plain absence of the one progression real harmony treats as a mistake:
 * V-IV undoes the tension the dominant just built, which is why every
 * textbook calls it a retrogression. An unweighted pick produced it in 3-4%
 * of chord changes once a bar could split into two chords (Grade 5+).
 */
const FOLLOWS = {
  I: [{ chord: 'IV', weight: 4 }, { chord: 'V', weight: 4 }, { chord: 'ii', weight: 3 }, { chord: 'vi', weight: 3 }, { chord: 'iii', weight: 1 }],
  ii: [{ chord: 'V', weight: 5 }, { chord: 'IV', weight: 1 }, { chord: 'vi', weight: 1 }, { chord: 'I', weight: 1 }],
  iii: [{ chord: 'vi', weight: 4 }, { chord: 'IV', weight: 3 }, { chord: 'I', weight: 1 }, { chord: 'ii', weight: 1 }],
  IV: [{ chord: 'V', weight: 4 }, { chord: 'I', weight: 3 }, { chord: 'ii', weight: 3 }, { chord: 'vi', weight: 1 }],
  V: [{ chord: 'I', weight: 3 }, { chord: 'vi', weight: 2 }],
  vi: [{ chord: 'IV', weight: 3 }, { chord: 'ii', weight: 3 }, { chord: 'V', weight: 3 }, { chord: 'I', weight: 1 }, { chord: 'iii', weight: 1 }],
};

/** Grade <=3: no ii/iii at all, so only the primary-chord relationships apply. */
const FOLLOWS_SIMPLE = {
  I: [{ chord: 'V', weight: 4 }, { chord: 'IV', weight: 3 }, { chord: 'vi', weight: 2 }],
  IV: [{ chord: 'V', weight: 4 }, { chord: 'I', weight: 3 }, { chord: 'vi', weight: 1 }],
  V: [{ chord: 'I', weight: 3 }, { chord: 'vi', weight: 2 }],
  vi: [{ chord: 'IV', weight: 3 }, { chord: 'V', weight: 2 }, { chord: 'I', weight: 1 }],
};

/** Weighted candidates for what may follow `previous`, excluding an immediate repeat. */
function mayFollow(table, previous) {
  const candidates = (table[previous] ?? []).filter((entry) => entry.chord !== previous);
  if (candidates.length) return candidates;
  return Object.keys(table)
    .filter((chord) => chord !== previous)
    .map((chord) => ({ chord, weight: 1 }));
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
  const table = options.simple ? FOLLOWS_SIMPLE : FOLLOWS;
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
  // How many bars running the harmony has already sat on `previous`,
  // counting the opening bar itself — see the prolongation comment below.
  let sameChordRun = 1;
  for (let bar = 1; bar < barCount - 2; bar++) {
    if (bar === half) {
      progression[bar] = 'V';
      previous = 'V';
      sameChordRun = 1;
      continue;
    }
    // The consequent begins by restating home, the way the piece opened.
    if (half !== null && bar === half + 1) {
      progression[bar] = 'I';
      previous = 'I';
      sameChordRun = 1;
      continue;
    }
    /*
     * Real tonal writing prolongs a chord across more than one bar — most
     * often the opening tonic, establishing the key before the harmony
     * starts moving — rather than changing on every single barline.
     * `mayFollow` below still refuses to *pick* a repeat when the harmony
     * does move on, which is correct (a "next chord" that's the same chord
     * isn't a move at all); without a separate chance to simply hold still
     * first, that meant harmony changed on 100% of bars, every time, which
     * is a far busier harmonic rhythm than these short, simple tests
     * actually have. Capped at two bars running the same chord — even a
     * held tonic opening rarely sits still longer than that here.
     */
    if (sameChordRun < 2 && rng.chance(bar === 1 && previous === 'I' ? 0.45 : 0.2)) {
      progression[bar] = previous;
      sameChordRun += 1;
      continue;
    }
    sameChordRun = 1;

    const first = rng.weighted(mayFollow(table, previous)).chord;
    if (twoChordBarChance > 0 && rng.chance(twoChordBarChance)) {
      const second = rng.weighted(mayFollow(table, first)).chord;
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
  // Weighted toward ii/IV: the classic pre-dominant approach into a cadence,
  // rather than treated as just another equally-likely replacement.
  if (barCount >= 4 && barCount - 3 !== half && lastChord(progression[barCount - 3]) === 'V') {
    progression[barCount - 3] = rng.weighted([
      { chord: 'ii', weight: 3 }, { chord: 'IV', weight: 3 }, { chord: 'vi', weight: 1 }, { chord: 'I', weight: 1 },
    ]).chord;
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
