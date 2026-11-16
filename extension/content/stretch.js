"use strict";

// Speeds audio up without changing its pitch, using WSOLA (waveform-similarity
// overlap-add): half-overlapping Hann frames are taken from the input at the
// faster pace, and each one is nudged by up to TOLERANCE so its waveform lines
// up with the frame before it. Google's own speakingRate slurs well above 1.0,
// so faster speeds are made here instead.
(() => {
  const RX = (globalThis.RX ??= {});

  const FRAME = 0.03; // seconds per frame
  const TOLERANCE = 0.012; // seconds a frame may shift to line up
  const COARSE_STEP = 4; // search every 4th offset first, then refine around the best
  const YIELD_EVERY = 400; // frames between breaks, so long clips don't freeze the page

  // Returns one Float32Array per channel, about length / factor samples long.
  async function stretchChannels(inputs, sampleRate, factor) {
    const n = 2 * Math.round((FRAME * sampleRate) / 2);
    const hop = n / 2;
    const tol = Math.round(TOLERANCE * sampleRate);
    const inLen = inputs[0].length;
    const outLen = Math.max(1, Math.round(inLen / factor));
    const outputs = inputs.map(() => new Float32Array(outLen + n));

    const window = new Float32Array(n);
    for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);

    // Frames are matched on a zero-padded mono mix, so lookups never run off the end.
    const mono = new Float32Array(inLen + 2 * n);
    for (const input of inputs) for (let i = 0; i < inLen; i++) mono[i] += input[i] / inputs.length;

    let prev = 0;
    for (let k = 0, out = 0; out < outLen; k++, out += hop) {
      let pos = Math.round(out * factor);
      // Match against what would naturally follow the previous frame.
      if (k > 0) pos = bestMatch(mono, prev + hop, pos, tol, hop, inLen);
      const end = Math.min(n, inLen - pos);
      for (let c = 0; c < inputs.length; c++) {
        const input = inputs[c];
        const output = outputs[c];
        for (let i = 0; i < end; i++) output[out + i] += input[pos + i] * window[i];
      }
      prev = pos;
      if (k % YIELD_EVERY === YIELD_EVERY - 1) await new Promise((r) => setTimeout(r));
    }
    return outputs.map((o) => o.subarray(0, outLen));
  }

  function bestMatch(x, target, center, tol, len, inLen) {
    const lo = Math.max(0, center - tol);
    const hi = Math.min(inLen - len, center + tol);
    if (hi < lo) return Math.min(center, inLen);
    let best = lo;
    let bestScore = -Infinity;
    for (let c = lo; c <= hi; c += COARSE_STEP) {
      const s = similarity(x, target, c, len, COARSE_STEP);
      if (s > bestScore) [best, bestScore] = [c, s];
    }
    const coarse = best;
    bestScore = -Infinity;
    for (let c = Math.max(lo, coarse - COARSE_STEP + 1); c <= Math.min(hi, coarse + COARSE_STEP - 1); c++) {
      const s = similarity(x, target, c, len, 1);
      if (s > bestScore) [best, bestScore] = [c, s];
    }
    return best;
  }

  // Cross-correlation normalized by the candidate's energy, so loud spots don't always win.
  function similarity(x, a, b, len, step) {
    let dot = 0;
    let energy = 1e-9;
    for (let i = 0; i < len; i += step) {
      dot += x[a + i] * x[b + i];
      energy += x[b + i] * x[b + i];
    }
    return dot / Math.sqrt(energy);
  }

  // Speeds up a clip by factor, scaling its word marks to match.
  async function stretchClip({ buffer, marks }, factor) {
    const inputs = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    const outputs = await stretchChannels(inputs, buffer.sampleRate, factor);
    const stretched = new AudioBuffer({
      numberOfChannels: outputs.length,
      length: outputs[0].length,
      sampleRate: buffer.sampleRate,
    });
    outputs.forEach((o, c) => stretched.copyToChannel(o, c));
    return { buffer: stretched, marks: marks.map((m) => ({ ...m, time: m.time / factor })) };
  }

  RX.stretchClip = stretchClip;
  RX.stretchChannels = stretchChannels;
})();
