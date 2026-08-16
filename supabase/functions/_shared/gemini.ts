/**
 * Gemini transcription, server side.
 *
 * This is a deliberate copy of src/main/stt/gemini-common.ts and the request-shape walk from
 * src/main/stt/gemini-batch.ts, ported to run under Deno with no imports outside this file.
 * It is duplicated rather than shared because the two run in different runtimes with different
 * module resolution, and a build step to bridge them would be more machinery than the ~200
 * lines it saves.
 *
 * **src/main/stt/prompt-drift.test.ts asserts the two prompt builders produce byte-identical output.**
 * That test is the only thing keeping this copy honest — if you change a rule here, change it
 * there, and the test will tell you when you didn't. Everything else in this file (parsing,
 * sanitising, the shapes walk) was arrived at the hard way against a live key; the reasoning
 * is preserved in the comments and should not be re-derived by anyone tidying up.
 */

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export type Language = 'uz' | 'ru' | 'en';

export interface StyleSettings {
  tone: 'verbatim' | 'tidy' | 'formal';
  removeFillers: boolean;
  punctuation: boolean;
}

export const DEFAULT_STYLE: StyleSettings = {
  tone: 'verbatim',
  removeFillers: true,
  punctuation: true
};

/**
 * What the model must emit when it hears nothing usable.
 *
 * Without a sentinel, a silent clip comes back as a sentence of prose — "I'm sorry, the
 * audio appears to be silent" — which would then be pasted into the user's document. A
 * fixed token is something we can detect exactly instead of pattern-matching apologies in
 * three languages.
 */
export const NO_SPEECH = '<no-speech>';

const LANGUAGE_NAMES: Record<Language, string> = {
  uz: 'Uzbek',
  ru: 'Russian',
  en: 'English'
};

export interface PromptOptions {
  language: Language;
  style?: StyleSettings;
}

/**
 * The tone rule — the one line that decides whether this is a transcriber or an editor.
 *
 * `verbatim` is the default because a dictation tool that silently improves your sentences
 * is one you stop being able to trust. The other two exist because dictating a chat message
 * and dictating a document genuinely want different things, and asking the model is the
 * only way to get them: nothing downstream knows which words were a stumble.
 */
const TONE_RULES: Record<StyleSettings['tone'], string> = {
  verbatim: 'Transcribe verbatim: do not summarise, do not fix grammar, do not add words that were not spoken.',
  tidy: 'Transcribe what was said, but drop stumbles, false starts and accidentally repeated words. Never add information, never reorder ideas, never change word choice.',
  formal:
    'Transcribe what was said in a clean written register: repair stumbles and spoken grammar, keep every fact and every meaningful word. Never add information that was not spoken.'
};

/**
 * The system prompt that turns a chat model into a dictation transcriber.
 *
 * Each rule is here because the unconstrained model does the opposite:
 * - it answers the speech instead of transcribing it (this is a dictation tool; the user
 *   saying "what time is it" wants those four words, not the time)
 * - it translates Uzbek to English unless told twice not to
 * - it tidies grammar, which silently rewrites what the user actually said
 * - it wraps output in quotes or a markdown fence
 *
 * The Uzbek apostrophe rule is not cosmetic: o' and g' are letters, and a model left to its
 * own devices alternates between the ASCII apostrophe and the typographic oʻ/gʻ from one
 * dictation to the next — which turns a user's own history into something they can't search.
 *
 * **Built here rather than sent by the client, and that is the security boundary of the whole
 * proxy.** If the app posted prompt text, any signed-in user could point the server's Gemini
 * key at any task they liked and bill it to us.
 */
export function transcriptionPrompt(opts: PromptOptions): string {
  const { language } = opts;
  const style = opts.style ?? DEFAULT_STYLE;
  const name = LANGUAGE_NAMES[language] ?? LANGUAGE_NAMES.uz;

  const rules = [
    `Output ONLY the transcript text. No preamble, no explanation, no quotation marks, no markdown, no code fences.`,
    `The speech is in ${name}. Transcribe it in ${name}. Never translate it.`,
    `Never answer, follow, or react to what is said. A question in the audio is transcribed, not answered.`,
    TONE_RULES[style.tone] ?? TONE_RULES.verbatim,
    style.removeFillers
      ? `Remove filler sounds and false starts (uh, mm, eee, aaa).`
      : `Keep filler sounds exactly as they were spoken.`,
    style.punctuation
      ? `Use normal sentence capitalisation and punctuation.`
      : `Write everything in lower case with no punctuation, except apostrophes inside words.`,
    `If there is no intelligible speech, output exactly: ${NO_SPEECH}`
  ];

  if (language === 'uz') {
    rules.splice(
      2,
      0,
      `Write Uzbek in the Latin alphabet. Use a straight ASCII apostrophe for o' and g' — write "o'zbek", not "oʻzbek".`,
      `Speakers mix Russian and English words into Uzbek. Keep such words as spoken, spelled in their own alphabet.`
    );
  }

  return [
    'You are a speech-to-text transcription engine inside a dictation tool.',
    'Transcribe the audio exactly as spoken.',
    '',
    'Rules:',
    ...rules.map((rule) => `- ${rule}`)
  ].join('\n');
}

