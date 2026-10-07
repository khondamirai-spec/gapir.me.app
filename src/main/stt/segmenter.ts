import { SAMPLE_RATE, BYTES_PER_SAMPLE, rms } from '../audio';

/**
 * Cuts a running dictation into pieces at the speaker's pauses.
 *
 * A dictation used to be one clip, posted once the hotkey came up. That made the wait after
 * release grow with the length of the utterance, and it capped a dictation at whatever one
 * request could carry (two minutes on the proxy). Cutting while the user is still talking
 * fixes both: every piece but the last has been transcribed by the time they let go, and no
 * single upload is ever large — see chunked.ts, which drives this.
 *
 * Where to cut is the whole problem. Gemini transcribes each piece with no knowledge of its
 * neighbours, so a cut through a word loses the word and a cut mid-sentence tends to come
 * back with a full stop glued on. So a piece is only closed at a *pause* — a run of quiet
 * frames — once it is at least `targetMs` long, and the cut goes in the middle of that pause
 * so both sides keep a little silence around their speech. Someone who never pauses still
 * gets cut at `maxMs`, at the quietest moment of the last few seconds: a bad cut is better
 * than a piece that grows until the server refuses it.
 *
 * Pure: no timers, no I/O, and it does not care how ffmpeg sizes its chunks — audio is
 * re-framed into fixed `FRAME_MS` frames internally.
 */

export interface SegmenterOptions {
  /** A piece is not closed before it is this long, however many pauses it has. */
  targetMs: number;
  /** A piece is closed at this length even without a pause. Must stay well under the
   *  server's per-clip cap (`plan_limits.max_clip_ms`, two minutes). */
  maxMs: number;
  /** How long a quiet run must be to count as a pause worth cutting at. */
  pauseMs: number;
}

/**
 * 20 s / 45 s / 350 ms.
 *
 * The target is a trade: shorter pieces mean less to transcribe after release (the latency
 * win) but more seams in the text and more requests against the free plan's six-a-minute
 * burst cap. Twenty seconds keeps a continuous talker at about three requests a minute and
 * leaves at most ~20–45 s of audio for the final round trip. 350 ms is longer than the gap
 * between words and about the length of a breath between phrases.
 */
export const DEFAULT_SEGMENTER_OPTIONS: SegmenterOptions = {
  targetMs: 20_000,
  maxMs: 45_000,
  pauseMs: 350
};

const FRAME_MS = 50;
const FRAME_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * FRAME_MS) / 1000;

/**
 * Bounds on the "is this frame quiet" threshold, in the 0..1 RMS of audio.ts. The floor is
 * about -46 dBFS — below it is room noise on any microphone worth the name — and the ceiling
 * stops a noisy room from making ordinary speech count as silence.
 */
const QUIET_MIN = 0.005;
const QUIET_MAX = 0.04;

/** How far back from `maxMs` a forced cut may look for its quietest moment. */
const FORCED_CUT_WINDOW_MS = 3_000;

