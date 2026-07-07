/* =============================================================================
 * DSP SoundLab — data over sound, in the browser.
 *
 * Your phone's speaker + mic form a real modem: text is encoded as audio tones,
 * played out loud, and decoded by another phone's microphone. Same DSP as an RF
 * radio, just at audio frequencies you can hear.
 *
 * This version supports SELECTABLE MODULATIONS. Everything shares one framing:
 *   START marker  ·  data symbols (burst + silent gap = self-clocking)  ·  END
 *   marker, with an additive checksum byte appended to the payload.
 * A "modulation" only decides two things:
 *   - txData():     how to render one data symbol to sound
 *   - decodeData():  how to turn one received tone-burst back into a symbol value
 * Bit-packing (symbol value <-> bits <-> bytes) is shared, so changing the
 * alphabet size (2/4/8/16-FSK) or the scheme (ASK, chirp, FHSS) just works.
 *
 * NOTE: both phones must select the SAME modulation to talk to each other.
 * ===========================================================================*/

/* ---- Framing / channel constants ------------------------------------------ */
const SYMBOL_MS = 120;   // how long each symbol sounds
const GAP_MS    = 60;    // silence between symbols (the self-clocking trick)
const AMP       = 0.3;   // default transmit volume (0..1)

const F_START = 1500;    // start-of-message marker tone
const F_END   = 3500;    // end-of-message marker tone
const DATA_LO = 1700;    // low edge of the data-tone band
const DATA_HI = 3300;    // high edge of the data-tone band

const BAND_LO = 1350;    // detection band (includes both markers)
const BAND_HI = 3650;
const TOLERANCE = 45;    // Hz — how close a peak must be to count as a given tone
let SNR_DB      = 10;    // a burst must beat the in-band average by this to count
                         // (adjustable live via the Sensitivity slider)
const ABS_FLOOR = -80;   // ...and be at least this loud (dBFS-ish)

const MIN_TONE_MS   = 45;   // ignore tone blips shorter than this
const MIN_GAP_MS    = 30;   // this much silence ends the current symbol
const RX_TIMEOUT_MS = 2500; // give up on a partial message after this much silence

/* ---- Low-level audio scheduling primitives -------------------------------- */
// A steady tone burst of length SYMBOL_MS at time t (click-free envelope).
function scheduleTone(osc, gain, freq, t, amp = AMP) {
  const Ts = SYMBOL_MS / 1000, atk = 0.006;
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(amp, t + atk);
  gain.gain.setValueAtTime(amp, t + Ts - atk);
  gain.gain.linearRampToValueAtTime(0, t + Ts);
}
// A frequency sweep from f0 to f1 over SYMBOL_MS (a chirp).
function scheduleChirp(osc, gain, f0, f1, t) {
  const Ts = SYMBOL_MS / 1000, atk = 0.006;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.linearRampToValueAtTime(f1, t + Ts);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(AMP, t + atk);
  gain.gain.setValueAtTime(AMP, t + Ts - atk);
  gain.gain.linearRampToValueAtTime(0, t + Ts);
}

const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// Given a burst's per-frame peaks and a candidate tone list, vote for the
// closest tone each frame and return the winning index (or null). Shared by the
// frequency-based modulations (FSK and FHSS).
function voteNearestTone(frames, tones) {
  const votes = new Array(tones.length).fill(0);
  for (const fr of frames) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < tones.length; i++) {
      const d = Math.abs(tones[i] - fr.freq);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bd <= TOLERANCE) votes[bi]++;
  }
  let best = -1, bn = 0;
  for (let i = 0; i < tones.length; i++) if (votes[i] > bn) { bn = votes[i]; best = i; }
  return bn > 0 ? best : null;
}

/* ---- Time-domain DSP (for chirp matched filter + PSK phase) ---------------- */
// The last n samples ending at the current write head, in order.
function getRecentSamples(n) {
  n = Math.min(n, capBuf.length);
  const out = new Float32Array(n);
  let p = (capPos - n + capBuf.length) % capBuf.length;
  for (let i = 0; i < n; i++) { out[i] = capBuf[p]; p = (p + 1) % capBuf.length; }
  return out;
}
// Crude boxcar-decimate by D (averages D samples — a cheap anti-alias low-pass).
function decimate(x, D) {
  const N = Math.floor(x.length / D), y = new Float32Array(N);
  for (let i = 0; i < N; i++) { let s = 0; for (let j = 0; j < D; j++) s += x[i * D + j]; y[i] = s / D; }
  return y;
}
// Quadrature reference chirp sweeping f0->f1 over N samples at rate fs.
function refChirp(f0, f1, fs, N) {
  const cos = new Float32Array(N), sin = new Float32Array(N);
  const k = (f1 - f0) / (N / fs);
  for (let n = 0; n < N; n++) {
    const t = n / fs, ph = 2 * Math.PI * (f0 * t + 0.5 * k * t * t);
    cos[n] = Math.cos(ph); sin[n] = Math.sin(ph);
  }
  return { cos, sin };
}
// Slide a quadrature reference over w and return the peak envelope magnitude —
// a phase-insensitive matched filter with a search over start offset (which
// also absorbs any timing slop between capture and symbol boundaries).
function matchedPeak(w, ref) {
  const N = ref.cos.length; let best = 0;
  const step = Math.max(1, Math.floor(N / 64));
  for (let off = 0; off + N <= w.length; off += step) {
    let I = 0, Q = 0;
    for (let n = 0; n < N; n++) { const x = w[off + n]; I += x * ref.cos[n]; Q += x * ref.sin[n]; }
    const m = Math.hypot(I, Q);
    if (m > best) best = m;
  }
  return best / N;
}
// Carrier phase of the strongest N-sample window in w, measured against the
// ABSOLUTE sample clock (startAbs = index of w[0]). Using a common time origin
// is what makes differential PSK phase comparisons meaningful across symbols.
// Returns the phase in radians, or null if the window is too quiet.
function iqPhaseAbs(w, fc, fs, N, startAbs) {
  let best = 0, bI = 0, bQ = 0;
  const step = Math.max(1, Math.floor(N / 128));
  for (let off = 0; off + N <= w.length; off += step) {
    let I = 0, Q = 0;
    for (let n = 0; n < N; n++) {
      const a = 2 * Math.PI * fc * (startAbs + off + n) / fs, x = w[off + n];
      I += x * Math.cos(a); Q += x * Math.sin(a);
    }
    const m = I * I + Q * Q;
    if (m > best) { best = m; bI = I; bQ = Q; }
  }
  if (best < 1e-4 * N * N) return null;
  return Math.atan2(bQ, bI);
}

