/**
 * MusicXML 4.0 (partwise) serialiser for a piano grand staff.
 *
 * Points that bite when hand-writing MusicXML, all handled here:
 *   - both staves live in ONE <part>; staff 2 is reached with <backup>
 *   - element order inside <note> is fixed by the DTD
 *   - <alter> sets the sound, <accidental> sets what is printed — a raised
 *     leading note needs both
 *   - beams are explicit, otherwise quavers render with flags
 *   - a tie needs <tie> (sound) *and* <notations><tied> (looks)
 */

import { keyAlterations, LETTERS } from './theory.js?v=27';

const ACCIDENTAL_NAMES = {
  '-2': 'flat-flat', '-1': 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp',
};
const BEAMABLE = { eighth: 1, '16th': 2, '32nd': 3, '64th': 4 };

const escapeXml = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * @param {ReturnType<import('./generate.js').generateTest>} score
 * @param {{title?: string}} [options]
 * @returns {string} MusicXML document
 */
export function toMusicXml(score, options = {}) {
  const title = options.title
    ?? `Grade ${score.grade} Sight-Reading — ${score.key.tonic} ${score.key.mode}`;
  const keyAlters = keyAlterations(score.key.fifths);
  const lines = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  lines.push('<score-partwise version="4.0">');
  lines.push(`  <work><work-title>${escapeXml(title)}</work-title></work>`);
  lines.push('  <identification>');
  lines.push('    <encoding><software>SightScore</software></encoding>');
  lines.push('  </identification>');
  lines.push('  <part-list>');
  lines.push('    <score-part id="P1"><part-name>Piano</part-name></score-part>');
  lines.push('  </part-list>');
  lines.push('  <part id="P1">');

  for (let barIndex = 0; barIndex < score.barCount; barIndex++) {
    lines.push(`    <measure number="${barIndex + 1}">`);

    if (barIndex === 0) {
      lines.push('      <attributes>');
      lines.push(`        <divisions>${score.divisions}</divisions>`);
      lines.push(`        <key><fifths>${score.key.fifths}</fifths><mode>${score.key.mode}</mode></key>`);
      lines.push(`        <time><beats>${score.timeSignature.beats}</beats><beat-type>${score.timeSignature.beatType}</beat-type></time>`);
      lines.push('        <staves>2</staves>');
      lines.push('        <clef number="1"><sign>G</sign><line>2</line></clef>');
      lines.push('        <clef number="2"><sign>F</sign><line>4</line></clef>');
      lines.push('      </attributes>');
      // Always above staff 1, at a fixed spot — the same place every test,
      // whether or not the right hand happens to rest through bar 1. Tying
      // it to whichever hand sounds first (as the dynamics mark below it
      // does) was tried and reverted: a term that jumps staves depending on
      // content is less consistent, not more, and real engraving keeps the
      // tempo/character word on the top staff regardless.
      lines.push('      <direction placement="above">');
      lines.push(`        <direction-type><words font-weight="bold">${escapeXml(score.tempoTerm)}</words></direction-type>`);
      lines.push('        <staff>1</staff>');
      lines.push(`        <sound tempo="${score.tempoBpm}"/>`);
      lines.push('      </direction>');
    }

    for (const staffNumber of [1, 2]) {
      const bar = score.staves[staffNumber][barIndex];
      lines.push(...renderBar(bar, staffNumber, score, keyAlters));
      if (staffNumber === 1) {
        lines.push(`      <backup><duration>${score.barDuration}</duration></backup>`);
      }
    }

    if (barIndex === score.barCount - 1) {
      lines.push('      <barline location="right"><bar-style>light-heavy</bar-style></barline>');
    }
    lines.push('    </measure>');
  }

  lines.push('  </part>');
  lines.push('</score-partwise>');
  return lines.join('\n');
}

