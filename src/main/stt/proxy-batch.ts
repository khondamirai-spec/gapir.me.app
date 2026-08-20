import { pcmToWav, SAMPLE_RATE, BYTES_PER_SAMPLE } from '../audio';
import { accessToken, notePlanUsage, refreshToken } from '../auth';
import { SUPABASE_ANON_KEY, TRANSCRIBE_URL, isConfigured } from '../supabase-config';
import {
  SttError,
  type SttAdapter,
  type SttErrorCode,
  type SttSession,
  type SttSessionOptions
} from './types';

/**
 * Transcription through our own server — the path every installed copy takes.
 *
 * Shaped exactly like gemini-batch.ts from the state machine's point of view (buffer the
 * utterance, wrap it in a WAV header, post it once), and different in the one way that
 * matters: **there is no API key in this process.** The app posts the audio to a Supabase
 * Edge Function with the signed-in user's JWT, and the function holds the Gemini key.
 *
 * That is what makes a paid plan enforceable. A key handed to the client is a key the client
 * can keep, so gating it behind a subscription would be a request rather than a rule. Here
 * the quota is checked in Postgres by a function the app cannot call
 * (supabase/migrations/20260820101217_weekly_word_quota.sql), and no amount of tampering with
 * this file changes it. What it counts is **words per week** — 1000 free, 6000 on Pro — taken
 * from the transcript the server produced rather than from anything this process says about
 * it, for the obvious reason that a client asked to report its own bill reports zero.
 *
 * What it costs, stated where someone will find it: an extra hop. The clip goes to Supabase
 * before it goes to Google, which is a few hundred milliseconds on a typical connection, and
 * caps the clip length well below Gemini's own limit. See MAX_PCM_BYTES.
 */

/**
 * The Edge Function's body limit is far tighter than Gemini's 20 MB inline cap, so the ceiling
 * is ours rather than Google's: two minutes of 16 kHz mono is ~3.8 MB of PCM and ~5 MB once
 * base64'd, which fits with room to spare. A dictation longer than that is a stuck hotkey.
 *
 * Kept in step with MAX_AUDIO_B64 in supabase/functions/transcribe/index.ts, which rejects
 * anything larger — this check exists so the user is told before the upload rather than after.
 */
const MAX_PCM_BYTES = 2 * 60 * SAMPLE_RATE * BYTES_PER_SAMPLE;

/**
 * Generous, because this timeout covers the upload as well as the transcription.
 *
 * The direct path's 60s was for a request that started transmitting immediately; here a slow
 * connection can spend most of a minute just sending the clip.
 */
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * What the Edge Function answers with — on success and on failure alike.
 *
 * `used` / `limit` are **words this week**, not dictations today; they carry the server's
 * own field names because that is what
 * supabase/functions/transcribe/index.ts puts on the wire. Every response carries them,
 * including the 402 and the refunded ones, which is what lets the Hisob pane be right after
 * a failed dictation without asking again.
 */
interface ProxyResponse {
  text?: string;
  error?: string;
  plan?: string;
  used?: number;
  limit?: number;
  resetsAt?: string | null;
}

/** The HTTP status, classified into what the caller can actually act on. */
function errorCode(status: number): SttErrorCode | undefined {
  // 402 is the paywall: the user's own weekly allowance, not a key of ours being spent.
  if (status === 402) return 'plan';
  if (status === 429) return 'quota';
  if (status === 401 || status === 403) return 'auth';
  return undefined;
}

class ProxySession implements SttSession {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private cancelled = false;

  constructor(private opts: SttSessionOptions) {}

  pushAudio(chunk: Buffer): void {
    if (this.cancelled) return;
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }

  async end(): Promise<string> {
    if (this.cancelled || this.bytes === 0) return '';

    if (!isConfigured()) {
      throw new SttError('Ilova serverga ulanmagan — ilovani yangilang', false);
    }

    if (this.bytes > MAX_PCM_BYTES) {
      throw new SttError('Yozuv juda uzun — 2 daqiqadan qisqa bo‘lishi kerak', false);
    }

    let token = await accessToken();
    if (!token) throw new SttError('Kirish kerak — Google bilan kiring', false, 'auth');

    const audio = pcmToWav(Buffer.concat(this.chunks)).toString('base64');
    const audioMs = (this.bytes / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000;

    // Note what is sent: the audio and four settings. **Not the prompt.** The prompt is built
    // on the server (supabase/functions/_shared/gemini.ts) precisely so that a signed-in user
    // cannot point our Gemini key at a task of their own choosing.
    const payload = JSON.stringify({
      audio,
      language: this.opts.language,
      style: this.opts.style,
      audioMs: Math.round(audioMs)
    });

    let res = await this.post(payload, token);

    // A session can expire between the hotkey going down and the upload finishing. One
    // refresh and one retry is a far better trade than making the user say it all again.
    if (res.status === 401) {
      token = await refreshToken();
      if (!token) throw new SttError('Kirish muddati tugadi — qaytadan kiring', false, 'auth');
      res = await this.post(payload, token);
    }

    let body: ProxyResponse = {};
    try {
      body = (await res.json()) as ProxyResponse;
    } catch {
      if (!res.ok) throw new SttError(`Server xatosi (${res.status})`, res.status >= 500);
      throw new SttError('Server tushunarsiz javob qaytardi', true);
    }

    // The server counts the words, so its numbers are the true ones — feeding them back here
    // is what keeps the Hisob pane counting up as you speak rather than only on open. Done
    // before the `res.ok` check on purpose: a 402 is precisely the moment the pane most needs
    // to be right, and the server sends the same figures with it.
    if (body.plan && typeof body.used === 'number' && typeof body.limit === 'number') {
      notePlanUsage({
        plan: body.plan === 'pro' ? 'pro' : 'free',
        wordsUsed: body.used,
        wordLimit: body.limit,
        resetsAt: typeof body.resetsAt === 'string' ? body.resetsAt : null
      });
    }

    if (!res.ok) {
      console.error(`[proxy] ${res.status}: ${body.error ?? ''}`);
      // The server writes its errors in Uzbek for exactly this reason — the pill shows them
      // verbatim, so a new failure mode needs no client release to be explained properly.
      throw new SttError(
        body.error || `Server xatosi (${res.status})`,
        res.status >= 500,
        errorCode(res.status)
      );
    }

    return (body.text ?? '').trim();
  }

  private async post(payload: string, token: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(TRANSCRIBE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Both are required by Supabase's gateway: apikey identifies the project, the
          // bearer token identifies the user. Sending only one gets a 401 from the edge
          // before the function ever runs.
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`
        },
        body: payload,
        signal: controller.signal
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SttError(
        controller.signal.aborted ? 'Server javob bermadi (timeout)' : `Tarmoq xatosi: ${message}`,
        false
      );
    } finally {
      clearTimeout(timer);
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.chunks = [];
    this.bytes = 0;
  }
}

export const proxyBatch: SttAdapter = {
  name: 'proxy-batch',
  async startSession(opts: SttSessionOptions): Promise<SttSession> {
    return new ProxySession(opts);
  }
};

export const _internals = { MAX_PCM_BYTES, errorCode };
