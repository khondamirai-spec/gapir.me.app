import { describe, it, expect } from 'vitest';
import { extractText, isPartial } from './aisha-realtime';

/**
 * These cover the tolerant frame parser. Aisha's docs don't pin down every field name,
 * so the parser accepts several plausible spellings; these tests lock in that tolerance
 * so a later cleanup can't silently narrow it back down to one guess.
 */

describe('extractText', () => {
  it('reads the documented `text` field', () => {
    expect(extractText({ text: 'salom dunyo' })).toBe('salom dunyo');
  });

  it('accepts the alternative spellings the API might use', () => {
    expect(extractText({ transcript: 'salom' })).toBe('salom');
    expect(extractText({ transcription: 'salom' })).toBe('salom');
    expect(extractText({ result: 'salom' })).toBe('salom');
  });

  it('unwraps a nested object form', () => {
    expect(extractText({ transcription: { text: 'salom', partial: false } })).toBe('salom');
  });

  it('returns null when there is no transcript to be had', () => {
    expect(extractText({ event: 'session_started' })).toBeNull();
    expect(extractText({})).toBeNull();
  });

  it('treats an empty string as no transcript', () => {
    // Otherwise an empty final would wipe out accumulated partials.
    expect(extractText({ text: '' })).toBeNull();
  });

  it('ignores non-string values', () => {
    expect(extractText({ text: 42 })).toBeNull();
    expect(extractText({ text: null })).toBeNull();
  });

  it('preserves Uzbek Latin diacritics exactly', () => {
    const uzbek = "O'zbekiston Respublikasi — g'alaba, sho'x, chiroyli";
    expect(extractText({ text: uzbek })).toBe(uzbek);
  });
});

describe('isPartial', () => {
  it('reads the boolean flag in its various spellings', () => {
    expect(isPartial({ partial: true })).toBe(true);
    expect(isPartial({ is_partial: true })).toBe(true);
    expect(isPartial({ isPartial: true })).toBe(true);
    expect(isPartial({ partial: false })).toBe(false);
  });

  it('falls back to the event type name', () => {
    expect(isPartial({ type: 'transcription.partial' })).toBe(true);
    expect(isPartial({ type: 'transcription.final' })).toBe(false);
  });

  it('defaults to final when nothing indicates otherwise', () => {
    // Safer default: a misclassified final still gets pasted, a misclassified
    // partial would be dropped.
    expect(isPartial({ text: 'salom' })).toBe(false);
  });

  it('prefers an explicit boolean over the type string', () => {
    expect(isPartial({ partial: false, type: 'transcription.partial' })).toBe(false);
  });
});
