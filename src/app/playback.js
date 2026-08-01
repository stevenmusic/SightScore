/**
 * Reference playback, matching ScrollScore's audio chain.
 *
 * Real recorded piano, not a synthesised timbre: the Salamander sample set
 * that ScrollScore uses, picked by nearest recorded note and pitch-shifted
 * with playbackRate.
 *
 *   sample -> gain (envelope) -> pan (by pitch) -+-> master -> limiter -> out
 *                                                |
 *                                                +-> send -> reverb bus
 *
 * The room is the same synthesised impulse response ScrollScore builds:
 * decaying noise with a one-pole low-pass so the tail darkens, plus discrete
 * early reflections, 18 ms pre-delay. Space is fixed at ScrollScore's default
 * of 30, so there is nothing to switch on.
 */

const PIANO_BASE = 'https://tonejs.github.io/audio/salamander/';

/** Exactly the notes the Salamander set ships, as in ScrollScore. */
const SAMPLE_LIST = [
  ['A', 0],
  ['C', 1], ['Ds', 1], ['Fs', 1], ['A', 1],
  ['C', 2], ['Ds', 2], ['Fs', 2], ['A', 2],
  ['C', 3], ['Ds', 3], ['Fs', 3], ['A', 3],
  ['C', 4], ['Ds', 4], ['Fs', 4], ['A', 4],
  ['C', 5], ['Ds', 5], ['Fs', 5], ['A', 5],
  ['C', 6], ['Ds', 6], ['Fs', 6], ['A', 6],
  ['C', 7], ['Ds', 7], ['Fs', 7], ['A', 7],
  ['C', 8],
];

const NOTE_SEMITONE = { C: 0, Cs: 1, D: 2, Ds: 3, E: 4, F: 5, Fs: 6, G: 7, Gs: 8, A: 9, As: 10, B: 11 };

/** ScrollScore's slider default of 30, applied as amount * 0.55. */
const SPACE_AMOUNT = 0.3;
const REVERB_SEND = 0.5;
const DECAY_TAU = 2.2;
const PEAK_GAIN = 0.6;
const TAIL = 0.4;
/** A slurred note's release is left to bleed further into the next note's attack — ScrollScore's legato tail. */
const LEGATO_TAIL = 0.6;
/** Sustain pedal rings longer still, and a touch louder — every damper is off the strings, not just the held note's. */
const PEDAL_TAIL = 0.9;
const PEDAL_GAIN_BOOST = 1.1;
/** How much softer/louder each printed dynamic is against `PEAK_GAIN`, `mf` (the usual unmarked default) left at 1. */
const DYNAMIC_GAIN = {
  ppp: 0.4, pp: 0.5, p: 0.65, mp: 0.8, mf: 1, f: 1.25, ff: 1.55, fff: 1.9,
};
/** How much slower a mid-piece rit./rall. gets at its deepest point, before "a tempo" (or the piece's end) restores it. */
const MIN_RIT_SCALE = 0.68;
const MIN_RALL_SCALE = 0.55;
/** An acciaccatura is crushed against the note it decorates — played just before it, not given its own beat. */
const GRACE_LEAD = 0.09;

