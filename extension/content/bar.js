"use strict";

// Floating control bar. Lives in a shadow root so page styles can't leak in,
// and never takes focus, so clicking it doesn't clear the page selection.
(() => {
  const RX = (globalThis.RX ??= {});

  const svg = (path) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
  const ICONS = {
    play: svg("M8 5v14l11-7z"),
    pause: svg("M6 5h4v14H6zM14 5h4v14h-4z"),
    stop: svg("M6 6h12v12H6z"),
    prev: svg("M6 6h2v12H6zM9.5 12 18 18V6z"),
    next: svg("M16 6h2v12h-2zM6 18l8.5-6L6 6z"),
    settings: svg(
      "M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.47.47 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.47.47 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.48.48 0 0 0-.12-.61zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z",
    ),
    collapse: svg("M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"),
    expand: svg("M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6z"),
    close: svg("M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z"),
  };
  const PRESETS = [1.25, 1.5, 2];

  const STYLE = `
    :host { all: initial; position: fixed; z-index: 2147483647; right: 24px; bottom: 24px; }
    :host([hidden]) { display: none; }
    .wrap {
      --bg: #1f2328; --fg: #e6e8eb; --muted: #9aa1a9; --hover: #343a42; --accent: #f0b429; --accent-fg: #1f2328;
      font: 13px/1.2 system-ui, sans-serif; color: var(--fg); background: var(--bg);
      border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.3); padding: 6px; user-select: none;
    }
    @media (prefers-color-scheme: light) {
      .wrap { --bg: #ffffff; --fg: #1f2328; --muted: #5f6873; --hover: #eef0f2; --accent: #f0b429; --accent-fg: #1f2328; }
    }
    .row { display: flex; align-items: center; gap: 2px; }
    button {
      all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
      min-width: 30px; height: 30px; padding: 0 6px; border-radius: 8px; cursor: pointer; color: inherit;
    }
    button:hover { background: var(--hover); }
    button.primary { background: var(--accent); color: var(--accent-fg); min-width: 36px; }
    button.preset { font-size: 12px; color: var(--muted); }
    button.preset.active { color: var(--fg); font-weight: 600; }
    svg { width: 18px; height: 18px; fill: currentColor; }
    .grip { cursor: grab; color: var(--muted); padding: 0 4px; font-size: 14px; letter-spacing: -2px; }
    .grip:active { cursor: grabbing; }
    .rate { min-width: 44px; text-align: center; font-variant-numeric: tabular-nums; font-weight: 600; }
    .sep { width: 1px; height: 20px; background: var(--hover); margin: 0 4px; }
    .collapsed .full { display: none; }
    .status { color: var(--muted); padding: 6px 6px 2px; max-width: 420px; }
    .status:empty { display: none; }
    .status a { color: var(--accent); cursor: pointer; text-decoration: underline; }
  `;

  const TEMPLATE = `
    <div class="wrap">
      <div class="row">
        <span class="grip" title="Drag to move">⋮⋮</span>
        <button class="full" data-cmd="prev-sentence" title="Previous sentence (Alt+Shift+←)">${ICONS.prev}</button>
        <button class="primary" data-cmd="toggle-play" title="Play / pause (Alt+Shift+P)">${ICONS.play}</button>
        <button class="full" data-cmd="next-sentence" title="Next sentence (Alt+Shift+→)">${ICONS.next}</button>
        <button class="full" data-cmd="stop" title="Stop (Alt+Shift+S)">${ICONS.stop}</button>
        <span class="sep full"></span>
        <button class="full" data-cmd="speed-down" title="Slower (Alt+Shift+,)">−</button>
        <span class="rate"></span>
        <button class="full" data-cmd="speed-up" title="Faster (Alt+Shift+.)">+</button>
        ${PRESETS.map((r) => `<button class="full preset" data-rate="${r}">${r}</button>`).join("")}
        <span class="sep full"></span>
        <button class="full" data-cmd="open-options" title="Settings">${ICONS.settings}</button>
        <button data-cmd="collapse" title="Collapse">${ICONS.collapse}</button>
        <button class="full" data-cmd="close" title="Close (stops reading)">${ICONS.close}</button>
      </div>
      <div class="status"></div>
    </div>
  `;

  class Bar {
    constructor({ onAction }) {
      this.onAction = onAction;
      this.host = null;
      this.collapsed = false;
    }

    mount() {
      if (this.host) return;
      this.host = document.createElement("read-along-bar");
      const root = this.host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = STYLE;
      const template = document.createElement("template");
      template.innerHTML = TEMPLATE;
      root.append(style, template.content);
      this.root = root;
      this.wrap = root.querySelector(".wrap");
      this.playButton = root.querySelector("[data-cmd='toggle-play']");
      this.rateLabel = root.querySelector(".rate");
      this.statusLine = root.querySelector(".status");

      // Keep focus and the page selection where they are.
      root.addEventListener("mousedown", (e) => e.preventDefault());
      root.addEventListener("click", (e) => this.handleClick(e));
      this.enableDrag(root.querySelector(".grip"));

      browser.storage.local.get({ barPos: null, barCollapsed: false }).then(({ barPos, barCollapsed }) => {
        if (barPos) this.moveTo(barPos.x, barPos.y);
        this.setCollapsed(barCollapsed);
      });
      document.documentElement.append(this.host);
      this.render();
    }

    handleClick(e) {
      const link = e.target.closest("a[data-cmd]");
      if (link) return this.onAction(link.dataset.cmd);
      const button = e.target.closest("button");
      if (!button) return;
      if (button.dataset.rate) return this.onAction("set-rate", Number(button.dataset.rate));
      const cmd = button.dataset.cmd;
      if (cmd === "collapse") {
        this.setCollapsed(!this.collapsed);
        browser.storage.local.set({ barCollapsed: this.collapsed });
      } else if (cmd === "close") {
        this.onAction("stop");
        this.hide();
      } else {
        this.onAction(cmd);
      }
    }

    enableDrag(grip) {
      grip.addEventListener("pointerdown", (e) => {
        const rect = this.host.getBoundingClientRect();
        const dx = e.clientX - rect.left;
        const dy = e.clientY - rect.top;
        grip.setPointerCapture(e.pointerId);
        const move = (ev) => this.moveTo(ev.clientX - dx, ev.clientY - dy);
        const up = () => {
          grip.removeEventListener("pointermove", move);
          const r = this.host.getBoundingClientRect();
          browser.storage.local.set({ barPos: { x: r.left, y: r.top } });
        };
        grip.addEventListener("pointermove", move);
        grip.addEventListener("pointerup", up, { once: true });
      });
    }

    moveTo(x, y) {
      const rect = this.host.getBoundingClientRect();
      const left = Math.min(Math.max(0, x), innerWidth - Math.max(rect.width, 60));
      const top = Math.min(Math.max(0, y), innerHeight - Math.max(rect.height, 40));
      Object.assign(this.host.style, { left: `${left}px`, top: `${top}px`, right: "auto", bottom: "auto" });
    }

    setCollapsed(collapsed) {
      this.collapsed = collapsed;
      this.wrap.classList.toggle("collapsed", collapsed);
      const button = this.root.querySelector("[data-cmd='collapse']");
      button.innerHTML = collapsed ? ICONS.expand : ICONS.collapse;
      button.title = collapsed ? "Expand" : "Collapse";
    }

    show() {
      this.mount();
      this.host.hidden = false;
    }

    hide() {
      if (this.host) this.host.hidden = true;
    }

    toggle() {
      if (this.host && !this.host.hidden) this.hide();
      else this.show();
    }

    update({ status, rate }) {
      if (status !== undefined) this.status = status;
      if (rate !== undefined) this.rate = rate;
      this.render();
    }

    render() {
      if (!this.host) return;
      const active = this.status === "playing" || this.status === "loading";
      this.playButton.innerHTML = active ? ICONS.pause : ICONS.play;
      this.rateLabel.textContent = `${(this.rate ?? 1).toFixed(2)}×`;
      for (const b of this.root.querySelectorAll("[data-rate]")) {
        b.classList.toggle("active", Number(b.dataset.rate) === this.rate);
      }
    }

    // Shows a line under the controls. `action` adds a link that runs a command.
    message(text, { action, timeout } = {}) {
      this.show();
      clearTimeout(this.messageTimer);
      this.statusLine.textContent = text;
      if (action) {
        const link = document.createElement("a");
        link.dataset.cmd = action.command;
        link.textContent = action.label;
        this.statusLine.append(" ", link);
      }
      if (timeout) this.messageTimer = setTimeout(() => this.clearMessage(), timeout);
    }

    clearMessage() {
      clearTimeout(this.messageTimer);
      if (this.statusLine) this.statusLine.textContent = "";
    }
  }

  RX.Bar = Bar;
})();
