import { pcmToWav, SAMPLE_RATE, BYTES_PER_SAMPLE } from '../audio';
import { DEFAULT_GEMINI_MODEL } from '@shared/types';
import {
  GEMINI_API_BASE,
  geminiErrorMessage,
  parseGeminiResponse,
  sanitizeTranscript,
  transcriptionPrompt
} from './gemini-common';
import {
  SttError,
  type SttAdapter,
  type SttErrorCode,
  type SttSession,
  type SttSessionOptions
} from './types';

/**
 * Gemini STT via generateContent — the primary Gemini path, and the reliable one.
 *
 * Buffers the whole utterance, wraps it in a WAV header (Gemini takes audio/wav inline;
 * it does not take headerless PCM) and posts it as base64 in a single request. Nothing is
 * transcribed until the user stops speaking, which costs a round trip a streaming socket
 * would avoid — but for a dictation clip of a few seconds that round trip is most of a
 * second, not most of the wait, and this path needs exactly one working HTTPS request to
 * succeed. That reliability is why it is the default and the Live socket is the experiment.
 *
 * The economics are the other half: audio bills at 32 tokens per second, so an hour of
 * speech is ~115k input tokens — cents, and on a free-tier key frequently nothing at all.
 */

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Inline request bodies cap at 20 MB including the base64 expansion, and 16 kHz mono s16le
 * runs 32 KB/s. 8 minutes leaves comfortable headroom under that ceiling; a dictation that
 * long is a stuck hotkey anyway, and a clear message beats a 400 from Google.
 */
const MAX_PCM_BYTES = 8 * 60 * SAMPLE_RATE * BYTES_PER_SAMPLE;

/**
 * Transcription is not a creative task: temperature 0, one candidate, and as little
 * thinking as the model will accept. Reasoning before a verbatim transcription buys
 * nothing and costs both tokens and the latency this path can least afford.
 *
 * `maxOutputTokens` is generous because thinking tokens are billed against it — too tight
 * a budget and the model thinks its way to MAX_TOKENS with no transcript to show.
 */
const BASE_TUNING = {
  temperature: 0,
  candidateCount: 1,
  maxOutputTokens: 8192,
  responseMimeType: 'text/plain'
} as const;

/**
 * Dictation is not content moderation's business. Someone swearing at their computer, or
 * dictating a medical note, must not have the transcript silently withheld — the user
 * already said the words out loud; we are only typing them.
 */
const SAFETY = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT'
].map((category) => ({ category, threshold: 'BLOCK_NONE' }));

export interface RequestShape {
  /** Contents of `generationConfig.thinkingConfig`, or undefined to omit it entirely. */
  thinking?: Record<string, unknown>;
  /** Whether to send the BLOCK_NONE safety overrides. */
  safety: boolean;
}

/**
 * How to ask a model not to think — which is not one question but three, because Google
 * renamed the field between model generations and no single spelling is accepted by all of
 * them. Measured against a live key across the whole Flash line in August 2026:
 *
 *   thinkingLevel: 'low'   accepted by every Gemini 3.x model tested
 *   thinkingBudget: 0      accepted by 3.0–3.5, **rejected by 3.5-flash-lite and 3.6-flash**
 *   thinkingLevel:'none'   rejected everywhere — 'low' is the floor, not zero
 *
 * A rejection arrives as `400 Request contains an invalid argument.` with no indication of
 * which argument, so this cannot be driven by reading the error. Instead the shapes are
 * tried in order of portability, ending with a request stripped of both blocks for accounts
 * that aren't allowed to set BLOCK_NONE either.
 */
const SHAPES: readonly RequestShape[] = [
  { thinking: { thinkingLevel: 'low' }, safety: true },
  { thinking: { thinkingBudget: 0 }, safety: true },
  { thinking: undefined, safety: true },
  { thinking: undefined, safety: false }
];

/**
 * The shape that last worked, per model.
 *
 * Without this, every dictation on a model that rejects the first shape would pay for a
 * wasted round trip before the one that works. Discovering it once per run is fine;
 * discovering it once per utterance is a latency bug.
 */
const shapeByModel = new Map<string, number>();

