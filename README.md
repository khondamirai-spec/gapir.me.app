# Whisper UZ

Push-to-talk dictation for Uzbek. Hold **Ctrl+CapsLock**, speak, release — the text lands
wherever your cursor is, in any app.

Like Wispr Flow, but Uzbek. The open-source dictation tools all run Whisper locally,
which is precisely why none of them work in Uzbek. This one uses
[Aisha](https://aisha.group), an Uzbek-native speech engine, and handles the
Uzbek/Russian code-switching that real speech in Tashkent is full of.

## How it works

```
Ctrl+Caps down ──▶ ffmpeg captures 16 kHz mono PCM ──▶ streamed to Aisha over WebSocket
                                                                     │
Ctrl+Caps up ──────▶ final transcript ◀───────────────────────────────┘
                          │
                          ▼
        logged to history → clipboard saved → pasted with Ctrl+V → clipboard restored
```

**Esc** while recording cancels — nothing is pasted.

A small pill sits at the bottom centre of the screen for the whole session: a dim logo at
rest, expanding into a live waveform and partial transcript while you speak, then a green
tick. It is click-through and unfocusable by design — see
[overlay.ts](src/main/overlay.ts). Turn the resting logo off in Settings if it gets in the
way of a fullscreen game.

Everything you dictate is kept in a searchable list in the app window, so a paste that
landed in the wrong place is recoverable. Open it from the tray.

## Installing (for users)

Download the installer from the [releases page](../../releases/latest), or from the
GitHub Pages site built from [docs/](docs/index.html). Windows 10/11, 64-bit. ffmpeg is
bundled — nothing else to install.

Expect **"Windows protected your PC"** (More info → Run anyway) and possibly an antivirus
complaint: the build is unsigned, and an app that installs a keyboard hook and synthesises
keystrokes looks exactly like a keylogger to a heuristic scanner. The fix is a certificate —
[Azure Trusted Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/) is ~$10/mo
and needs a verifiable legal entity. It is the highest-leverage thing to buy once this has
users; until then, report false positives to Microsoft after each release.

## Developing

Requires **Node 22+** and **ffmpeg** on PATH (`winget install ffmpeg`) — the bundled copy is
only fetched for packaged builds.

```bash
npm install
npm run dev
```

Then open **Settings** from the tray icon and paste your Aisha API key. Get one at
[aisha.group](https://aisha.group) — billing is pay-as-you-go at 425 UZS/min (~$0.034),
with no monthly fee. The **Tekshirish** button validates it against Aisha before you save.

For development you can instead put the key in a `.env` file at the project root:

```
AISHA_API_KEY=...
```

### Working without a key

```bash
npm run dev:mock
```

Runs with a fake transcriber, so the hotkey, overlay, level meter, history and paste path
can all be exercised offline and unbilled.

### Verifying the Aisha socket

```bash
# record a few seconds of speech first
ffmpeg -f dshow -i audio="<device>" -ar 16000 -ac 1 -f s16le -t 6 sample.pcm
npm run spike
```

Logs every frame the realtime endpoint sends back, verbatim.

## Releasing

```bash
npm run ffmpeg   # fetch the bundled ffmpeg.exe (~108 MB, pinned + digest-checked)
npm run dist     # -> release/Whisper-UZ-Setup.exe
```

Or let CI do it — tag a commit and
[release.yml](.github/workflows/release.yml) builds, tests and publishes to a GitHub
Release, including the `latest.yml` that `electron-updater` reads:

```bash
npm version patch && git push --follow-tags
```

Installed copies check for updates on launch and every six hours, download in the
background, and install on quit.

The download page in [docs/](docs/index.html) is meant to be served by GitHub Pages
(Settings → Pages → main / docs). It derives the download URL from its own hostname, so
there is no repo name to keep in sync.

**The installer is ~150 MB, almost all of it ffmpeg.** That is a lot for the bandwidth this
app's users have. A custom `--disable-everything --enable-indev=dshow` build would be a few
MB and is the obvious next optimisation.

## Layout

| Path | Role |
| --- | --- |
| [src/main/state.ts](src/main/state.ts) | The dictation state machine — the only module that coordinates the others |
| [src/main/hotkey.ts](src/main/hotkey.ts) | Ctrl+CapsLock hold/release via a low-level keyboard hook |
| [src/main/audio.ts](src/main/audio.ts) | ffmpeg capture, device enumeration, RMS, WAV wrapping |
| [src/main/stt/](src/main/stt/) | Swappable STT adapters — Aisha realtime, Aisha batch, mock, key check |
| [src/main/inject.ts](src/main/inject.ts) | The clipboard save → paste → restore dance |
| [src/main/overlay.ts](src/main/overlay.ts) | The floating pill that must never steal focus |
| [src/main/history.ts](src/main/history.ts) | The dictation log |
| [src/renderer/app/](src/renderer/app/) | The window: history, settings, first-run welcome |

## Things that look wrong but aren't

Six decisions here are load-bearing and will look like mistakes to anyone tidying up:

**Audio comes from an ffmpeg subprocess, not `getUserMedia`.** `uiohook-napi`'s keyboard
hook [silently stops firing on Windows once a getUserMedia stream is
opened](https://github.com/SnosMe/uiohook-napi/issues/54) — which is exactly this app's
usage pattern, and would break the hotkey after the first dictation. The subprocess also
happens to emit precisely the 16 kHz mono s16le that Aisha's socket wants, so audio pipes
through with no conversion.

**The hotkey module sends keystrokes as well as reading them.** `uiohook-napi` observes
input but cannot suppress it, and CapsLock toggles on key *down* — so the OS flips caps
state the moment a dictation starts, and nothing can prevent it. Left alone, every
dictation would leave you typing in CAPS. So [hotkey.ts](src/main/hotkey.ts) taps CapsLock
once when the gesture ends, cancelling out the user's own toggle.

That injected tap is visible to our own hook, because injected input travels the same
low-level chain as real input. Without the `restoringCaps` guard it would look like a
fresh trigger press and — with Ctrl still held — immediately start another recording.
Set `RESTORE_CAPS_LOCK` to false to drop the correction and live with the flipped state.

**The hotkey doesn't use Electron's `globalShortcut`.** That API requires a non-modifier
key and only fires on press, never release, so a modifier-only hold gesture is impossible
with it.

**The overlay uses `showInactive()` and `focusable: false`, and its window never resizes.**
Calling `show()` would activate the window, move the caret out of the app being dictated
into, and paste the text into the wrong place. The window is a fixed 360×80 and the pill
inside it grows in CSS, because resizing a transparent always-on-top window on Windows
flickers and lags a frame behind.

**The whole bootstrap is gated on the single-instance lock, not just `app.quit()`.**
`quit()` is a request, not a return: the losing instance would otherwise reach `whenReady`
and call `uIOhook.start()` while already tearing down, and uiohook-napi answers that by
aborting the process with a native fatal error rather than throwing.

**ffmpeg is passed the `@device_cm_{...}` alternative name, not the friendly device
name.** Friendly names are localised — on a Russian-locale Windows they arrive as
Cyrillic and get mangled by the console codepage. Alternative names are ASCII and stable.

## Privacy

Audio is streamed to Aisha and never stored. Transcripts *are* stored, in plaintext, at
`%APPDATA%/whisper-uz/history.json` — the app window shows you the exact path. It is not
encrypted because the list has to be searchable, and anything that can read `%APPDATA%` can
read this process's memory anyway. What you get instead is a switch to turn the log off and
a button to wipe it. The API key is separate and *is* encrypted, with `safeStorage` (DPAPI).

## Not built yet

Deliberately absent, in rough priority order:

- **AI cleanup layer** — an LLM pass to strip Uzbek filler words (*yani*, *anaqa*), add
  punctuation and format lists. This is Wispr's real differentiator and raw STT output
  needs it.
- **macOS.** Windows-only for now, and the blocker is practical: a Mac build can't be
  produced on Windows, and the Accessibility / Input Monitoring / Microphone prompts can't
  be verified by CI. Four files need platform branches when the time comes —
  `audio.ts` (dshow → avfoundation), `hotkey.ts` (Ctrl+CapsLock → hold Right ⌘, which also
  sidesteps the entire CapsLock-restore mechanism), `inject.ts` (Ctrl+V → ⌘V), and
  `overlay.ts` (`toolbar` → `panel`, plus `app.dock.hide()`). Shipping it to anyone else
  also needs an Apple Developer account for signing and notarization.
- **Code signing** — see Installing above.
- **Latin/Cyrillic toggle** — Uzbek is split across both scripts.
- **Custom dictionary** — so names and jargon stop getting mangled.
- **Configurable hotkey** — currently hardcoded to Ctrl+CapsLock, changeable only by
  editing `TRIGGER` in [src/main/hotkey.ts](src/main/hotkey.ts).