/* ---- The modulation registry --------------------------------------------- *
 * Each modulation exposes:
 *   name, bits           — label + bits carried per data symbol
 *   guides()             — tone frequencies to draw on the waterfall
 *   txData(osc,gain,sym,idx,t) — schedule data symbol `sym` at time t
 *   decodeData(frames,idx)     — burst frames -> symbol value (or null)
 * `idx` is the data-symbol index since START (used by FHSS to de-hop).
 */

// M-ary FSK: one of M evenly spaced tones per symbol. M=16 is the classic
// default; M=2 is plain binary FSK. Robust because frequency survives amplitude
// and phase changes over the acoustic channel.
function makeFSK(M) {
  const bits = Math.round(Math.log2(M));
  const tones = M === 1 ? [DATA_LO]
    : Array.from({ length: M }, (_, i) => DATA_LO + (i * (DATA_HI - DATA_LO)) / (M - 1));
  return {
    name: M + '-FSK', bits,
    guides: () => tones.slice(),
    txData: (osc, gain, sym, idx, t) => scheduleTone(osc, gain, tones[sym], t),
    decodeData: (frames) => voteNearestTone(frames, tones),
  };
}

// OOK/ASK: a single carrier at one of two amplitudes. Deliberately the fragile
// one — amplitude changes with distance, so this blurs and fails as the phones
// move apart. Great for *seeing* why frequency-based schemes are preferred.
function makeASK() {
  const CARRIER = 2000, AMP_LO = 0.16, AMP_HI = 0.36, THRESH_DB = 19;
  return {
    name: 'OOK/ASK', bits: 1, iq: 'amp', // amplitude → constellation on the I axis
    guides: () => [CARRIER],
    txData: (osc, gain, sym, idx, t) =>
      scheduleTone(osc, gain, CARRIER, t, sym ? AMP_HI : AMP_LO),
    decodeData: (frames) => {
      const snrs = frames.filter((fr) => Math.abs(fr.freq - CARRIER) <= TOLERANCE)
        .map((fr) => fr.snr).sort((a, b) => a - b);
      if (!snrs.length) return null;
      const median = snrs[Math.floor(snrs.length / 2)];
      // Plot the symbol's strength along +I (radius = amplitude), with a little
      // spread so overlapping symbols read as a cloud. As the link weakens both
      // clusters slide toward the origin and merge — the visual "why ASK is fragile".
      const r = Math.max(0, Math.min(1, median / 40));
      pushConstellation(r, (Math.random() - 0.5) * 0.08);
      return median >= THRESH_DB ? 1 : 0; // fragile by design
    },
  };
}

// Chirp / CSS (LoRa-style): each symbol is a frequency sweep — up = 0, down = 1.
// Very noise/Doppler tolerant and gorgeous on the waterfall (diagonal streaks).
// Decoded with a proper quadrature MATCHED FILTER: correlate the captured
// waveform against reference up- and down-chirps (with a search over start
// offset) and take whichever matches better.
function makeChirp() {
  const F0 = 1700, F1 = 3300, DECIM = 4;
  return {
    name: 'Chirp (CSS)', bits: 1,
    guides: () => [F0, (F0 + F1) / 2, F1],
    txData: (osc, gain, sym, idx, t) =>
      sym ? scheduleChirp(osc, gain, F1, F0, t) : scheduleChirp(osc, gain, F0, F1, t),
    decodeData: (frames, idx, rx) => {
      const fs = rx.sampleRate;
      const w = decimate(rx.getRecent(Math.floor(fs * (SYMBOL_MS + 2 * GAP_MS) / 1000)).x, DECIM);
      const fsd = fs / DECIM, N = Math.floor(fsd * SYMBOL_MS / 1000);
      const up = matchedPeak(w, refChirp(F0, F1, fsd, N));
      const dn = matchedPeak(w, refChirp(F1, F0, fsd, N));
      if (Math.max(up, dn) < 1e-4) return null;
      return up >= dn ? 0 : 1;   // up-chirp = 0, down-chirp = 1
    },
  };
}

// DBPSK (differential binary phase-shift keying): a single carrier where each
// bit is encoded as a phase CHANGE from the previous symbol (change = 1, same =
// 0). Differential means no absolute carrier reference is needed — the only PSK
// that's remotely feasible between two independent phones. Even so it's the most
// acoustically demanding scheme (room echo scrambles phase), so treat it as a
// solo/loopback constellation demo. A leading reference symbol seeds the phase.
function makeDBPSK() {
  const CAR = 2000;
  return {
    name: 'DBPSK', bits: 1, experimental: true, iq: 'phase', // phase → ±I constellation
    guides: () => [CAR],
    reset: () => { dbpskPrev = null; constPoints = []; },
    // Render the whole message to a sample buffer with a phase-continuous
    // carrier (played via an AudioBuffer, not the shared oscillator).
    renderBuffer: (dataSyms) => {
      const fs = ctx.sampleRate;
      const Nsy = Math.floor(fs * SYMBOL_MS / 1000), Ng = Math.floor(fs * GAP_MS / 1000);
      const atk = Math.floor(fs * 0.006);
      const phases = [0]; let p = 0;
      for (const b of dataSyms) { p += b ? Math.PI : 0; phases.push(p); } // [ref, ...data]
      const seq = [{ tone: F_START }, ...phases.map((ph) => ({ ph })), { tone: F_END }];
      const buf = new Float32Array(seq.length * (Nsy + Ng));
      let pos = 0;
      for (const s of seq) {
        for (let n = 0; n < Nsy; n++) {
          const abs = pos + n; // absolute index keeps the carrier phase continuous
          const f = s.tone !== undefined ? s.tone : CAR;
          const env = Math.max(0, Math.min(1, n / atk, (Nsy - n) / atk));
          buf[pos + n] = Math.sin(2 * Math.PI * f * abs / fs + (s.ph || 0)) * AMP * env;
        }
        pos += Nsy + Ng;
      }
      return buf;
    },
    decodeData: (frames, idx, rx) => {
      const fs = rx.sampleRate, N = Math.floor(fs * SYMBOL_MS / 1000);
      const { x, startAbs } = rx.getRecent(Math.floor(fs * (SYMBOL_MS + 2 * GAP_MS) / 1000));
      const ph = iqPhaseAbs(x, CAR, fs, N, startAbs);
      if (ph === null) return null;
      let bit = null;
      if (dbpskPrev !== null) {           // first symbol is the phase reference
        let d = ph - dbpskPrev;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        bit = Math.abs(d) > Math.PI / 2 ? 1 : 0;
        pushConstellation(Math.cos(d), Math.sin(d));
      }
      dbpskPrev = ph;
      return bit;
    },
  };
}

