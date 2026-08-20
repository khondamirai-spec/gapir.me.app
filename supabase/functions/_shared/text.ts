/**
 * Word counting, on the server side of the wire.
 *
 * **A deliberate copy of `countWords` / `WORD_CHARS` in src/shared/text.ts**, for the same
 * reason `_shared/gemini.ts` is a copy of `src/main/stt/gemini-common.ts`: the two run in
 * different runtimes and bridging them would be more machinery than the twenty lines it
 * saves. The copy is kept honest by src/main/word-count-drift.test.ts, which imports both
 * and asserts they agree — including on the awkward inputs, which is where a re-implemented
 * regex quietly stops agreeing.
 *
 * This copy is not a convenience. Since the quota became words per week
 * (supabase/migrations/20260820101217_weekly_word_quota.sql), a word is a **unit of
 * account**: this function decides how much of somebody's week a dictation costs, and the
 * app's copy decides what the Hisob pane tells them they have left. If the two disagree by
 * even one word per sentence, the pane says 940 while the server says 1000 and refuses — and
 * the user is looking at a screen that says they have words left.
 *
 * Note that no comment here explains *what* a word is. That decision lives in
 * src/shared/text.ts, which is the original; changing it there and not here is what the
 * drift test exists to catch.
 */

/** Every character that behaves as a letter inside an Uzbek word without being one. */
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