export function createPlayer({ onStatus } = {}) {
  let context = null;
  let master = null;
  let reverbBus = null;
  let samples = null;
  let pending = null;
  /** Sample downloads start immediately; decoding waits for a user gesture. */
  let downloads = null;
  let voices = [];
  let stopTimer = null;
  /** AudioContext time of musical position zero, for visual sync. */
  let startTime = null;

  const download = () => {
    downloads ??= SAMPLE_LIST.map(([letter, octave]) => {
      const midi = (octave + 1) * 12 + NOTE_SEMITONE[letter];
      return fetch(`${PIANO_BASE}${letter}${octave}.mp3`)
        .then((response) => {
          if (!response.ok) throw new Error(String(response.status));
          return response.arrayBuffer();
        })
        .then((data) => ({ midi, data }))
        .catch(() => null); // a missing sample just drops out; the rest still play
    });
    return downloads;
  };

  const ensureAudio = () => {
    if (context) {
      if (context.state === 'suspended') context.resume();
      return context;
    }
    context = new (window.AudioContext ?? window.webkitAudioContext)();

    master = context.createGain();
    master.gain.value = 0.48; // headroom: Web Audio sums voices, so peaks add up

    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 3;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.25;

    master.connect(limiter);
    limiter.connect(context.destination);

    reverbBus = context.createGain();
    const preDelay = context.createDelay(0.2);
    preDelay.delayTime.value = 0.018;
    const convolver = context.createConvolver();
    convolver.buffer = impulseResponse(context, 2.1, 2.4);
    const wet = context.createGain();
    wet.gain.value = SPACE_AMOUNT * 0.55;

    reverbBus.connect(preDelay);
    preDelay.connect(convolver);
    convolver.connect(wet);
    wet.connect(master); // before the limiter, so the tail is protected too

    return context;
  };

  const loadSamples = () => {
    if (samples) return Promise.resolve(samples);
    if (pending) return pending;

    onStatus?.('載入鋼琴音色中…');
    pending = Promise.all(download())
      .then((entries) => Promise.all(
        entries.filter(Boolean).map(
          ({ midi, data }) => context.decodeAudioData(data.slice(0))
            .then((buffer) => ({ midi, buffer }))
            .catch(() => null),
        ),
      ))
      .then((decoded) => {
        samples = decoded.filter(Boolean).sort((a, b) => a.midi - b.midi);
        onStatus?.(samples.length ? null : '鋼琴音色載入失敗，暫用備援音色');
        return samples;
      });
    return pending;
  };

  const stop = () => {
    for (const voice of voices) {
      try {
        voice.stop();
      } catch {
        /* already stopped */
      }
    }
    voices = [];
    startTime = null;
    clearTimeout(stopTimer);
    stopTimer = null;
  };

  return {
    get playing() {
      return voices.length > 0;
    },
    /** Seconds since the first note, or null when not playing. */
    get elapsed() {
      if (startTime === null || !context) return null;
      return context.currentTime - startTime;
    },
    /** Start fetching the samples before anyone presses play. */
    preload: download,
    stop,
    /**
     * A short block chord — the tonic triad given before the 30-second
     * preparation starts, matching what an examiner plays to establish the
     * key. Shares the sample chain and voice bookkeeping with `play()`
     * rather than standing up a second audio path, so it is stopped by the
     * same `stop()` (pressing Stop, or starting a new test, cuts it off
     * exactly as it would the reference playback). `startTime` is left
     * untouched: a chord announcement isn't the timeline `startFollowing()`
     * tracks, so `elapsed` should keep reporting null through it.
     * @param {number[]} midis
     * @returns {Promise<void>} resolves once the chord has decayed
     */
    async playChord(midis, { duration = 1.3 } = {}) {
      stop();
      ensureAudio();
      await loadSamples();

      const at = context.currentTime + 0.08;
      let end = at;
      for (const midi of midis) {
        const voice = samples?.length
          ? sampledNote(context, { master, reverbBus }, samples, midi, at, duration)
          : fallbackNote(context, { master, reverbBus }, midi, at, duration);
        voices.push(voice);
        end = Math.max(end, at + duration);
      }

      return new Promise((resolve) => {
        stopTimer = setTimeout(() => {
          voices = [];
          resolve();
        }, (end - context.currentTime + TAIL + 0.3) * 1000);
      });
    },
    /**
     * @param {object} score
     * @param {{onEnd?: () => void, tempoScale?: number}} [options]
     */
    async play(score, options = {}) {
      stop();
      ensureAudio();
      await loadSamples();

      const bpm = score.tempoBpm * (options.tempoScale ?? 1);
      const secondsPerDivision = 60 / bpm / score.divisions;
      const start = context.currentTime + 0.15;
      startTime = start;
      let end = start;

      // Every printed direction (dynamics, wedges, pedal, rit./a tempo/rall.)
      // lives on only one staff or the other, but all of them apply to the
      // whole texture — so this is built once, in notated-offset space
      // shared by both hands, rather than re-derived per staff.
      const timeline = scoreDirectionTimeline(score);
      const timeAt = buildTimeMap(score, timeline, secondsPerDivision, start);
      const gainAt = buildDynamicsEnvelope(timeline);
      const pedalRanges = buildPedalRanges(timeline);

      for (const staffNumber of [1, 2]) {
        const { notes, slurRanges } = layOutStaff(score.staves[staffNumber], score.barDuration);
        const legatoAt = (offset) => slurRanges.some((range) => offset >= range.start && offset < range.end);
        const pedalOnAt = (offset) => pedalRanges.some((range) => offset >= range.start && offset < range.end);

        for (const { event, offset, dur } of notes) {
          const at = timeAt(offset);
          // Both endpoints go through the same tempo-warped map, so a note
          // under a ritardando doesn't just start later — it actually lasts
          // longer in real seconds too, which is what makes the slowing
          // audible rather than just delayed.
          const duration = timeAt(offset + dur) - at;
          const pedalOn = pedalOnAt(offset);
          const legato = !pedalOn && legatoAt(offset);
          const envelope = {
            tail: pedalOn ? PEDAL_TAIL : (legato ? LEGATO_TAIL : TAIL),
            gainScale: gainAt(offset) * (pedalOn ? PEDAL_GAIN_BOOST : 1),
            articulations: event.articulations,
          };
          for (const pitch of [event.pitch, ...(event.chord ?? [])]) {
            const voice = samples?.length
              ? sampledNote(context, { master, reverbBus }, samples, pitch.midi, at, duration, envelope)
              : fallbackNote(context, { master, reverbBus }, pitch.midi, at, duration, envelope);
            voices.push(voice);
          }
          if (event.grace) {
            // Crushed against the beat: as short as it can be while still
            // sounding like a distinct note, played right up against the
            // main note's own onset rather than taking time from the beat.
            const graceDuration = Math.min(GRACE_LEAD, duration * 0.4);
            const graceAt = Math.max(start, at - graceDuration);
            const graceEnvelope = { tail: TAIL, gainScale: envelope.gainScale * 0.85 };
            const voice = samples?.length
              ? sampledNote(context, { master, reverbBus }, samples, event.grace.pitch.midi, graceAt, graceDuration, graceEnvelope)
              : fallbackNote(context, { master, reverbBus }, event.grace.pitch.midi, graceAt, graceDuration, graceEnvelope);
            voices.push(voice);
          }
          end = Math.max(end, at + duration);
        }
      }

      stopTimer = setTimeout(() => {
        voices = [];
        options.onEnd?.();
      }, (end - context.currentTime + TAIL + 2.1) * 1000);
    },
  };
}

