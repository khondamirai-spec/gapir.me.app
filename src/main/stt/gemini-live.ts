import WebSocket from 'ws';
import { SAMPLE_RATE } from '../audio';
import { sanitizeTranscript, transcriptionPrompt } from './gemini-common';
import { SttError, type SttAdapter, type SttSession, type SttSessionOptions } from './types';

/**
 * Gemini Live API over WebSocket — the streaming experiment, off by default.
 *
 * This is the answer to "can I see the words while I'm still speaking?" — yes, technically:
 * the Live API takes 16 kHz mono s16le exactly as ffmpeg already produces it,
 * and with `inputAudioTranscription` enabled it streams back an ASR transcript of what you
 * said as you say it.
 *
 * It is nevertheless not the default, for three honest reasons:
 *
 *  1. The Live API is built for conversation, not dictation. The model on the other end
 *     wants to reply to you; we are paying it to keep quiet and hand over the ASR track.
 *  2. Live model ids churn faster than any other part of Google's surface, and a wrong one
 *     is a setup failure at hotkey-press time. Hence GAPIR_ME_GEMINI_LIVE_MODEL, and
 *     hence `npm run spike -- --models` to list what a key can actually reach.
 *  3. Live pricing is not the same bargain as batch audio tokens.
 *
 * None of that can cost a dictation, because the state machine keeps every PCM chunk: if
 * this socket never opens, or opens and says nothing useful, the same audio goes to
 * gemini-batch and the user sees a little latency rather than a failure.
 */

const WS_URL =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/** Overridable without a rebuild — see reason 2 above. */
const LIVE_MODEL = process.env.GAPIR_ME_GEMINI_LIVE_MODEL || 'gemini-2.0-flash-live-001';

const OPEN_TIMEOUT_MS = 5_000;
const FINAL_TIMEOUT_MS = 15_000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Pull the incremental ASR text out of a serverContent frame.
 *
 * These are *fragments*, not successive whole transcripts: Gemini sends "sa", "lom",
 * " dun", "yo" and the caller must concatenate them. Overwriting instead — the natural
 * thing to write if you assume a streaming ASR resends the sentence so far — leaves you
 * with the last syllable of every dictation, which is exactly the bug this comment exists
 * to stop someone reintroducing.
 */
export function extractInputTranscription(msg: Record<string, unknown>): string | null {
  const content = asRecord(msg.serverContent);
  const transcription = asRecord(content?.inputTranscription);
  const text = transcription?.text;
  return typeof text === 'string' && text.length > 0 ? text : null;
}

/** The model's own reply, kept only as a fallback for when the ASR track stays empty. */
export function extractModelText(msg: Record<string, unknown>): string | null {
  const content = asRecord(msg.serverContent);
  const turn = asRecord(content?.modelTurn);
  const parts = Array.isArray(turn?.parts) ? (turn.parts as unknown[]) : [];

  const chunks: string[] = [];
  for (const part of parts) {
    const record = asRecord(part);
    if (!record || record.thought === true) continue;
    if (typeof record.text === 'string' && record.text.length > 0) chunks.push(record.text);
  }
  return chunks.length > 0 ? chunks.join('') : null;
}

/** Has the server finished this turn? Both spellings appear depending on model version. */
export function isTurnComplete(msg: Record<string, unknown>): boolean {
  const content = asRecord(msg.serverContent);
  if (!content) return false;
  return content.turnComplete === true || content.generationComplete === true;
}

class GeminiLiveSession implements SttSession {
  private ws: WebSocket;
  /** True once the server has acknowledged `setup`, not merely once the socket is open. */
  private ready = false;
  private cancelled = false;
  private ended = false;
  /** Audio captured before the setup handshake completed. */
  private pending: Buffer[] = [];
  /** Accumulated ASR fragments — see extractInputTranscription. */
  private transcript = '';
  /** The model's own reply, used only if the ASR track produced nothing. */
  private modelText = '';
  private final = deferred<string>();
  private finalTimer: NodeJS.Timeout | null = null;