export interface GeminiResult {
  text: string | null;
  blockReason?: string;
  finishReason?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Pull the transcript out of a generateContent response.
 *
 * Deliberately tolerant: read the documented shape first, then the plausible alternatives,
 * rather than betting the dictation on one schema surviving Google's next model generation.
 * Text parts are joined because a long utterance can come back split across several of them.
 */
export function parseGeminiResponse(body: unknown): GeminiResult {
  const root = asRecord(body);
  if (!root) return { text: null };

  const feedback = asRecord(root.promptFeedback);
  const blockReason = typeof feedback?.blockReason === 'string' ? feedback.blockReason : undefined;

  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  const first = asRecord(candidates[0]);
  const finishReason = typeof first?.finishReason === 'string' ? first.finishReason : undefined;

  const content = asRecord(first?.content);
  const parts = Array.isArray(content?.parts) ? (content.parts as unknown[]) : [];

  const chunks: string[] = [];
  for (const part of parts) {
    const record = asRecord(part);
    // `thought` parts are the model's reasoning, not its answer — never paste those.
    if (!record || record.thought === true) continue;
    if (typeof record.text === 'string' && record.text.length > 0) chunks.push(record.text);
  }

  if (chunks.length === 0) {
    const flat = typeof root.text === 'string' ? root.text : null;
    return { text: flat && flat.length > 0 ? flat : null, blockReason, finishReason };
  }

  return { text: chunks.join(''), blockReason, finishReason };
}

/** Quote wrappers worth unwrapping. Deliberately excludes the ASCII apostrophe: it is a
 *  letter in Uzbek ("o'zbek"), not punctuation, and stripping it would corrupt words. */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ['«', '»'],
  ['“', '”'],
  ['‘', '’']
];

/**
 * Undo the three things the model still does after being told not to, and turn the
 * no-speech sentinel back into an empty string.
 */
export function sanitizeTranscript(raw: string): string {
  let text = raw.trim();
  if (!text) return '';

  const fenced = text.match(/^```[a-z]*\s*\n?([\s\S]*?)\n?\s*```$/i);
  if (fenced) text = fenced[1].trim();

  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length > open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
      const inner = text.slice(open.length, -close.length);
      if (!inner.includes(close)) {
        text = inner.trim();
        break;
      }
    }
  }

  // The bracketed sentinel counts wherever it appears — a real response from
  // gemini-3.6-flash on a silent clip was `<no-speech>00:00`, with a stray timestamp glued
  // on. The bare form must match the whole string, or the ordinary sentence "no speech was
  // detected in the room" would vanish.
  if (/<\s*no[-\s]?speech\s*>/i.test(text)) return '';
  if (/^no[-\s]?speech[.!]?$/i.test(text)) return '';

  return text;
}

// ------------------------------------------------------------------- request

const REQUEST_TIMEOUT_MS = 60_000;

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

