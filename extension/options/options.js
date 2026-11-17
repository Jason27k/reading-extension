"use strict";

// Preferences and usage counts sync across devices; the API key stays on this one.
const SYNCED = {
  voice: "en-US-Standard-C",
  jaVoice: "ja-JP-Standard-A",
  rate: 1.25,
  jaRate: 1,
  skipCode: true,
  readCaptions: true,
};
const VOICE_SELECTS = { voice: "voice", jaVoice: "ja-voice" };
const LOCAL = { apiKey: "" };
const ORIGINS = ["<all_urls>"];
const $ = (id) => document.getElementById(id);

function setStatus(text) {
  $("status").textContent = text;
}

async function load() {
  const s = { ...(await browser.storage.sync.get(SYNCED)), ...(await browser.storage.local.get(LOCAL)) };
  $("api-key").value = s.apiKey;
  $("rate").value = s.rate;
  $("ja-rate").value = s.jaRate;
  $("skip-code").checked = s.skipCode;
  $("read-captions").checked = s.readCaptions;
  setVoiceOptions("voice", [{ name: s.voice }], s.voice);
  setVoiceOptions("ja-voice", [{ name: s.jaVoice }], s.jaVoice);
  showUsage();
  showTime();
  checkPermissions();
  if (s.apiKey) loadVoices();
}

function setVoiceOptions(id, voices, selected) {
  const select = $(id);
  select.replaceChildren(
    ...voices.map((v) => {
      const label = v.gender ? `${v.name} (${v.gender.toLowerCase()})` : v.name;
      return new Option(label, v.name, false, v.name === selected);
    }),
  );
}

async function loadVoices() {
  const res = await browser.runtime.sendMessage({ type: "list-voices" });
  if (res.error) return setStatus(`Couldn't load voices: ${res.error}`);
  const lists = {
    voice: res.voices.filter((v) => v.name.startsWith("en-")),
    "ja-voice": res.voices.filter((v) => v.name.startsWith("ja-")),
  };
  for (const [id, voices] of Object.entries(lists)) {
    const selected = $(id).value;
    if (selected && !voices.some((v) => v.name === selected)) voices.unshift({ name: selected });
    setVoiceOptions(id, voices, selected);
  }
}

// Each device counts under its own "usage-<deviceId>" key; see background.js.
async function showUsage() {
  const month = new Date().toISOString().slice(0, 7);
  const all = await browser.storage.sync.get(null);
  const { deviceId } = await browser.storage.local.get("deviceId");
  let total = 0;
  let here = 0;
  for (const [key, usage] of Object.entries(all)) {
    if (!key.startsWith("usage-") || usage?.month !== month) continue;
    total += usage.chars;
    if (key === `usage-${deviceId}`) here = usage.chars;
  }
  const text = `${total.toLocaleString()} characters`;
  $("usage").textContent = total === here ? text : `${text} (${here.toLocaleString()} on this device)`;
}

// Reading time is stored per day: the last 30 days in storage.sync under
// "time-<deviceId>-<day>", and all of it in storage.local under "time-<day>".
// See background.js.
const LANGS = { en: "English", ja: "Japanese" };

