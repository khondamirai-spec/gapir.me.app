import { DEFAULT_STYLE, type Language, type StyleSettings } from '@shared/types';

/**
 * The bits both Gemini adapters share: the endpoint, the prompt, and the parsing of what
 * comes back.
 *
 * Everything here is pure and exported so it can be unit-tested, and that matters more here
 * than anywhere else in the app: Gemini is a language model, not an ASR service. It returns
 * whatever it feels like, so the prompt and the clean-up around it are load-bearing product
 * code rather than glue — without each rule below the model answers the speech instead of
 * transcribing it, translates Uzbek to English, tidies grammar, or fences its output.
 */

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

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

/** How the transcript should read. */
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
  /** Joined text of every text part, or null when the response carried none. */
  text: string | null;
  /** Set when the request was refused rather than answered. */
  blockReason?: string;
  /** STOP, MAX_TOKENS, SAFETY… — useful for telling a truncation from a refusal. */
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
    // Some responses put a flat string where the parts array would be.
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
 *
 * Conservative by construction: a wrapper is only removed when it encloses the *whole*
 * string and doesn't recur inside it, so speech that genuinely contains quotation marks
 * survives untouched.
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

  /*
   * The sentinel, in the two forms it actually arrives in.
   *
   * The bracketed form is unambiguous, so it counts wherever it appears — a real response
   * from gemini-3.6-flash on a silent clip was `<no-speech>00:00`, with a stray timestamp
   * glued on. Anchoring this to the whole string, as it was first written, meant the app
   * would have pasted that literal text into the user's document. If the model emitted the
   * sentinel at all it heard nothing, and whatever it appended is an artifact.
   *
   * The bare form has no such marker, so it must match the entire string — otherwise the
   * perfectly ordinary sentence "no speech was detected in the room" would vanish.
   */
  if (/<\s*no[-\s]?speech\s*>/i.test(text)) return '';
  if (/^no[-\s]?speech[.!]?$/i.test(text)) return '';

  return text;
}

/**
 * Turn an HTTP failure into one line a user can act on, in Uzbek like the rest of the UI.
 *
 * "Act on" is doing less work than it used to, and the messages say so. The key and the
 * model are the app's, not the user's — there is no settings screen left to send anyone to,
 * so a rejected key or a retired model id is a broken build, and updating is the only move
 * the person standing there can make.
 */
export function geminiErrorMessage(status: number, body: string): string {
  if (status === 400 && /API key not valid/i.test(body)) {
    return 'Ilova kaliti qabul qilinmadi — ilovani yangilang';
  }
  if (status === 401 || status === 403) {
    return 'Ilova kaliti qabul qilinmadi — ilovani yangilang';
  }
  if (status === 404) {
    return 'Model mavjud emas — ilovani yangilang';
  }
  if (status === 429) {
    return 'Gemini limitga yetdi — biroz kutib turing';
  }
  if (status >= 500) {
    return `Gemini serveri xato qaytardi (${status})`;
  }
  return `Gemini ${status}: ${body.slice(0, 200)}`;
}
