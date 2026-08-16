import { describe, expect, it } from 'vitest';
import type { Language, StyleSettings } from '@shared/types';
import {
  transcriptionPrompt as clientPrompt,
  sanitizeTranscript as clientSanitize,
  parseGeminiResponse as clientParse
} from './gemini-common';
import {
  transcriptionPrompt as serverPrompt,
  sanitizeTranscript as serverSanitize,
  parseGeminiResponse as serverParse
} from '../../../supabase/functions/_shared/gemini';

/**
 * The two copies of the Gemini prompt must not drift.
 *
 * Since transcription moved behind a proxy, the prompt that decides what every dictation
 * returns is built on the *server*
 * (supabase/functions/_shared/gemini.ts) — but the client's copy in gemini-common.ts is still
 * live on the developer `.env` route and on pre-Supabase builds. Two copies of product code
 * this load-bearing, in two runtimes, is exactly the arrangement that silently diverges:
 * someone fixes a rule in one file, ships it, and dictations start behaving differently
 * depending on a route nobody was thinking about.
 *
 * The copy is deliberate — the two run under different module resolution and bridging them
 * would be more machinery than it saves — so this test is what makes it honest. It fails the
 * moment a rule is changed in one file and not the other.
 *
 * Note the extensionless import of a file that Deno itself would require an extension on.
 * That asymmetry is fine because `_shared/gemini.ts` imports nothing — the extensions Deno
 * cares about are in the *functions* that import it, which tsc never sees. Written this way
 * because `allowImportingTsExtensions` would otherwise have to be turned on project-wide for
 * one line here.
 *
 * `supabase/` is outside tsconfig's `include`, so this test is also the only thing
 * typechecking that file at all.
 */

const LANGUAGES: Language[] = ['uz', 'ru', 'en'];
const TONES: StyleSettings['tone'][] = ['verbatim', 'tidy', 'formal'];

describe('prompt parity between the app and the edge function', () => {
  it('produces identical prompts across every language, tone and switch', () => {
    let compared = 0;

    for (const language of LANGUAGES) {
      for (const tone of TONES) {
        for (const removeFillers of [true, false]) {
          for (const punctuation of [true, false]) {
            const style: StyleSettings = { tone, removeFillers, punctuation };
            const client = clientPrompt({ language, style });
            const server = serverPrompt({ language, style });

            expect(
              server,
              `prompt drift for language=${language} tone=${tone} ` +
                `removeFillers=${removeFillers} punctuation=${punctuation}`
            ).toBe(client);
            compared++;
          }
        }
      }
    }

    // 3 languages x 3 tones x 2 x 2. Asserted so that a refactor which quietly stops
    // iterating can't leave this test passing over an empty matrix.
    expect(compared).toBe(36);
  });

  it('defaults the style identically when none is given', () => {
    for (const language of LANGUAGES) {
      expect(serverPrompt({ language })).toBe(clientPrompt({ language }));
    }
  });

  it('keeps the Uzbek-only rules on the Uzbek prompt in both copies', () => {
    // Not a parity check but a guard on what parity is worth: if both copies lost the
    // apostrophe rule together, the test above would still pass.
    for (const build of [clientPrompt, serverPrompt]) {
      const uz = build({ language: 'uz' });
      expect(uz).toContain("straight ASCII apostrophe");
      expect(build({ language: 'en' })).not.toContain('straight ASCII apostrophe');
    }
  });
});

describe('transcript clean-up parity', () => {
  const cases = [
    '',
    '   ',
    'salom dunyo',
    '"salom dunyo"',
    '«salom dunyo»',
    '```\nsalom dunyo\n```',
    '```text\nsalom\n```',
    '<no-speech>',
    '<no-speech>00:00',
    'no speech',
    'no speech was detected in the room',
    "o'zbek tilida gapiraman",
    'u dedi: "salom", keyin ketdi'
  ];

  it('sanitizes every case the same way', () => {
    for (const raw of cases) {
      expect(serverSanitize(raw), `sanitize drift for ${JSON.stringify(raw)}`).toBe(
        clientSanitize(raw)
      );
    }
  });

  it('parses responses the same way, including thought parts', () => {
    const bodies: unknown[] = [
      null,
      {},
      { candidates: [{ content: { parts: [{ text: 'salom' }] }, finishReason: 'STOP' }] },
      // The one that matters most: a thinking model's reasoning must never become a transcript.
      {
        candidates: [
          { content: { parts: [{ text: 'reasoning', thought: true }, { text: 'salom' }] } }
        ]
      },
      { candidates: [{ content: { parts: [] } }], promptFeedback: { blockReason: 'SAFETY' } },
      { candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] },
      { text: 'flat' }
    ];

    for (const body of bodies) {
      expect(serverParse(body), `parse drift for ${JSON.stringify(body)}`).toEqual(
        clientParse(body)
      );
    }
  });
});