// FHSS: 4-ary FSK whose tone block hops across the band on a shared pseudo-noise
// schedule, one hop per symbol. Ties into the repo's spread-spectrum lessons and
// scatters across the waterfall. Both ends run the same PN sequence indexed by
// the symbol position, so the receiver knows where to listen.
function makeFHSS() {
  const M = 4, SPACING = 100;
  const HOPS = [1700, 2100, 2500, 2900];        // block base frequencies
  const PN = [0, 2, 3, 1, 2, 0, 1, 3, 3, 1, 0, 2, 1, 3, 2, 0]; // fixed hop pattern
  const tonesAt = (idx) => {
    const base = HOPS[PN[idx % PN.length]];
    return Array.from({ length: M }, (_, s) => base + s * SPACING);
  };
  return {
    name: 'FHSS', bits: 2,
    guides: () => {
      const gs = [];
      for (const h of HOPS) for (let s = 0; s < M; s++) gs.push(h + s * SPACING);
      return gs;
    },
    txData: (osc, gain, sym, idx, t) => scheduleTone(osc, gain, tonesAt(idx)[sym], t),
    decodeData: (frames, idx) => voteNearestTone(frames, tonesAt(idx)),
  };
}

const MODS = [makeFSK(2), makeFSK(4), makeFSK(8), makeFSK(16),
              makeASK(), makeChirp(), makeFHSS(), makeDBPSK()];
let mod = MODS[3];  // default: 16-FSK (the original behavior)

function pushConstellation(x, y) { constPoints.push({ x, y }); if (constPoints.length > 96) constPoints.shift(); }

/* ---- Bit / byte packing (shared by every modulation) ---------------------- */
function bytesToBits(bytes) {
  const b = [];
  for (const by of bytes) for (let i = 7; i >= 0; i--) b.push((by >> i) & 1);
  return b;
}
function bitsToBytes(bits) {
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    out.push(v);
  }
  return out; // trailing <8 padding bits are dropped
}
function bitsToSymbols(bits, k) {
  const s = [];
  for (let i = 0; i < bits.length; i += k) {
    let v = 0; for (let j = 0; j < k; j++) v = (v << 1) | (bits[i + j] || 0);
    s.push(v);
  }
  return s;
}
function symbolsToBits(syms, k) {
  const b = [];
  for (const s of syms) for (let i = k - 1; i >= 0; i--) b.push((s >> i) & 1);
  return b;
}

/* ---- Audio graph state ---------------------------------------------------- */
let ctx = null, analyser = null, freqData = null, byteData = null;
let muted = false; // TX kill switch: when true, every transmit path is blocked (see setMuted)
let micStream = null, micSrc = null, capNode = null; // the live mic graph (rebuilt on unmute)
let micMuted = false; // RX kill switch: when true the mic is fully released (see stopMic)
let bandLoBin = 0, bandHiBin = 0;
let running = false;
let wfRow = null;          // reusable 1-pixel-tall ImageData for the waterfall
let signalSNR = -Infinity; // loudest in-band peak above the noise floor, in dB
let specMode = 'fft';      // 'fft' = instantaneous magnitude bars; 'psd' = averaged trace
let psdFloat = null, psdAvg = null; // scratch + running power average for the PSD view
const PSD_ALPHA = 0.15;    // Welch-ish EMA weight per frame (lower = smoother/slower)
let capBuf = null, capPos = 0, capTotal = 0; // ring buffer + absolute sample clock
let constPoints = [];      // recent DBPSK phasors for the constellation view
let dbpskPrev = null;      // previous DBPSK symbol phase (for differential decode)

/* ---- Helpers -------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const setStatus = (t) => { $('status').textContent = t; };
function binToFreq(b) { return (b * ctx.sampleRate) / analyser.fftSize; }
function freqToBin(f) { return Math.round((f * analyser.fftSize) / ctx.sampleRate); }

/* ---- Startup (needs a user gesture on mobile) ----------------------------- */
async function enable() {
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    setupAudioGraph(); // analyser + buffers exist even before a mic is attached

    $('enable').style.display = 'none';
    $('controls').hidden = false;
    running = true;
    requestAnimationFrame(loop);
    drawGuides();

    // Defaults: both kill switches ON. Transmit is off and the mic is NOT acquired
    // (no permission prompt) until the user turns them on with the buttons.
    micMuted = true;
    setMuted(true);
    setMicMutedUI(true);
  } catch (err) {
    $('enableErr').textContent = 'Could not start: ' + err.message + ' — tap to retry.';
    setStatus('could not start audio: ' + err.message);
  }
}

// Build the analysis graph once, with no mic connected yet. An AnalyserNode with no
// input just reads as silence, so the spectrum/waterfall run (flat) until the mic is
// turned on. startMic() later connects a source into this same analyser.
function setupAudioGraph() {
  analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0.0;
  analyser.minDecibels = -100;
  analyser.maxDecibels = -10;
  freqData = new Float32Array(analyser.frequencyBinCount);
  byteData = new Uint8Array(analyser.frequencyBinCount);
  bandLoBin = freqToBin(BAND_LO);
  bandHiBin = freqToBin(BAND_HI);
  capBuf = new Float32Array(Math.ceil(ctx.sampleRate * 1.0)); capPos = 0; // 1 s ring
}

/* ---- Microphone acquire / release (the RX side; also the mic-mute engine) ---
 * Muting the mic actually STOPS the MediaStream tracks, so the phone's "mic in use"
 * indicator turns off — real reassurance, not just discarded samples. Unmuting
 * re-acquires (no re-prompt after the first grant) and rebuilds the capture graph. */
