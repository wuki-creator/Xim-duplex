// PCM16 mono at 16 kHz. Retain the most recent 800 ms while waiting for speech.
const BYTES_PER_MS = 32;
const PRE_ROLL_BYTES = 800 * BYTES_PER_MS;

export class VadSegmenter {
  constructor({onStart, onEnd, threshold = .012, startMs = 160, silenceMs = 700, maxMs = 14000}) {
    Object.assign(this, {onStart, onEnd, threshold, startMs, silenceMs, maxMs});
    this.preRoll = Buffer.alloc(PRE_ROLL_BYTES);
    this.reset();
  }

  reset() {
    this.frames = [];
    this.writeAt = 0;
    this.preRollSize = 0;
    this.voiced = 0;
    this.silence = 0;
    this.duration = 0;
    this.active = false;
  }

  finish() {
    if (!this.active) return false;
    const pcm = Buffer.concat(this.frames);
    this.reset();
    this.onEnd(pcm);
    return true;
  }

  bufferPreRoll(frame) {
    const size = Math.min(frame.length, PRE_ROLL_BYTES);
    const offset = frame.length - size;
    const first = Math.min(size, PRE_ROLL_BYTES - this.writeAt);
    frame.copy(this.preRoll, this.writeAt, offset, offset + first);
    if (first < size) frame.copy(this.preRoll, 0, offset + first);
    this.writeAt = (this.writeAt + size) % PRE_ROLL_BYTES;
    this.preRollSize = Math.min(this.preRollSize + size, PRE_ROLL_BYTES);
  }

  push(frame) {
    if (frame.length === 0) return;
    let power = 0;
    for (let i = 0; i < frame.length; i += 2) {
      const sample = frame.readInt16LE(i);
      power += sample * sample;
    }
    const rms = Math.sqrt(power / (frame.length / 2)) / 32768;
    const ms = frame.length / BYTES_PER_MS;
    if (!this.active) {
      this.bufferPreRoll(frame);
      this.voiced = rms >= this.threshold ? this.voiced + ms : 0;
      if (this.voiced >= this.startMs) {
        // The ring stays read-only until finish() copies the utterance or reset() discards it.
        if (this.preRollSize === PRE_ROLL_BYTES && this.writeAt > 0) {
          this.frames.push(this.preRoll.subarray(this.writeAt));
        }
        const end = this.writeAt || this.preRollSize;
        this.frames.push(this.preRoll.subarray(0, end));
        this.active = true;
        this.duration = this.voiced;
        this.onStart();
      }
      return;
    }
    this.frames.push(Buffer.from(frame));
    this.duration += ms;
    this.silence = rms < this.threshold * .8 ? this.silence + ms : 0;
    if (this.silence >= this.silenceMs || this.duration >= this.maxMs) this.finish();
  }
}
