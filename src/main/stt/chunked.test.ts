import { describe, it, expect, vi } from 'vitest';
import { ChunkedTranscription } from './chunked';
import { SAMPLE_RATE, BYTES_PER_SAMPLE } from '../audio';

// Small numbers so a test's "long dictation" is a few seconds of audio.
const OPTS = { targetMs: 1_000, maxMs: 2_000, pauseMs: 200 };

function tone(ms: number, amp = 0.3): Buffer {
  const samples = Math.round((ms / 1000) * SAMPLE_RATE);
  const buf = Buffer.alloc(samples * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * amp * 32767), i * 2);
  }
  return buf;
}
const quiet = (ms: number) => tone(ms, 0.001);

/** `n` sentences of 1.2 s, each followed by a pause long enough to cut at. */
const sentences = (n: number) =>
  Buffer.concat(Array.from({ length: n }, () => [tone(1_200), quiet(400)]).flat());

/** A transcriber whose replies the test releases by hand, in any order. */
function controlled() {
  const pending: { index: number; resolve: (t: string) => void; reject: (e: unknown) => void }[] = [];
  const transcribe = vi.fn(
    (_pcm: Buffer, index: number) =>
      new Promise<string>((resolve, reject) => pending.push({ index, resolve, reject }))
  );
  return { transcribe, pending };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('ChunkedTranscription', () => {
  it('sends pieces while recording and joins them in spoken order', async () => {
    const { transcribe, pending } = controlled();
    const c = new ChunkedTranscription(transcribe, undefined, OPTS);
    // Released mid-sentence, so the last piece can only go out on end().
    c.pushAudio(Buffer.concat([sentences(2), tone(1_200)]));
    // Two pieces have gone out before "release".
    expect(transcribe).toHaveBeenCalledTimes(2);

    const done = c.end();
    expect(transcribe).toHaveBeenCalledTimes(3);
    // Replies come back out of order; the text must not.
    pending[2].resolve('uch');
    pending[0].resolve(' bir ');
    pending[1].resolve('ikki');
    await expect(done).resolves.toEqual({ text: 'bir ikki uch', segments: 3 });
  });

  it('keeps the text before a failure and drops what came after it', async () => {
    const { transcribe, pending } = controlled();
    const c = new ChunkedTranscription(transcribe, undefined, OPTS);
    c.pushAudio(sentences(3));
    const done = c.end();
    const limit = new Error('Haftalik so‘zlar tugadi');
    pending[0].resolve('bir');
    pending[1].reject(limit);
    pending[2].resolve('uch');
    await expect(done).resolves.toEqual({ text: 'bir', segments: 3, error: limit });
  });

  it('fails the dictation outright when the first piece fails', async () => {
    const { transcribe, pending } = controlled();
    const c = new ChunkedTranscription(transcribe, undefined, OPTS);
    c.pushAudio(sentences(2));
    const done = c.end();
    const boom = new Error('Tarmoq xatosi');
    pending[0].reject(boom);
    pending[1].resolve('ikki');
    await expect(done).rejects.toBe(boom);
  });

  it('sends a short dictation as one piece, exactly as before', async () => {
    const { transcribe, pending } = controlled();
    const c = new ChunkedTranscription(transcribe, undefined, OPTS);
    const pcm = tone(800);
    c.pushAudio(pcm);
    const done = c.end();
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0][0].equals(pcm)).toBe(true);
    pending[0].resolve('salom');
    await expect(done).resolves.toEqual({ text: 'salom', segments: 1 });
  });

  it('does not send a silent breath after the last sentence', async () => {
    const { transcribe, pending } = controlled();
    const c = new ChunkedTranscription(transcribe, undefined, OPTS);
    // One sentence, cut at its pause, then nothing but room noise until release.
    c.pushAudio(Buffer.concat([tone(1_200), quiet(1_000)]));
    const done = c.end();
    expect(transcribe).toHaveBeenCalledTimes(1);
    pending[0].resolve('bir');
    await expect(done).resolves.toEqual({ text: 'bir', segments: 1 });
  });

  it('still sends a silent first piece — the server decides what silence is', async () => {
    const { transcribe } = controlled();
    const c = new ChunkedTranscription(transcribe, undefined, OPTS);
    c.pushAudio(quiet(500));
    void c.end();
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('reports finished pieces as live text, only as an unbroken run from the start', async () => {
    const { transcribe, pending } = controlled();
    const onPartial = vi.fn();
    const c = new ChunkedTranscription(transcribe, onPartial, OPTS);
    c.pushAudio(sentences(3));

    pending[1].resolve('ikki');
    await flush();
    expect(onPartial).not.toHaveBeenCalled();

    pending[0].resolve('bir');
    await flush();
    expect(onPartial).toHaveBeenLastCalledWith('bir ikki');
  });

  it('sends nothing more and reports nothing once cancelled', async () => {
    const { transcribe, pending } = controlled();
    const onPartial = vi.fn();
    const c = new ChunkedTranscription(transcribe, onPartial, OPTS);
    c.pushAudio(sentences(2));
    const sent = transcribe.mock.calls.length;
    c.cancel();
    c.pushAudio(sentences(3));
    expect(transcribe).toHaveBeenCalledTimes(sent);
    pending[0].resolve('bir');
    await flush();
    expect(onPartial).not.toHaveBeenCalled();
  });
});
