/**
 * THROWAWAY SPIKE — delete once src/main/stt/aisha-realtime.ts is written.
 *
 * Purpose: find out what Aisha's realtime STT socket ACTUALLY sends back.
 * The public docs describe `session_started` / `transcription` / `error` but not
 * the exact field names, so we log every frame verbatim and code against reality.
 *
 * Usage:
 *   1. put AISHA_API_KEY=... in .env
 *   2. record a few seconds of Uzbek:
 *        ffmpeg -f dshow -i audio="<device>" -ar 16000 -ac 1 -f s16le -t 6 sample.pcm
 *   3. npm run spike
 */
import { readFileSync, existsSync } from 'node:fs';
import WebSocket from 'ws';

const KEY = process.env.AISHA_API_KEY;
if (!KEY) {
  console.error('Missing AISHA_API_KEY. Put it in .env at the project root.');
  process.exit(1);
}

const PCM_PATH = process.argv[2] ?? 'sample.pcm';
if (!existsSync(PCM_PATH)) {
  console.error(`No PCM file at ${PCM_PATH}. Record one first (see header comment).`);
  process.exit(1);
}

// 16 kHz mono s16le => 32000 bytes/sec. 100ms chunks = 3200 bytes.
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const CHUNK_MS = 100;
const CHUNK_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_MS) / 1000;

const pcm = readFileSync(PCM_PATH);
console.log(
  `PCM: ${pcm.length} bytes = ${(pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)).toFixed(2)}s of audio`
);

const url = `wss://back.aisha.group/api/v1/stt/realtime?format=pcm&token=${encodeURIComponent(KEY)}&language=uz`;
console.log(`Connecting to ${url.replace(KEY, '<KEY>')}`);

const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(5) + 'ms';

const ws = new WebSocket(url);
ws.binaryType = 'nodebuffer';

ws.on('open', async () => {
  console.log(`${ms()} OPEN`);

  // Stream in realtime-ish pacing so the server sees it like a live mic.
  for (let off = 0; off < pcm.length; off += CHUNK_BYTES) {
    if (ws.readyState !== WebSocket.OPEN) break;
    ws.send(pcm.subarray(off, off + CHUNK_BYTES));
    await new Promise((r) => setTimeout(r, CHUNK_MS));
  }

  console.log(`${ms()} all audio sent -> {"event":"end"}`);
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'end' }));
});

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    console.log(`${ms()} <- BINARY ${data.length} bytes`);
    return;
  }
  const raw = data.toString();
  console.log(`${ms()} <- ${raw}`);
  try {
    console.log('        parsed:', JSON.stringify(JSON.parse(raw), null, 2));
  } catch {
    console.log('        (not JSON)');
  }
});

ws.on('error', (err) => console.error(`${ms()} ERROR`, err.message));
ws.on('close', (code, reason) => {
  console.log(`${ms()} CLOSE code=${code} reason=${reason.toString() || '(none)'}`);
  process.exit(0);
});

// Don't hang forever if the server never closes.
setTimeout(() => {
  console.log(`${ms()} timeout — closing`);
  ws.close();
}, 60_000);
