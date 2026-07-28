/**
 * Reference playback of a generated test, straight from the score object —
 * no MIDI file, no sample library.
 *
 * Signal path:
 *
 *   voice -> pan (hand) -+-> dry ----------+-> master -> out
 *                        |                 |
 *                        +-> pre-delay -> convolver (wet)
 *
 * The convolver runs a synthesised impulse response, so the room is built at
 * runtime rather than shipped as an audio file — nothing to download and it
 * still works offline. Space is on by default; `setSpace(0)` gives the old
 * dry sound back.
 */

const REVERB = {
  seconds: 2.4,
  decay: 2.6,
  preDelay: 0.02,
  /** Wet level at space = 1. */
  wet: 0.34,
};

/** Each hand is nudged off-centre so the texture opens up. */
const PAN = { 1: 0.18, 2: -0.18 };

export function createPlayer() {
  let context = null;
  let graph = null;
  let voices = [];
  let stopTimer = null;
  let space = 1;

  const build = () => {
    context ??= new (window.AudioContext ?? window.webkitAudioContext)();
    if (graph) return graph;

    const master = context.createGain();
    const dry = context.createGain();
    const wet = context.createGain();
    const preDelay = context.createDelay(0.5);
    const convolver = context.createConvolver();

    convolver.buffer = impulseResponse(context, REVERB.seconds, REVERB.decay);
    preDelay.delayTime.value = REVERB.preDelay;

    master.gain.value = 0.9;
    dry.connect(master);
    preDelay.connect(convolver).connect(wet).connect(master);
    master.connect(context.destination);

    graph = { master, dry, wet, preDelay, input: null };
    applySpace();
    return graph;
  };

  const applySpace = () => {
    if (!graph) return;
    graph.wet.gain.value = REVERB.wet * space;
    // Pull the dry signal back a little as the room comes up, so the overall
    // level stays put instead of swelling.
    graph.dry.gain.value = 1 - 0.25 * space;
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
    get space() {
      return space;
    },
    /** @param {number} amount 0 = dry, 1 = default room */
    setSpace(amount) {
      space = Math.min(Math.max(amount, 0), 1.5);
      applySpace();
    },
    stop,
    /**
     * @param {object} score
     * @param {{onEnd?: () => void, tempoScale?: number}} [options]
     */
    play(score, options = {}) {
      stop();
      const { dry, preDelay } = build();
      context.resume();

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
                voices.push(
                  schedule(context, { dry, preDelay }, pitch.midi, at, duration, staffNumber),
                );
              }
              end = Math.max(end, at + duration);
            }
            offset += event.dur;
          }
        }
      }

      // Let the tail ring out before reporting the end.
      const tail = REVERB.seconds * Math.min(space, 1) + 0.4;
      stopTimer = setTimeout(() => {
        voices = [];
        options.onEnd?.();
      }, (end - context.currentTime + tail) * 1000);
    },
  };
}

function schedule(context, destinations, midi, at, duration, staffNumber) {
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  const sustain = Math.max(duration * 0.92, 0.09);
  const peak = staffNumber === 1 ? 0.2 : 0.15; // keep the left hand under the melody

  const oscillator = context.createOscillator();
  const shimmer = context.createOscillator();
  const gain = context.createGain();
  const panner = context.createStereoPanner();

  oscillator.type = 'triangle';
  oscillator.frequency.value = frequency;
  // A quiet octave above gives the tone a little edge without a sample set.
  shimmer.type = 'sine';
  shimmer.frequency.value = frequency * 2;

  const shimmerGain = context.createGain();
  shimmerGain.gain.value = 0.18;

  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + sustain);

  panner.pan.value = PAN[staffNumber] ?? 0;

  oscillator.connect(gain);
  shimmer.connect(shimmerGain).connect(gain);
  gain.connect(panner);
  panner.connect(destinations.dry);
  panner.connect(destinations.preDelay);

  oscillator.start(at);
  shimmer.start(at);
  oscillator.stop(at + sustain + 0.05);
  shimmer.stop(at + sustain + 0.05);

  return { stop: () => { oscillator.stop(); shimmer.stop(); } };
}

/**
 * Exponentially decaying noise — a plain, neutral room. Built once per
 * AudioContext and reused for every note.
 */
function impulseResponse(context, seconds, decay) {
  const rate = context.sampleRate;
  const length = Math.floor(rate * seconds);
  const buffer = context.createBuffer(2, length, rate);

  for (let channel = 0; channel < 2; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const progress = i / length;
      // Slightly different noise per channel widens the stereo image.
      samples[i] = (Math.random() * 2 - 1) * (1 - progress) ** decay;
    }
  }
  return buffer;
}
