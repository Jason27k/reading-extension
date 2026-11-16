"use strict";

// Page text extraction: turns the readable part of a page into ordered blocks
// (paragraphs, headings, list items), each split into sentences and words with
// offsets that map back to DOM text nodes for highlighting.
(() => {
  const RX = (globalThis.RX ??= {});

  // Per-site settings. `selectors`: where the text lives, tried in order; the first match
  // with real text wins. `skip`: extra elements never to read on that site.
  const SITES = [
    {
      host: /(^|\.)oreilly\.com$/,
      selectors: ["#sbo-rt-content", "[data-testid='contentViewer']", "#book-content", "main"],
    },
    {
      host: /(^|\.)marumori\.io$/,
      // Numbered badges ("1.3") next to example sentences.
      skip: [".example-number"],
    },
  ];
  const site = SITES.find((s) => s.host.test(location.hostname));
  const GENERIC_ROOTS = ["article", "main", "[role='main']"];

  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "CAPTION", "DD", "DETAILS", "DIV", "DL", "DT",
    "FIELDSET", "FIGCAPTION", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR",
    "LI", "MAIN", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TD", "TH", "TR", "UL",
  ]);
  // Blocks that get a short pause around them so they don't run into the next paragraph.
  const PAUSE_SELECTOR = "h1, h2, h3, h4, h5, h6, figure, figcaption, caption";

  // Never read these (or anything inside them). Images are skipped as elements, so their
  // alt text is never read even when the figure caption around them is.
  const SKIP_SELECTOR = [
    "script", "style", "noscript", "template",
    "img", "picture", "svg", "canvas", "video", "audio", "iframe", "object", "embed", "math",
    "[role='img']",
    "nav", "button", "input", "select", "textarea",
    "[aria-hidden='true']", "[hidden]",
    // Furigana: the reading above a kanji would otherwise be read right after it.
    "rt", "rp",
    // Footnote markers and the footnote list at the end of O'Reilly chapters.
    "sup > a", "a[data-type='noteref']", "[data-type='footnotes']",
  ].join(",");
  const CODE_SELECTOR = "pre";
  const FIGURE_SELECTOR = "figure, [role='figure'], [data-type='figure']";
  const FOOTNOTE_MARK = /^[\s\d*†‡§,]+$/;

  const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  const wordSegmenter = new Intl.Segmenter("en", { granularity: "word" });
  const encoder = new TextEncoder();

  function findRoot() {
    for (const selector of [...(site?.selectors ?? []), ...GENERIC_ROOTS]) {
      const el = document.querySelector(selector);
      if (el && el.innerText.trim().length > 200) return el;
    }
    return document.body;
  }

  function blockAncestor(node, root) {
    let el = node.parentElement;
    while (el && el !== root && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
    return el ?? root;
  }

  function extractBlocks(root, { skipCode = true, readCaptions = true } = {}) {
    const skip = [SKIP_SELECTOR, ...(site?.skip ?? []), skipCode && CODE_SELECTOR, !readCaptions && FIGURE_SELECTOR]
      .filter(Boolean)
      .join(",");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, (node) => {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      if (node.matches(skip)) return NodeFilter.FILTER_REJECT;
      if (node.tagName === "SUP" && FOOTNOTE_MARK.test(node.textContent)) return NodeFilter.FILTER_REJECT;
      if (node.checkVisibility && !node.checkVisibility()) return NodeFilter.FILTER_REJECT;
      // Blurred text is hidden on purpose, e.g. a translation the reader should guess first.
      if (getComputedStyle(node).filter.includes("blur(")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_SKIP;
    });

    // Consecutive text nodes with the same block ancestor form one block, so text
    // that wraps around a nested block (e.g. a list inside a list item) keeps its order.
    const blocks = [];
    let current = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = blockAncestor(node, root);
      if (current?.el !== el) {
        current = { el, pause: !!el.closest(PAUSE_SELECTOR), nodes: [], text: "" };
        blocks.push(current);
      }
      const start = current.text.length;
      current.text += node.data;
      current.nodes.push({ node, start, end: current.text.length });
    }
    return blocks.filter((b) => /[\p{L}\p{N}]/u.test(b.text));
  }

  function escapeXml(s) {
    return s.replace(/[&<>"']/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "apos" }[c]};`);
  }

  function cleanForSpeech(s) {
    // Soft hyphens and control characters (invalid in XML) are dropped; whitespace collapses.
    return s.replace(/[\u00AD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/\s+/g, " ");
  }

  // Only English and Japanese are read, so the script decides the language: a word with
  // kana or kanji (or fullwidth/CJK punctuation) is Japanese, one with Latin letters is
  // English. Everything else (digits, spaces, punctuation) stays with the run it is in.
  const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\u3000-\u303f\u30fc\uff00-\uffef]/u;
  const LATIN = /\p{Script=Latin}/u;

  // The segmenter can split a word like だった into だ/っ/た. A mark between those pieces
  // could break up the sound, so a piece that starts with a small kana or ー, or follows
  // a っ, stays part of the word before it.
  const JOINS_PREVIOUS = /^[ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶー]/;
  const JOINS_NEXT = /[っッ]$/;

  function languageOf(part, i, parts) {
    if (!part.isWordLike) return null;
    if (JAPANESE.test(part.segment)) return "ja";
    if (LATIN.test(part.segment)) return "en";
    // A number written right before Japanese is part of it, like 3時 or 2人.
    if (parts[i + 1]?.isWordLike && JAPANESE.test(parts[i + 1].segment)) return "ja";
    return null;
  }

  // Splits a block into sentences, each with its words and its SSML split into runs of one
  // language. Every word gets a <mark name="sentence.word"/> before it so playback can
  // report its position.
  function segment(block) {
    if (block.sentences) return block.sentences;
    block.sentences = [];
    // Newlines from the HTML source would count as sentence breaks; replace them 1:1
    // so offsets still line up with the DOM text.
    const flat = block.text.replace(/[\r\n\t\f\v\u2028\u2029]/g, " ");
    for (const { segment: sentence, index } of sentenceSegmenter.segment(flat)) {
      const parts = [...wordSegmenter.segment(sentence)];
      if (!parts.some((p) => p.isWordLike)) continue;

      const s = block.sentences.length;
      const words = [];
      const languages = parts.map((p, i) => languageOf(p, i, parts));
      // Leading digits or punctuation take the language of the first real word.
      let language = languages.find(Boolean) ?? "en";
      const runs = [];
      let run = { ja: language === "ja", ssml: "" };
      parts.forEach((part, i) => {
        if (languages[i] && languages[i] !== language) {
          if (run.ssml) runs.push(run);
          language = languages[i];
          run = { ja: language === "ja", ssml: "" };
        }
        if (part.isWordLike) {
          const prev = parts[i - 1];
          const joins =
            languages[i] === "ja" &&
            languages[i - 1] === "ja" &&
            (JOINS_PREVIOUS.test(part.segment) || JOINS_NEXT.test(prev.segment));
          if (joins) {
            words.at(-1).end = index + part.index + part.segment.length;
          } else {
            run.ssml += `<mark name="${s}.${words.length}"/>`;
            words.push({ start: index + part.index, end: index + part.index + part.segment.length });
          }
        }
        run.ssml += escapeXml(cleanForSpeech(part.segment));
      });
      runs.push(run);
      runs[0].ssml = runs[0].ssml.trimStart();
      runs.at(-1).ssml = runs.at(-1).ssml.trimEnd();

      const lead = sentence.length - sentence.trimStart().length;
      const result = { start: index + lead, end: index + sentence.trimEnd().length, words, runs };
      result.bytes = runs.reduce((sum, r) => sum + encoder.encode(r.ssml).length, 0);
      block.sentences.push(result);
    }
    return block.sentences;
  }

  // Joins the runs of consecutive sentences into runs of one language each, so every
  // run can be synthesized with its own voice and speed.
  function languageRuns(sentences) {
    const merged = [];
    for (const { runs } of sentences) {
      for (const run of runs) {
        const last = merged.at(-1);
        if (last?.ja === run.ja) last.ssml += ` ${run.ssml}`;
        else merged.push({ ...run });
      }
    }
    return merged.map((r) => ({ ja: r.ja, ssml: r.ssml.trim() })).filter((r) => r.ssml);
  }

  function locate(block, offset, isEnd) {
    for (const n of block.nodes) {
      if (offset < n.end || (isEnd && offset === n.end)) return [n.node, offset - n.start];
    }
    const last = block.nodes.at(-1);
    return [last.node, last.end - last.start];
  }

  function rangeFor(block, start, end) {
    const range = document.createRange();
    range.setStart(...locate(block, start, false));
    range.setEnd(...locate(block, end, true));
    return range;
  }

  function sentenceAt(block, offset) {
    const sentences = segment(block);
    const i = sentences.findIndex((s) => offset < s.end);
    return i === -1 ? sentences.length - 1 : i;
  }

  // Maps a DOM point (from a selection or a click) to a reading position.
  function positionOf(blocks, node, offset) {
    if (node.nodeType === Node.TEXT_NODE) {
      for (let b = 0; b < blocks.length; b++) {
        const hit = blocks[b].nodes.find((n) => n.node === node);
        if (hit) return { block: b, sentence: sentenceAt(blocks[b], hit.start + offset) };
      }
    } else if (node.childNodes[offset]) {
      node = node.childNodes[offset];
    }
    // Not readable text itself (e.g. inside a skipped figure): use the block it's in, or the next one.
    for (let b = 0; b < blocks.length; b++) {
      const el = blocks[b].el;
      if (el === node || el.contains(node) || node.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        return { block: b, sentence: 0 };
      }
    }
    return null;
  }

  function firstVisibleBlock(blocks) {
    const i = blocks.findIndex((b) => {
      const r = rangeFor(b, 0, b.text.length).getBoundingClientRect();
      return r.height > 0 && r.bottom > 0 && r.top < innerHeight;
    });
    return Math.max(i, 0);
  }

  RX.text = { findRoot, extractBlocks, segment, languageRuns, rangeFor, positionOf, firstVisibleBlock };
})();
