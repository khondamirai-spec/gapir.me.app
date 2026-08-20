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
import { addHistory } from './history';
import { stopMicTest } from './mic-test';
import { isSignedIn } from './auth';
import { isConfigured } from './supabase-config';
import { geminiBatch } from './stt/gemini-batch';
import { geminiLive } from './stt/gemini-live';
import { proxyBatch } from './stt/proxy-batch';
import { mockStt, useMockStt } from './stt/mock';
import type { SttSession, SttSessionOptions } from './stt/types';
import type { AppState, OverlayPrompt, Settings } from '@shared/types';

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
 * How long the "sign in with Google" pill stays up.
 *
 * Much longer than an error, because it is not one: it is a button, and a button that
 * disappears while somebody is moving the mouse toward it is worse than no button. Not
 * permanent either — a red bar pinned across the bottom of the screen for a user who has
 * decided not to sign in today is the app arguing with them.
 */
const SIGN_IN_DISPLAY_MS = 9000;

/**
 * Where this dictation's transcript will come from.
 *
 *   proxy  — our Supabase Edge Function, holding the Gemini key and the user's quota.
 *            **This is the path every installed copy takes.**
 *   direct — Gemini, called from this process with a key in `.env`. A developer convenience,
 *            so that working on the app never spends the quota real users are dictating on.
 *   mock   — npm run dev:mock.
 *   none   — nothing can transcribe; the caller shows an error instead of recording.
 *
 * There used to be a fourth transcribing route, `pool` — Gemini on a key shipped inside the
 * installer, the way this app worked before it had a backend. Phase 5 of
 * docs/supabase-setup.md removed it: a key inside an installer is extractable by anyone who
 * downloads it, which once the proxy was live made it a hole in the paywall rather than a
 * safety net.
 */
type Route = 'proxy' | 'direct' | 'mock' | 'none';

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
  /** The offer currently drawn on the pill, if any — see `OverlayStatus.prompt`. */
  private prompt: OverlayPrompt = '';
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
    // Hands-free from the keyboard is the same two transitions the pill's click drives.
    hotkey.on('toggle', () => this.toggle());
    this.applyHotkeys();
    hotkey.start();
  }

  /**
   * Push the user's chords into the hook. Called at startup and whenever the shortcut
   * settings change — the hook holds its own copy, so a chord edited in Sozlamalar that
   * never reaches it would appear to save and then do nothing.
   */
  applyHotkeys(): void {
    hotkey.setChords(getSettings().hotkeys);
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

  private set(state: AppState, message = '', prompt: OverlayPrompt = ''): void {
    this.state = state;
    this.prompt = prompt;
    updateOverlay({ state, level: this.level, partial: this.partial, message, prompt });
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
   * The order is the product decision: a developer's own `.env` key wins over the proxy so
   * that working on the app never spends the quota real users are dictating on, and never
   * bills our Gemini key for a test. A packaged build has no environment to read, so on an
   * installed copy that branch is empty and `proxy` is the answer.
   */
  private resolveRoute(): Route {
    if (useMockStt()) return 'mock';

    const resolved = resolveGeminiKey();
    this.key = resolved.key;
    this.keyOrigin = resolved.origin;
    if (resolved.key) return 'direct';

    // Signed out is a real, expected state rather than an error condition — it is simply
    // the answer "not until you sign in", which onStart turns into a message. An
    // unconfigured build has nothing to transcribe with at all; the pool of bundled keys
    // that used to catch that case is gone (Phase 5 of docs/supabase-setup.md).
    return isConfigured() && isSignedIn() ? 'proxy' : 'none';
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
      // Signed out is not an error, and it stopped being written as one. It is the single
      // step left before the app works, so the pill offers the step — a Google button the
      // user can press where they are — instead of a sentence telling them to go and find
      // a window with a button in it. See `prompt` on OverlayStatus.
      if (isConfigured()) this.promptSignIn();
      else this.fail('Ilova kaliti topilmadi — ilovani qayta o‘rnating');
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
   * Post the utterance straight to Gemini — the `direct` route, a developer's `.env` key.
   *
   * One request, no retry on quota or auth failures, deliberately: a developer running
   * against their own GEMINI_API_KEY who hits a quota wall needs to be told that about
   * their own account. (The rotation that used to live here walked the bundled key pool,
   * which Phase 5 of docs/supabase-setup.md removed.)
   */
  private async batchTranscribe(settings: Settings): Promise<string> {
    const session = await geminiBatch.startSession(this.sessionOptions(settings));
    for (const chunk of this.pcm) session.pushAudio(chunk);
    return await session.end();
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

  /**
   * Offer sign-in on the pill itself.
   *
   * Deliberately not routed through `fail()`: there is nothing to tear down (no recorder, no
   * session — this is decided before either is opened), nothing to log as an error, and the
   * epoch must not move, because no dictation was ever in flight.
   */
  private promptSignIn(): void {
    this.set('ERROR', '', 'sign-in');
    this.scheduleReset(SIGN_IN_DISPLAY_MS);
    hotkey.resetModifierState();
  }

  /**
   * The browser is opening after a press of that button. A state of its own so the pill can
   * say what it is waiting for — the sign-in itself finishes minutes later, in a browser,
   * and comes back through the deep link.
   */
  noteSigningIn(): void {
    this.set('ERROR', '', 'signing-in');
    this.scheduleReset(SIGN_IN_DISPLAY_MS);
  }

  /**
   * The deep link came back and there is an account now. Told to us rather than watched for,
   * to keep this module's one-way dependency on auth.ts (state -> auth) intact.
   *
   * Only clears an offer, never a real error: an error the user has not read yet is not
   * something a background sign-in gets to dismiss.
   */
  clearSignInPrompt(): void {
    if (this.state !== 'ERROR' || !this.prompt) return;
    this.clearResetTimer();
    this.reset();
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
