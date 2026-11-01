"use strict";

// Audio: fetches synthesized clips through the background script and plays them
// back to back on one AudioContext, so chunk boundaries are gapless and
// pausing or stopping fades out instead of cutting mid-waveform (no pops).
(() => {
  const RX = (globalThis.RX ??= {});

  const CACHE_SIZE = 40;
  const FADE = 0.01; // seconds, time constant for fades

  class SynthError extends Error {
    constructor(message, code) {
      super(message);
      this.code = code;
    }
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

    // Returns a promise of { buffer, marks }, cached so prefetched or replayed text isn't re-billed.
    synth(ssml, voice, rate) {
      const key = `${voice}|${rate}|${ssml}`;
      let clip = this.cache.get(key);
      if (clip) {
        this.cache.delete(key);
      } else {
        clip = this.fetchClip(ssml, voice, rate);
        clip.catch(() => this.cache.delete(key));
      }
      this.cache.set(key, clip);
      if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value);
      return clip;
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
