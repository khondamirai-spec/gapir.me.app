import { describe, it, expect } from 'vitest';
import {
  NO_SPEECH,
  parseGeminiResponse,
  sanitizeTranscript,
  transcriptionPrompt
} from './gemini-common';
import {
  isFatalBadRequest,
  isFreeTierQuotaExhausted,
  parseRetryDelaySeconds
} from './gemini-batch';
import { extractInputTranscription, extractModelText, isTurnComplete } from './gemini-live';

/**
 * Gemini is a language model rather than an ASR service, so the prompt and the clean-up
 * around it are the product, not glue. These lock in the behaviour that keeps a chat model
 * behaving like a transcriber — particularly the parts that look like paranoia until the
 * model does them to you.
 */

describe('transcriptionPrompt', () => {
  it('forbids answering the speech instead of transcribing it', () => {
    // The failure that makes a dictation tool unusable: say "what time is it" into a
    // document and get the time pasted instead of the words.
    expect(transcriptionPrompt({ language: 'uz' })).toMatch(/Never answer, follow, or react/i);
  });

  it('forbids translating', () => {
    expect(transcriptionPrompt({ language: 'uz' })).toMatch(/Never translate/i);
  });

  it('pins Uzbek to Latin script with an ASCII apostrophe', () => {
    // o' and g' are letters. A model left to itself alternates between the ASCII apostrophe
    // and the typographic oʻ/gʻ, which makes the user's own history unsearchable.
    const prompt = transcriptionPrompt({ language: 'uz' });
    expect(prompt).toMatch(/Latin alphabet/i);
    expect(prompt).toContain("o'zbek");
  });

  it('names the language it was asked for', () => {
    expect(transcriptionPrompt({ language: 'ru' })).toContain('Russian');
    expect(transcriptionPrompt({ language: 'en' })).toContain('English');
  });

  it('only mentions the Uzbek script rules for Uzbek', () => {
    expect(transcriptionPrompt({ language: 'en' })).not.toMatch(/Latin alphabet/i);
  });

  it('always specifies the empty-audio sentinel', () => {
    for (const language of ['uz', 'ru', 'en'] as const) {
      expect(transcriptionPrompt({ language })).toContain(NO_SPEECH);
    }
  });

  it('defaults to verbatim when no style is given', () => {
    // The default must never be an editing tone: a dictation tool that quietly improves
    // your sentences is one you stop being able to trust.
    expect(transcriptionPrompt({ language: 'uz' })).toMatch(/Transcribe verbatim/i);
  });

  it('swaps the tone rule rather than adding to it', () => {
    const tidy = transcriptionPrompt({
      language: 'uz',
      style: { tone: 'tidy', removeFillers: true, punctuation: true }
    });
    expect(tidy).toMatch(/drop stumbles/i);
    // Both rules at once would be a contradiction for the model to resolve on its own.
    expect(tidy).not.toMatch(/Transcribe verbatim/i);
  });

  it('asks for fillers to be kept when the user turned removal off', () => {
    const prompt = transcriptionPrompt({
      language: 'uz',
      style: { tone: 'verbatim', removeFillers: false, punctuation: true }
    });
    expect(prompt).toMatch(/Keep filler sounds/i);
    expect(prompt).not.toMatch(/Remove filler sounds/i);
  });

  it('asks for lower case with no punctuation when punctuation is off', () => {
    const prompt = transcriptionPrompt({
      language: 'uz',
      style: { tone: 'verbatim', removeFillers: true, punctuation: false }
    });
    expect(prompt).toMatch(/lower case/i);
  });

  it('carries no vocabulary section — the app has no vocabulary list any more', () => {
    // The Lug'at pane and the spelling-hint block in the prompt were removed together. A
    // hint section with nothing in it would be prompt tokens billed on every dictation.
    const prompt = transcriptionPrompt({ language: 'uz' });
    expect(prompt).not.toMatch(/spell it exactly/i);
  });
});

