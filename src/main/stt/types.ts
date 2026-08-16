import type { Language, StyleSettings } from '@shared/types';

/**
 * Provider-agnostic STT interface.
 *
 * Gemini's batch and Live transports are the two implementations today, and the boundary
 * earns its keep by letting the state machine treat them identically — realtime first,
 * batch on any failure. Swapping in ElevenLabs Scribe or a self-hosted whisper-uz
 * fine-tune would be the same shape of change.
 */

export interface SttSessionOptions {
  language: Language;
  /**
   * The Gemini key, for the adapters that call Google directly.
   *
   * Empty on the proxy path, which is the one every installed copy uses: there the key is a
   * server secret and the app authenticates as a *user* instead. See proxy-batch.ts.
   */
  apiKey: string;
  /** Model id. Comes from `geminiModel()` in src/main/config.ts, not from a setting. */
  model?: string;
  /** How the transcript should read — turned into prompt rules by the adapter. */
  style?: StyleSettings;
  /** Called with interim results, if the transport streams them. */
  onPartial?: (text: string) => void;
}

export interface SttSession {
  /** Feed 16 kHz mono s16le PCM. Safe to call before the transport is ready. */
  pushAudio(chunk: Buffer): void;
  /** Signal end of speech; resolves with the final transcript. */
  end(): Promise<string>;
  /** Abandon the session — no transcript, no paste. */
  cancel(): void;
}

export interface SttAdapter {
  readonly name: string;
  startSession(opts: SttSessionOptions): Promise<SttSession>;
}

/**
 * Why a transcription failed, when the answer changes what the caller should do next.
 *
 * `quota` is the one that earns its place: it is the difference between "this key is spent,
 * try the next one in the pool" and "stop, nothing will help" — and on a free tier it is a
 * routine operating condition rather than an exception.
 *
 * `plan` is its counterpart on the proxy path and is **not** the same failure, however
 * similar the message looks. `quota` is our problem and the user can do nothing about it;
 * `plan` is the user's daily allowance running out, and the answer is an offer to upgrade.
 * Collapsing the two would show someone an upgrade button for our outage, or an outage
 * message for a paywall.
 */
export type SttErrorCode = 'quota' | 'auth' | 'model' | 'plan';

export class SttError extends Error {
  constructor(
    message: string,
    /** True when retrying via a different transport might succeed. */
    readonly recoverable: boolean = true,
    readonly code?: SttErrorCode
  ) {
    super(message);
    this.name = 'SttError';
  }
}