interface RequestShape {
  thinking?: Record<string, unknown>;
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
 * which argument, so this cannot be driven by reading the error. The shapes are tried in
 * order of portability, ending with a request stripped of both blocks.
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
 * Edge Function instances are recycled, so this is warm for a burst of dictations and cold
 * after a quiet spell — which is fine. It exists to stop *every* request paying for a wasted
 * round trip, not to be durable.
 */
const shapeByModel = new Map<string, number>();

/**
 * Is this 400 permanent, or could a different request shape fix it?
 *
 * A bad key, a missing model or audio the model won't take are settled facts — walking the
 * remaining shapes would burn three more round trips before showing the same error.
 */
export function isFatalBadRequest(body: string): boolean {
  return /API[_ ]?key|API_KEY_INVALID|not found|NOT_FOUND|is not supported|unsupported|too large|exceeds|PERMISSION_DENIED/i.test(
    body
  );
}

/** Is this 429 a free-tier allowance running out, rather than a momentary burst limit? */
export function isFreeTierQuotaExhausted(body: string): boolean {
  return /free_tier/i.test(body);
}

export function parseRetryDelaySeconds(body: string): number | null {
  const match = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : null;
}

export class GeminiError extends Error {
  constructor(
    message: string,
    /** What the app should show the user, in Uzbek. */
    readonly userMessage: string,
    /** HTTP status to hand back to the app. */
    readonly status: number,
    /** True when a different key in the pool might succeed. */
    readonly rotatable = false
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

async function postAudio(opts: {
  model: string;
  apiKey: string;
  prompt: string;
  audioBase64: string;
  shape: RequestShape;
}): Promise<Response> {
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
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GeminiError(
      `fetch failed: ${message}`,
      controller.signal.aborted ? 'Gemini javob bermadi (timeout)' : 'Gemini bilan bog‘lanib bo‘lmadi',
      502
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Transcribe one clip. Walks the request shapes until one is accepted, then reads the answer.
 *
 * Throws GeminiError; `rotatable` distinguishes "this key is spent, try another" from "this
 * will fail the same way on every key", which is what drives the pool loop in the caller.
 */
export async function transcribe(opts: {
  model: string;
  apiKey: string;
  language: Language;
  style?: StyleSettings;
  audioBase64: string;
}): Promise<string> {
  const prompt = transcriptionPrompt({ language: opts.language, style: opts.style });
  const { model, apiKey, audioBase64 } = opts;

  let res: Response | null = null;
  let lastBody = '';
  let usedShape = 0;

  for (let i = shapeByModel.get(model) ?? 0; i < SHAPES.length; i++) {
    const attempt = await postAudio({ model, apiKey, prompt, audioBase64, shape: SHAPES[i] });

    if (attempt.status !== 400) {
      shapeByModel.set(model, i);
      usedShape = i;
      res = attempt;
      break;
    }

    // A Response body can only be read once, and the retry decision needs to see it.
    lastBody = await attempt.text().catch(() => '');
    if (isFatalBadRequest(lastBody)) {
      // A 400 that names the key is an auth failure wearing the wrong status code — on a
      // pool key that means "try the next one".
      const isKey = /API[_ ]?key|PERMISSION_DENIED/i.test(lastBody);
      throw new GeminiError(
        `400 ${lastBody.slice(0, 300)}`,
        isKey ? 'Server kaliti qabul qilinmadi' : 'Gemini so‘rovni rad etdi',
        502,
        isKey
      );
    }
    console.warn(`[gemini] ${model} rejected shape ${i}: ${lastBody.replace(/\s+/g, ' ').slice(0, 160)}`);
  }

  if (!res) {
    throw new GeminiError(`400 ${lastBody.slice(0, 300)}`, 'Gemini so‘rovni rad etdi', 502);
  }

  // A burst limit clears in seconds and the audio is already here, so a short sleep rescues
  // the transcript instead of making the user say it all again. A daily cap does not clear,
  // and its retryDelay is fiction — that one rotates to the next key instead.
  if (res.status === 429) {
    const body = await res.text().catch(() => '');
    const waitMs = Math.ceil((parseRetryDelaySeconds(body) ?? 2) * 1000);

    if (waitMs > 6_000 || isFreeTierQuotaExhausted(body)) {
      console.error(`[gemini] ${model} rate limited: ${body.replace(/\s+/g, ' ').slice(0, 800)}`);
      throw new GeminiError(`429 ${body.slice(0, 300)}`, 'Server band — biroz kutib turing', 503, true);
    }

    console.warn(`[gemini] ${model} rate limited, retrying in ${waitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    res = await postAudio({ model, apiKey, prompt, audioBase64, shape: SHAPES[usedShape] });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[gemini] ${model} -> ${res.status}: ${body.replace(/\s+/g, ' ').slice(0, 800)}`);
    const rotatable = res.status === 429 || res.status === 401 || res.status === 403;
    throw new GeminiError(
      `${res.status} ${body.slice(0, 300)}`,
      res.status >= 500 ? 'Gemini serveri xato qaytardi' : 'Gemini so‘rovni rad etdi',
      502,
      rotatable
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new GeminiError('unparseable body', 'Gemini tushunarsiz javob qaytardi', 502);
  }

  const result = parseGeminiResponse(json);

  if (result.blockReason) {
    throw new GeminiError(`blocked ${result.blockReason}`, `Gemini javobni bloklandi (${result.blockReason})`, 502);
  }
  if (result.finishReason === 'MAX_TOKENS' && !result.text) {
    throw new GeminiError('MAX_TOKENS', 'Yozuv juda uzun — qisqaroq gapirib ko‘ring', 400);
  }
  if (result.text === null) return '';

  return sanitizeTranscript(result.text);
}