async function startMic() {
  // Turn OFF the phone's speech "cleanup" — it would eat our tones.
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  micSrc = ctx.createMediaStreamSource(micStream);
  micSrc.connect(analyser); // into the graph built by setupAudioGraph()

  // Raw-sample capture path (chirp matched filter + PSK phase need the actual
  // waveform, not just spectra). ScriptProcessor is deprecated but simple and
  // universal; fine for a learning demo.
  capNode = ctx.createScriptProcessor(2048, 1, 1);
  capNode.onaudioprocess = (e) => {
    const inp = e.inputBuffer.getChannelData(0);
    for (let i = 0; i < inp.length; i++) {
      capBuf[capPos] = inp[i]; capPos = (capPos + 1) % capBuf.length; capTotal++;
    }
  };
  const sink = ctx.createGain(); sink.gain.value = 0; // keep the node alive without audible output
  micSrc.connect(capNode); capNode.connect(sink); sink.connect(ctx.destination);
  micMuted = false;
}

function stopMic() {
  micMuted = true;
  if (micSrc) { try { micSrc.disconnect(); } catch (_) {} micSrc = null; }
  if (capNode) { capNode.onaudioprocess = null; try { capNode.disconnect(); } catch (_) {} capNode = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; } // releases the mic
  // Drop any half-received message and blank the visuals so it's clearly "off".
  rxActive = false; setRxLive('');
  signalSNR = -Infinity;
  if (byteData) byteData.fill(0);
  if (freqData) freqData.fill(-100);
}

/* ---- Per-frame loop ------------------------------------------------------- */
function loop() {
  if (!running) return;
  drawSpectrum();   // refreshes byteData + draws the instantaneous bars
  drawWaterfall();  // reuses byteData for its new row
  if (!micMuted) decodeStep(); // mic released → nothing to decode (updates signalSNR)
  drawConstellation();
  requestAnimationFrame(loop);
}

/* ---- Spectrum: FFT bars or averaged PSD trace ----------------------------- */
function drawSpectrum() {
  const cv = $('spectrum'), g = cv.getContext('2d');
  const W = cv.width, H = cv.height, maxBin = freqToBin(5000);
  analyser.getByteFrequencyData(byteData); // always refresh — the waterfall reuses it
  g.fillStyle = '#0b1020'; g.fillRect(0, 0, W, H);
  // Shaded data-tone band (common to both views).
  const bx = (bandLoBin / maxBin) * W, bw = ((bandHiBin - bandLoBin) / maxBin) * W;
  g.fillStyle = 'rgba(90,140,255,0.12)'; g.fillRect(bx, 0, bw, H);

  if (specMode === 'psd') drawPsd(g, W, H, maxBin);
  else drawFftBars(g, W, H, maxBin);

  drawThreshold(g, W, H, maxBin); // detection line floating above the live noise floor
  drawFreqAxis(g, W, H, maxBin);
}

// x-axis: kHz ticks across the full 0–5 kHz span, plus START/END markers so you can
// see exactly where the in-band tones are relative to whatever energy is showing.
function drawFreqAxis(g, W, H, maxBin) {
  g.font = '9px system-ui,sans-serif';
  g.textAlign = 'center';
  for (let f = 1000; f <= 4000; f += 1000) {
    const x = (freqToBin(f) / maxBin) * W;
    g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H - 12); g.stroke();
    g.fillStyle = 'rgba(139,150,196,0.9)';
    g.fillText((f / 1000) + 'k', x, H - 2);
  }
  for (const [f, label] of [[F_START, 'START'], [F_END, 'END']]) {
    const x = (freqToBin(f) / maxBin) * W;
    g.strokeStyle = 'rgba(124,140,255,0.55)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H - 12); g.stroke();
    g.fillStyle = 'rgba(200,210,255,0.9)'; g.textAlign = 'left';
    g.fillText(label, x + 2, 10);
    g.textAlign = 'center';
  }
}

// The detection rule is "peak must beat the in-band average by SNR_DB", which is a
// *relative* test — so on an absolute-level plot the threshold is a line SNR_DB above
// the current noise floor. The vertical gap between the two dashed lines literally IS
// the SNR requirement; a peak that pokes above the red line is what registers.
function drawThreshold(g, W, H, maxBin) {
  const FLOOR = analyser.minDecibels, CEIL = analyser.maxDecibels;
  const yOf = (db) => H * (1 - (Math.max(FLOOR, Math.min(CEIL, db)) - FLOOR) / (CEIL - FLOOR));

  // In-band noise floor = mean level across the detection band (byteData is a linear
  // map of FLOOR..CEIL dB, so averaging the bytes ≈ the mean dB the detector uses).
  let sum = 0, n = 0;
  for (let b = bandLoBin; b <= bandHiBin && b < byteData.length; b++) { sum += byteData[b]; n++; }
  const noiseDb = FLOOR + (n ? sum / n : 0) / 255 * (CEIL - FLOOR);
  const yN = yOf(noiseDb), yT = yOf(noiseDb + SNR_DB);

  // Draw ONLY across the detection band, fading out at the edges (roll-off), so it's
  // clear the threshold governs this band — not the whole 0–5 kHz display.
  const xLo = (bandLoBin / maxBin) * W, xHi = (bandHiBin / maxBin) * W;
  const bandLine = (y, rgb, alpha, width) => {
    const gr = g.createLinearGradient(xLo, 0, xHi, 0);
    gr.addColorStop(0, `rgba(${rgb},0)`);
    gr.addColorStop(0.14, `rgba(${rgb},${alpha})`);
    gr.addColorStop(0.86, `rgba(${rgb},${alpha})`);
    gr.addColorStop(1, `rgba(${rgb},0)`);
    g.strokeStyle = gr; g.lineWidth = width;
    g.beginPath(); g.moveTo(xLo, y); g.lineTo(xHi, y); g.stroke();
  };

  g.save();
  g.setLineDash([4, 4]);
  bandLine(yN, '139,150,196', 0.7, 1);   // noise floor
  bandLine(yT, '255,143,143', 1, 1.5);   // detection threshold
  g.setLineDash([]);

  g.font = '10px system-ui,sans-serif'; g.textAlign = 'right';
  g.fillStyle = '#ff8f8f';
  g.fillText('detect ▸ noise + ' + SNR_DB + ' dB', xHi - 2, Math.max(yT - 3, 10));
  g.fillStyle = 'rgba(139,150,196,0.9)';
  g.fillText('noise', xHi - 2, Math.min(yN + 12, H - 15));
  g.restore();
}

