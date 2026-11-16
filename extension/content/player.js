"use strict";

// Audio: fetches synthesized clips through the background script and plays them
// back to back on one AudioContext, so chunk boundaries are gapless and
// pausing or stopping fades out instead of cutting mid-waveform (no pops).
(() => {
  const RX = (globalThis.RX ??= {});

  const CACHE_SIZE = 40;
  // Google synthesizes up to this speed; faster speeds are stretched locally,
  // because Google's speedup slurs at high rates.
  const NATIVE_MAX_RATE = 1.25;
  const FADE = 0.01; // seconds, time constant for fades

  class SynthError extends Error {
    constructor(message, code) {
      super(message);
      this.code = code;
    }
  }

  // Plays clips back to back as one, shifting each one's word marks by where it starts.
  // Every buffer comes from the same AudioContext, so they share a sample rate.
  function joinClips(clips) {
    const { sampleRate } = clips[0].buffer;
    const channels = Math.max(...clips.map((c) => c.buffer.numberOfChannels));
    const length = clips.reduce((sum, c) => sum + c.buffer.length, 0);
    const buffer = new AudioBuffer({ numberOfChannels: channels, length, sampleRate });
    const marks = [];
    let offset = 0;
    for (const clip of clips) {
      for (let ch = 0; ch < channels; ch++) {
        const source = Math.min(ch, clip.buffer.numberOfChannels - 1);
        buffer.copyToChannel(clip.buffer.getChannelData(source), ch, offset);
      }
      const start = offset / sampleRate;
      for (const m of clip.marks) marks.push({ ...m, time: m.time + start });
      offset += clip.buffer.length;
    }
    return { buffer, marks };
  }

  class Player {
    constructor() {
      this.cache = new Map();
      this.ctx = null;
      this.gain = null;
      this.sources = new Set();
      this.endTime = 0;
    }

    ensureContext() {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.gain = this.newGain();
      }
      return this.ctx;
    }

    newGain() {
      const gain = this.ctx.createGain();
      gain.connect(this.ctx.destination);
      return gain;
    }

    now() {
      return this.ctx?.currentTime ?? 0;
    }

    // Returns a promise of { buffer, marks }. Google's audio is cached so prefetched
    // or replayed text, and speed changes above NATIVE_MAX_RATE, aren't re-billed.
    synth(ssml, voice, rate) {
      const googleRate = Math.min(rate, NATIVE_MAX_RATE);
      const key = `${voice}|${googleRate}|${ssml}`;
      let clip = this.cache.get(key);
      if (clip) {
        this.cache.delete(key);
      } else {
        clip = this.fetchClip(ssml, voice, googleRate);
        clip.catch(() => this.cache.delete(key));
      }
      this.cache.set(key, clip);
      if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value);
      const factor = rate / googleRate;
      return factor > 1.001 ? clip.then((c) => RX.stretchClip(c, factor)) : clip;
    }

    // Synthesizes each part ({ ssml, voice, rate }) on its own and joins them into one
    // clip. Google's word timings are wrong after a <voice> switch inside one request,
    // so text in another language is a separate request rather than a <voice> tag.
    async synthParts(parts) {
      const clips = await Promise.all(parts.map((p) => this.synth(p.ssml, p.voice, p.rate)));
      return clips.length === 1 ? clips[0] : joinClips(clips);
    }

    async fetchClip(ssml, voice, rate) {
      const res = await browser.runtime.sendMessage({ type: "synthesize", ssml, voice, rate });
      if (!res || res.error) throw new SynthError(res?.error ?? "No response from the extension", res?.code);
      const binary = atob(res.audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const buffer = await this.ensureContext().decodeAudioData(bytes.buffer);
      const marks = res.timepoints
        .map((t) => ({ name: t.markName, time: t.timeSeconds }))
        .sort((a, b) => a.time - b.time);
      return { buffer, marks };
    }

    // Queues a clip right after whatever is already scheduled. Returns its start time.
    schedule(clip, onEnded) {
      const ctx = this.ensureContext();
      const source = ctx.createBufferSource();
      source.buffer = clip.buffer;
      source.connect(this.gain);
      const start = Math.max(ctx.currentTime + 0.05, this.endTime);
      source.start(start);
      this.endTime = start + clip.buffer.duration;
      this.sources.add(source);
      source.onended = () => {
        if (this.sources.delete(source)) onEnded();
      };
      return start;
    }

    stopAll() {
      if (!this.ctx) return;
      const { ctx, gain, sources } = this;
      const t = ctx.currentTime;
      gain.gain.setTargetAtTime(0, t, FADE);
      for (const source of sources) {
        source.onended = null;
        source.stop(t + 6 * FADE);
      }
      setTimeout(() => gain.disconnect(), 500);
      // New clips go through a fresh gain node so they aren't caught in the fade-out.
      this.gain = this.newGain();
      this.sources = new Set();
      this.endTime = 0;
    }

    pause() {
      if (this.ctx?.state !== "running") return;
      this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, FADE);
      const ctx = this.ctx;
      this.pauseTimer = setTimeout(() => ctx.suspend(), 60);
    }

    // Resolves to false if the browser is blocking audio until the page gets a click.
    async resume() {
      clearTimeout(this.pauseTimer);
      const ctx = this.ensureContext();
      if (ctx.state !== "running") {
        await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 600))]);
      }
      if (ctx.state !== "running") return false;
      this.gain.gain.cancelScheduledValues(ctx.currentTime);
      this.gain.gain.setTargetAtTime(1, ctx.currentTime, FADE);
      return true;
    }
  }

  RX.Player = Player;
})();
