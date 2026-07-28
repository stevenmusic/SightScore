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
    clearTimeout(stopTimer);
    stopTimer = null;
  };

  return {
    get playing() {
      return voices.length > 0;
    },
    /** Start fetching the samples before anyone presses play. */
    preload: download,
    stop,
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
      let end = start;

      for (const staffNumber of [1, 2]) {
        let offset = 0;
        for (const bar of score.staves[staffNumber]) {
          for (const event of bar.events) {
            if (!event.rest) {
              const at = start + offset * secondsPerDivision;
              const duration = event.dur * secondsPerDivision;
              for (const pitch of [event.pitch, ...(event.chord ?? [])]) {
                const voice = samples?.length
                  ? sampledNote(context, { master, reverbBus }, samples, pitch.midi, at, duration)
                  : fallbackNote(context, { master, reverbBus }, pitch.midi, at, duration);
                voices.push(voice);
              }
              end = Math.max(end, at + duration);
            }
            offset += event.dur;
          }
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

function sampledNote(context, buses, samples, midi, at, duration) {
  const sample = nearest(samples, midi);
  const rate = 2 ** ((midi - sample.midi) / 12);

  const source = context.createBufferSource();
  source.buffer = sample.buffer;
  source.playbackRate.setValueAtTime(rate, at);

  const sustain = Math.max(duration, 0.1);
  // The recording may be shorter than the note needs; loop its tail to hold on.
  const needed = (sustain + TAIL) * rate;
  if (sample.buffer.duration < needed && sample.buffer.duration > 0.3) {
    const loopLength = Math.min(0.6, sample.buffer.duration * 0.3);
    source.loop = true;
    source.loopStart = Math.max(0, sample.buffer.duration - loopLength);
    source.loopEnd = sample.buffer.duration;
  }

  const gain = context.createGain();
  gain.gain.setValueAtTime(PEAK_GAIN, at);
  // A struck string decays at a fixed rate per second, so a long note and a
  // short one lose loudness at the same speed.
  const decayEnd = Math.max(at + sustain, at + 0.02);
  const endLevel = Math.max(0.06, Math.exp(-(decayEnd - at) / DECAY_TAU));
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, PEAK_GAIN * endLevel), decayEnd);
  gain.gain.exponentialRampToValueAtTime(0.0001, decayEnd + TAIL);

  const panner = context.createStereoPanner();
  panner.pan.value = panFor(midi);

  source.connect(gain).connect(panner);
  panner.connect(buses.master);

  const send = context.createGain();
  send.gain.value = REVERB_SEND;
  panner.connect(send).connect(buses.reverbBus);

  source.start(at);
  source.stop(decayEnd + TAIL + 0.05);
  return source;
}

/** Only reached if the sample set cannot be fetched at all. */
function fallbackNote(context, buses, midi, at, duration) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const panner = context.createStereoPanner();
  const sustain = Math.max(duration * 0.92, 0.09);

  oscillator.type = 'triangle';
  oscillator.frequency.value = 440 * 2 ** ((midi - 69) / 12);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.25, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + sustain);
  panner.pan.value = panFor(midi);

  oscillator.connect(gain).connect(panner);
  panner.connect(buses.master);
  const send = context.createGain();
  send.gain.value = REVERB_SEND;
  panner.connect(send).connect(buses.reverbBus);

  oscillator.start(at);
  oscillator.stop(at + sustain + 0.05);
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