/**
 * Flattens one staff's bars into notated-offset (divisions from the piece's
 * start, not seconds — real timing is resolved later, once for both hands,
 * by `buildTimeMap`) note events plus the offset spans its slurs cover. A
 * slur only marks its first and last note (`event.slur = 'start'`/`'stop'`),
 * not the notes in between, and the first note can't know where its own
 * span ends until the matching `stop` is reached walking forward — so
 * ranges are collected in this same pass and every note's `legato` state is
 * decided afterward by testing its onset against them, the same two-phase
 * approach ScrollScore's MusicXML reader uses rather than tracking "am I
 * inside a slur" as running state.
 */
function layOutStaff(bars, barDuration) {
  const notes = [];
  const slurRanges = [];
  const slurStarts = {};
  bars.forEach((bar, barIndex) => {
    let local = 0;
    for (const event of bar.events) {
      const offset = barIndex * barDuration + local;
      if (!event.rest) {
        const number = event.slurNumber ?? 1;
        if (event.slur === 'start') slurStarts[number] = offset;
        notes.push({ event, offset, dur: event.dur });
        if (event.slur === 'stop' && slurStarts[number] !== undefined) {
          slurRanges.push({ start: slurStarts[number], end: offset + event.dur });
          delete slurStarts[number];
        }
      }
      local += event.dur;
    }
  });
  return { notes, slurRanges };
}