// Raw, instantaneous magnitude — jumpy but responsive.
function drawFftBars(g, W, H, maxBin) {
  const barW = W / maxBin;
  g.fillStyle = '#5ad1ff';
  for (let b = 0; b < maxBin; b++) {
    const h = (byteData[b] / 255) * H;
    g.fillRect(b * barW, H - h, Math.max(1, barW), h);
  }
}

// Power spectral density: exponentially time-average the power (Welch-style), then
// draw a smooth filled trace with a dB grid — the calmer spectrum-analyzer look.
function drawPsd(g, W, H, maxBin) {
  const n = analyser.frequencyBinCount;
  if (!psdFloat || psdFloat.length !== n) { psdFloat = new Float32Array(n); psdAvg = null; }
  analyser.getFloatFrequencyData(psdFloat); // magnitude in dB (10·log10 power)
  if (!psdAvg) { psdAvg = new Float32Array(n); for (let i = 0; i < n; i++) psdAvg[i] = 1e-10; }
  for (let b = 0; b < maxBin; b++) {
    const lin = Math.pow(10, psdFloat[b] / 10);          // dB -> linear power
    psdAvg[b] = PSD_ALPHA * lin + (1 - PSD_ALPHA) * psdAvg[b]; // average in power domain
  }

  const FLOOR = analyser.minDecibels, CEIL = analyser.maxDecibels; // -100 .. -10
  const yOf = (db) => H * (1 - (Math.max(FLOOR, Math.min(CEIL, db)) - FLOOR) / (CEIL - FLOOR));

  // dB grid + labels.
  g.strokeStyle = 'rgba(255,255,255,0.06)'; g.fillStyle = 'rgba(139,150,196,0.7)';
  g.font = '9px system-ui,sans-serif'; g.textAlign = 'left'; g.lineWidth = 1;
  for (let db = Math.ceil(FLOOR / 20) * 20; db <= CEIL; db += 20) {
    const y = yOf(db);
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    g.fillText(db + ' dB', 3, y - 2);
  }

  // Filled trace.
  g.beginPath();
  for (let b = 0; b < maxBin; b++) {
    const db = 10 * Math.log10(psdAvg[b] + 1e-12);
    const x = (b / maxBin) * W, y = yOf(db);
    b === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.lineTo(W, H); g.lineTo(0, H); g.closePath();
  g.fillStyle = 'rgba(90,209,255,0.18)'; g.fill();

  // Bright stroke on top.
  g.beginPath();
  for (let b = 0; b < maxBin; b++) {
    const db = 10 * Math.log10(psdAvg[b] + 1e-12);
    const x = (b / maxBin) * W, y = yOf(db);
    b === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.strokeStyle = '#5ad1ff'; g.lineWidth = 1.5; g.stroke();
}

/* ---- Waterfall (spectrogram) ---------------------------------------------- */
function drawWaterfall() {
  const cv = $('waterfall'), g = cv.getContext('2d');
  const W = cv.width, H = cv.height, maxBin = freqToBin(5000);
  if (!wfRow || wfRow.width !== W) wfRow = g.createImageData(W, 1);
  const d = wfRow.data;
  for (let x = 0; x < W; x++) {
    const c = heat(byteData[Math.floor((x / W) * maxBin)] / 255);
    const i = x * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
  }
  // Scroll down one pixel by copying pixels explicitly. (Drawing the canvas onto
  // its own context — drawImage(cv,0,1) — is a no-op in some engines, e.g. iOS
  // Safari, which left the waterfall frozen while the spectrum kept updating.)
  const prev = g.getImageData(0, 0, W, H - 1);
  g.putImageData(prev, 0, 1);   // shift existing rows down
  g.putImageData(wfRow, 0, 0);  // new line at the top
}
function heat(v) {
  v = Math.max(0, Math.min(1, v));
  const stops = [[11, 16, 32], [30, 60, 160], [40, 180, 200], [240, 220, 60], [230, 60, 40]];
  const s = v * (stops.length - 1), i = Math.floor(s), f = s - i;
  const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
  return [Math.round(a[0] + (b[0] - a[0]) * f),
          Math.round(a[1] + (b[1] - a[1]) * f),
          Math.round(a[2] + (b[2] - a[2]) * f)];
}
// Static overlay: a guide line at each of the current modulation's tones.
function drawGuides() {
  const cv = $('wfguides'), g = cv.getContext('2d');
  const W = cv.width, H = cv.height, maxBin = freqToBin(5000);
  g.clearRect(0, 0, W, H);
  for (const f of mod.guides()) {
    const x = (freqToBin(f) / maxBin) * W;
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
  for (const [f, label] of [[F_START, 'START'], [F_END, 'END']]) {
    const x = (freqToBin(f) / maxBin) * W;
    g.strokeStyle = 'rgba(124,140,255,0.55)';
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    g.fillStyle = 'rgba(200,210,255,0.75)'; g.font = '10px system-ui,sans-serif';
    g.fillText(label, x + 3, 12);
  }
}

/* ---- Constellation view (for DBPSK) --------------------------------------- */
function drawConstellation() {
  const cv = $('constellation'); if (!cv) return;
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.4;
  g.fillStyle = '#0b1020'; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,0.15)';
  g.beginPath(); g.moveTo(0, cy); g.lineTo(W, cy); g.moveTo(cx, 0); g.lineTo(cx, H); g.stroke();
  g.beginPath(); g.arc(cx, cy, R, 0, 2 * Math.PI); g.stroke();
  g.fillStyle = 'rgba(200,210,255,0.6)'; g.font = '11px system-ui,sans-serif';
  if (mod && mod.iq === 'amp') {
    // ASK: amplitude along +I — weak (0) near the origin, strong (1) toward the edge.
    g.fillText('0 (weak)', cx + 10, cy - 6);
    g.fillText('1 (strong)', cx + R - 56, cy - 6);
  } else {
    // DBPSK: phase — same phase (bit 0) at +I, flipped (bit 1) at −I.
    g.fillText('bit 0', cx + R - 30, cy - 6);
    g.fillText('bit 1', cx - R + 4, cy - 6);
  }
  for (let i = 0; i < constPoints.length; i++) {
    const p = constPoints[i], age = i / constPoints.length;
    g.fillStyle = 'rgba(90,209,255,' + (0.25 + 0.75 * age) + ')';
    g.beginPath(); g.arc(cx + p.x * R, cy - p.y * R, 4, 0, 2 * Math.PI); g.fill();
  }
}

/* ---- Receiver ------------------------------------------------------------- */
let inTone = false, toneStartT = 0, lastValidT = 0, burstFrames = [];
let rxActive = false, rxSymbols = [], dataIdx = 0, lastRxSymbolT = 0;

// Loudest peak in the detection band this frame, with its SNR over the average.
function peakInBand() {
  analyser.getFloatFrequencyData(freqData);
  let peakBin = -1, peakDb = -Infinity, sum = 0, n = 0;
  for (let b = bandLoBin; b <= bandHiBin; b++) {
    const dv = freqData[b]; sum += dv; n++;
    if (dv > peakDb) { peakDb = dv; peakBin = b; }
  }
  if (peakBin < 0) return null;
  return { freq: binToFreq(peakBin), peakDb, snr: peakDb - sum / n };
}

function decodeStep() {
  const now = performance.now();
  const peak = peakInBand();
  // A burst only "counts" when it clears BOTH the absolute floor and the SNR
  // threshold. Use that same test for "now hearing", so the readout previews what
  // would actually register — not a faint peak that merely beats a very quiet band.
  const present = !!(peak && peak.peakDb >= ABS_FLOOR && peak.snr >= SNR_DB);
  signalSNR = peak ? peak.snr : -Infinity;
  updateSignal(peak);
  $('hearing').textContent = present ? Math.round(peak.freq) + ' Hz' : '—';

  if (rxActive && (now - lastRxSymbolT) > RX_TIMEOUT_MS) {
    rxActive = false; setRxLive('');
    logMessage('◀ ✗ incomplete', '(signal lost mid-message)', 'corrupt');
    setStatus(listeningStatus());
  }

  if (present) {
    if (!inTone) { inTone = true; toneStartT = now; burstFrames = []; }
    burstFrames.push(peak);
    lastValidT = now;
  } else if (inTone && (now - lastValidT) >= MIN_GAP_MS) {
    if (lastValidT - toneStartT >= MIN_TONE_MS && burstFrames.length) {
      commitBurst(burstFrames);
    }
    inTone = false; burstFrames = [];
  }
}

// A view onto the raw sample buffer, handed to modulations that need the
// waveform (chirp matched filter, DBPSK phase).
const rxSamples = {
  get sampleRate() { return ctx.sampleRate; },
  getRecent(n) {
    const m = Math.min(n, capBuf.length);
    return { x: getRecentSamples(n), startAbs: capTotal - m };
  },
};

// Decide what a finished tone-burst was: a marker, a data symbol, or noise.
function classifyBurst(frames, idx) {
  const freqs = frames.map((f) => f.freq).sort((a, b) => a - b);
  const med = freqs[Math.floor(freqs.length / 2)];
  if (Math.abs(med - F_START) <= TOLERANCE) return 'START';
  if (Math.abs(med - F_END) <= TOLERANCE) return 'END';
  return mod.decodeData(frames, idx, rxSamples); // modulation-specific
}

function commitBurst(frames) {
  const sym = classifyBurst(frames, dataIdx);
  if (sym === 'START') {
    rxActive = true; rxSymbols = []; dataIdx = 0;
    if (mod.reset) mod.reset();
    lastRxSymbolT = performance.now();
    setStatus('receiving…'); setRxLive('');
  } else if (sym === 'END') {
    if (rxActive) finishMessage();
  } else if (typeof sym === 'number' && rxActive) {
    rxSymbols.push(sym); dataIdx++;
    lastRxSymbolT = performance.now();
    setRxLive(decodeUtf8(bitsToBytes(symbolsToBits(rxSymbols, mod.bits))));
  }
}

function finishMessage() {
  rxActive = false; setRxLive('');
  const bytes = bitsToBytes(symbolsToBits(rxSymbols, mod.bits));
  if (bytes.length < 1) {
    logMessage('◀ ✗ corrupt', '(empty message)', 'corrupt');
  } else {
    const chk = bytes.pop();
    const calc = bytes.reduce((a, b) => (a + b) & 0xff, 0);
    const ok = chk === calc;
    logMessage(ok ? '◀ ✓ verified' : '◀ ✗ corrupt', decodeUtf8(bytes), ok ? 'verified' : 'corrupt');
  }
  setStatus(listeningStatus());
}

function decodeUtf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes)); }
  catch (_) { return '[decode error]'; }
}

