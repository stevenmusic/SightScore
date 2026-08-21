/**
 * Rhythm-cell library.
 *
 * Rhythms are not built by drawing note values one at a time — that produces
 * bar-fillings ABRSM would never print. Instead each *beat* is drawn from a
 * library of idiomatic cells. This guarantees, for free:
 *   - bars always add up exactly
 *   - quavers appear in pairs and beam correctly
 *   - dotted, tied and syncopated figures only appear once the grade allows
 */

/** Divisions per quarter note. 24 covers 32nds (3) and triplet quavers (8). */
export const DIVISIONS = 24;

const W = DIVISIONS * 4;
const H = DIVISIONS * 2;
const Q = DIVISIONS;
const E = DIVISIONS / 2;
const S = DIVISIONS / 4;

const note = (type, dur, extra = {}) => ({ type, dur, dots: 0, rest: false, ...extra });
const dotted = (type, dur) => ({ type, dur, dots: 1, rest: false });
const rest = (type, dur, dots = 0) => ({ type, dur, dots, rest: true });
const triplet = () => ({
  type: 'eighth',
  dur: Q / 3,
  dots: 0,
  rest: false,
  timeModification: { actualNotes: 3, normalNotes: 2, normalType: 'eighth' },
});

/**
 * Cells for simple time. `beats` counts quarter-note beats.
 * `requires` lists grade capabilities the cell depends on.
 * `calm: true` marks cells suitable for an accompanying left hand.
 */
const SIMPLE_CELLS = [
  { id: 'q', beats: 1, weight: 5, calm: true, requires: [], events: [note('quarter', Q)] },
  // Two quavers is a staple accompaniment cell (broken octaves, Alberti), so
  // it counts as calm. Leaving it out left a low-grade left hand drawing from
  // six or seven cells whose weights concentrated on one or two fillings, and
  // that narrowness — not the ostinato mechanic — was what made its rhythm
  // repeat: with so few ways to fill a bar, independent draws kept coinciding.
  { id: 'ee', beats: 1, weight: 4, calm: true, requires: ['eighth'], events: [note('eighth', E), note('eighth', E)] },
  { id: 'ssss', beats: 1, weight: 0.9, requires: ['sixteenth'], events: [note('16th', S), note('16th', S), note('16th', S), note('16th', S)] },
  { id: 'ess', beats: 1, weight: 2, requires: ['sixteenth'], events: [note('eighth', E), note('16th', S), note('16th', S)] },
  { id: 'sse', beats: 1, weight: 1.5, requires: ['sixteenth'], events: [note('16th', S), note('16th', S), note('eighth', E)] },
  { id: 'de_s', beats: 1, weight: 1.5, requires: ['dottedEighth'], events: [dotted('eighth', E + S), note('16th', S)] },
  { id: 'trip', beats: 1, weight: 0.45, requires: ['triplet'], events: [triplet(), triplet(), triplet()] },
  { id: 'qr', beats: 1, weight: 0.9, calm: true, rests: 1, requires: [], events: [rest('quarter', Q)] },
  { id: 'e_er', beats: 1, weight: 0.8, rests: 1, requires: ['eighthRest'], events: [note('eighth', E), rest('eighth', E)] },

  { id: 'h', beats: 2, weight: 4, calm: true, requires: ['half'], events: [note('half', H)] },
  { id: 'dq_e', beats: 2, weight: 3, calm: true, requires: ['dottedQuarter'], events: [dotted('quarter', Q + E), note('eighth', E)] },
  { id: 'e_q_e', beats: 2, weight: 2, requires: ['syncopation'], events: [note('eighth', E), note('quarter', Q), note('eighth', E)] },
  { id: 'hr', beats: 2, weight: 0.6, calm: true, rests: 1, requires: ['half'], events: [rest('half', H)] },

  { id: 'dh', beats: 3, weight: 3, calm: true, requires: ['dottedHalf'], events: [dotted('half', H + Q)] },
  { id: 'w', beats: 4, weight: 2.5, calm: true, requires: ['whole'], events: [note('whole', W)] },
];

/** Cells for compound time. One `beat` is a dotted quarter. */
const COMPOUND_CELLS = [
  { id: 'c_dq', beats: 1, weight: 4, calm: true, requires: ['dottedQuarter'], events: [dotted('quarter', Q + E)] },
  { id: 'c_eee', beats: 1, weight: 3, requires: ['eighth'], events: [note('eighth', E), note('eighth', E), note('eighth', E)] },
  { id: 'c_q_e', beats: 1, weight: 3, requires: ['eighth'], events: [note('quarter', Q), note('eighth', E)] },
  { id: 'c_e_q', beats: 1, weight: 1.5, requires: ['syncopation'], events: [note('eighth', E), note('quarter', Q)] },
  { id: 'c_e_ss_e', beats: 1, weight: 1.2, requires: ['sixteenth'], events: [note('eighth', E), note('16th', S), note('16th', S), note('eighth', E)] },
  { id: 'c_dqr', beats: 1, weight: 0.7, calm: true, rests: 1, requires: ['dottedQuarter'], events: [rest('quarter', Q + E, 1)] },
  { id: 'c_dh', beats: 2, weight: 2.5, calm: true, requires: ['dottedHalf'], events: [dotted('half', H + Q)] },
];

