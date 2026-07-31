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
 * One chord per bar: opens on I, closes with a V–I cadence.
 * @param {ReturnType<import('./random.js').createRandom>} rng
 * @param {number} barCount
 * @param {{simple?: boolean}} [options]
 * @returns {string[]} roman numerals, one per bar
 */
export function buildProgression(rng, barCount, options = {}) {
  const pool = options.simple ? MIDDLE_POOL_SIMPLE : MIDDLE_POOL;
  if (barCount <= 1) return ['I'];
  if (barCount === 2) return ['I', 'I'];

  const progression = new Array(barCount);
  progression[0] = 'I';
  progression[barCount - 1] = 'I';
  progression[barCount - 2] = 'V';

  let previous = 'I';
  for (let bar = 1; bar < barCount - 2; bar++) {
    const candidates = pool.filter((chord) => chord !== previous);
    progression[bar] = rng.pick(candidates);
    previous = progression[bar];
  }

  // Avoid a static V–V into the cadence.
  if (barCount >= 4 && progression[barCount - 3] === 'V') {
    progression[barCount - 3] = rng.pick(['IV', 'ii', 'I', 'vi']);
  }
  return progression;
}
