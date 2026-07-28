/**
 * Reference playback of a generated test, straight from the score object —
 * no MIDI file, no sample library. A triangle wave with a short envelope is
 * plenty for "what should it have sounded like".
 */

export function createPlayer() {
  let context = null;
  let voices = [];
  let stopTimer = null;

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
    stop,
    /**
     * @param {object} score
     * @param {{onEnd?: () => void, tempoScale?: number}} [options]
     */
    play(score, options = {}) {
      stop();
      context ??= new (window.AudioContext ?? window.webkitAudioContext)();
      context.resume();

      const bpm = score.tempoBpm * (options.tempoScale ?? 1);
      const secondsPerDivision = 60 / bpm / score.divisions;
      const start = context.currentTime + 0.15;
      let end = start;

      const master = context.createGain();
      master.gain.value = 0.9;
      master.connect(context.destination);

      for (const staffNumber of [1, 2]) {
        let offset = 0;
        for (const bar of score.staves[staffNumber]) {
          for (const event of bar.events) {
            if (!event.rest) {
              const at = start + offset * secondsPerDivision;
              const duration = event.dur * secondsPerDivision;
              for (const pitch of [event.pitch, ...(event.chord ?? [])]) {
                voices.push(schedule(context, master, pitch.midi, at, duration, staffNumber));
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
      }, (end - context.currentTime + 0.4) * 1000);
    },
  };
}

function schedule(context, destination, midi, at, duration, staffNumber) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const sustain = Math.max(duration * 0.92, 0.08);
  const peak = staffNumber === 1 ? 0.22 : 0.16; // keep the left hand under the melody

  oscillator.type = 'triangle';
  oscillator.frequency.value = 440 * 2 ** ((midi - 69) / 12);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + sustain);

  oscillator.connect(gain).connect(destination);
  oscillator.start(at);
  oscillator.stop(at + sustain + 0.05);
  return oscillator;
}