/**
 * Every direction (dynamics, wedges, pedal, tempo words) from both staves,
 * in one notated-offset-ordered list. Each kind is only ever written to
 * whichever staff `applyExpression`/`addPedalMarking` chose (dynamics and
 * wedges to whichever hand sounds first in bar 1, pedal always to the bass,
 * tempo words always to the treble), but all of them apply to the whole
 * texture — so the envelope builders below read from this shared list
 * rather than each staff building its own, which would simply see nothing
 * for the directions that live on the other one.
 */
function scoreDirectionTimeline(score) {
  const list = [];
  for (const staffNumber of [1, 2]) {
    score.staves[staffNumber].forEach((bar, barIndex) => {
      const eventOffset = (index) => {
        let sum = 0;
        for (let i = 0; i < index && i < bar.events.length; i++) sum += bar.events[i].dur;
        return sum;
      };
      for (const direction of bar.directions ?? []) {
        list.push({ offset: barIndex * score.barDuration + eventOffset(direction.atEventIndex ?? 0), direction });
      }
    });
  }
  list.sort((a, b) => a.offset - b.offset);
  return list;
}

/**
 * Tempo multiplier (1 = written tempo) as a function of notated offset.
 * `rit.` ramps down toward the following `a tempo` (or, lacking one, the
 * end of the piece); `rall.` ramps down toward the end with nothing to
 * restore it, matching how each is actually used in `generate.js` — a
 * mid-piece rit./a tempo pair (Grade 6+), or a `rall.` into the final bars.
 */
function tempoScaleFn(timeline, totalOffset) {
  const marks = timeline
    .filter(({ direction }) => direction.kind === 'words'
      && (direction.value === 'rit.' || direction.value === 'a tempo' || direction.value === 'rall.'))
    .map(({ offset, direction }) => ({ offset, value: direction.value }));

  const segments = [];
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    if (mark.value === 'rit.') {
      const next = marks[i + 1];
      const to = next?.value === 'a tempo' ? next.offset : totalOffset;
      if (to > mark.offset) segments.push({ from: mark.offset, to, fromScale: 1, toScale: MIN_RIT_SCALE });
    } else if (mark.value === 'rall.') {
      if (totalOffset > mark.offset) segments.push({ from: mark.offset, to: totalOffset, fromScale: 1, toScale: MIN_RALL_SCALE });
    }
  }

  return (offset) => {
    for (const segment of segments) {
      if (offset >= segment.from && offset < segment.to) {
        const fraction = (offset - segment.from) / (segment.to - segment.from);
        return segment.fromScale + (segment.toScale - segment.fromScale) * fraction;
      }
    }
    return 1;
  };
}

/**
 * Notated offset (divisions) -> real seconds, integrating the tempo curve
 * instead of a flat `secondsPerDivision` multiply. A rit. changes how much
 * real time a division takes, not just where the words sit on the page —
 * building this once up front is what makes every later note in *either*
 * hand both start later and last longer under it, which is what actually
 * reads as slowing down rather than just a label. The curve is piecewise
 * linear in *tempo*, not in time, so it's integrated numerically (trapezoid
 * rule at sixteenth-note-ish steps) rather than sampled directly.
 */
function buildTimeMap(score, timeline, secondsPerDivision, start) {
  const totalOffset = score.barCount * score.barDuration;
  const scaleAt = tempoScaleFn(timeline, totalOffset);
  const step = Math.max(1, score.barDuration / 16);

  const offsets = [0];
  const times = [start];
  let offset = 0;
  let time = start;
  while (offset < totalOffset) {
    const next = Math.min(offset + step, totalOffset);
    const costHere = 1 / scaleAt(offset);
    const costNext = 1 / scaleAt(next);
    time += secondsPerDivision * (next - offset) * (costHere + costNext) / 2;
    offset = next;
    offsets.push(offset);
    times.push(time);
  }

  return (target) => {
    const clamped = Math.max(0, Math.min(totalOffset, target));
    let i = 1;
    while (i < offsets.length - 1 && offsets[i] < clamped) i++;
    const t0 = offsets[i - 1];
    const t1 = offsets[i];
    return t1 === t0 ? times[i - 1] : times[i - 1] + (times[i] - times[i - 1]) * (clamped - t0) / (t1 - t0);
  };
}

