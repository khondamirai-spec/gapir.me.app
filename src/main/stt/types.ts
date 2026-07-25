import type { Language } from '@shared/types';

/**
 * Provider-agnostic STT interface.
 *
 * Aisha is the only implementation today, but keeping the state machine behind this
 * boundary means swapping in ElevenLabs Scribe, a self-hosted whisper-uz fine-tune, or
 * running two providers side by side to compare Uzbek accuracy costs nothing later.
 */

export interface SttSessionOptions {
  language: Language;
  apiKey: string;
  /** Called with interim results, if the provider streams them. */
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

export class SttError extends Error {
  constructor(
    message: string,
    /** True when retrying via a different transport might succeed. */
    readonly recoverable: boolean = true
  ) {
    super(message);
    this.name = 'SttError';
  }
}