  constructor(private opts: SttSessionOptions) {
    this.ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(opts.apiKey)}`);
    this.ws.binaryType = 'nodebuffer';

    const openTimer = setTimeout(() => {
      if (!this.ready) {
        this.ws.terminate();
        this.final.reject(new SttError('Gemini Live ulanmadi (timeout)', true));
      }
    }, OPEN_TIMEOUT_MS);

    this.ws.on('open', () => {
      // The socket being open is not permission to send audio; `setup` must be
      // acknowledged first, so the open timer keeps running until setupComplete arrives.
      this.send({
        setup: {
          model: `models/${LIVE_MODEL}`,
          generationConfig: { responseModalities: ['TEXT'], temperature: 0 },
          systemInstruction: {
            parts: [
              {
                text: transcriptionPrompt({
                  language: opts.language,
                  style: opts.style
                })
              }
            ]
          },
          inputAudioTranscription: {}
        }
      });
    });

    this.ws.on('message', (data) => {
      clearTimeout(openTimer);
      this.onMessage(data);
    });

    this.ws.on('error', (err) => {
      clearTimeout(openTimer);
      this.final.reject(new SttError(`Gemini Live socket xatosi: ${err.message}`, true));
    });

    this.ws.on('close', (code, reason) => {
      clearTimeout(openTimer);
      if (this.cancelled) return;
      const text = this.best();
      if (this.ended && text) this.final.resolve(text);
      else if (this.ended) {
        this.final.reject(
          new SttError(
            `Gemini Live matnsiz yopildi (code ${code}${reason.length ? `: ${reason.toString()}` : ''})`,
            true
          )
        );
      }
    });
  }

  /**
   * Gemini sends its JSON as *binary* frames, not text frames — so this must NOT skip
   * binary data, however much it looks like audio. Everything is decoded as UTF-8 and
   * offered to the JSON parser.
   */
  private onMessage(data: WebSocket.RawData): void {
    const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);

    if (process.env.GAPIR_ME_LOG_FRAMES === '1') {
      console.log('[gemini-live] <-', raw.slice(0, 500));
    }

    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      const record = asRecord(parsed);
      if (!record) return;
      msg = record;
    } catch {
      console.warn('[gemini-live] non-JSON frame:', raw.slice(0, 200));
      return;
    }

    if (msg.setupComplete !== undefined) {
      this.ready = true;
      for (const chunk of this.pending) this.sendAudio(chunk);
      this.pending = [];
      if (this.ended) this.sendStreamEnd();
      return;
    }

    if (msg.error) {
      const detail = asRecord(msg.error)?.message;
      this.final.reject(
        new SttError(`Gemini Live: ${typeof detail === 'string' ? detail : JSON.stringify(msg.error)}`, true)
      );
      return;
    }

    // The server is about to drop the connection — settle with what we have rather than
    // waiting out the final timer for a socket that is already leaving.
    if (msg.goAway !== undefined) {
      if (this.ended) this.settle();
      return;
    }

    const fragment = extractInputTranscription(msg);
    if (fragment !== null) {
      this.transcript += fragment;
      this.opts.onPartial?.(this.transcript.trim());
    }

    const reply = extractModelText(msg);
    if (reply !== null) this.modelText += reply;

    if (isTurnComplete(msg) && this.ended) this.settle();
  }

  private best(): string {
    return sanitizeTranscript(this.transcript.trim() || this.modelText.trim());
  }

  private send(payload: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private sendAudio(chunk: Buffer): void {
    this.send({
      realtimeInput: {
        audio: {
          mimeType: `audio/pcm;rate=${SAMPLE_RATE}`,
          data: chunk.toString('base64')
        }
      }
    });
  }

  private sendStreamEnd(): void {
    this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  private settle(): void {
    if (this.finalTimer) clearTimeout(this.finalTimer);
    this.final.resolve(this.best());
    this.close();
  }

  pushAudio(chunk: Buffer): void {
    if (this.cancelled || this.ended) return;
    if (this.ready) this.sendAudio(chunk);
    else this.pending.push(chunk);
  }

  end(): Promise<string> {
    if (this.ended) return this.final.promise;
    this.ended = true;

    // Never opened and no longer trying — fail fast so the caller reaches batch sooner.
    if (!this.ready && this.ws.readyState !== WebSocket.CONNECTING) {
      this.final.reject(new SttError('Gemini Live ochilmadi', true));
      return this.final.promise;
    }

    if (this.ready) this.sendStreamEnd();

    this.finalTimer = setTimeout(() => {
      const text = this.best();
      if (text) this.final.resolve(text);
      else this.final.reject(new SttError('Gemini Live javobini kutib bo‘lmadi', true));
      this.close();
    }, FINAL_TIMEOUT_MS);

    return this.final.promise;
  }

  cancel(): void {
    this.cancelled = true;
    if (this.finalTimer) clearTimeout(this.finalTimer);
    this.close();
    this.final.resolve('');
  }

  private close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}

export const geminiLive: SttAdapter = {
  name: 'gemini-live',
  async startSession(opts: SttSessionOptions): Promise<SttSession> {
    return new GeminiLiveSession(opts);
  }
};

export const _internals = { LIVE_MODEL, WS_URL };
