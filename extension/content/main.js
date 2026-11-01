"use strict";

// Controller: ties page text, audio and the control bar together, keeps the
// highlight in sync with playback and handles every command.
(() => {
  const { text, Player, Bar } = globalThis.RX;

  const DEFAULTS = { voice: "en-US-Standard-C", rate: 1.25, skipCode: true };
  const MIN_RATE = 0.75;
  const MAX_RATE = 3;
  const RATE_STEP = 0.05;
  const PREFETCH = 3; // chunks requested ahead of the one playing
  const FIRST_CHUNK_CHARS = 250; // keep the first request small so audio starts fast
  const CHUNK_BYTES = 4000; // Google's limit is 5000 bytes of SSML per request
  const RATE_RESTART_DELAY = 350; // wait for repeated speed presses before re-synthesizing
  const USER_SCROLL_PAUSE = 4000; // ms to hold off auto-scroll after the user scrolls

  let settings = { ...DEFAULTS };
  const player = new Player();
  const bar = new Bar({ onAction: handleCommand });

  const state = {
    status: "stopped", // stopped | loading | playing | paused
    blocks: null,
    pos: null, // { block, sentence } being read, or where to continue from
    gen: 0, // bumped on every restart so stale async work can bail out
    chunks: null,
    upcoming: [], // [{ chunk, clip: Promise }] fetched, not yet scheduled
    scheduled: [], // [{ chunk, clip, start }] queued on the AudioContext
    pumping: 0,
    restartOnResume: false,
    highlighted: null,
    userScrollUntil: 0,
    lastContextMenu: null,
  };

  // ---- Settings ----

  browser.storage.local.get(DEFAULTS).then((stored) => {
    settings = { ...DEFAULTS, ...stored };
    bar.update({ rate: settings.rate });
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key of Object.keys(DEFAULTS)) {
      if (key in changes) settings[key] = changes[key].newValue ?? DEFAULTS[key];
    }
    if ("skipCode" in changes) state.blocks = null;
    if ("rate" in changes) bar.update({ rate: settings.rate });
  });

  // ---- Positions and chunks ----

  function loadBlocks() {
    state.blocks = text.extractBlocks(text.findRoot(), settings);
    return state.blocks;
  }

  function ensureBlocks() {
    if (!state.blocks?.length || !state.blocks[0].el.isConnected) {
      loadBlocks();
      state.pos = null;
    }
    return state.blocks;
  }

  function* chunksFrom(blocks, pos) {
    let first = true;
    for (let b = pos.block; b < blocks.length; b++) {
      const sentences = text.segment(blocks[b]);
      let s0 = b === pos.block ? pos.sentence : 0;
      while (s0 < sentences.length) {
        let s1 = s0;
        let bytes = 0;
        let chars = 0;
        while (s1 < sentences.length) {
          const next = sentences[s1];
          const full = bytes + next.bytes > CHUNK_BYTES || (first && chars >= FIRST_CHUNK_CHARS);
          if (s1 > s0 && full) break;
          bytes += next.bytes;
          chars += next.end - next.start;
          s1++;
        }
        yield { block: b, s0, s1 };
        first = false;
        s0 = s1;
      }
    }
  }

  function chunkSsml({ block, s0, s1 }) {
    const b = state.blocks[block];
    const body = text.segment(b).slice(s0, s1).map((s) => s.ssml).join(" ");
    // A short pause around headings so they don't run into the next paragraph.
    return b.heading ? `<speak><break time="250ms"/>${body}<break time="250ms"/></speak>` : `<speak>${body}</speak>`;
  }

  // ---- Playback ----

  function setStatus(status) {
    state.status = status;
    bar.update({ status });
    if (status === "playing") bar.clearMessage();
  }

  async function playFrom(pos) {
    const gen = ++state.gen;
    player.stopAll();
    state.upcoming = [];
    state.scheduled = [];
    state.restartOnResume = false;
    state.pos = pos;
    state.chunks = chunksFrom(state.blocks, pos);
    bar.show();
    setStatus("loading");
    highlight(pos.block, pos.sentence, 0);

    if (!(await player.resume())) {
      if (gen !== state.gen) return;
      setStatus("paused");
      bar.message("Firefox is blocking audio until you click the page. Press ▶ to start.");
      return;
    }
    fillPrefetch();
    pump(gen);
    startHighlightLoop();
  }

  function fillPrefetch() {
    while (state.upcoming.length < PREFETCH) {
      const { value: chunk, done } = state.chunks.next();
      if (done) break;
      const clip = player.synth(chunkSsml(chunk), settings.voice, settings.rate);
      clip.catch(() => {}); // reported when this chunk's turn comes
      state.upcoming.push({ chunk, clip });
    }
  }

  // Keeps the current clip and the next one queued on the AudioContext so there's
  // no gap between chunks.
  async function pump(gen) {
    if (state.pumping === gen) return;
    state.pumping = gen;
    try {
      while (gen === state.gen && state.scheduled.length < 2) {
        const next = state.upcoming.shift();
        if (!next) {
          if (!state.scheduled.length) finish();
          return;
        }
        fillPrefetch();
        let clip;
        try {
          clip = await next.clip;
        } catch (err) {
          if (gen === state.gen) fail(err);
          return;
        }
        if (gen !== state.gen) return;
        const item = { chunk: next.chunk, clip };
        item.start = player.schedule(clip, () => {
          state.scheduled = state.scheduled.filter((it) => it !== item);
          if (gen === state.gen) pump(gen);
        });
        state.scheduled.push(item);
        if (state.status === "loading") setStatus("playing");
      }
    } finally {
      if (state.pumping === gen) state.pumping = 0;
    }
  }

  function pause() {
    player.pause();
    setStatus("paused");
  }

  async function resume() {
    if (state.restartOnResume || !state.scheduled.length) return playFrom(state.pos);
    if (await player.resume()) {
      setStatus("playing");
      startHighlightLoop();
    }
  }

  function stop() {
    state.gen++;
    player.stopAll();
    state.upcoming = [];
    state.scheduled = [];
    setStatus("stopped");
    clearHighlight();
  }

  function finish() {
    stop();
    state.pos = null;
    bar.message("Reached the end of the page.", { timeout: 5000 });
  }

  function fail(err) {
    stop();
    if (err.code === "no-key") {
      bar.message(err.message, { action: { label: "Open settings", command: "open-options" } });
    } else {
      bar.message(`Couldn't read this part: ${err.message}`);
    }
  }

  // ---- Commands ----

  function hasSelection() {
    const sel = getSelection();
    return sel && !sel.isCollapsed && sel.rangeCount > 0 && !bar.host?.contains(sel.anchorNode);
  }

  function startFromPoint(node, offset) {
    const pos = text.positionOf(loadBlocks(), node, offset);
    if (!pos) return bar.message("Couldn't find readable text there.", { timeout: 4000 });
    playFrom(pos);
  }

  function startFromSelection() {
    const sel = getSelection();
    const range = sel.getRangeAt(0);
    // Clear it so a later play/pause doesn't jump back to this spot.
    sel.removeAllRanges();
    startFromPoint(range.startContainer, range.startOffset);
  }

  function startFromScreen() {
    const blocks = ensureBlocks();
    if (!blocks.length) return bar.message("No readable text found on this page.", { timeout: 4000 });
    playFrom(state.pos ?? { block: text.firstVisibleBlock(blocks), sentence: 0 });
  }

  function togglePlay() {
    if (state.status === "playing" || state.status === "loading") return pause();
    if (hasSelection()) return startFromSelection();
    if (state.status === "paused") return resume();
    startFromScreen();
  }

  function readFromContextMenu() {
    if (hasSelection()) return startFromSelection();
    const point = state.lastContextMenu;
    const caret = point && document.caretPositionFromPoint(point.x, point.y);
    if (caret) startFromPoint(caret.offsetNode, caret.offset);
    else startFromScreen();
  }

  function setRate(rate) {
    rate = Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, rate)) * 100) / 100;
    if (rate === settings.rate) return;
    settings.rate = rate;
    browser.storage.local.set({ rate });
    bar.update({ rate });
    // Google synthesizes at the new speed (natural pitch), so the current sentence restarts.
    clearTimeout(state.rateTimer);
    if (state.status === "playing" || state.status === "loading") {
      state.rateTimer = setTimeout(() => playFrom(state.pos), RATE_RESTART_DELAY);
    } else if (state.status === "paused") {
      state.restartOnResume = true;
    }
  }

  function skip(dir, unit) {
    if (!state.pos || !state.blocks?.[0]?.el.isConnected) return;
    const blocks = state.blocks;
    let { block, sentence } = state.pos;
    if (unit === "sentence") {
      sentence += dir;
      if (sentence < 0) {
        block = Math.max(0, block - 1);
        sentence = block === state.pos.block ? 0 : text.segment(blocks[block]).length - 1;
      } else if (sentence >= text.segment(blocks[block]).length) {
        block++;
        sentence = 0;
      }
    } else {
      // "Previous paragraph" from mid-paragraph goes back to the start of this one first.
      block += dir < 0 && sentence > 0 ? 0 : dir;
      block = Math.max(0, block);
      sentence = 0;
    }
    if (block >= blocks.length) return finish();
    playFrom({ block, sentence });
  }

  function handleCommand(command, value) {
    switch (command) {
      case "toggle-play":
        return togglePlay();
      case "read-selection":
        return hasSelection() ? startFromSelection() : startFromScreen();
      case "read-from-context":
        return readFromContextMenu();
      case "stop":
        return stop();
      case "speed-up":
        return setRate(settings.rate + RATE_STEP);
      case "speed-down":
        return setRate(settings.rate - RATE_STEP);
      case "set-rate":
        return setRate(value);
      case "next-sentence":
        return skip(1, "sentence");
      case "prev-sentence":
        return skip(-1, "sentence");
      case "next-paragraph":
        return skip(1, "paragraph");
      case "prev-paragraph":
        return skip(-1, "paragraph");
      case "toggle-bar":
        return bar.toggle();
      case "open-options":
        return browser.runtime.sendMessage({ type: "open-options" });
    }
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "command") handleCommand(msg.command);
  });

  addEventListener("contextmenu", (e) => (state.lastContextMenu = { x: e.clientX, y: e.clientY }), true);

  // ---- Highlighting and scrolling ----

  const highlights = "highlights" in CSS ? { sentence: new Highlight(), word: new Highlight() } : null;
  if (highlights) {
    highlights.word.priority = 1;
    CSS.highlights.set("read-along-sentence", highlights.sentence);
    CSS.highlights.set("read-along-word", highlights.word);
  }

  function startHighlightLoop() {
    if (state.raf) return;
    const tick = () => {
      if (state.status === "stopped") {
        state.raf = 0;
        return;
      }
      state.raf = requestAnimationFrame(tick);
      if (state.status !== "playing") return;
      const t = player.now();
      const item = state.scheduled.find((it) => t >= it.start && t < it.start + it.clip.buffer.duration);
      if (!item) return;
      let mark = null;
      for (const m of item.clip.marks) {
        if (m.time > t - item.start) break;
        mark = m;
      }
      const [sentence, word] = mark ? mark.name.split(".").map(Number) : [item.chunk.s0, 0];
      highlight(item.chunk.block, sentence, word);
    };
    state.raf = requestAnimationFrame(tick);
  }

  function highlight(block, sentence, word) {
    const prev = state.highlighted;
    if (prev?.block === block && prev.sentence === sentence && prev.word === word) return;
    state.highlighted = { block, sentence, word };
    state.pos = { block, sentence };
    if (!highlights) return;

    const b = state.blocks[block];
    const s = text.segment(b)[sentence];
    const w = s.words[word] ?? s.words[0];
    const sentenceChanged = prev?.block !== block || prev.sentence !== sentence;
    if (sentenceChanged) {
      highlights.sentence.clear();
      highlights.sentence.add(text.rangeFor(b, s.start, s.end));
    }
    highlights.word.clear();
    const wordRange = text.rangeFor(b, w.start, w.end);
    highlights.word.add(wordRange);
    if (sentenceChanged || word % 8 === 0) autoScroll(b, wordRange);
  }

  function clearHighlight() {
    state.highlighted = null;
    highlights?.sentence.clear();
    highlights?.word.clear();
  }

  function scrollParent(el) {
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const { overflowY } = getComputedStyle(p);
      if ((overflowY === "auto" || overflowY === "scroll") && p.scrollHeight > p.clientHeight) return p;
    }
    return document.scrollingElement ?? document.documentElement;
  }

  function autoScroll(block, range) {
    if (Date.now() < state.userScrollUntil) return;
    const rect = range.getBoundingClientRect();
    if (rect.top >= innerHeight * 0.15 && rect.bottom <= innerHeight * 0.75) return;
    scrollParent(block.el).scrollBy({ top: rect.top - innerHeight * 0.3, behavior: "smooth" });
  }

  const holdAutoScroll = () => (state.userScrollUntil = Date.now() + USER_SCROLL_PAUSE);
  addEventListener("wheel", holdAutoScroll, { passive: true, capture: true });
  addEventListener("touchmove", holdAutoScroll, { passive: true, capture: true });
  addEventListener(
    "keydown",
    (e) => {
      const scrollKeys = ["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "];
      if (scrollKeys.includes(e.key) && !e.altKey) holdAutoScroll();
    },
    true,
  );
})();
