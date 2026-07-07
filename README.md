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

## Wire format (the protocol)

This is the "contract" both phones must agree on. All values are the constants at
the top of `app.js` — they are **not** user-adjustable at runtime (except the
receiver's SNR threshold, which is a local decision and doesn't affect the format).
Two phones interoperate only if these match.

### Frequency plan

| Element        | Frequency        | Notes |
|----------------|------------------|-------|
| START marker   | **1500 Hz**      | announces the start of a frame (`F_START`) |
| END marker     | **3500 Hz**      | ends the frame (`F_END`) |
| Data band      | **1700–3300 Hz** | where payload tones live (`DATA_LO`…`DATA_HI`) |
| Detection band | **1350–3650 Hz** | receiver only looks here (`BAND_LO`…`BAND_HI`) |

### Timing (self-clocking)

Every symbol — markers included — is a **120 ms tone burst** (`SYMBOL_MS`) followed
by a **60 ms silence** (`GAP_MS`). There is no shared clock: the receiver detects
bursts separated by silence, so timing drift between phones doesn't matter.

### Frame structure

```
[START] [data symbol]…[data symbol] [END]
         └── payload bytes + 1 checksum byte, packed to symbols ──┘
```

1. **Payload** = the message text as **UTF-8** bytes.
2. **Checksum** = one byte = `(sum of all payload bytes) mod 256`, appended after
   the payload. The receiver pops the last byte, recomputes the sum over the rest,
   and flags the message **✓ verified** or **✗ corrupt**.
3. **Bit packing** = each byte → 8 bits **MSB-first**; the bit stream is then chopped
   into symbols of `k` bits (`k` = bits/symbol for the chosen modulation), again
   MSB-first. A final partial symbol is zero-padded; trailing sub-byte bits are
   dropped on decode.

### Symbol → tone mapping (per modulation)

All modulations share the framing above and differ only in how one data symbol of
`k` bits is rendered/decoded:

| Modulation   | k | Symbol rendering |
|--------------|---|------------------|
| **M-FSK** (M=2/4/8/16) | 1/2/3/4 | symbol value *v* → tone `1700 + v·(1600/(M−1))` Hz (M tones evenly spanning the data band) |
| **OOK/ASK**  | 1 | carrier **2000 Hz** at amplitude 0.16 (bit 0) or 0.36 (bit 1); RX decides by SNR ≥ 19 dB |
| **Chirp/CSS**| 1 | up-sweep 1700→3300 Hz = 0, down-sweep 3300→1700 Hz = 1; decoded by quadrature matched filter |
| **FHSS**     | 2 | 4-FSK block whose base hops over `[1700,2100,2500,2900]` on a fixed 16-entry PN schedule indexed by data-symbol position; tone = `base + v·100` Hz |
| **DBPSK**    | 1 | carrier **2000 Hz**; bit = phase **change** (1) vs **same** (0) from the previous symbol, with a leading reference symbol; rendered phase-continuous |

### Receiver rules

- A burst "counts" when the loudest peak in the detection band is at least
  `ABS_FLOOR` (−80 dBFS-ish) **and** clears the SNR threshold (`SNR_DB`, default
  10 dB, adjustable live).
- A burst must last ≥ `MIN_TONE_MS` (45 ms); ≥ `MIN_GAP_MS` (30 ms) of silence ends
  the current symbol.
- A burst is a **marker** if its median frequency is within `TOLERANCE` (±45 Hz) of
  1500/3500 Hz; otherwise it's handed to the modulation's decoder.
- A partially-received frame is abandoned after `RX_TIMEOUT_MS` (2500 ms) of silence.

### Frame validation — "is it really a message?"

A reception is only accepted as genuine when **all three** hold:

1. **It framed.** A START marker opened it and an END marker closed it (a lone START
   that never sees an END times out as `✗ incomplete`).
2. **Every symbol was real.** Each burst cleared the loudness floor and the SNR
   threshold and met the min-duration/gap timing — ambient hiss and clicks are
   filtered out before they ever become symbols.
3. **The checksum matched.** The recomputed `sum mod 256` over the payload equals the
   trailing checksum byte → logged `✓ verified`; otherwise `✗ corrupt`.

So a `✓ verified` means "framed correctly **and** integrity-checked." A false START
from room noise almost always dies at step 1 or 3, showing as `incomplete`/`corrupt`
rather than a false accept.

**Known limits (this is a teaching modem, not a hardened link):**

- The checksum is a weak **8-bit additive sum**: random/garbled data has a ~**1/256
  (0.4%)** chance of passing by coincidence, and it misses byte swaps and
  compensating errors.
- There is **no length field, no CRC, and no real preamble** — just a single START
  tone — so noise can *trigger* a reception (it just rarely survives to `✓`).

**Possible hardening** (all drop into the shared framing): swap the additive byte for
a **CRC-16** (~1/65536 false-accept, catches burst errors), add a **length field** so
truncated/overrun frames are rejected outright, and use a **multi-tone sync word**
instead of a lone START so a stray blip can't begin a reception.

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
