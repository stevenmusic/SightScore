/**
 * Seeded PRNG (mulberry32). A seeded generator means every test is
 * reproducible from its seed — useful for sharing a test, for regression
 * tests, and for the "same test again" button.
 */
export function createRandom(seed) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    seed: a,
    /** float in [0, 1) */
    next,
    /** integer in [min, max] inclusive */
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    /** uniform pick */
    pick(items) {
      if (!items.length) throw new Error('pick() called with an empty list');
      return items[Math.floor(next() * items.length)];
    },
    /** pick honouring an optional `weight` field (default 1) */
    weighted(items) {
      if (!items.length) throw new Error('weighted() called with an empty list');
      const total = items.reduce((sum, item) => sum + (item.weight ?? 1), 0);
      let roll = next() * total;
      for (const item of items) {
        roll -= item.weight ?? 1;
        if (roll < 0) return item;
      }
      return items[items.length - 1];
    },
    /** true with probability p */
    chance(p) {
      return next() < p;
    },
  };
}

export function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}
