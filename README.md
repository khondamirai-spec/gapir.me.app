# gapir me

Push-to-talk dictation for Uzbek. Hold **Ctrl+Shift**, speak, release — the text lands
wherever your cursor is, in any app. Or click the pill at the bottom of the screen to
dictate hands-free: click to start, click again (or Esc) to stop. The keys are yours to
change (Sozlamalar → Umumiy → Diktovka tugmalari), and you can bind a second chord that
starts and stops hands-free without the mouse.

Like Wispr Flow, but Uzbek. The open-source dictation tools all run Whisper locally, which
is precisely why none of them work in Uzbek. This one sends the audio to **Google Gemini**,
which handles Uzbek — including the Uzbek/Russian code-switching that real speech in
Tashkent is full of — and bills per audio token, which works out to cents per hour of
speech rather than dollars per hour.

**Sign in with Google and dictate.** There is nothing to paste and nothing to choose — no API
key, no model, no Settings screen that can be filled in wrongly. Everyone dictates on the same
server-side key and the same model. A free plan covers 30 dictations a day; **Pro** raises that
and is paid with Uzcard or Humo through Payme.

## How it works

```
Ctrl+Shift down ──▶ ffmpeg captures 16 kHz mono PCM ──▶ buffered
                                                           │
Ctrl+Shift up ──────▶ the clip goes to our server ─────────┘
                          │  checks your plan and today's quota,
                          │  then calls Gemini with a key you never see
                          ▼
              logged to history → clipboard saved
                    → pasted with Ctrl+V → clipboard restored
```

**Esc** while recording cancels — nothing is pasted.

A pill sits at the bottom centre of the screen for the whole session, and it has four
shapes. At rest it is a hairline bar, breathing very slowly. Hold the hotkey and it becomes
a small black capsule of live bars. Let go and the capsule widens a little, those same bars
flatten into a row of dots and a spinner steps round beside them. Then it collapses back to
the hairline — with a tick on the way past, if the paste landed.

Point at the resting bar and it widens to name both ways in — click it, or hold the
hotkey. The window is unfocusable by design and click-through everywhere except the pill
itself, so clicking it can never move your caret — see [overlay.ts](src/main/overlay.ts).
Turn the resting bar off in Settings if it gets in the
way of a fullscreen game.

## The app window

Open it from the tray. It has five panes and a settings dialog, and everything in them is
local to your machine.

| Pane | What it does |
| --- | --- |
| **Diktovka** | Everything you have dictated, grouped by day and searchable — so a paste that landed in the wrong place is recoverable |
| **Statistika** | Words, speaking rate, streak, and the last fourteen days, computed from that log |
| **Uslub** | Verbatim, tidied or formal; fillers; punctuation. Each one is a rule in the prompt |
| **Qaydlar** | A notes pane you can dictate into |
| **Sozlamalar** | A dialog over the window: microphone, dictation language, name, startup, the resting pill, history and privacy. Everything saves as you change it |
| **Yordam** | The three things that actually go wrong, and what to do about them |

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

## Accounts and API keys

**The Gemini key is not in the app.** It lives as a secret in a Supabase project, and the app
reaches it only through an Edge Function that first checks who you are and how much you have
dictated today. Setting that up — the Supabase project, Google sign-in, and Payme — is
documented step by step in [docs/supabase-setup.md](docs/supabase-setup.md).

This is a change from how the app used to work, and it was made for one reason: a key shipped
inside an installer is a key anyone who downloads it can extract. That was an acceptable trade
while the app was free. It is not one if people are paying, and it left no way to tell one
user from another — nothing to attach a plan or a limit to.

What the app holds instead is a Supabase session, stored in `%APPDATA%\gapir me\auth.json`
and encrypted with Windows DPAPI. The project URL and `anon` key in
[src/main/supabase-config.ts](src/main/supabase-config.ts) *are* committed, and that is
correct: the anon key identifies the project, and everything it can reach is decided by the
row-level-security policies in `supabase/migrations/`.

