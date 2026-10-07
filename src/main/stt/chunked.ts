import {
  DEFAULT_SEGMENTER_OPTIONS,
  Segmenter,
  peakLevel,
  pcmMs,
  type SegmenterOptions
} from './segmenter';

/**
 * A dictation transcribed piece by piece *while it is still being spoken*.
 *
 * The segmenter closes a piece at a pause every 20-odd seconds and this hands it straight to
 * the batch transport — the proxy on an installed copy, Gemini directly on a developer's
 * `.env` key — without waiting for the hotkey to come up. By release, every piece but the
 * last is already back, so the wait after release is one short clip's round trip however long
 * the user talked, and there is no length limit beyond the auto-stop in state.ts.
 *
 * Nothing on the server changes: each piece is an ordinary dictation to `transcribe`, with
 * its own quota check and its own word count. Two consequences are deliberate:
 *
 * - **A failure keeps what came before it.** If piece 3 fails (most likely: the weekly words
 *   ran out at piece 3), pieces 1–2 were transcribed, charged and are the user's — throwing
 *   them away would bill someone for words they never got. `end()` returns the unbroken run
 *   of pieces up to the first failure, plus that failure, and the caller pastes the text and
 *   then shows the error. A failure in the *first* piece is just a failed dictation.
 * - **Later pieces after a failure are dropped, not stitched around the hole.** A paragraph
 *   with its middle missing reads as if the user said something they didn't.
 */

/** Transcribe one piece of 16 kHz mono s16le PCM. Throws as the batch adapters do. */
export type SegmentTranscriber = (pcm: Buffer, index: number) => Promise<string>;

export interface ChunkedResult {
  text: string;
  /** How many pieces the dictation was sent as. */
  segments: number;
  /** Set when a piece after the first failed — `text` is everything before it. */
  error?: unknown;
}

/**
 * A final piece shorter than this that is also silent is dropped instead of sent: it is the
 * breath after the last sentence, cut off from it by a pause, and sending it costs a round
 * trip on the one request the user is actually waiting for.
 */
const SILENT_TAIL_MS = 1_500;
const SILENT_TAIL_LEVEL = 0.02;

type Settled = { ok: true; text: string } | { ok: false; error: unknown };

export class ChunkedTranscription {
  private readonly segmenter: Segmenter;
  private readonly results: Promise<Settled>[] = [];
  /** Settled pieces in order, for the running partial on the pill. */
  private readonly settled: (Settled | undefined)[] = [];
  private cancelled = false;
  private ended = false;

  constructor(
    private readonly transcribe: SegmentTranscriber,
    private readonly onPartial: (text: string) => void = () => {},
    opts: SegmenterOptions = DEFAULT_SEGMENTER_OPTIONS
  ) {
    this.segmenter = new Segmenter((pcm) => this.send(pcm), opts);
  }

  pushAudio(chunk: Buffer): void {
    if (this.cancelled || this.ended) return;
    this.segmenter.push(chunk);
  }

  /** Close the last piece, wait for every piece, and join them in spoken order. */
  async end(): Promise<ChunkedResult> {
    this.ended = true;
    const tail = this.segmenter.flush();
    const silentTail =
      this.results.length > 0 && pcmMs(tail.length) < SILENT_TAIL_MS && peakLevel(tail) < SILENT_TAIL_LEVEL;
    if (tail.length > 0 && !silentTail) this.send(tail);

    const settled = await Promise.all(this.results);
    const segments = settled.length;
    const failedAt = settled.findIndex((s) => !s.ok);
    if (failedAt === 0) throw (settled[0] as { error: unknown }).error;

    const text = joinPieces(settled.slice(0, failedAt === -1 ? segments : failedAt));
    if (failedAt === -1) return { text, segments };
    return { text, segments, error: (settled[failedAt] as { error: unknown }).error };
  }

  /**
   * Stop caring about this dictation. Requests already sent run to completion — SttSession
   * has no abort, and a piece the server has transcribed has been charged either way — but
   * nothing new is sent and nothing is reported.
   */
  cancel(): void {
    this.cancelled = true;
    this.segmenter.flush();
  }

  private send(pcm: Buffer): void {
    if (this.cancelled) return;
    const index = this.results.length;
    const startedAt = Date.now();
    const result = this.transcribe(pcm, index).then(
      (text): Settled => ({ ok: true, text: text.trim() }),
      (error): Settled => ({ ok: false, error })
    );
    this.results.push(result);
    void result.then((s) => {
      console.log(
        `[chunk] #${index} audio=${(pcmMs(pcm.length) / 1000).toFixed(1)}s ` +
          `rtt=${Date.now() - startedAt}ms ${s.ok ? `chars=${s.text.length}` : 'failed'}`
      );
      this.settled[index] = s;
      this.reportPartial();
    });
  }

  /** The unbroken run of finished pieces from the start, as the pill's live text. */
  private reportPartial(): void {
    if (this.cancelled) return;
    const done: Settled[] = [];
    for (const s of this.settled) {
      if (!s || !s.ok) break;
      done.push(s);
    }
    if (done.length) this.onPartial(joinPieces(done));
  }
}

function joinPieces(pieces: Settled[]): string {
  return pieces
    .map((s) => (s.ok ? s.text : ''))
    .filter(Boolean)
    .join(' ');
}

export const _internals = { SILENT_TAIL_MS, SILENT_TAIL_LEVEL, joinPieces };
