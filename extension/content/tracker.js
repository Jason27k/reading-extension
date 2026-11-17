"use strict";

// Reading time: adds up how long each language was heard on this page and
// sends the totals to the background script, which keeps them per day and per
// site. "listened" is time actually heard; "normal" is how long that audio
// would last at 1× speed.
(() => {
  const RX = (globalThis.RX ??= {});

  const FLUSH_DELAY = 30000; // ms between sends while reading

  // Local date, so a day's reading lands under the day it happened for the reader.
  function localDay() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function siteName() {
    return location.hostname.replace(/^www\./, "") || "local files";
  }

  class Tracker {
    constructor() {
      this.pending = {}; // { en: { listened, normal }, ja: … }
      this.timer = 0;
    }

    add(lang, listened, normal) {
      const p = (this.pending[lang] ??= { listened: 0, normal: 0 });
      p.listened += listened;
      p.normal += normal;
      this.timer ||= setTimeout(() => this.flush(), FLUSH_DELAY);
    }

    flush() {
      clearTimeout(this.timer);
      this.timer = 0;
      if (!Object.keys(this.pending).length) return;
      const time = this.pending;
      this.pending = {};
      browser.runtime
        .sendMessage({ type: "record-time", day: localDay(), site: siteName(), time })
        .catch(console.error);
    }
  }

  RX.Tracker = Tracker;
})();