**There is no user key field.** It existed, and it was removed: a dictation tool whose first
screen asks for a Google API key is a tool most people never dictate with. `GEMINI_API_KEY` in
a developer's `.env` still bypasses the server entirely, so working on the app doesn't spend
real users' quota — a packaged build has no environment to read it from.

**No Gemini key exists anywhere in the installer.** The app used to ship a pool of free-tier
keys as `resources/gemini-keys.json`; Phase 5 of the setup doc deleted it, because a key
inside an installer is extractable by anyone who downloads it — a paywall bypass, once the
proxy was live. The only Gemini keys are the server's, set with
`supabase secrets set GEMINI_API_KEYS=...`.

## Developing

Requires **Node 22+** and **ffmpeg** on PATH (`winget install ffmpeg`) — the bundled copy is
only fetched for packaged builds.

```bash
npm install
npm run dev
```

For development, put a key in a `.env` file at the project root. It takes precedence over the
server, so working on the app never spends real users' quota — and it is how you work on
anything except the account and billing flows:

```
GEMINI_API_KEY=...              # or GOOGLE_API_KEY — both are read
WHISPER_UZ_GEMINI_MODEL=...     # optional: try a model without cutting a release
WHISPER_UZ_GEMINI_REALTIME=1    # optional: take the Live socket instead of batch
SUPABASE_URL=...                # optional: point at a staging project
SUPABASE_ANON_KEY=...
```

**To work on sign-in, quota or payment, remove `GEMINI_API_KEY` from `.env`** — with it set,
`resolveRoute()` takes the direct path and never touches the server. The `[state]` log line
tells you which happened: `route=proxy` means the request went through Supabase,
`route=direct` means it did not.

Get a key free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
`npm run spike -- --models` lists what it can actually reach.

### Working without a key

```bash
npm run dev:mock
```

Runs with a fake transcriber, so the hotkey, overlay, level meter, history and paste path
can all be exercised offline and unbilled.

### Comparing models

```bash
# record a few seconds of speech first
ffmpeg -f dshow -i audio="<device>" -ar 16000 -ac 1 -f s16le -t 6 sample.pcm
npm run spike -- --model gemini-3.1-flash-lite,gemini-3.6-flash
```

Same audio through each model, transcripts and latencies side by side, with token counts.
Which model to ship is a question about your own voice; this is how you answer it rather
than assume it. `npm run spike -- --models` lists what your key can reach.

`npm run dev -- --log-frames` dumps every Gemini Live socket frame and any batch response
that parsed to no transcript.

## Releasing

