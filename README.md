# DSP SoundLab

A tiny, install-free web app that turns your phone's **speaker + microphone into a
modem**. Encode text as audio tones, play them, and let another phone's mic decode
them back to text. Same DSP as an RF radio — just at audio frequencies you can hear.

Built as the mobile companion to the `dsp/` learning project. No build step, no
framework, no app store.

## The three-step lead-up

1. **Spectrum** — a live FFT of the mic. See that every sound *is* a set of frequencies.
2. **Tones** — play the marker and data tones so you *hear* frequency-shift keying.
3. **Messenger** — type a message; it plays as a tone sequence and decodes on any
   nearby phone running the page. The payoff: **two phones talking over sound.**

## How the modem works

- **Framing (shared by every modulation):** a START marker tone, then data
  symbols, then an END marker tone, with an **additive checksum byte** appended to
  the payload. Each symbol is a **tone burst + short silent gap**. The gap makes
  the link *self-clocking* — the receiver watches for bursts separated by silence,
  so no synchronized clock is needed.
- **Receiver:** runs an FFT every animation frame, tracks the loudest in-band peak,
  collects a burst's frames, and hands them to the current modulation to decode.
  A checksum then marks each message **✓ verified** or **✗ corrupt**.

## Selectable modulations

Pick one in the Messenger tab (both phones must match). All share the framing
above; they differ only in how a data symbol is rendered and decoded:

| Modulation | Bits/sym | Notes |
|-----------|----------|-------|
| **2 / 4 / 8 / 16-FSK** | 1 / 2 / 3 / 4 | One of M evenly spaced tones. Robust — frequency survives amplitude & phase changes. More tones = faster but tighter spacing. |
| **OOK/ASK** | 1 | One carrier at two amplitudes. **Fragile on purpose** — watch it fail as the phones move apart; that's *why* FSK is preferred. |
| **Chirp (CSS)** | 1 | Up-sweep = 0, down-sweep = 1 (LoRa-style). Noise/Doppler tolerant, beautiful diagonal streaks on the waterfall. *Experimental* frame-slope decoder. |
| **FHSS** | 2 | 4-FSK whose tone block hops across the band on a shared pseudo-noise schedule. Ties into the spread-spectrum lessons; scatters across the waterfall. |

The pluggable design lives in `app.js`: each modulation is a small object with
`txData()` / `decodeData()`, and bit-packing / framing / checksum are shared. Add
a new scheme by dropping another object into the `MODS` array.

All timing and thresholds are tunable at the top of `app.js` (`SYMBOL_MS`,
`GAP_MS`, `TOLERANCE`, `SNR_DB`, …).

## Running it

The microphone requires a **secure context**:

- **Desktop testing:** `localhost` counts as secure.
  ```
  cd dsp/webapp
  python -m http.server 8000
  # open http://localhost:8000
  ```
- **Two real phones:** they need **HTTPS**. Easiest is GitHub Pages (free, HTTPS):
  push this folder to a repo, enable Pages, open the URL on both phones. `ngrok
  http 8000` also works for a quick test.

Then on each phone: open the page → tap **Enable microphone & audio** → go to
**Messenger** → send. Keep the phones within ~30 cm and the volume up.

## Tips / gotchas

- Turn the **volume up** and keep phones close for the first try.
- The sending phone also hears itself (loopback) — handy for testing solo.
- Noisy rooms shorten range; raise `SNR_DB` / `SYMBOL_MS` if decoding is flaky.
- iOS Safari and Android Chrome both need the initial tap (autoplay policy).

## Next ideas

- Error detection (a checksum symbol) so garbled messages are flagged.
- Faster protocol (concurrent tones / shorter symbols) once the basics feel solid.
- A "capture to file" button to feed real recordings into the Python `fft.py`.
