/**
 * Test fingerprinting, so the same question does not come back within a
 * session. Hashing the musical content (key, metre, rhythm, pitches) rather
 * than the MusicXML means two tests that differ only in, say, their dynamic
 * marking still count as duplicates.
 */

export function fingerprintOf(score) {
  const parts = [
    score.grade,
    `${score.key.tonic}${score.key.mode}`,
    score.timeSignature.text,
    score.barCount,
  ];

  for (const staffNumber of [1, 2]) {
    for (const bar of score.staves[staffNumber]) {
      for (const event of bar.events) {
        parts.push(event.rest ? `r${event.dur}` : `${event.pitch.midi}:${event.dur}`);
      }
    }
  }
  return hash(parts.join('|'));
}

/** FNV-1a, 32-bit, rendered as hex. */
function hash(text) {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(16).padStart(8, '0');
}

/** Ring buffer of recent fingerprints. */
export function createHistory({ capacity = 50, load, save } = {}) {
  let entries = load?.() ?? [];

  return {
    has: (fingerprint) => entries.includes(fingerprint),
    add(fingerprint) {
      entries = [fingerprint, ...entries.filter((item) => item !== fingerprint)].slice(0, capacity);
      save?.(entries);
    },
    clear() {
      entries = [];
      save?.(entries);
    },
    get size() {
      return entries.length;
    },
  };
}

/**
 * Generate until the result is not in recent history.
 * @param {() => object} produce
 */
export function generateUnique(produce, history, attempts = 12) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const score = produce();
    const fingerprint = fingerprintOf(score);
    last = { score, fingerprint };
    if (!history.has(fingerprint)) {
      history.add(fingerprint);
      return last;
    }
  }
  // Every attempt collided (a very small rule space, e.g. Grade 1 in 2/4):
  // return the last one rather than looping forever.
  history.add(last.fingerprint);
  return last;
}
