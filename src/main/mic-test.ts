import { startRecording, type Recorder } from './audio';

/**
 * The level meter in the Settings tab.
 *
 * Answers "is this microphone the right one, and is it picking anything up" without making
 * the user dictate into a real app to find out. Same capture path as a dictation — the
 * audio is read for its RMS and thrown away, never sent anywhere.
 *
 * Only one ffmpeg process can hold a DirectShow device at a time, so a dictation always
 * wins: src/main/state.ts stops any running test before it opens the microphone. The
 * dependency points one way (state → here) on purpose, to keep this a leaf module.
 */

/** A forgotten test must not hold the microphone open all session. */
const AUTO_STOP_MS = 30_000;

let recorder: Recorder | null = null;
let autoStop: NodeJS.Timeout | null = null;

export interface MicTestHandlers {
  onLevel: (level: number) => void;
  onError: (message: string) => void;
}

export function startMicTest(deviceId: string, handlers: MicTestHandlers): void {
  stopMicTest();

  try {
    recorder = startRecording(deviceId);
  } catch (err) {
    handlers.onError(err instanceof Error ? err.message : 'Mikrofonni ochib bo‘lmadi');
    return;
  }

  recorder.on('level', handlers.onLevel);
  recorder.on('error', (err) => {
    stopMicTest();
    handlers.onError(err.message);
  });

  autoStop = setTimeout(stopMicTest, AUTO_STOP_MS);
}

export function stopMicTest(): void {
  if (autoStop) {
    clearTimeout(autoStop);
    autoStop = null;
  }
  recorder?.stop();
  recorder = null;
}