function localDay(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatTime(seconds) {
  const minutes = Math.round(seconds / 60);
  if (seconds > 0 && minutes === 0) return "<1m";
  const h = Math.floor(minutes / 60);
  return h ? `${h}h ${minutes % 60}m` : `${minutes}m`;
}

function timeTable(table, rows) {
  const header = document.createElement("tr");
  for (const label of ["", ...Object.values(LANGS)]) {
    const th = document.createElement("th");
    th.textContent = label;
    header.append(th);
  }
  table.replaceChildren(
    header,
    ...rows.map(([label, totals]) => {
      const tr = document.createElement("tr");
      for (const value of [label, ...Object.keys(LANGS).map((lang) => formatTime(totals[lang]))]) {
        const td = document.createElement("td");
        td.textContent = value;
        tr.append(td);
      }
      return tr;
    }),
  );
}

// Adds up normal-speed time per language over the days in `days`
// ({ site: { en: { normal }, … } } per day), from day `from` on.
function addUp(days, from) {
  const totals = { en: 0, ja: 0 };
  const bySite = {};
  for (const { day, sites } of days) {
    if (day < from) continue;
    for (const [site, langs] of Object.entries(sites)) {
      for (const lang of Object.keys(LANGS)) {
        const normal = langs[lang]?.normal ?? 0;
        totals[lang] += normal;
        (bySite[site] ??= { en: 0, ja: 0 })[lang] += normal;
      }
    }
  }
  return { totals, bySite };
}

function timeDays(all, pattern) {
  return Object.entries(all)
    .filter(([key]) => pattern.test(key))
    .map(([key, sites]) => ({ day: key.slice(-10), sites }));
}

// Recent days come from storage.sync, added up across devices; all time is this
// device's own history in storage.local.
async function showTime() {
  const synced = timeDays(await browser.storage.sync.get(null), /^time-.+-\d{4}-\d{2}-\d{2}$/);
  const local = timeDays(await browser.storage.local.get(null), /^time-\d{4}-\d{2}-\d{2}$/);
  const recent = addUp(synced, localDay(29));
  const rows = [
    ["Today", addUp(synced, localDay()).totals],
    ["Last 7 days", addUp(synced, localDay(6)).totals],
    ["Last 30 days", recent.totals],
    ["All time on this device", addUp(local, "").totals],
  ];
  const sites = Object.entries(recent.bySite).sort(([, a], [, b]) => b.en + b.ja - (a.en + a.ja));
  const empty = !synced.length && !local.length;
  $("time-empty").hidden = !empty;
  $("time-totals").hidden = empty;
  $("time-sites").hidden = !sites.length;
  $("time-sites").previousElementSibling.hidden = !sites.length;
  timeTable($("time-totals"), rows);
  timeTable($("time-sites"), sites);
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
  loadVoices();
});

$("voice").addEventListener("change", (e) => {
  browser.storage.sync.set({ voice: e.target.value });
  setStatus("Voice saved.");
});

$("ja-voice").addEventListener("change", (e) => {
  browser.storage.sync.set({ jaVoice: e.target.value });
  setStatus("Japanese voice saved.");
});

function rateInput(id, key, fallback) {
  $(id).addEventListener("change", (e) => {
    const rate = Math.min(3, Math.max(0.75, Number(e.target.value) || fallback));
    e.target.value = rate;
    browser.storage.sync.set({ [key]: rate });
    setStatus("Speed saved.");
  });
}
rateInput("rate", "rate", SYNCED.rate);
rateInput("ja-rate", "jaRate", SYNCED.jaRate);

$("skip-code").addEventListener("change", (e) => {
  browser.storage.sync.set({ skipCode: e.target.checked });
  setStatus("Saved.");
});

$("read-captions").addEventListener("change", (e) => {
  browser.storage.sync.set({ readCaptions: e.target.checked });
  setStatus("Saved.");
});

async function testVoice(ssml, voiceId, rateId) {
  setStatus("Synthesizing…");
  const res = await browser.runtime.sendMessage({
    type: "synthesize",
    ssml,
    voice: $(voiceId).value,
    rate: Number($(rateId).value) || 1,
  });
  if (res.error) return setStatus(res.error);
  setStatus("");
  new Audio(`data:audio/mpeg;base64,${res.audio}`).play();
}

$("test").addEventListener("click", () =>
  testVoice(
    "<speak>All of these patterns share a common theme: they put the business logic first.</speak>",
    "voice",
    "rate",
  ),
);

$("test-ja").addEventListener("click", () =>
  testVoice("<speak>優等生だった人はマイクです。</speak>", "ja-voice", "ja-rate"),
);

browser.storage.onChanged.addListener((changes, area) => {
  if (Object.keys(changes).some((k) => k.startsWith("time-"))) showTime();
  if (area !== "sync") return;
  if (Object.keys(changes).some((k) => k.startsWith("usage-"))) showUsage();
  for (const [key, id] of Object.entries(VOICE_SELECTS)) {
    if (changes[key]) $(id).value = changes[key].newValue;
  }
  if (changes.rate) $("rate").value = changes.rate.newValue;
  if (changes.jaRate) $("ja-rate").value = changes.jaRate.newValue;
  if (changes.skipCode) $("skip-code").checked = changes.skipCode.newValue;
  if (changes.readCaptions) $("read-captions").checked = changes.readCaptions.newValue;
});

load();