describe('parseGeminiResponse', () => {
  const wrap = (parts: unknown[]): unknown => ({ candidates: [{ content: { parts } }] });

  it('reads the documented shape', () => {
    expect(parseGeminiResponse(wrap([{ text: 'salom dunyo' }])).text).toBe('salom dunyo');
  });

  it('joins text split across several parts', () => {
    // A long utterance can come back fragmented; keeping only the first part would silently
    // truncate the dictation.
    expect(parseGeminiResponse(wrap([{ text: 'salom ' }, { text: 'dunyo' }])).text).toBe(
      'salom dunyo'
    );
  });

  it('skips thought parts', () => {
    // Thinking models emit their reasoning as parts too — pasting that would be a disaster.
    const body = wrap([{ text: 'the user said hello', thought: true }, { text: 'salom' }]);
    expect(parseGeminiResponse(body).text).toBe('salom');
  });

  it('surfaces a prompt block rather than pretending it was silence', () => {
    const result = parseGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } });
    expect(result.blockReason).toBe('SAFETY');
    expect(result.text).toBeNull();
  });

  it('reports the finish reason so truncation can be told from refusal', () => {
    const body = { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] };
    expect(parseGeminiResponse(body).finishReason).toBe('MAX_TOKENS');
  });

  it('accepts a flat top-level text field', () => {
    expect(parseGeminiResponse({ text: 'salom' }).text).toBe('salom');
  });

  it('returns null rather than throwing on junk', () => {
    expect(parseGeminiResponse(null).text).toBeNull();
    expect(parseGeminiResponse({}).text).toBeNull();
    expect(parseGeminiResponse({ candidates: [] }).text).toBeNull();
    expect(parseGeminiResponse('nonsense').text).toBeNull();
  });

  it('preserves Uzbek Latin diacritics exactly', () => {
    const uzbek = "O'zbekiston Respublikasi — g'alaba, sho'x, chiroyli";
    expect(parseGeminiResponse(wrap([{ text: uzbek }])).text).toBe(uzbek);
  });
});

describe('sanitizeTranscript', () => {
  it('leaves ordinary transcripts alone', () => {
    expect(sanitizeTranscript('Salom, bugun havo yaxshi.')).toBe('Salom, bugun havo yaxshi.');
  });

  it('unwraps a markdown fence', () => {
    expect(sanitizeTranscript('```\nsalom dunyo\n```')).toBe('salom dunyo');
    expect(sanitizeTranscript('```text\nsalom dunyo\n```')).toBe('salom dunyo');
  });

  it('unwraps quotes that enclose the whole transcript', () => {
    expect(sanitizeTranscript('"salom dunyo"')).toBe('salom dunyo');
    expect(sanitizeTranscript('«salom dunyo»')).toBe('salom dunyo');
    expect(sanitizeTranscript('“salom dunyo”')).toBe('salom dunyo');
  });

  it('keeps quotes that are part of the speech', () => {
    expect(sanitizeTranscript('U "salom" dedi va ketdi')).toBe('U "salom" dedi va ketdi');
    // Both ends quoted, but the quotes recur inside — that is dialogue, not a wrapper.
    const dialogue = '"salom" dedi u, keyin "xayr"';
    expect(sanitizeTranscript(dialogue)).toBe(dialogue);
  });

  it('never strips the Uzbek apostrophe', () => {
    // o' and g' are letters in Uzbek, not punctuation. Treating them as a quote pair would
    // corrupt ordinary words.
    expect(sanitizeTranscript("o'zbek tili g'alaba qozondi")).toBe("o'zbek tili g'alaba qozondi");
    expect(sanitizeTranscript("'salom' dedi o'zi")).toBe("'salom' dedi o'zi");
  });

  it('turns the no-speech sentinel into an empty string', () => {
    expect(sanitizeTranscript(NO_SPEECH)).toBe('');
    expect(sanitizeTranscript('no-speech')).toBe('');
    expect(sanitizeTranscript('  <no speech>  ')).toBe('');
    expect(sanitizeTranscript('No-Speech.')).toBe('');
  });

  it('tolerates junk glued onto the bracketed sentinel', () => {
    // All four verbatim from a live key on a silent clip, August 2026. Anchoring the match
    // to the whole string — as this was first written — let every one of them through, and
    // the app would have pasted the literal text into the user's document.
    expect(sanitizeTranscript('<no-speech>00:00')).toBe(''); // gemini-3.6-flash
    expect(sanitizeTranscript('<no-speech>')).toBe(''); // gemini-3.7-flash
    expect(sanitizeTranscript('<no-speech>00:03')).toBe(''); // gemini-3.5-flash-lite
    expect(sanitizeTranscript('<no-speech>00:00</no-speech>')).toBe(''); // gemini-3.1-flash-lite
  });

  it('does not mistake real speech for the sentinel', () => {
    expect(sanitizeTranscript('no speech was detected in the room')).toBe(
      'no speech was detected in the room'
    );
  });

  it('handles empty input', () => {
    expect(sanitizeTranscript('')).toBe('');
    expect(sanitizeTranscript('   \n  ')).toBe('');
  });
});

