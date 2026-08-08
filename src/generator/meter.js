/**
 * Meter handling.
 *
 * The rhythm-cell library is written in quarter-note beats. Time signatures
 * with a different beat unit reuse the same cells, rescaled: 3/8 halves every
 * value (quarter -> eighth), 2/2 doubles them. Compound signatures switch to
 * the dotted-quarter cell set instead.
 */

import { DIVISIONS } from './rhythm.js?v=43';

const TYPE_LADDER = ['breve', 'whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th'];

export function parseTimeSignature(text) {
  const [beats, beatType] = text.split('/').map(Number);
  if (!beats || !beatType) throw new Error(`bad time signature: ${text}`);
  return { beats, beatType, text };
}

/**
 * @returns {{
 *   beats: number, beatType: number, text: string, compound: boolean,
 *   cellBeats: number, beatDuration: number, barDuration: number, scale: number
 * }}
 */
export function meterInfo(text) {
  const { beats, beatType } = parseTimeSignature(text);
  const compound = beatType === 8 && beats % 3 === 0 && beats >= 6;

  if (compound) {
    const beatDuration = DIVISIONS * 1.5; // dotted quarter
    const cellBeats = beats / 3;
    return {
      beats, beatType, text, compound, cellBeats, beatDuration,
      barDuration: cellBeats * beatDuration, scale: 1,
    };
  }

  const scale = 4 / beatType; // 4/4 -> 1, x/8 -> 0.5, x/2 -> 2
  const beatDuration = DIVISIONS * scale;
  return {
    beats, beatType, text, compound: false, cellBeats: beats, beatDuration,
    barDuration: beats * beatDuration, scale,
  };
}

/** Rescale a cell's note values by a power-of-two factor. */
export function scaleCell(cell, scale) {
  if (scale === 1) return cell;
  const shift = scale === 0.5 ? 1 : -1;
  return {
    ...cell,
    events: cell.events.map((event) => {
      const index = TYPE_LADDER.indexOf(event.type);
      const scaledType = TYPE_LADDER[index + shift];
      if (!scaledType) throw new Error(`cannot rescale note type ${event.type}`);
      const scaled = { ...event, type: scaledType, dur: event.dur * scale };
      if (event.timeModification) {
        // The tuplet's reference value scales with everything else, or the
        // engraving claims a triplet of quavers while printing semiquavers.
        const normalIndex = TYPE_LADDER.indexOf(event.timeModification.normalType);
        const normalType = TYPE_LADDER[normalIndex + shift];
        if (!normalType) throw new Error(`cannot rescale tuplet type ${event.timeModification.normalType}`);
        scaled.timeModification = { ...event.timeModification, normalType };
      }
      return scaled;
    }),
  };
}

/** Note types a grade is allowed to print, including dotted forms. */
export function allowedTypes(gradeRules) {
  return new Set(gradeRules.rhythm.noteValues);
}

/**
 * Rescale a cell list and drop any cell that would need a note value the
 * grade does not use. Rescaling changes dotted values too: in 3/8 a dotted
 * crotchet becomes a dotted quaver, which Grade 3 does not print.
 */
export function rescaleCells(cells, scale, gradeRules) {
  if (scale === 1) return cells;
  const permitted = allowedTypes(gradeRules);
  const permittedDots = new Set(gradeRules.rhythm.dottedValues ?? []);
  const out = [];
  for (const cell of cells) {
    let scaled;
    try {
      scaled = scaleCell(cell, scale);
    } catch {
      continue;
    }
    const usable = scaled.events.every(
      (event) => permitted.has(event.type) && (!event.dots || permittedDots.has(event.type)),
    );
    if (usable) out.push(scaled);
  }
  return out;
}
