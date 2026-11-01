"use strict";

// Page text extraction: turns the readable part of a page into ordered blocks
// (paragraphs, headings, list items), each split into sentences and words with
// offsets that map back to DOM text nodes for highlighting.
(() => {
  const RX = (globalThis.RX ??= {});

  // Where the book text lives, tried in order. The first match with real text wins.
  const SITE_ROOTS = [
    {
      host: /(^|\.)oreilly\.com$/,
      selectors: ["#sbo-rt-content", "[data-testid='contentViewer']", "#book-content", "main"],
    },
  ];
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
    const site = SITE_ROOTS.find((s) => s.host.test(location.hostname));
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
    const skip = [SKIP_SELECTOR, skipCode && CODE_SELECTOR, !readCaptions && FIGURE_SELECTOR].filter(Boolean).join(",");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, (node) => {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      if (node.matches(skip)) return NodeFilter.FILTER_REJECT;
      if (node.tagName === "SUP" && FOOTNOTE_MARK.test(node.textContent)) return NodeFilter.FILTER_REJECT;
      if (node.checkVisibility && !node.checkVisibility()) return NodeFilter.FILTER_REJECT;
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

  // Splits a block into sentences, each with its words and an SSML fragment that has a
  // <mark name="sentence.word"/> before every word so playback can report its position.
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
      let ssml = "";
      for (const part of parts) {
        if (part.isWordLike) {
          ssml += `<mark name="${s}.${words.length}"/>`;
          words.push({ start: index + part.index, end: index + part.index + part.segment.length });
        }
        ssml += escapeXml(cleanForSpeech(part.segment));
      }
      ssml = ssml.trim();
      const lead = sentence.length - sentence.trimStart().length;
      block.sentences.push({
        start: index + lead,
        end: index + sentence.trimEnd().length,
        words,
        ssml,
        bytes: encoder.encode(ssml).length,
      });
    }
    return block.sentences;
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

  RX.text = { findRoot, extractBlocks, segment, rangeFor, positionOf, firstVisibleBlock };
})();
