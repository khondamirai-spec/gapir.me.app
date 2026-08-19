import { startRecording, type Recorder, SAMPLE_RATE, BYTES_PER_SAMPLE } from './audio';
import { hotkey } from './hotkey';
import { injectText } from './inject';
import { ensureVisible, updateOverlay } from './overlay';
import {
  geminiModel,
  geminiRealtimeEnabled,
  getSettings,
  resolveGeminiKey,
  type KeyOrigin
} from './config';
import { markKeyExhausted, nextBundledKey } from './keys';
import { addHistory } from './history';
import { stopMicTest } from './mic-test';
import { isSignedIn } from './auth';
import { isConfigured } from './supabase-config';
import { geminiBatch } from './stt/gemini-batch';
import { geminiLive } from './stt/gemini-live';
import { proxyBatch } from './stt/proxy-batch';
import { mockStt, useMockStt } from './stt/mock';
import { SttError, type SttSession, type SttSessionOptions } from './stt/types';
import type { AppState, Settings } from '@shared/types';

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

/**
 * How many bundled keys one dictation may burn through before giving up.
 *
 * A spent free-tier key costs a round trip to discover, and the user is standing there with
 * a hotkey in their hand — so the pool is walked, but only a little way. Whatever is left
 * stays healthy for the next press, which will start from the first key that still works.
 */
const MAX_KEY_ROTATIONS = 3;

/**
 * Where this dictation's transcript will come from.
 *
 *   proxy  — our Supabase Edge Function, holding the Gemini key and the user's quota.
 *            **This is the path every installed copy takes.**
 *   direct — Gemini, called from this process with a key in `.env`. A developer convenience,
 *            so that working on the app never spends the quota real users are dictating on.
 *   pool   — Gemini, on a key shipped inside the installer. The way this app used to work,
 *            kept alive only for builds made before a backend was configured. It is what
 *            Phase 5 of docs/supabase-setup.md deletes, and nothing new should reach for it.
 *   mock   — npm run dev:mock.
 *   none   — nothing can transcribe; the caller shows an error instead of recording.
 */
type Route = 'proxy' | 'direct' | 'pool' | 'mock' | 'none';

class Dictation {
  private state: AppState = 'IDLE';
  private recorder: Recorder | null = null;
  private session: SttSession | null = null;
  /**
   * Every PCM chunk, kept so the batch path can still transcribe the utterance if the Live
   * socket dies mid-session. ~32 KB per second, so a minute costs ~2 MB.
   */
  private pcm: Buffer[] = [];
  private level = 0;
  private partial = '';
  /** The key this dictation is using, resolved once at hotkey-press time. Empty on the proxy
   *  route, where there is no key in this process at all. */
  private key = '';
  private keyOrigin: KeyOrigin = 'none';
  /** Where this dictation's transcript comes from. Decided once, at hotkey-press time. */
  private route: Route = 'none';
  /** Pending return to IDLE from a transient DONE/ERROR display. */
  private resetTimer: NodeJS.Timeout | null = null;
  /**
   * Which dictation is the current one.
   *
   * Transcription is a round trip of a second or more, and the user can walk away from it —
   * by pressing Esc, or simply by starting the next dictation. Neither of those can reach
   * into the `await` inside onStop, so without a way to tell that the reply belongs to a
   * dictation nobody wants any more, an abandoned utterance still gets logged to history and
   * pasted into whatever now has focus. Bumping this abandons everything in flight.
   */
  private epoch = 0;

  init(): void {
    hotkey.on('start', () => void this.onStart());
    hotkey.on('stop', () => void this.onStop());
    hotkey.on('cancel', () => this.onCancel());
    hotkey.start();
  }

