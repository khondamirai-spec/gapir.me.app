import { startRecording, type Recorder, SAMPLE_RATE, BYTES_PER_SAMPLE } from './audio';
import { hotkey } from './hotkey';
import { injectText } from './inject';
import { ensureVisible, updateOverlay } from './overlay';
import { resolveApiKey, getSettings } from './config';
import { addHistory } from './history';
import { stopMicTest } from './mic-test';
import { aishaRealtime } from './stt/aisha-realtime';
import { aishaBatch } from './stt/aisha-batch';
import { mockStt, useMockStt } from './stt/mock';
import type { SttAdapter, SttSession } from './stt/types';
import type { AppState } from '@shared/types';

/**
 * The dictation state machine — the only place that coordinates hotkey, audio, STT and
 * injection. Everything else is a leaf module with no knowledge of the others.
 *
 *   IDLE ──hotkey down──> RECORDING ──hotkey up──> TRANSCRIBING ──> INJECTING ──> DONE
 *     ▲                       │                         │                          │
 *     └──────(0.9s)───────────┴────── Esc / error ───────┴────> ERROR ──(2.5s)──────┘
 *
 * DONE and ERROR are transient display states, not dead ends: a new hotkey press cancels
 * the timer and starts recording immediately, so retrying after a failure never means
 * waiting for a message to time out.
 */

const ERROR_DISPLAY_MS = 2500;
/** Long enough for the tick to register, short enough not to delay the next dictation. */
const DONE_DISPLAY_MS = 900;

class Dictation {
  private state: AppState = 'IDLE';
  private recorder: Recorder | null = null;
  private session: SttSession | null = null;
  /**
   * Every PCM chunk, kept so the batch fallback can still transcribe the utterance if
   * the realtime socket dies mid-session. ~32 KB per second, so a minute costs ~2 MB.
   */
  private pcm: Buffer[] = [];
  private level = 0;
  private partial = '';
  /** Pending return to IDLE from a transient DONE/ERROR display. */
  private resetTimer: NodeJS.Timeout | null = null;

  init(): void {
    hotkey.on('start', () => void this.onStart());
    hotkey.on('stop', () => void this.onStop());
    hotkey.on('cancel', () => this.onCancel());
    hotkey.start();
  }

  private set(state: AppState, message = ''): void {
    this.state = state;
    updateOverlay({ state, level: this.level, partial: this.partial, message });
  }

  /**
   * Read the current state.
   *
   * Deliberately a method, not a direct field read: `this.state` is mutated inside
   * `set()`, which TypeScript's control-flow analysis can't see, so reading the field
   * directly after an `await` gives a stale narrowed type. Going through a call resets
   * the narrowing and keeps the checks honest.
   */
  private currentState(): AppState {
    return this.state;
  }

  private async onStart(): Promise<void> {
    // Ignore a second press while we're still finishing the previous dictation — but a
    // lingering DONE tick or error message is fair game to interrupt.
    if (this.state !== 'IDLE' && this.state !== 'DONE' && this.state !== 'ERROR') return;

    this.clearResetTimer();
    // Only one process can hold a DirectShow device; the dictation always wins.
    stopMicTest();

    const settings = getSettings();
    const apiKey = resolveApiKey();

    this.pcm = [];
    this.partial = '';
    this.level = 0;

    ensureVisible();

    if (!apiKey && !useMockStt()) {
      this.fail('API kaliti yo‘q — trayda Sozlamalarni oching');
      return;
    }

    this.set('RECORDING');

    // Start capture and the socket together: the handshake overlaps with the user
    // drawing breath, which is most of why this feels instant rather than merely fast.
    try {
      this.recorder = startRecording(settings.deviceId);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : 'Mikrofonni ochib bo‘lmadi');
      return;
    }

    this.recorder.on('data', (chunk) => {
      this.pcm.push(chunk);
      this.session?.pushAudio(chunk);
    });

    this.recorder.on('level', (level) => {
      this.level = level;
      if (this.state === 'RECORDING') this.set('RECORDING');
    });

    this.recorder.on('error', (err) => {
      if (this.state === 'RECORDING') this.fail(err.message);
    });

    const primary: SttAdapter = useMockStt() ? mockStt : aishaRealtime;