/** Milliseconds of 16 kHz mono s16le in `bytes`. */
export function pcmMs(bytes: number): number {
  return (bytes / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000;
}

/** The loudest `FRAME_MS` frame in a clip, as 0..1 RMS. Used to drop a silent tail. */
export function peakLevel(pcm: Buffer): number {
  let peak = 0;
  for (let at = 0; at + FRAME_BYTES <= pcm.length; at += FRAME_BYTES) {
    peak = Math.max(peak, rms(pcm.subarray(at, at + FRAME_BYTES)));
  }
  return peak;
}

/**
 * The level below which a frame counts as a pause, estimated from the piece itself.
 *
 * Speech is full of short gaps, so the quietest fifth of a piece's frames is a fair reading
 * of the room. Measured per piece rather than fixed because microphones differ by an order
 * of magnitude in gain, and a fixed number is either deaf on a quiet laptop mic or hears a
 * pause in every syllable on a loud headset.
 */
export function quietThreshold(levels: readonly number[]): number {
  if (levels.length === 0) return QUIET_MIN;
  const sorted = [...levels].sort((a, b) => a - b);
  const noise = sorted[Math.floor(sorted.length * 0.2)];
  return Math.min(QUIET_MAX, Math.max(QUIET_MIN, noise * 2.5));
}

export class Segmenter {
  /** Bytes that have arrived but do not yet fill a frame. */
  private pending: Buffer = Buffer.alloc(0);
  /** The open piece, one entry per frame, with each frame's level alongside. */
  private frames: Buffer[] = [];
  private levels: number[] = [];
  /** Fixed once the piece reaches its target length, so it is not re-sorted every frame. */
  private threshold: number | null = null;
  private quietRun = 0;

  private readonly targetFrames: number;
  private readonly maxFrames: number;
  private readonly pauseFrames: number;

  constructor(
    private readonly onSegment: (pcm: Buffer) => void,
    opts: SegmenterOptions = DEFAULT_SEGMENTER_OPTIONS
  ) {
    this.targetFrames = Math.ceil(opts.targetMs / FRAME_MS);
    this.maxFrames = Math.max(this.targetFrames, Math.floor(opts.maxMs / FRAME_MS));
    this.pauseFrames = Math.max(1, Math.ceil(opts.pauseMs / FRAME_MS));
  }

  push(chunk: Buffer): void {
    const buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let at = 0;
    for (; at + FRAME_BYTES <= buf.length; at += FRAME_BYTES) {
      this.addFrame(buf.subarray(at, at + FRAME_BYTES));
    }
    // Copied, not sliced: a subarray would pin ffmpeg's whole chunk in memory.
    this.pending = Buffer.from(buf.subarray(at));
  }

  /** Close the dictation: everything not yet handed out, as one final piece (maybe empty). */
  flush(): Buffer {
    const rest = Buffer.concat([...this.frames, this.pending]);
    this.frames = [];
    this.levels = [];
    this.pending = Buffer.alloc(0);
    this.threshold = null;
    this.quietRun = 0;
    return rest;
  }

  private addFrame(frame: Buffer): void {
    const level = rms(frame);
    this.frames.push(frame);
    this.levels.push(level);

    const n = this.frames.length;
    if (n < this.targetFrames) return;

    if (this.threshold === null) {
      this.threshold = quietThreshold(this.levels);
      // Count back over the quiet frames that led up to the target, so a pause already in
      // progress when the piece came of age is not made to start over.
      this.quietRun = 0;
      for (let i = n - 1; i >= 0 && this.levels[i] < this.threshold; i--) this.quietRun++;
    } else {
      this.quietRun = level < this.threshold ? this.quietRun + 1 : 0;
    }

    if (this.quietRun >= this.pauseFrames) {
      // The middle of the pause: both pieces keep some silence at the seam.
      this.cut(n - Math.floor(this.quietRun / 2));
    } else if (n >= this.maxFrames) {
      this.cut(this.quietestFrame());
    }
  }

  /**
   * Where a forced cut goes: the quietest moment of the last few seconds, smoothed over three
   * frames so one dropped sample is not mistaken for a gap between words.
   */
  private quietestFrame(): number {
    const n = this.frames.length;
    const from = Math.max(1, n - Math.floor(FORCED_CUT_WINDOW_MS / FRAME_MS));
    let best = n;
    let bestLevel = Infinity;
    for (let i = from; i < n - 1; i++) {
      const smoothed = (this.levels[i - 1] + this.levels[i] + this.levels[i + 1]) / 3;
      if (smoothed < bestLevel) {
        bestLevel = smoothed;
        best = i;
      }
    }
    return best;
  }

  /** Hand out frames [0, at) as a piece and keep the rest as the start of the next one. */
  private cut(at: number): void {
    const piece = Buffer.concat(this.frames.slice(0, at));
    this.frames = this.frames.slice(at);
    this.levels = this.levels.slice(at);
    this.threshold = null;
    this.quietRun = 0;
    this.onSegment(piece);
  }
}

export const _internals = { FRAME_MS, FRAME_BYTES, QUIET_MIN, QUIET_MAX };