/**
 * Loudness as a function of notated offset: a step at every printed
 * dynamic, ramped smoothly across a crescendo/diminuendo wedge's span
 * toward whichever dynamic follows it — `generate.js` always adds one 1-2
 * bars after a wedge's stop — rather than jumping the instant the wedge
 * ends.
 */
function buildDynamicsEnvelope(timeline) {
  const marks = timeline
    .filter(({ direction }) => direction.kind === 'dynamics')
    .map(({ offset, direction }) => ({ offset, level: DYNAMIC_GAIN[direction.value] ?? 1 }));
  const wedges = [];
  let open = null;
  for (const { offset, direction } of timeline) {
    if (direction.kind !== 'wedge') continue;
    if (direction.type === 'start') open = offset;
    else if (direction.type === 'stop' && open !== null) {
      wedges.push({ start: open, end: offset });
      open = null;
    }
  }

  const levelBefore = (offset) => {
    let level = marks.length ? marks[0].level : 1;
    for (const mark of marks) {
      if (mark.offset > offset) break;
      level = mark.level;
    }
    return level;
  };
  const levelAtOrAfter = (offset) => {
    for (const mark of marks) if (mark.offset >= offset) return mark.level;
    return marks.length ? marks[marks.length - 1].level : 1;
  };

  return (offset) => {
    const wedge = wedges.find((range) => offset >= range.start && offset < range.end);
    if (!wedge) return levelBefore(offset);
    const from = levelBefore(wedge.start);
    const to = levelAtOrAfter(wedge.end);
    const fraction = wedge.end > wedge.start ? (offset - wedge.start) / (wedge.end - wedge.start) : 1;
    return from + (to - from) * fraction;
  };
}

/**
 * Sustain-pedal spans, in notated-offset terms. The mid-span `change`
 * notches `addMidBarPedalChange`/`addPedalMarking` write at each harmony
 * change mark a lift-and-immediately-redepress for the *engraving*, but the
 * pedal is never actually up in between, so the whole start-to-stop run
 * counts as one continuously pedalled span for the audio envelope.
 */
function buildPedalRanges(timeline) {
  const ranges = [];
  let open = null;
  for (const { offset, direction } of timeline) {
    if (direction.kind !== 'pedal') continue;
    if (direction.type === 'start') open ??= offset;
    else if (direction.type === 'stop' && open !== null) {
      ranges.push({ start: open, end: offset });
      open = null;
    }
  }
  return ranges;
}

/**
 * Low strings sit left, high strings right, from the player's seat. Kept
 * narrow (±0.32) — wider reads as two pianos rather than one.
 */
function panFor(midi) {
  const position = Math.max(0, Math.min(1, (midi - 21) / 87));
  return (position - 0.5) * 0.64;
}

function nearest(samples, midi) {
  let best = samples[0];
  let bestDistance = Infinity;
  for (const sample of samples) {
    const distance = Math.abs(sample.midi - midi);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = sample;
    }
  }
  return best;
}

/**
 * Duration and gain shaping for engraved articulation marks, matching
 * ScrollScore's `applyArticulation` — the same vocabulary this project's
 * MusicXML output already writes (`musicxml.js` pushes MusicXML tag names
 * straight into `event.articulations`, so the strings checked here are
 * `staccato`/`tenuto`/`staccatissimo`/`accent`/`strong-accent`, not the
 * rules table's `marcato` label). `sustain` is carved out of the note's own
 * written duration; the gap to the next note's onset — left untouched — is
 * what actually makes a shortened note audible as detached rather than just
 * quieter.
 */
function applyArticulation(sustain, duration, articulations) {
  if (!articulations?.length) return { sustain, gain: 1 };
  let s = sustain;
  let gain = 1;
  if (articulations.includes('staccatissimo')) s = duration * 0.25;
  else if (articulations.includes('staccato')) s = duration * 0.5;
  // Tenuto overrides even a competing shortening mark: holding a note its
  // full value is the entire point of the sign.
  if (articulations.includes('tenuto')) s = Math.max(s, duration * 0.98);
  if (articulations.includes('strong-accent')) gain = 1.5;
  else if (articulations.includes('accent')) gain = 1.3;
  return { sustain: s, gain };
}