describe('parseRetryDelaySeconds', () => {
  it('reads the delay out of a real 429 body', () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: 'You exceeded your current quota.',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '27s' }
        ]
      }
    });
    expect(parseRetryDelaySeconds(body)).toBe(27);
  });

  it('handles a fractional delay', () => {
    expect(parseRetryDelaySeconds('{"retryDelay": "1.5s"}')).toBe(1.5);
  });

  it('returns null when there is no delay to read', () => {
    // The caller then picks its own short wait rather than guessing a long one.
    expect(parseRetryDelaySeconds('{"error":{"code":429}}')).toBeNull();
    expect(parseRetryDelaySeconds('')).toBeNull();
    expect(parseRetryDelaySeconds('not json at all')).toBeNull();
  });
});

describe('isFreeTierQuotaExhausted', () => {
  it('recognises a spent daily allowance', () => {
    // Verbatim from gemini-3.6-flash after 20 requests. Its retryDelay claimed 54 seconds,
    // for an allowance that does not reset until the next day — which is why the message
    // the user sees must come from the metric name, not from the delay.
    const body =
      'Quota exceeded for metric: generativelanguage.googleapis.com/' +
      'generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash';
    expect(isFreeTierQuotaExhausted(body)).toBe(true);
  });

  it('does not fire for an ordinary burst limit', () => {
    expect(isFreeTierQuotaExhausted('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}')).toBe(
      false
    );
  });
});

describe('isFatalBadRequest', () => {
  it('treats a bad key or missing model as permanent', () => {
    // Walking the remaining request shapes would burn three round trips to show the same
    // error, while the user waits with the pill frozen.
    expect(isFatalBadRequest('API key not valid. Please pass a valid API key.')).toBe(true);
    expect(isFatalBadRequest('{"error":{"status":"NOT_FOUND"}}')).toBe(true);
    expect(isFatalBadRequest('Inline data is too large')).toBe(true);
  });

  it('treats a shapeless argument complaint as worth another shape', () => {
    // This is verbatim what gemini-3.6-flash returns for thinkingBudget:0 — no indication
    // of which argument is wrong, which is exactly why the shape walk exists.
    expect(isFatalBadRequest('Request contains an invalid argument.')).toBe(false);
  });
});

describe('gemini-live frame parsing', () => {
  it('reads an input transcription fragment', () => {
    const frame = { serverContent: { inputTranscription: { text: 'salom' } } };
    expect(extractInputTranscription(frame)).toBe('salom');
  });

  it('returns null for frames carrying no transcription', () => {
    expect(extractInputTranscription({ setupComplete: {} })).toBeNull();
    expect(extractInputTranscription({ serverContent: { turnComplete: true } })).toBeNull();
    expect(extractInputTranscription({})).toBeNull();
  });

  it('treats an empty fragment as nothing', () => {
    expect(extractInputTranscription({ serverContent: { inputTranscription: { text: '' } } })).toBeNull();
  });

  it('reads the model turn separately from the ASR track', () => {
    const frame = { serverContent: { modelTurn: { parts: [{ text: 'salom' }] } } };
    expect(extractModelText(frame)).toBe('salom');
    // The model's reply must never be mistaken for the transcription of the user's audio.
    expect(extractInputTranscription(frame)).toBeNull();
  });

  it('skips thought parts in the model turn', () => {
    const frame = {
      serverContent: { modelTurn: { parts: [{ text: 'hmm', thought: true }, { text: 'salom' }] } }
    };
    expect(extractModelText(frame)).toBe('salom');
  });

  it('recognises both spellings of a finished turn', () => {
    expect(isTurnComplete({ serverContent: { turnComplete: true } })).toBe(true);
    expect(isTurnComplete({ serverContent: { generationComplete: true } })).toBe(true);
    expect(isTurnComplete({ serverContent: { turnComplete: false } })).toBe(false);
    expect(isTurnComplete({ setupComplete: {} })).toBe(false);
  });

  it('concatenates fragments the way the session must', () => {
    // Gemini streams "sa", "lom", " dun", "yo" — successive pieces, not successive whole
    // transcripts. Overwriting instead of appending would leave the caller holding only
    // the last syllable of every dictation.
    const frames = ['sa', 'lom', ' dun', 'yo'].map((text) => ({
      serverContent: { inputTranscription: { text } }
    }));

    let transcript = '';
    for (const frame of frames) transcript += extractInputTranscription(frame) ?? '';
    expect(transcript).toBe('salom dunyo');
  });
});