```bash
npm run ffmpeg   # fetch the bundled ffmpeg.exe (~108 MB, pinned + digest-checked)
npm run dist     # -> release/gapir-me-Setup.exe
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
| [src/main/hotkey.ts](src/main/hotkey.ts) | The user's chords, hold/release, via a low-level keyboard hook |
| [src/main/audio.ts](src/main/audio.ts) | ffmpeg capture, device enumeration, RMS, WAV wrapping |
| [src/main/stt/](src/main/stt/) | The proxy adapter, the direct Gemini batch and Live adapters, the prompt, the mock |
| [src/main/auth.ts](src/main/auth.ts) | Google sign-in and the encrypted Supabase session |
| [supabase/](supabase/) | The schema and the three Edge Functions: `transcribe`, `checkout`, `payme` |
| [src/main/inject.ts](src/main/inject.ts) | The clipboard save → paste → restore dance |
| [src/main/overlay.ts](src/main/overlay.ts) | The floating pill that must never steal focus |
| [src/main/history.ts](src/main/history.ts) | The dictation log |
| [src/shared/hotkeys.ts](src/shared/hotkeys.ts) | What a chord is, in the one vocabulary main and both renderers share |
| [src/main/app-paths.ts](src/main/app-paths.ts) | `%APPDATA%\gapir me\`, and the one-time move out of the old folder |
| [src/renderer/app/](src/renderer/app/) | The window: all six panes, the shortcut editor, and the first-run setup |
| [src/renderer/fonts/](src/renderer/fonts/) | The two brand typefaces, bundled because the renderers may not fetch |

## Things that look wrong but aren't

These decisions are load-bearing and will look like mistakes to anyone tidying up:

**Audio comes from an ffmpeg subprocess, not `getUserMedia`.** `uiohook-napi`'s keyboard
hook [silently stops firing on Windows once a getUserMedia stream is
opened](https://github.com/SnosMe/uiohook-napi/issues/54) — which is exactly this app's
usage pattern, and would break the hotkey after the first dictation. The subprocess also
happens to emit precisely the 16 kHz mono s16le that Gemini takes, so audio pipes through
with no conversion.

**A key outside the chord cancels the gesture.** Ctrl+Shift — the default — is the prefix
of half the shortcuts in Windows, Ctrl+Shift+V, Ctrl+Shift+T, Ctrl+Shift+Esc, and holding the
combo on the way to the third key looks exactly like the start of a dictation. So
[hotkey.ts](src/main/hotkey.ts) cancels the moment a key that is not part of the gesture goes
down: the user is typing a shortcut, not speaking, and the sub-`minRecordingMs` guard discards
the false start's half-second of audio. (The trigger used to be Ctrl+CapsLock, which needed a
whole synthetic-keystroke mechanism to un-toggle the caps state each press caused; a chord of
pure modifiers toggles nothing, so all of that is gone — and it is why
[hotkeys.ts](src/shared/hotkeys.ts) warns you off binding an ordinary key to a chord you
*hold*.)

**Setup will not finish until you have signed in.** Every dictation goes through our server,
which needs an account, so a welcome flow that let you press past that step would hand you an
app that cannot transcribe a word and no clue why. The one gate is the first step; everything
after it — microphone, language, keys — has a working default and can be skipped.

**The hotkey doesn't use Electron's `globalShortcut`.** That API requires a non-modifier
key and only fires on press, never release, so a modifier-only hold gesture is impossible
with it.

**The overlay uses `showInactive()` and `focusable: false`, and its window never resizes to
show a bigger pill.** Calling `show()` would activate the window, move the caret out of the
app being dictated into, and paste the text into the wrong place. The window is 360×150 at
the bottom dock (tall enough for the hover tooltip that floats above the pill) and the pill
inside it grows in CSS, because resizing a transparent always-on-top window on Windows
flickers and lags a frame behind. The one programmatic move it does make is dragging: hold
the pill and main walks the window after the cursor, snapping it to the left edge, bottom
centre or right edge on release (persisted as `overlayDock`, along with the height it was
dropped at as `overlayDockY` — a side dock is a whole edge, so the pill stays at the level
you left it). While it is held, a second
full-screen click-through window draws the three slots it can land in, and a magnet leans
the pill toward whichever it is nearing — by at most `MAX_ASSIST_PX`, so the pill never
leaves the cursor carrying it; the drop is what puts it in the slot.

**A side-docked pill is rotated a quarter turn, and its window is 360 wide by 360 tall
instead.** A left or right edge runs top to bottom, so a wide capsule stuck to one reads as
having fallen against the screen rather than as living there. Rotating it takes the hover
tooltip with it — which is why the side window is taller: the tooltip's 150px of text now
needs 150px of *height*. The width stays 360 for the one state that refuses to turn, the
error pill, because a three-line sentence read sideways is not read at all.

**That drag moves the window with `setBounds`, restating the size, never with
`setPosition`.** On a fractionally scaled display — 125% is the Windows default on most
laptops — `setPosition` grows the window about a pixel per call, because Electron rounds
the DIP→physical conversion and then re-derives the size from the rounded rect. At a
hundred-odd calls a second the window outgrows the screen in seconds, and since the pill
hangs from the window's bottom edge it slides out of the user's hand on the way.

**The overlay reacts to hover without ever receiving a mouse event, and main polls the
cursor to do it.** The obvious implementation is `setIgnoreMouseEvents(true, { forward:
true })` plus mouseenter/mouseleave in the renderer, and it was tried first. On Windows that
forwarding runs off a low-level mouse hook inside Electron, and against this window —
transparent, unfocusable, `type: 'toolbar'` — it delivered nothing at all: the renderer saw
no moves and the pill never reacted. So main hit-tests `getCursorScreenPoint()` itself and
sends the answer to the renderer, which is a poll, and is the honest cost of the feature. It
is bounded to the only situation where hover means anything: a resting pill actually on
screen. During a dictation, and whenever `showIdlePill` is off, the interval is cleared. The
hovered hit box is deliberately bigger than the resting one, so the cursor cannot sit on the
hint it just summoned, be judged outside, and collapse it.

**The whole bootstrap is gated on the single-instance lock, not just `app.quit()`.**
`quit()` is a request, not a return: the losing instance would otherwise reach `whenReady`
and call `uIOhook.start()` while already tearing down, and uiohook-napi answers that by
aborting the process with a native fatal error rather than throwing.

**ffmpeg is passed the `@device_cm_{...}` alternative name, not the friendly device
name.** Friendly names are localised — on a Russian-locale Windows they arrive as
Cyrillic and get mangled by the console codepage. Alternative names are ASCII and stable.

**Gemini's request shape is discovered by trying, not by reading the error.** The four
entries in `SHAPES` in [gemini-batch.ts](src/main/stt/gemini-batch.ts) exist because Google
renamed the "don't think about it" field between model generations and rejects the wrong
spelling with a bare *400 Request contains an invalid argument* that names no argument. The
winning shape is memoised per model id.

**The Statistika chart is SVG, not divs.** As DOM elements the bars would not keep the
height they were given — as a flex item, absolutely positioned, in pixels, in percentages
and with `!important`, the height resolved to the full height of the chart — so every day
with no dictations drew a full-height bar that read as a day of solid work. In SVG a height
is geometry rather than a layout suggestion.

## Privacy

Audio goes to Google and is not stored by this app. Transcripts *are* stored, in plaintext,
at `%APPDATA%/gapir me/history.json` — the app window shows you the exact path. It is not
encrypted because the list has to be searchable, and anything that can read `%APPDATA%` can
read this process's memory anyway. What you get instead is a switch to turn the log off and
a button to wipe it. `settings.json` holds no credential; the Supabase session lives beside it
in `auth.json`, encrypted with DPAPI.

**Since dictation moved behind a server, that server sees things too, and it is worth being
precise about which.** It receives the audio of each dictation, forwards it to Google, and
returns the text — it does not store the audio or the transcript. What it does keep is one row
per dictation holding the timestamp, the clip length and the *character count*, which is what
the daily quota is counted from; the server log records the same figures and deliberately not
the transcript, unlike the local log below. Signing in also stores your Google email and
display name. There is no telemetry beyond that.

The diagnostic log next to them, `logs/main.log`, is the one thing that quotes transcripts
back: the `[state]` line records the first 200 characters of each one so a failed dictation
can be diagnosed at all. It stays on that machine — nothing uploads it — but it is worth
knowing about before sending the file to anyone, and the tray's *Loglar papkasi* item opens
the folder it lives in.

Note what the shared key means, because it is the trade this app makes on the user's behalf:
every dictation goes through a Google account this project controls, and Google's terms for
free-tier keys allow that audio to be used for improving their models. That is the price of an
app that works without asking anyone to register with Google first. Anyone who needs it
otherwise should build from source with their own key in a `.env`, which bypasses the server
entirely.

## Not built yet

Deliberately absent, in rough priority order:

- **macOS.** Windows-only for now, and the blocker is practical: a Mac build can't be
  produced on Windows, and the Accessibility / Input Monitoring / Microphone prompts can't
  be verified by CI. Four files need platform branches when the time comes —
  `audio.ts` (dshow → avfoundation), `hotkey.ts` (Ctrl+Shift → hold Right ⌘, or keep the
  combo), `inject.ts` (Ctrl+V → ⌘V), and
  `overlay.ts` (`toolbar` → `panel`, plus `app.dock.hide()`). Shipping it to anyone else
  also needs an Apple Developer account for signing and notarization.
- **Code signing** — see Installing above.
- **Latin/Cyrillic toggle** — Uzbek is split across both scripts, and the prompt currently
  pins output to Latin.
- **Per-app style** — Wispr changes register between a chat window and a document; here the
  Uslub pane is global.
