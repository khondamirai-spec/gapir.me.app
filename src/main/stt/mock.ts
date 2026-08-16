import { SAMPLE_RATE, BYTES_PER_SAMPLE } from '../audio';
import type { SttAdapter, SttSession, SttSessionOptions } from './types';

/**
 * Fake STT for development — enabled with WHISPER_UZ_MOCK_STT=1.
 *
 * Lets the hotkey, overlay, level meter and paste path be exercised end to end without
 * an API key, a network connection, or spending a single so'm on transcription. It emits
 * partials on a timer so the overlay's live-text rendering gets exercised too.
 */

const SENTENCE = [
  'Salom,',
  'bu',
  'gapir',
  'me',
  'ilovasining',
  'sinov',
  'matni.',
  'Ctrl',
  'va',
  'Caps',
  'Lock',
  'ishlayapti.'
];

class MockSession implements SttSession {
  private bytes = 0;
  private cancelled = false;
  private timer: NodeJS.Timeout | null = null;
  private wordIndex = 0;

  constructor(private opts: SttSessionOptions) {
    // Reveal a word every 400ms so partial rendering is visible while "speaking".
    this.timer = setInterval(() => {
      if (this.cancelled || this.wordIndex >= SENTENCE.length) return;
      this.wordIndex++;
      this.opts.onPartial?.(SENTENCE.slice(0, this.wordIndex).join(' '));
    }, 400);
  }

  pushAudio(chunk: Buffer): void {
    this.bytes += chunk.length;
  }

  async end(): Promise<string> {
    this.stopTimer();
    if (this.cancelled) return '';

    // Simulate provider round-trip latency so the TRANSCRIBING state is actually visible.
    await new Promise((r) => setTimeout(r, 350));

    const seconds = this.bytes / (SAMPLE_RATE * BYTES_PER_SAMPLE);
    // Return roughly one word per 0.4s of audio, so the output tracks how long you held.
    const words = Math.max(1, Math.min(SENTENCE.length, Math.round(seconds / 0.4)));
    return SENTENCE.slice(0, words).join(' ');
  }

  cancel(): void {
    this.cancelled = true;
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const mockStt: SttAdapter = {
  name: 'mock',
  async startSession(opts: SttSessionOptions): Promise<SttSession> {
    return new MockSession(opts);
  }
};

export const useMockStt = (): boolean => process.env.WHISPER_UZ_MOCK_STT === '1';