function renderDirection(direction, staffNumber) {
  const out = ['      <direction placement="below">'];
  if (direction.kind === 'dynamics') {
    out.push(`        <direction-type><dynamics><${direction.value}/></dynamics></direction-type>`);
  } else if (direction.kind === 'wedge') {
    const type = direction.type === 'stop' ? 'stop' : direction.value;
    out.push(`        <direction-type><wedge type="${type}"/></direction-type>`);
  } else if (direction.kind === 'words') {
    out.push(`        <direction-type><words font-style="italic">${escapeXml(direction.value)}</words></direction-type>`);
  } else if (direction.kind === 'pedal') {
    out.push(`        <direction-type><pedal type="${direction.type}" line="yes"/></direction-type>`);
  } else {
    return [];
  }
  out.push(`        <staff>${staffNumber}</staff>`);
  out.push('      </direction>');
  return out;
}

/**
 * Directions default to the very start of the bar (`atEventIndex: 0`,
 * matching every existing direction kind — dynamics, wedges, words, a
 * pedal start/stop at a bar boundary), but a pedal `change` partway
 * through a bar that splits into two chords needs to land at a specific
 * note's attack instead — MusicXML directions take effect wherever the
 * reader position is when they're encountered, so that one has to be
 * interleaved between notes rather than dumped before all of them.
 */
function renderBar(bar, staffNumber, score, keyAlters) {
  const beams = computeBeams(bar.events, score.beatDuration);
  const tuplets = computeTuplets(bar.events);
  const lines = [];
  const directionsAt = (index) => (bar.directions ?? [])
    .filter((direction) => (direction.atEventIndex ?? 0) === index);

  for (const direction of directionsAt(0)) lines.push(...renderDirection(direction, staffNumber));

  bar.events.forEach((event, index) => {
    lines.push(...renderNote(event, {
      staffNumber,
      voice: staffNumber,
      keyAlters,
      beams: beams[index],
      tuplet: tuplets[index],
    }));
    for (const direction of directionsAt(index + 1)) lines.push(...renderDirection(direction, staffNumber));
  });
  return lines;
}

/** A crushed grace note (acciaccatura) has no <duration> — it borrows its time from the main note. */
function renderGraceNote(grace, ctx) {
  const lines = ['      <note>', '        <grace slash="yes"/>'];
  lines.push(...pitchElement(grace.pitch));
  lines.push(`        <voice>${ctx.voice}</voice>`);
  lines.push('        <type>eighth</type>');
  const accidental = accidentalFor(grace.pitch, ctx.keyAlters);
  if (accidental) lines.push(`        <accidental>${accidental}</accidental>`);
  lines.push(`        <staff>${ctx.staffNumber}</staff>`);
  lines.push('      </note>');
  return lines;
}

function renderNote(event, ctx) {
  const lines = event.grace ? renderGraceNote(event.grace, ctx) : [];
  lines.push('      <note>');

  if (event.rest) {
    lines.push(event.measureRest ? '        <rest measure="yes"/>' : '        <rest/>');
  } else {
    lines.push(...pitchElement(event.pitch));
  }

  lines.push(`        <duration>${event.dur}</duration>`);
  if (event.tie === 'start' || event.tie === 'both') lines.push('        <tie type="start"/>');
  if (event.tie === 'stop' || event.tie === 'both') lines.push('        <tie type="stop"/>');
  lines.push(`        <voice>${ctx.voice}</voice>`);
  if (!event.measureRest) lines.push(`        <type>${event.type}</type>`);
  for (let dot = 0; dot < (event.dots ?? 0); dot++) lines.push('        <dot/>');

  if (!event.rest) {
    const accidental = accidentalFor(event.pitch, ctx.keyAlters);
    if (accidental) lines.push(`        <accidental>${accidental}</accidental>`);
  }

  if (event.timeModification) {
    lines.push('        <time-modification>');
    lines.push(`          <actual-notes>${event.timeModification.actualNotes}</actual-notes>`);
    lines.push(`          <normal-notes>${event.timeModification.normalNotes}</normal-notes>`);
    lines.push(`          <normal-type>${event.timeModification.normalType}</normal-type>`);
    lines.push('        </time-modification>');
  }

  lines.push(`        <staff>${ctx.staffNumber}</staff>`);
  for (const beam of ctx.beams ?? []) {
    lines.push(`        <beam number="${beam.number}">${beam.value}</beam>`);
  }

  const notations = [];
  if (event.tie === 'start' || event.tie === 'both') notations.push('          <tied type="start"/>');
  if (event.tie === 'stop' || event.tie === 'both') notations.push('          <tied type="stop"/>');
  if (event.slur) {
    notations.push(`          <slur type="${event.slur}" number="${event.slurNumber ?? 1}"/>`);
  }
  if (ctx.tuplet) notations.push(`          <tuplet type="${ctx.tuplet}" bracket="yes"/>`);
  if (event.articulations?.length) {
    notations.push('          <articulations>');
    for (const articulation of event.articulations) {
      notations.push(`            <${articulation}/>`);
    }
    notations.push('          </articulations>');
  }
  if (notations.length) {
    lines.push('        <notations>');
    lines.push(...notations);
    lines.push('        </notations>');
  }

  lines.push('      </note>');

  // Chord tones: same duration, marked with <chord/>.
  for (const extra of event.chord ?? []) {
    lines.push('      <note>');
    lines.push('        <chord/>');
    lines.push(...pitchElement(extra));
    lines.push(`        <duration>${event.dur}</duration>`);
    lines.push(`        <voice>${ctx.voice}</voice>`);
    lines.push(`        <type>${event.type}</type>`);
    for (let dot = 0; dot < (event.dots ?? 0); dot++) lines.push('        <dot/>');
    const accidental = accidentalFor(extra, ctx.keyAlters);
    if (accidental) lines.push(`        <accidental>${accidental}</accidental>`);
    lines.push(`        <staff>${ctx.staffNumber}</staff>`);
    lines.push('      </note>');
  }

  return lines;
}