/* ---- Transmitter ---------------------------------------------------------- */
function transmit(text) {
  if (!ctx) { setStatus('enable audio first'); return; }
  if (muted) { setStatus('transmit muted — tap 🔊 Transmit to enable'); return; }
  const payload = new TextEncoder().encode(text);
  const chk = payload.reduce((a, b) => (a + b) & 0xff, 0);
  const bytes = [...payload, chk];
  const dataSyms = bitsToSymbols(bytesToBits(bytes), mod.bits);

  let totalMs;
  if (mod.renderBuffer) {
    // Modulation builds the whole waveform itself (e.g. DBPSK needs sample-level
    // phase control) — play it through an AudioBuffer.
    const samples = mod.renderBuffer(dataSyms);
    const ab = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    ab.copyToChannel(samples, 0);
    const node = ctx.createBufferSource();
    node.buffer = ab; node.connect(ctx.destination); node.start();
    totalMs = (samples.length / ctx.sampleRate) * 1000;
  } else {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    const Ts = SYMBOL_MS / 1000, Tg = GAP_MS / 1000;
    let t = ctx.currentTime + 0.08;
    scheduleTone(osc, gain, F_START, t); t += Ts + Tg;
    for (let i = 0; i < dataSyms.length; i++) { mod.txData(osc, gain, dataSyms[i], i, t); t += Ts + Tg; }
    scheduleTone(osc, gain, F_END, t); t += Ts + Tg;
    osc.start(); osc.stop(t + 0.05);
    totalMs = (dataSyms.length + 2) * (SYMBOL_MS + GAP_MS);
  }
  logMessage('▶ sent (' + mod.name + ')', text);
  setStatus('transmitting ~' + (totalMs / 1000).toFixed(1) + ' s (' + mod.name + ')…');
  setTimeout(() => { if (running) setStatus(listeningStatus()); }, totalMs + 250);
}