  /**
   * A click on the overlay pill: hands-free dictation, without the hotkey.
   *
   * The same two transitions the hotkey drives, chosen from the current state instead of
   * from key edges — resting starts a recording, recording stops it and transcribes. A
   * click-started recording has no keyup to end it, so it runs until the next click (or
   * Esc); nothing else in the flow knows the difference, because there isn't one.
   */
  toggle(): void {
    if (this.state === 'RECORDING') void this.onStop();
    else if (this.state === 'IDLE' || this.state === 'DONE' || this.state === 'ERROR')
      void this.onStart();
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

  /** The per-session options every transport takes. */
  private sessionOptions(settings: Settings): Omit<SttSessionOptions, 'onPartial'> {
    return {
      language: settings.language,
      apiKey: this.key,
      model: geminiModel(),
      style: settings.style
    };
  }

  /**
   * Decide how this dictation will be transcribed.
   *
   * The order is the product decision, and it is not the order it looks like it should be:
   *
   * A developer's own `.env` key wins over the proxy so that working on the app never spends
   * the quota real users are dictating on, and never bills our Gemini key for a test. A
   * packaged build has no environment to read, so on an installed copy that branch is empty
   * and `proxy` is the answer.
   *
   * `pool` is last, and only when no backend is configured at all. That is the pre-Supabase
   * way this app worked — a key inside the installer, extractable by anyone. It survives so
   * that a build made before the backend existed still dictates, not because it is a
   * fallback worth having: once the proxy is live, a pool key would be a hole in the paywall
   * rather than a safety net. Deleting it is Phase 5.
   */
  private resolveRoute(): Route {
    if (useMockStt()) return 'mock';

    const env = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    if (env) {
      this.key = env;
      this.keyOrigin = 'env';
      return 'direct';
    }

    if (isConfigured()) {
      this.key = '';
      this.keyOrigin = 'none';
      // Signed out is a real, expected state rather than an error condition — it is simply
      // the answer "not until you sign in", which onStart turns into a message.
      return isSignedIn() ? 'proxy' : 'none';
    }

    const resolved = resolveGeminiKey();
    this.key = resolved.key;
    this.keyOrigin = resolved.origin;
    return resolved.key ? 'pool' : 'none';
  }

  private async onStart(): Promise<void> {
    // Ignore a second press while we're still finishing the previous dictation — but a
    // lingering DONE tick or error message is fair game to interrupt.
    if (this.state !== 'IDLE' && this.state !== 'DONE' && this.state !== 'ERROR') return;

    // Anything still in flight from the previous dictation belongs to nobody now.
    this.epoch++;
    this.clearResetTimer();
    // Only one process can hold a DirectShow device; the dictation always wins.
    stopMicTest();

    const settings = getSettings();
    this.route = this.resolveRoute();

    this.pcm = [];
    this.partial = '';
    this.level = 0;

    ensureVisible();

    // Nothing can transcribe. Two different reasons, and they need different answers: a
    // configured build is telling the user to sign in, which they can do; an unconfigured one
    // is a broken build, and reinstalling is the honest advice for a person who cannot fix it.
    if (this.route === 'none') {
      this.fail(
        isConfigured()
          ? 'Kirish kerak — ilovani ochib, Google bilan kiring'
          : 'Ilova kaliti topilmadi — ilovani qayta o‘rnating'
      );
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

    // Nothing to open ahead of time on the default path — the PCM buffer above is already
    // collecting, and onStop hands the whole utterance to the batch adapter. The Live
    // socket is the opt-in experiment; see src/main/stt/gemini-live.ts.
    //
    // It is unavailable on the proxy route, and not by omission: the Live API is a WebSocket
    // the client opens to Google with a key in hand, and the whole point of the proxy is that
    // this process has no key. Streaming through our own server would be a second transport
    // to build, not a flag to flip.
    const primary =
      this.route === 'mock' ? mockStt
      : this.route !== 'proxy' && geminiRealtimeEnabled() ? geminiLive
      : null;
    if (!primary) return;

    try {
      const session = await primary.startSession({
        ...this.sessionOptions(settings),
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

    const epoch = this.epoch;
    let text = '';
    const startedAt = Date.now();
    try {
      text = await this.transcribe(settings);
    } catch (err) {
      // A dictation the user has already walked away from must not raise an error pill over
      // whatever they went on to do.
      if (this.epoch !== epoch) return;
      this.fail(err instanceof Error ? err.message : 'Matnga o‘girib bo‘lmadi');
      return;
    }

    // Esc, or the start of the next dictation, while this transcript was in flight. Drop it
    // on the floor: nothing logged, nothing pasted, which is what cancelling has to mean —
    // an Esc that still pastes a paragraph a second later is worse than no Esc at all.
    //
    // The reply is discarded here rather than never asked for: the request is already with
    // Google and SttSession has no abort, so the cost of an abandoned dictation is one
    // wasted round trip, paid quietly.
    if (this.epoch !== epoch) return;

    text = text.trim();

    // The one line that makes a failure diagnosable at all: which route, which model, on
    // which key, how long the audio was, how long the round trip took, and what came back.
    // Without it a dictation leaves no trace in the console at all.
    //
    // `route=` is the field to read first now. "Which model actually ran?" used to be the
    // question this line answered; with a server in the path the prior question is whether
    // the request even went through it, and on the proxy route `model=` is only what this
    // build *believes* the server uses — the server's own log is the authority.
    console.log(
      `[state] route=${this.route} gemini/${geminiModel()} key=${this.keyOrigin} ` +
        `audio=${(durationMs / 1000).toFixed(1)}s rtt=${Date.now() - startedAt}ms ` +
        `chars=${text.length} :: ${JSON.stringify(text.slice(0, 200))}`
    );

    if (!text) {
      this.fail('Hech narsa eshitilmadi');
      return;
    }

    // Logged BEFORE the paste is attempted, on purpose: a paste that lands in the wrong
    // window — or doesn't land at all — is exactly when the user needs to go and fetch the
    // text by hand, so the transcript must already be safe by then.
    if (settings.saveHistory) {
      try {
        addHistory({ text, language: settings.language, durationMs });
      } catch (err) {
        // A full disk or a locked file must not cost the user their dictation.
        console.warn('[state] could not write history:', err instanceof Error ? err.message : err);
      }
    }

    this.set('INJECTING');
    try {
      await injectText(text);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : 'Matnni joylashtira olmadim');
      return;
    }

    this.succeed();
  }

  /** The Live socket's result if there is one, otherwise the batch path over the same audio. */
  private async transcribe(settings: Settings): Promise<string> {
    if (this.session) {
      try {
        const text = await this.session.end();
        if (text.trim()) return text;
        // Empty result — fall through and let batch have a go at the same audio.
      } catch (err) {
        console.warn(
          '[state] Live socket failed, falling back to batch:',
          err instanceof Error ? err.message : err
        );
      } finally {
        this.session = null;
      }
    }

    // The mock has no second transport to fall back to.
    if (this.route === 'mock') return '';

    // One request, no rotation: the server holds the key pool now and rotates it internally,
    // so a failure that arrives here is one the client cannot improve on by asking again.
    if (this.route === 'proxy') {
      const session = await proxyBatch.startSession(this.sessionOptions(settings));
      for (const chunk of this.pcm) session.pushAudio(chunk);
      return await session.end();
    }

    return this.batchTranscribe(settings);
  }

  /**
   * Post the utterance straight to Gemini, stepping to the next key in the pool if this one
   * turns out to be spent or revoked.
   *
   * The pre-Supabase path, reached only on the `direct` and `pool` routes. Rotation is for
   * pool keys only, deliberately: a developer running against their own GEMINI_API_KEY who
   * hits a quota wall needs to be told that about their own account, not to have the app
   * quietly start spending the shipped keys instead.
   */
  private async batchTranscribe(settings: Settings): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        const session = await geminiBatch.startSession(this.sessionOptions(settings));
        for (const chunk of this.pcm) session.pushAudio(chunk);
        return await session.end();
      } catch (err) {
        const code = err instanceof SttError ? err.code : undefined;
        const rotatable = code === 'quota' || code === 'auth';
        if (this.keyOrigin !== 'pool' || !rotatable || attempt >= MAX_KEY_ROTATIONS) throw err;

        markKeyExhausted(this.key, 'daily');
        const next = nextBundledKey(this.key);
        if (!next) throw err;

        console.warn(`[state] pool key ${code}, retrying the dictation on the next key`);
        this.key = next;
      }
    }
  }

  private onCancel(): void {
    if (this.state !== 'RECORDING' && this.state !== 'TRANSCRIBING') return;
    // Esc arrives here from anywhere, including with no dictation running at all, so the
    // guard above is what decides whether there is anything to cancel. Past it, a transcript
    // still on its way back is disowned.
    this.epoch++;
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
    // This dictation is over however it got here, so nothing still in flight may go on to
    // paste itself over the error the user is now looking at.
    this.epoch++;
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
   * Back to rest. Note this does not hide the overlay — IDLE is a state the pill renders
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