function pitchElement(pitch) {
  const lines = ['        <pitch>', `          <step>${pitch.step}</step>`];
  if (pitch.alter) lines.push(`          <alter>${pitch.alter}</alter>`);
  lines.push(`          <octave>${pitch.octave}</octave>`, '        </pitch>');
  return lines;
}

/** Print an accidental only where it differs from the key signature. */
function accidentalFor(pitch, keyAlters) {
  const expected = keyAlters[LETTERS.indexOf(pitch.step)];
  if (pitch.alter === expected) return null;
  return ACCIDENTAL_NAMES[String(pitch.alter)] ?? null;
}

/**
 * Beam runs, computed per beat so groupings follow the metre.
 * @returns {Array<Array<{number: number, value: string}>>} indexed like events
 */
function computeBeams(events, beatDuration) {
  const result = events.map(() => []);
  let offset = 0;
  let run = [];

  const flush = () => {
    if (run.length >= 2) {
      run.forEach((index, position) => {
        const levels = BEAMABLE[events[index].type] ?? 0;
        const value = position === 0 ? 'begin' : position === run.length - 1 ? 'end' : 'continue';
        for (let level = 1; level <= levels; level++) {
          // Only beam a secondary level when the neighbour shares it.
          const previousLevels = position > 0 ? BEAMABLE[events[run[position - 1]].type] ?? 0 : 0;
          const nextLevels = position < run.length - 1 ? BEAMABLE[events[run[position + 1]].type] ?? 0 : 0;
          let levelValue = value;
          if (level > 1) {
            const hasPrevious = previousLevels >= level;
            const hasNext = nextLevels >= level;
            if (!hasPrevious && !hasNext) continue;
            if (!hasPrevious) levelValue = 'begin';
            else if (!hasNext) levelValue = 'end';
            else levelValue = 'continue';
          }
          result[index].push({ number: level, value: levelValue });
        }
      });
    }
    run = [];
  };

  events.forEach((event, index) => {
    const startsBeat = offset % beatDuration === 0;
    if (startsBeat) flush();
    if (!event.rest && BEAMABLE[event.type]) run.push(index);
    else flush();
    offset += event.dur;
  });
  flush();
  return result;
}

/** Tuplet bracket start/stop for runs sharing a time-modification. */
function computeTuplets(events) {
  const result = events.map(() => null);
  let index = 0;
  while (index < events.length) {
    if (!events[index].timeModification) {
      index += 1;
      continue;
    }
    let end = index;
    while (end + 1 < events.length && events[end + 1].timeModification) end += 1;
    if (end > index) {
      result[index] = 'start';
      result[end] = 'stop';
    }
    index = end + 1;
  }
  return result;
}
