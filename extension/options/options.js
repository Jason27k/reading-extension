"use strict";

// Preferences sync across devices; the API key and usage count stay on this one.
const SYNCED = { voice: "en-US-Standard-C", rate: 1.25, skipCode: true, readCaptions: true };
const LOCAL = { apiKey: "", usage: null };
const ORIGINS = ["<all_urls>"];
const $ = (id) => document.getElementById(id);

function setStatus(text) {
  $("status").textContent = text;
}

async function load() {
  const s = { ...(await browser.storage.sync.get(SYNCED)), ...(await browser.storage.local.get(LOCAL)) };
  $("api-key").value = s.apiKey;
  $("rate").value = s.rate;
  $("skip-code").checked = s.skipCode;
  $("read-captions").checked = s.readCaptions;
  setVoiceOptions([{ name: s.voice }], s.voice);
  showUsage(s.usage);
  checkPermissions();
  if (s.apiKey) loadVoices(s.voice);
}

function setVoiceOptions(voices, selected) {
  const select = $("voice");
  select.replaceChildren(
    ...voices.map((v) => {
      const label = v.gender ? `${v.name} (${v.gender.toLowerCase()})` : v.name;
      return new Option(label, v.name, false, v.name === selected);
    }),
  );
}

async function loadVoices(selected) {
  const res = await browser.runtime.sendMessage({ type: "list-voices" });
  if (res.error) return setStatus(`Couldn't load voices: ${res.error}`);
  if (!res.voices.some((v) => v.name === selected)) res.voices.unshift({ name: selected });
  setVoiceOptions(res.voices, selected);
}

function showUsage(usage) {
  const month = new Date().toISOString().slice(0, 7);
  const chars = usage?.month === month ? usage.chars : 0;
  $("usage").textContent = `${chars.toLocaleString()} characters`;
}

async function checkPermissions() {
  const granted = await browser.permissions.contains({ origins: ORIGINS });
  $("permission-warning").hidden = granted;
}

$("grant").addEventListener("click", async () => {
  await browser.permissions.request({ origins: ORIGINS });
  checkPermissions();
});

$("toggle-key").addEventListener("click", () => {
  const input = $("api-key");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("toggle-key").textContent = show ? "Hide" : "Show";
});

$("api-key").addEventListener("change", async (e) => {
  await browser.storage.local.set({ apiKey: e.target.value.trim() });
  setStatus("API key saved.");
  loadVoices($("voice").value);
});

$("voice").addEventListener("change", (e) => {
  browser.storage.sync.set({ voice: e.target.value });
  setStatus("Voice saved.");
});

$("rate").addEventListener("change", (e) => {
  const rate = Math.min(3, Math.max(0.75, Number(e.target.value) || 1.25));
  e.target.value = rate;
  browser.storage.sync.set({ rate });
  setStatus("Speed saved.");
});

$("skip-code").addEventListener("change", (e) => {
  browser.storage.sync.set({ skipCode: e.target.checked });
  setStatus("Saved.");
});

$("read-captions").addEventListener("change", (e) => {
  browser.storage.sync.set({ readCaptions: e.target.checked });
  setStatus("Saved.");
});

$("test").addEventListener("click", async () => {
  setStatus("Synthesizing…");
  const res = await browser.runtime.sendMessage({
    type: "synthesize",
    ssml: "<speak>All of these patterns share a common theme: they put the business logic first.</speak>",
    voice: $("voice").value,
    rate: Number($("rate").value) || 1,
  });
  if (res.error) return setStatus(res.error);
  setStatus("");
  new Audio(`data:audio/mpeg;base64,${res.audio}`).play();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.usage) showUsage(changes.usage.newValue);
  if (area !== "sync") return;
  if (changes.voice) $("voice").value = changes.voice.newValue;
  if (changes.rate) $("rate").value = changes.rate.newValue;
  if (changes.skipCode) $("skip-code").checked = changes.skipCode.newValue;
  if (changes.readCaptions) $("read-captions").checked = changes.readCaptions.newValue;
});

load();