/* ---- Feedback: link meter + live receive preview -------------------------- */
function updateSignal(peak) {
  const snr = peak && isFinite(peak.snr) ? peak.snr : 0;
  const bar = $('sigBar');
  // Everything is relative to the threshold so the bar and colour agree: a full bar
  // means "at the level that decodes". Green = would decode, yellow = within 3 dB of
  // it (a near miss), red = clearly below — regardless of where you set the slider.
  bar.style.width = Math.round(Math.max(0, Math.min(1, snr / SNR_DB)) * 100) + '%';
  if (snr >= SNR_DB) { bar.style.background = '#5affa0'; $('sigLabel').textContent = 'signal'; }
  else if (snr >= SNR_DB - 3) { bar.style.background = '#ffd75a'; $('sigLabel').textContent = 'close'; }
  else { bar.style.background = '#ff8f8f'; $('sigLabel').textContent = 'weak'; }
}
function setRxLive(text) {
  const el = $('rxLive');
  if (!rxActive) { el.textContent = ''; return; }
  el.textContent = text ? 'receiving: ' + text + '▊' : 'receiving…';
}

/* ---- Tone playground ------------------------------------------------------ */
let toneOsc = null;
function startTone(f) {
  if (muted) { setStatus('transmit muted'); return; }
  stopTone();
  toneOsc = ctx.createOscillator();
  const g = ctx.createGain(); g.gain.value = 0.2;
  toneOsc.frequency.value = f; toneOsc.connect(g); g.connect(ctx.destination);
  toneOsc.start();
}
function stopTone() { if (toneOsc) { try { toneOsc.stop(); } catch (_) {} toneOsc = null; } }
function sweepTones() {
  if (!ctx) return;
  if (muted) { setStatus('transmit muted'); return; }
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.connect(g); g.connect(ctx.destination);
  let t = ctx.currentTime + 0.05;
  for (const f of [F_START, ...mod.guides(), F_END]) {
    osc.frequency.setValueAtTime(f, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.setValueAtTime(0.25, t + 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    t += 0.14;
  }
  osc.start(); osc.stop(t + 0.05);
}

/* ---- Message log ---------------------------------------------------------- */
function logMessage(kind, text, cls) {
  const el = document.createElement('div');
  el.className = 'msg' + (cls ? ' ' + cls : '');
  el.innerHTML = '<span class="kind">' + kind + '</span> ' +
    String(text).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  $('log').prepend(el);
}

/* ---- Tabs ----------------------------------------------------------------- */
function showView(name) {
  for (const v of ['spectrum', 'tones', 'messenger', 'constellation', 'sdr']) {
    $('view-' + v).style.display = (v === name) ? 'block' : 'none';
    $('nav-' + v).classList.toggle('active', v === name);
  }
  if (name === 'sdr') renderSdrStats();
}

/* ---- Device (SDR) stats --------------------------------------------------- */
function fmtHz(hz) {
  if (!isFinite(hz)) return '—';
  if (hz >= 1e6) return (hz / 1e6).toFixed(3) + ' MHz';
  if (hz >= 1e3) return (hz / 1e3).toFixed(hz % 1e3 ? 1 : 0) + ' kHz';
  return (hz < 100 ? hz.toFixed(1) : Math.round(hz)) + ' Hz';
}
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// The device-abstraction point: describes whatever is currently capturing. Today
// that's the mic; a USB-SDR backend would fill these same rows from its own API
// (tuned frequency, RF bandwidth, gain stages). Values are either read from the
// device (getSettings) or inferred from the sample rate.
function deviceStats() {
  const track = (micStream && micStream.getAudioTracks) ? micStream.getAudioTracks()[0] : null;
  const s = track ? track.getSettings() : null;
  const fs = ctx ? ctx.sampleRate : NaN;
  const on = !!track;
  const flag = (v) => (v == null ? '—' : v ? 'on' : 'off');
  return [
    ['Device', on ? (track.label || 'Microphone') : 'Microphone (inactive — turn mic on)'],
    ['Type', 'Audio input · real-valued baseband'],
    ['Sample rate', on ? fmtHz(fs) : '—'],
    ['Frequency range', on ? '0 – ' + fmtHz(fs / 2) + ' (DC → Nyquist)' : '—'],
    ['Bandwidth', on ? fmtHz(fs / 2) + ' (real → fs/2)' : '—'],
    ['Tuning / center', 'N/A · fixed baseband (an SDR tunes here)'],
    ['FFT size', (on && analyser) ? analyser.fftSize + ' pts' : '—'],
    ['Resolution (RBW)', (on && analyser) ? fmtHz(fs / analyser.fftSize) + '/bin' : '—'],
    ['Channels', s ? String(s.channelCount || 1) : '—'],
    ['Gain', 'not exposed by browser'],
    ['Auto gain (AGC)', s ? (s.autoGainControl ? 'on ⚠︎' : 'off') : '—', !!(s && s.autoGainControl)],
    ['Echo cancel', flag(s && s.echoCancellation)],
    ['Noise suppress', flag(s && s.noiseSuppression)],
    ['Updated', new Date().toLocaleTimeString()], // changes each render → proves refresh fired
  ];
}

function renderSdrStats() {
  const el = $('sdrStats'); if (!el) return;
  el.innerHTML = deviceStats().map(([k, v, warn]) =>
    '<div class="statrow"><span class="statk">' + esc(k) + '</span>' +
    '<span class="statv' + (warn ? ' warn' : '') + '">' + esc(v) + '</span></div>'
  ).join('');
}

/* ---- Mute state -> status line ------------------------------------------- */
// Both mutes share the one status line, so it must reflect the COMBINED state —
// otherwise releasing one toggle wrongly resets the line while the other is active.
function muteStatus() {
  if (micMuted && muted) return 'mic muted · transmit off';
  if (micMuted) return 'mic muted — not listening or recording';
  if (muted) return 'transmit muted — this phone won’t emit sound';
  return listeningStatus();
}

// The idle line, shown consistently everywhere (previously the sample-rate suffix
// only appeared on the first enable, then vanished after the first message).
function listeningStatus() {
  return 'listening · ' + mod.name + (ctx ? ' · ' + ctx.sampleRate + ' Hz' : '');
}

// One threshold (SNR_DB), two sliders (Spectrum + Messenger). Dragging either moves
// the other and the meter's threshold line — so you can adjust wherever you're looking.
function bindSnrControls() {
  const ranges = ['snrRange', 'snrRange2'].map($).filter(Boolean);
  const labels = ['snrLabel', 'snrLabel2'].map($).filter(Boolean);
  const apply = (v) => {
    SNR_DB = v;
    ranges.forEach((r) => { r.value = v; });
    labels.forEach((l) => { l.textContent = '≥ ' + v + ' dB'; });
  };
  ranges.forEach((r) => r.addEventListener('input', () => apply(+r.value)));
  apply(SNR_DB); // sync both to the real default on load
}

function setSpecMode(m) {
  specMode = m;
  if (m === 'psd') psdAvg = null; // restart the running average cleanly
  $('specFft').classList.toggle('active', m === 'fft');
  $('specPsd').classList.toggle('active', m === 'psd');
}

// Inline SVG icons (Feather-style) so BOTH toggles visibly change glyph on/off —
// emoji has no reliable "muted mic". stroke=currentColor means they follow the
// button colour, turning red with the `.muted` class.
const ICON = {
  mic: '<svg class="ic" viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>',
  micOff: '<svg class="ic" viewBox="0 0 24 24"><line x1="2" y1="2" x2="22" y2="22"/><path d="M9 9v2a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 11v-1m14 0v1a7 7 0 0 1-.11 1.23"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>',
  spk: '<svg class="ic" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
  spkOff: '<svg class="ic" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
};

/* ---- Receive-only mute (app-level TX kill switch) ------------------------- */
// There is no OS/browser "speaker permission", so this is how a phone guarantees it
// stays receive-only: block every transmit path and grey out the controls.
function setMuted(m) {
  muted = m;
  stopTone(); // silence any tone already sounding
  const b = $('muteBtn');
  b.classList.toggle('muted', m);
  b.setAttribute('aria-pressed', String(m));
  b.innerHTML = (m ? ICON.spkOff : ICON.spk) + (m ? 'Transmit: off' : 'Transmit: on');
  ['send', 'tonePlay', 'toneMark', 'toneSpace', 'toneEnd', 'toneSweep'].forEach((id) => {
    const el = $(id); if (el) el.disabled = m;
  });
  setStatus(muteStatus());
}

/* ---- Receive-only mute (mic kill switch) --------------------------------- */
// Releases/re-acquires the actual microphone so the OS "mic in use" indicator
// reflects reality — the user's proof that nothing is being captured.
function setMicMutedUI(m) {
  const b = $('micMuteBtn');
  b.classList.toggle('muted', m);
  b.setAttribute('aria-pressed', String(m));
  b.innerHTML = (m ? ICON.micOff : ICON.mic) + (m ? 'Mic: muted' : 'Mic: on');
  setStatus(muteStatus());
  renderSdrStats(); // keep the Device tab current when the mic toggles
}

/* ---- Wire up the UI ------------------------------------------------------- */
window.addEventListener('DOMContentLoaded', () => {
  $('enable').addEventListener('click', enable);
  $('muteBtn').addEventListener('click', () => setMuted(!muted));
  $('micMuteBtn').addEventListener('click', async () => {
    const b = $('micMuteBtn');
    if (micMuted) {
      b.disabled = true;
      try { await startMic(); setMicMutedUI(false); }
      catch (e) { setStatus('mic error: ' + e.message); }
      b.disabled = false;
    } else {
      stopMic();
      setMicMutedUI(true);
    }
  });
  $('nav-spectrum').addEventListener('click', () => showView('spectrum'));
  $('nav-tones').addEventListener('click', () => showView('tones'));
  $('nav-messenger').addEventListener('click', () => showView('messenger'));
  $('nav-constellation').addEventListener('click', () => showView('constellation'));
  $('nav-sdr').addEventListener('click', () => showView('sdr'));
  $('sdrRefresh').addEventListener('click', renderSdrStats);

  const sel = $('modSelect');
  MODS.forEach((m, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = m.name + '  (' + m.bits + ' bit/sym)';
    if (m === mod) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => {
    mod = MODS[+sel.value];
    constPoints = []; dbpskPrev = null; // don't mix one scheme's dots into another's
    if (ctx) { drawGuides(); setStatus('modulation: ' + mod.name); }
  });

  bindSnrControls();
  $('specFft').addEventListener('click', () => setSpecMode('fft'));
  $('specPsd').addEventListener('click', () => setSpecMode('psd'));

  $('send').addEventListener('click', () => {
    const text = $('message').value.trim();
    if (text) transmit(text);
  });
  $('message').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('send').click(); });

  const slider = $('toneFreq'), readout = $('toneReadout');
  slider.addEventListener('input', () => {
    readout.textContent = slider.value + ' Hz';
    if (toneOsc) toneOsc.frequency.setValueAtTime(+slider.value, ctx.currentTime);
  });
  $('tonePlay').addEventListener('click', () => { if (ctx) startTone(+slider.value); });
  $('toneStop').addEventListener('click', stopTone);
  // Label the protocol-tone buttons with their real frequencies, straight from the
  // constants so they can never drift. The "data" example is the data-band centre.
  const dataTone = Math.round((DATA_LO + DATA_HI) / 2);
  $('toneMark').textContent = 'START · ' + F_START + ' Hz';
  $('toneSpace').textContent = 'data · ' + dataTone + ' Hz';
  $('toneEnd').textContent = 'END · ' + F_END + ' Hz';
  $('toneHint').innerHTML =
    '<b>START</b> (' + F_START + ' Hz) and <b>END</b> (' + F_END + ' Hz) are the fixed ' +
    'markers that bracket every message. <b>data</b> (' + dataTone + ' Hz) is one example ' +
    'from the ' + DATA_LO + '–' + DATA_HI + ' Hz payload band the data symbols use. ' +
    '<b>Sweep all</b> plays START, the current modulation’s data tones, then END — the ' +
    'whole alphabet in order. Watch them on the Spectrum/waterfall tabs.';
  $('toneMark').addEventListener('click', () => { if (ctx) startTone(F_START); });
  $('toneSpace').addEventListener('click', () => { if (ctx) startTone(dataTone); });
  $('toneEnd').addEventListener('click', () => { if (ctx) startTone(F_END); });
  $('toneSweep').addEventListener('click', sweepTones);

  showView('spectrum');
  $('version').textContent = 'v' + (self.__APP_VERSION__ || 'dev');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
});