    try {
      const session = await primary.startSession({
        language: settings.language,
        apiKey,
        onPartial: (text) => {
          this.partial = text;
          if (this.state === 'RECORDING' || this.state === 'TRANSCRIBING') this.set(this.state);
        }
      });
      // The user may have already released the key while we were connecting.
      if (this.currentState() !== 'RECORDING') {
        session.cancel();
        return;
      }
      this.session = session;
      // Feed it whatever was captured during the handshake.
      for (const chunk of this.pcm) session.pushAudio(chunk);
    } catch {
      // Socket refused to open — leave `session` null and let onStop use the batch path.
      this.session = null;
    }
  }

  private async onStop(): Promise<void> {
    if (this.state !== 'RECORDING') return;

    const settings = getSettings();
    const recorder = this.recorder;
    this.recorder = null;
    recorder?.stop();

    const capturedBytes = recorder?.byteCount ?? 0;
    const durationMs = (capturedBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000;

    // Too short to be speech — almost certainly a stray tap of the modifiers.
    if (durationMs < settings.minRecordingMs) {
      this.session?.cancel();
      this.session = null;
      this.reset();
      return;
    }

    this.set('TRANSCRIBING');

    let text = '';
    try {
      text = await this.transcribe();
    } catch (err) {
      this.fail(err instanceof Error ? err.message : 'Matnga o‘girib bo‘lmadi');
      return;
    }

    if (!text.trim()) {
      this.fail('Hech narsa eshitilmadi');
      return;
    }

    // Logged BEFORE the paste is attempted, on purpose: a paste that lands in the wrong
    // window — or doesn't land at all — is exactly when the user needs to go and fetch the
    // text by hand, so the transcript must already be safe by then.
    if (settings.saveHistory) {
      try {
        addHistory({ text: text.trim(), language: settings.language, durationMs });
      } catch (err) {
        // A full disk or a locked file must not cost the user their dictation.
        console.warn('[state] could not write history:', err instanceof Error ? err.message : err);
      }
    }

    this.set('INJECTING');
    try {
      await injectText(text.trim());
    } catch (err) {
      this.fail(err instanceof Error ? err.message : 'Matnni joylashtira olmadim');
      return;
    }

    this.succeed();
  }

  /** Realtime first; fall back to batch on any recoverable failure. */
  private async transcribe(): Promise<string> {
    const settings = getSettings();
    const apiKey = resolveApiKey();

    if (this.session) {
      try {
        const text = await this.session.end();
        if (text.trim()) return text;
        // Empty result — fall through and let batch have a go at the same audio.
      } catch (err) {
        console.warn(
          '[state] realtime failed, falling back to batch:',
          err instanceof Error ? err.message : err
        );
      } finally {
        this.session = null;
      }
    }

    // The mock has no second transport to fall back to.
    if (useMockStt()) return '';

    const batch = await aishaBatch.startSession({ language: settings.language, apiKey });
    for (const chunk of this.pcm) batch.pushAudio(chunk);
    return batch.end();
  }

  private onCancel(): void {
    if (this.state !== 'RECORDING' && this.state !== 'TRANSCRIBING') return;
    this.recorder?.stop();
    this.recorder = null;
    this.session?.cancel();
    this.session = null;
    this.reset();
  }

  /** Flash the tick, then collapse. */
  private succeed(): void {
    this.pcm = [];
    this.partial = '';
    this.level = 0;
    this.set('DONE');
    this.scheduleReset(DONE_DISPLAY_MS);
    // A swallowed keyup (alt-tab, UAC prompt) would otherwise wedge the hotkey forever.
    hotkey.resetModifierState();
  }

  private fail(message: string): void {
    console.error('[state]', message);
    this.recorder?.stop();
    this.recorder = null;
    this.session?.cancel();
    this.session = null;
    this.set('ERROR', message);
    this.scheduleReset(ERROR_DISPLAY_MS);
    hotkey.resetModifierState();
  }

  private scheduleReset(delayMs: number): void {
    this.clearResetTimer();
    this.resetTimer = setTimeout(() => {
      this.resetTimer = null;
      this.reset();
    }, delayMs);
  }

  private clearResetTimer(): void {
    if (!this.resetTimer) return;
    clearTimeout(this.resetTimer);
    this.resetTimer = null;
  }

  /**
   * Back to rest. Note this no longer hides the overlay — IDLE is a state the pill renders
   * (collapsed to its logo), and whether the window is on screen at all is decided by
   * `showIdlePill` inside src/main/overlay.ts.
   */
  private reset(): void {
    this.pcm = [];
    this.partial = '';
    this.level = 0;
    this.set('IDLE');
    hotkey.resetModifierState();
  }

  shutdown(): void {
    this.clearResetTimer();
    this.recorder?.stop();
    this.session?.cancel();
    hotkey.stop();
  }
}

export const dictation = new Dictation();