/**
 * Longest we will make someone stand and wait before admitting the rate limit won.
 *
 * They are mid-sentence with a hotkey in their hand; six seconds of a frozen pill is
 * already at the edge of tolerable, and a 30-second wait would be worse than being told to
 * try again.
 */
const MAX_RETRY_WAIT_MS = 6_000;

/**
 * Is this 429 a free-tier allowance running out, rather than a momentary burst limit?
 *
 * The two are told apart only by the quota metric name — both carry a `retryDelay`, and the
 * daily one's is fiction as far as the user is concerned: `gemini-3.6-flash` says "retry in
 * 54s" for an allowance that does not reset until tomorrow.
 */
export function isFreeTierQuotaExhausted(body: string): boolean {
  return /free_tier/i.test(body);
}

/**
 * How long Google says to wait, from the RetryInfo detail attached to a 429.
 *
 * Read with a regex rather than by walking `error.details[]` looking for the
 * `type.googleapis.com/google.rpc.RetryInfo` entry: the detail array's shape has moved
 * around, the field name has not, and guessing wrong here costs a dictation.
 */
export function parseRetryDelaySeconds(body: string): number | null {
  const match = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * Is this 400 permanent, or could a different request shape fix it?
 *
 * A bad key, a missing model or audio the model won't take are settled facts — walking the
 * remaining shapes would burn three more round trips before showing the user the same
 * error. Everything else is treated as "our request was shaped wrong", which is the case
 * the walk exists for.
 */
export function isFatalBadRequest(body: string): boolean {
  return /API[_ ]?key|API_KEY_INVALID|not found|NOT_FOUND|is not supported|unsupported|too large|exceeds|PERMISSION_DENIED/i.test(
    body
  );
}

/** The HTTP status, classified into the three failures the caller can actually act on. */
function errorCode(status: number): SttErrorCode | undefined {
  if (status === 429) return 'quota';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model';
  return undefined;
}

interface RequestOptions {
  model: string;
  apiKey: string;
  prompt: string;
  audioBase64: string;
  shape: RequestShape;
}

async function postAudio(opts: RequestOptions): Promise<Response> {
  const generationConfig: Record<string, unknown> = { ...BASE_TUNING };
  if (opts.shape.thinking) generationConfig.thinkingConfig = opts.shape.thinking;

  const body: Record<string, unknown> = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: opts.prompt },
          { inline_data: { mime_type: 'audio/wav', data: opts.audioBase64 } }
        ]
      }
    ],
    generationConfig
  };

  if (opts.shape.safety) body.safetySettings = SAFETY;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(
      `${GEMINI_API_BASE}/models/${encodeURIComponent(opts.model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': opts.apiKey
        },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SttError(
      controller.signal.aborted ? 'Gemini javob bermadi (timeout)' : `Tarmoq xatosi: ${message}`,
      false
    );
  } finally {
    clearTimeout(timer);
  }
}

class GeminiBatchSession implements SttSession {
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
    if (this.cancelled) return '';
    if (this.bytes === 0) return '';

    if (this.bytes > MAX_PCM_BYTES) {
      throw new SttError('Yozuv juda uzun — Gemini uchun 8 daqiqadan qisqa bo‘lishi kerak', false);
    }

    const model = this.opts.model?.trim() || DEFAULT_GEMINI_MODEL;
    const audioBase64 = pcmToWav(Buffer.concat(this.chunks)).toString('base64');
    const prompt = transcriptionPrompt({
      language: this.opts.language,
      style: this.opts.style
    });

    // Walk the request shapes until one is accepted, starting from whichever worked last
    // for this model. See SHAPES above for why this can't be a single blind retry.
    let res: Response | null = null;
    let lastBody = '';
    let usedShape = 0;

    for (let i = shapeByModel.get(model) ?? 0; i < SHAPES.length; i++) {
      const attempt = await postAudio({
        model,
        apiKey: this.opts.apiKey,
        prompt,
        audioBase64,
        shape: SHAPES[i]
      });

      if (attempt.status !== 400) {
        shapeByModel.set(model, i);
        usedShape = i;
        res = attempt;
        break;
      }

      // A Response body can only be read once, and the retry decision needs to see it.
      lastBody = await attempt.text().catch(() => '');
      if (isFatalBadRequest(lastBody)) {
        // A 400 that names the key is an auth failure wearing the wrong status code, and
        // the caller needs to know that rather than seeing a generic bad request.
        throw new SttError(
          geminiErrorMessage(400, lastBody),
          false,
          /API[_ ]?key|PERMISSION_DENIED/i.test(lastBody) ? 'auth' : undefined
        );
      }
      console.warn(
        `[gemini-batch] ${model} rejected request shape ${i}:`,
        lastBody.replace(/\s+/g, ' ').slice(0, 160)
      );
    }

    if (!res) throw new SttError(geminiErrorMessage(400, lastBody), false);

    // Free-tier keys are limited per minute, so on the cheap plan a 429 is a normal
    // operating condition rather than an exception — dictate three times in quick
    // succession and you will meet one. The audio is already buffered and Google tells us
    // how long to wait, so a short sleep and one more try rescues the transcript instead of
    // making the user say it all again.
    if (res.status === 429) {
      const body = await res.text().catch(() => '');
      const waitMs = Math.ceil((parseRetryDelaySeconds(body) ?? 2) * 1000);

      if (waitMs > MAX_RETRY_WAIT_MS) {
        console.error(
          `[gemini-batch] ${model} rate limited:`,
          body.replace(/\s+/g, ' ').slice(0, 800)
        );
        // A daily cap and a per-minute burst limit both arrive as a 429 with a retryDelay,
        // but the advice for them is opposite: waiting a minute fixes one and is useless
        // for the other. `gemini-3.6-flash` allows 20 requests a day on the free tier, so
        // "try again in 54 seconds" would be a lie that costs the user their afternoon.
        //
        // The daily message names no fix, deliberately: this adapter only runs on a
        // developer's own key (installed copies dictate through the proxy), and the model
        // is not the user's to change either.
        throw new SttError(
          isFreeTierQuotaExhausted(body)
            ? 'Bugungi limit tugadi — ertaga yana ishlaydi'
            : `Gemini limitga yetdi — ${Math.ceil(waitMs / 1000)} soniyadan keyin urinib ko‘ring`,
          false,
          // `quota` is what tells the caller this key is spent rather than wrong.
          'quota'
        );
      }

      console.warn(`[gemini-batch] ${model} rate limited, retrying in ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      res = await postAudio({
        model,
        apiKey: this.opts.apiKey,
        prompt,
        audioBase64,
        shape: SHAPES[usedShape]
      });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Log the raw body: the Uzbek one-liner the user sees is deliberately short, and
      // without this there is nothing in the console to diagnose a failure from.
      // 800 rather than a tidy 200: Google puts the quota metric and its limit near the end
      // of the message, and truncating before it hides the one fact that explains the error.
      console.error(
        `[gemini-batch] ${model} -> ${res.status}:`,
        body.replace(/\s+/g, ' ').slice(0, 800)
      );
      // 429 and 5xx are worth another transport's time; a bad key or a bad model id is not.
      const recoverable = res.status === 429 || res.status >= 500;
      throw new SttError(geminiErrorMessage(res.status, body), recoverable, errorCode(res.status));
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new SttError('Gemini tushunarsiz javob qaytardi', true);
    }

    const result = parseGeminiResponse(json);

    if (result.blockReason) {
      throw new SttError(`Gemini javobni bloklandi (${result.blockReason})`, false);
    }
    if (result.finishReason === 'MAX_TOKENS' && !result.text) {
      throw new SttError('Yozuv juda uzun — qisqaroq gapirib ko‘ring', false);
    }
    if (result.text === null) {
      if (process.env.WHISPER_UZ_LOG_FRAMES === '1') {
        console.log('[gemini-batch] <-', JSON.stringify(json).slice(0, 1000));
      }
      return '';
    }

    return sanitizeTranscript(result.text);
  }

  cancel(): void {
    this.cancelled = true;
    this.chunks = [];
    this.bytes = 0;
  }
}

export const geminiBatch: SttAdapter = {
  name: 'gemini-batch',
  async startSession(opts: SttSessionOptions): Promise<SttSession> {
    return new GeminiBatchSession(opts);
  }
};

export const _internals = { SHAPES, shapeByModel };
