import { describe, it, expect } from 'vitest';
import { Segmenter, quietThreshold, pcmMs, peakLevel, _internals } from './segmenter';
import { SAMPLE_RATE, BYTES_PER_SAMPLE } from '../audio';

/** A 220 Hz tone at `amp` of full scale — "speech", as far as the segmenter can tell. */
function tone(ms: number, amp = 0.3): Buffer {
  const samples = Math.round((ms / 1000) * SAMPLE_RATE);
  const buf = Buffer.alloc(samples * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * amp * 32767), i * 2);
  }
  return buf;
}

/** Room noise: a tone too faint to be anything but the room. */
const quiet = (ms: number) => tone(ms, 0.001);

/** Words with the short gaps real speech has — none of them long enough to cut at. */
function talking(ms: number): Buffer {
  const parts: Buffer[] = [];
  for (let t = 0; t < ms; t += 300) parts.push(tone(200), quiet(100));
  return Buffer.concat(parts).subarray(0, Math.round((ms / 1000) * SAMPLE_RATE) * BYTES_PER_SAMPLE);
}

/** Feed `pcm` in ffmpeg-sized pieces that do not line up with frames, and collect the cuts. */
function run(pcm: Buffer, chunkBytes = 3_202) {
  const pieces: Buffer[] = [];
  const seg = new Segmenter((p) => pieces.push(p));
  for (let at = 0; at < pcm.length; at += chunkBytes) seg.push(pcm.subarray(at, at + chunkBytes));
  const rest = seg.flush();
  return { pieces, rest };
}

const secs = (b: Buffer) => pcmMs(b.length) / 1000;

describe('Segmenter', () => {
  it('leaves a short dictation as one piece, pauses and all', () => {
    const pcm = Buffer.concat([talking(5_000), quiet(1_000), talking(5_000)]);
    const { pieces, rest } = run(pcm);
    expect(pieces).toHaveLength(0);
    expect(rest.equals(pcm)).toBe(true);
  });

  it('cuts at the first real pause after the target, inside the pause', () => {
    const pcm = Buffer.concat([talking(21_000), quiet(800), talking(5_000)]);
    const { pieces } = run(pcm);
    expect(pieces).toHaveLength(1);
    // The pause runs 21.0–21.8 s; the cut lands in it, not in the speech either side.
    expect(secs(pieces[0])).toBeGreaterThan(21.0);
    expect(secs(pieces[0])).toBeLessThan(21.8);
  });

  it('does not mistake the gaps between words for a pause', () => {
    const { pieces } = run(talking(40_000));
    expect(pieces).toHaveLength(0);
  });

  it('forces a cut at the maximum length when nobody pauses', () => {
    const { pieces } = run(talking(100_000));
    expect(pieces.length).toBe(2);
    for (const p of pieces) {
      expect(secs(p)).toBeLessThanOrEqual(45);
      expect(secs(p)).toBeGreaterThanOrEqual(42);
    }
  });

  it('hands back every byte, in order, whatever the chunk size', () => {
    const pcm = Buffer.concat([talking(23_000), quiet(600), talking(30_000), quiet(500), talking(7_777)]);
    for (const size of [777, 3_200, 65_536]) {
      const { pieces, rest } = run(pcm, size);
      expect(pieces.length).toBeGreaterThan(0);
      expect(Buffer.concat([...pieces, rest]).equals(pcm)).toBe(true);
    }
  });

  it('never splits a sample in half', () => {
    const { pieces } = run(Buffer.concat([talking(21_000), quiet(800)]), 1_001);
    for (const p of pieces) expect(p.length % BYTES_PER_SAMPLE).toBe(0);
  });
});

describe('quietThreshold', () => {
  it('sits between room noise and speech', () => {
    const levels = [...Array(20).fill(0.003), ...Array(80).fill(0.2)];
    const t = quietThreshold(levels);
    expect(t).toBeGreaterThan(0.003);
    expect(t).toBeLessThan(0.2);
  });

  it('is clamped so a noisy room does not swallow speech', () => {
    expect(quietThreshold(Array(100).fill(0.3))).toBe(_internals.QUIET_MAX);
    expect(quietThreshold(Array(100).fill(0))).toBe(_internals.QUIET_MIN);
    expect(quietThreshold([])).toBe(_internals.QUIET_MIN);
  });
});

describe('peakLevel', () => {
  it('reads the loudest frame', () => {
    expect(peakLevel(quiet(1_000))).toBeLessThan(0.01);
    expect(peakLevel(Buffer.concat([quiet(1_000), tone(100)]))).toBeGreaterThan(0.1);
  });
});
