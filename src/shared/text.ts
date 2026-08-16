/**
 * Text arithmetic shared by main and the renderers.
 *
 * Today only the renderer counts words — the Statistika pane's totals and speaking rates
 * all flow through these two functions, while main's `[state]` line logs `chars=`. It
 * lives under src/shared anyway because the counting rule is product policy, not
 * presentation: if main (or anything else) ever needs a word count, importing this is what
 * keeps it from disagreeing with the pane. Dependency-free, like everything under
 * src/shared.
 */

/**
 * Every character that behaves as a letter inside an Uzbek word without being one.
 *
 * All five apostrophes are here because all five turn up in practice: the ASCII `'` this
 * app asks Gemini for, the typographic `‘`/`’` that Windows autocorrect and most keyboards
 * produce, and the modifier letters `ʻ`/`ʼ` that the orthography actually specifies for
 * oʻ and gʻ. Counting only some of them means "to‘rt" is two words on one machine and one
 * word on the next — and word counts that disagree with themselves are worse than none.
 */
export const WORD_CHARS = "'’‘ʻʼ`-";

/**
 * Words in a piece of transcript.
 *
 * Unicode-aware on purpose: `\w` is ASCII, so an Uzbek sentence in Latin script or a
 * Russian word mixed into one would be miscounted.
 */
export function countWords(text: string): number {
  const matches = text.trim().match(new RegExp(`[\\p{L}\\p{N}${WORD_CHARS}]+`, 'gu'));
  return matches ? matches.length : 0;
}

/**
 * Speaking rate for one dictation.
 *
 * Over the length of the *audio*, not of the request: this is how fast the person spoke,
 * which is the number they would recognise, and it must not move because Google was slow.
 */
export function wordsPerMinute(text: string, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return Math.round(countWords(text) / (durationMs / 60_000));
}