/** Which cell requirements the grade's rhythm rules satisfy. */
export function capabilitiesFor(gradeRules) {
  const { noteValues = [], dottedValues = [], rests = [], smallestDivision = 8 } = gradeRules.rhythm;
  const caps = new Set();
  if (noteValues.includes('whole')) caps.add('whole');
  if (noteValues.includes('half')) caps.add('half');
  if (noteValues.includes('eighth')) caps.add('eighth');
  if (noteValues.includes('16th') && smallestDivision >= 16) caps.add('sixteenth');
  if (noteValues.includes('32nd') && smallestDivision >= 32) caps.add('thirtysecond');
  if (dottedValues.includes('half')) caps.add('dottedHalf');
  if (dottedValues.includes('quarter')) caps.add('dottedQuarter');
  if (dottedValues.includes('eighth')) caps.add('dottedEighth');
  if (rests.includes('eighth')) caps.add('eighthRest');
  if (gradeRules.rhythm.triplets) caps.add('triplet');
  if (gradeRules.rhythm.syncopation) caps.add('syncopation');
  return caps;
}

/**
 * @param {object} gradeRules entry from the rules table
 * @param {{compound: boolean, calmOnly?: boolean}} options
 */
export function cellsFor(gradeRules, { compound, calmOnly = false }) {
  const caps = capabilitiesFor(gradeRules);
  const source = compound ? COMPOUND_CELLS : SIMPLE_CELLS;
  return source.filter(
    (cell) => cell.requires.every((req) => caps.has(req)) && (!calmOnly || cell.calm),
  );
}

/**
 * Fill one bar with cells.
 *
 * `activity` (0–1) tilts the draw toward busier or sparser cells. Without it
 * every grade lands on much the same note count, and Grade 8 reads no harder
 * than Grade 3 — the vocabulary widens but nothing actually uses it.
 *
 * @param {ReturnType<import('./random.js').createRandom>} rng
 * @param {Array} cells
 * @param {number} beatsPerBar in cell-beat units
 * @param {{restBudget?: number, activity?: number}} [options]
 * @returns {{cellIds: string[], events: object[]}}
 */
export function fillBar(rng, cells, beatsPerBar, options = {}) {
  const restBudget = options.restBudget ?? 1;
  // Notes per beat, raised to an exponent that runs from about -0.5 (favour
  // long values) to +1.2 (favour short ones).
  const exponent = -0.5 + 1.7 * (options.activity ?? 0.4);
  const cellIds = [];
  const events = [];
  let remaining = beatsPerBar;
  let restsUsed = 0;

  while (remaining > 0) {
    const position = beatsPerBar - remaining;
    const candidates = cells.filter(
      (cell) => cell.beats <= remaining
        && (!cell.rests || restsUsed + cell.rests <= restBudget)
        && !crossesMidBar(cell, position, beatsPerBar),
    );
    if (!candidates.length) {
      throw new Error(`no rhythm cell fits ${remaining} remaining beat(s)`);
    }
    const weighted = candidates.map((cell) => ({
      cell,
      weight: (cell.weight ?? 1) * (cell.events.length / cell.beats) ** exponent,
    }));
    const cell = rng.weighted(weighted).cell;
    cellIds.push(cell.id);
    for (const event of cell.events) events.push({ ...event });
    restsUsed += cell.rests ?? 0;
    remaining -= cell.beats;
  }

  return { cellIds, events };
}

/**
 * A single rest cell placed at `position` (beats from bar start) that would
 * straddle the bar's structural half-way point (beat 3 in 4/4) hides that
 * beat instead of showing it — real engraving splits it into two rests
 * instead. A rest that spans the whole bar is exempt: that's the ordinary
 * whole-bar-rest convention, not a beat obscured mid-bar.
 */
function crossesMidBar(cell, position, beatsPerBar) {
  const half = beatsPerBar / 2;
  if (!Number.isInteger(half)) return false;
  const isSoleRest = cell.events.length === 1 && cell.events[0].rest;
  if (!isSoleRest) return false;
  const end = position + cell.beats;
  if (position === 0 && end === beatsPerBar) return false;
  return position < half && end > half;
}

/** Total division count of an event list. */
export function totalDuration(events) {
  return events.reduce((sum, event) => sum + event.dur, 0);
}

/** A bar filled with a single whole-measure rest. */
export function wholeBarRest(barDuration) {
  return [{ type: 'whole', dur: barDuration, dots: 0, rest: true, measureRest: true }];
}
