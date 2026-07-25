import WebSocket from 'ws';
import { SttError, type SttAdapter, type SttSession, type SttSessionOptions } from './types';

const WS_URL = 'wss://back.aisha.group/api/v1/stt/realtime';
/** How long to wait after {"event":"end"} for the server's final transcript. */
const FINAL_TIMEOUT_MS = 15_000;
const OPEN_TIMEOUT_MS = 5_000;

/**
 * Aisha realtime STT over WebSocket — the primary path.
 *
 * The socket is opened at hotkey-press time so the handshake overlaps with the user
 * drawing breath, which is most of why this feels instant rather than merely fast.
 *
 * Audio goes out as binary frames of raw PCM; the stream is terminated with a text
 * frame {"event":"end"}, after which the server sends its final transcript.
 *
 * NOTE ON FRAME PARSING: Aisha's public docs describe `session_started`, `transcription`
 * and `error` events but don't pin down every field name, so `extractText` below accepts
 * the several plausible spellings rather than betting on one. Unrecognised frames are
 * logged, not dropped silently — that's how we learn what the server really sends.
 */

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

/** Pull transcript text out of a server frame without over-committing to one schema. */
export function extractText(msg: Record<string, unknown>): string | null {
  for (const key of ['text', 'transcript', 'transcription', 'result']) {
    const v = msg[key];
    if (typeof v === 'string' && v.length > 0) return v;
    // Some APIs nest it one level: { transcription: { text: "..." } }
    if (v && typeof v === 'object') {
      const nested = (v as Record<string, unknown>).text;
      if (typeof nested === 'string' && nested.length > 0) return nested;
    }
  }
  return null;
}

/** Is this frame an interim result rather than a final one? */
export function isPartial(msg: Record<string, unknown>): boolean {
  for (const key of ['partial', 'is_partial', 'isPartial']) {
    if (typeof msg[key] === 'boolean') return msg[key] as boolean;
  }
  if (typeof msg.type === 'string') return msg.type.includes('partial');
  return false;
}

class AishaRealtimeSession implements SttSession {
  private ws: WebSocket;
  private opened = false;
  private cancelled = false;
  private ended = false;
  /** Audio captured before the socket finished its handshake. */
  private pending: Buffer[] = [];
  /** Best final transcript seen so far; partials accumulate here as a fallback. */
  private finalText = '';
  private lastPartial = '';
  private final = deferred<string>();
  private finalTimer: NodeJS.Timeout | null = null;

  constructor(private opts: SttSessionOptions) {
    const url =
      `${WS_URL}?format=pcm&token=${encodeURIComponent(opts.apiKey)}` +
      `&language=${encodeURIComponent(opts.language)}`;

    this.ws = new WebSocket(url);
    this.ws.binaryType = 'nodebuffer';

    const openTimer = setTimeout(() => {
      if (!this.opened) {
        this.ws.terminate();
        this.final.reject(new SttError('Timed out connecting to Aisha realtime', true));
      }
    }, OPEN_TIMEOUT_MS);

    this.ws.on('open', () => {
      clearTimeout(openTimer);
      this.opened = true;
      // Flush whatever the user already said while we were connecting.
      for (const chunk of this.pending) this.ws.send(chunk);
      this.pending = [];
      if (this.ended) this.sendEnd();
    });

    this.ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));

    this.ws.on('error', (err) => {
      clearTimeout(openTimer);
      this.final.reject(new SttError(`Aisha realtime socket error: ${err.message}`, true));
    });

    this.ws.on('close', (code, reason) => {
      clearTimeout(openTimer);
      if (this.cancelled) return;
      // A clean close after `end` means the server is done talking; settle with what we have.
      const text = this.finalText || this.lastPartial;
      if (this.ended && text) this.final.resolve(text);
      else if (this.ended) {
        this.final.reject(
          new SttError(
            `Aisha closed without a transcript (code ${code}${reason.length ? `: ${reason.toString()}` : ''})`,
            true
          )
        );
      }
    });
  }

  private onMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) return;

    // WHISPER_UZ_LOG_FRAMES=1 dumps every inbound frame verbatim. Aisha's docs don't
    // pin down the transcription frame shape, so this is how we learn it from the wire.
    if (process.env.WHISPER_UZ_LOG_FRAMES === '1') {
      console.log('[aisha-realtime] <-', data.toString().slice(0, 500));
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.warn('[aisha-realtime] non-JSON frame:', data.toString().slice(0, 200));
      return;
    }

    const event = typeof msg.event === 'string' ? msg.event : (msg.type as string) ?? '';

    if (event.includes('error') || msg.error) {
      const detail =
        (typeof msg.message === 'string' && msg.message) ||
        (typeof msg.error === 'string' && msg.error) ||
        JSON.stringify(msg);
      this.final.reject(new SttError(`Aisha: ${detail}`, true));
      return;
    }

    if (event.includes('session_started')) return;

    const text = extractText(msg);
    if (text === null) {
      console.debug('[aisha-realtime] unhandled frame:', JSON.stringify(msg).slice(0, 300));
      return;
    }

    if (isPartial(msg)) {
      this.lastPartial = text;
      this.opts.onPartial?.(text);
    } else {
      // Finals may arrive per-utterance; join them rather than overwriting.
      this.finalText = this.finalText ? `${this.finalText} ${text}`.trim() : text;
      this.opts.onPartial?.(this.finalText);
      // Once we've been told to end, the first final is what we're waiting for.
      if (this.ended) this.settle();
    }
  }

  private settle(): void {
    const text = (this.finalText || this.lastPartial).trim();
    if (this.finalTimer) clearTimeout(this.finalTimer);
    this.final.resolve(text);
    this.close();
  }

  pushAudio(chunk: Buffer): void {
    if (this.cancelled || this.ended) return;
    if (this.opened && this.ws.readyState === WebSocket.OPEN) this.ws.send(chunk);
    else this.pending.push(chunk);
  }

  private sendEnd(): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ event: 'end' }));
    }
  }

  end(): Promise<string> {
    if (this.ended) return this.final.promise;
    this.ended = true;

    // If the socket never opened, fail fast so the caller can fall back to batch.
    if (!this.opened && this.ws.readyState !== WebSocket.CONNECTING) {
      this.final.reject(new SttError('Aisha realtime socket never opened', true));
      return this.final.promise;
    }

    if (this.opened) this.sendEnd();

    this.finalTimer = setTimeout(() => {
      const text = (this.finalText || this.lastPartial).trim();
      if (text) this.final.resolve(text);
      else this.final.reject(new SttError('Timed out waiting for Aisha transcript', true));
      this.close();
    }, FINAL_TIMEOUT_MS);

    return this.final.promise;
  }

  cancel(): void {
    this.cancelled = true;
    if (this.finalTimer) clearTimeout(this.finalTimer);
    this.close();
    // Nobody is awaiting a cancelled session, but leave the promise settled.
    this.final.resolve('');
  }

  private close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}

export const aishaRealtime: SttAdapter = {
  name: 'aisha-realtime',
  async startSession(opts: SttSessionOptions): Promise<SttSession> {
    return new AishaRealtimeSession(opts);
  }
};