function sampledNote(context, buses, samples, midi, at, duration, envelope = {}) {
  const { tail = TAIL, gainScale = 1, articulations = null } = envelope;
  const sample = nearest(samples, midi);
  const rate = 2 ** ((midi - sample.midi) / 12);

  const source = context.createBufferSource();
  source.buffer = sample.buffer;
  source.playbackRate.setValueAtTime(rate, at);

  const { sustain, gain: articGain } = applyArticulation(Math.max(duration, 0.1), duration, articulations);
  const peak = PEAK_GAIN * gainScale * articGain;
  // The recording may be shorter than the note needs; loop its tail to hold on.
  const needed = (sustain + tail) * rate;
  if (sample.buffer.duration < needed && sample.buffer.duration > 0.3) {
    const loopLength = Math.min(0.6, sample.buffer.duration * 0.3);
    source.loop = true;
    source.loopStart = Math.max(0, sample.buffer.duration - loopLength);
    source.loopEnd = sample.buffer.duration;
  }

  const gain = context.createGain();
  gain.gain.setValueAtTime(peak, at);
  // A struck string decays at a fixed rate per second, so a long note and a
  // short one lose loudness at the same speed.
  const decayEnd = Math.max(at + sustain, at + 0.02);
  const endLevel = Math.max(0.06, Math.exp(-(decayEnd - at) / DECAY_TAU));
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * endLevel), decayEnd);
  gain.gain.exponentialRampToValueAtTime(0.0001, decayEnd + tail);

  const panner = context.createStereoPanner();
  panner.pan.value = panFor(midi);

  source.connect(gain).connect(panner);
  panner.connect(buses.master);

  const send = context.createGain();
  send.gain.value = REVERB_SEND;
  panner.connect(send).connect(buses.reverbBus);

  source.start(at);
  source.stop(decayEnd + tail + 0.05);
  return source;
}

/** Only reached if the sample set cannot be fetched at all. */
function fallbackNote(context, buses, midi, at, duration, envelope = {}) {
  const { tail = TAIL, gainScale = 1, articulations = null } = envelope;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const panner = context.createStereoPanner();
  const { sustain, gain: articGain } = applyArticulation(Math.max(duration * 0.92, 0.09), duration, articulations);
  const peak = 0.25 * gainScale * articGain;

  oscillator.type = 'triangle';
  oscillator.frequency.value = 440 * 2 ** ((midi - 69) / 12);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + sustain + tail);
  panner.pan.value = panFor(midi);

  oscillator.connect(gain).connect(panner);
  panner.connect(buses.master);
  const send = context.createGain();
  send.gain.value = REVERB_SEND;
  panner.connect(send).connect(buses.reverbBus);

  oscillator.start(at);
  oscillator.stop(at + sustain + tail + 0.05);
  return oscillator;
}

/**
 * Room impulse response, built rather than downloaded.
 * Independent noise per channel gives the tail real stereo width; the
 * one-pole low-pass darkens it over time the way a room absorbs highs; the
 * discrete early reflections are what actually convey the size of the space.
 */
function impulseResponse(context, seconds, decayPower) {
  const rate = context.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const buffer = context.createBuffer(2, length, rate);

  for (let channel = 0; channel < 2; channel++) {
    const samples = buffer.getChannelData(channel);
    let lowpass = 0;
    for (let i = 0; i < length; i++) {
      const progress = i / length;
      const noise = (Math.random() * 2 - 1) * (1 - progress) ** decayPower;
      const coefficient = 0.42 * (1 - progress * 0.8) + 0.02;
      lowpass += coefficient * (noise - lowpass);
      samples[i] = lowpass;
    }
    const early = [0.011, 0.019, 0.031, 0.044, 0.058, 0.077];
    early.forEach((time, index) => {
      const position = Math.floor(rate * (time + (channel ? 0.0031 : 0)));
      if (position < length) {
        samples[position] += (0.55 - index * 0.07) * (channel ? -1 : 1) * 0.6;
      }
    });
  }
  return buffer;
}
